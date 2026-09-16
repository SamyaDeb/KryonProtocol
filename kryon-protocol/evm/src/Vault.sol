// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {KryonUpgradeable} from "./governance/KryonUpgradeable.sol";
import {Roles} from "./governance/Roles.sol";
import {IEngine, IInsurance, ISignatureTransfer} from "./interfaces/IKryon.sol";
import {Decimals} from "./libraries/Decimals.sol";
import {Errors} from "./libraries/Errors.sol";
import {KryonMath as M} from "./libraries/KryonMath.sol";

/// @title Vault
/// @notice USDC custody and the protocol's internal 1e18 ledger.
/// @dev Custody uses Arc USDC's ERC-20 interface (6 decimals) only, through
///      SafeERC20. Native value is rejected. Balances are signed: a negative
///      balance is unsettled bad debt. Token <-> ledger conversion happens
///      only in `Decimals`.
///
///      Accounting identity (protocol invariant 5), exact barring donations:
///        usdc.balanceOf(vault) * 1e12
///          == totalLedger - engine.netCostBasis()
///      where totalLedger is the sum of every balance (traders, fee router,
///      insurance, funding pool; negative balances included).
contract Vault is KryonUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant REASON_FEE = "FEE";
    uint256 public constant UNCAPPED = type(uint256).max;

    struct CollateralConfig {
        bool listed;
        bool active;
    }

    /// @custom:storage-location erc7201:kryon.storage.Vault
    struct VaultStorage {
        IERC20 usdc;
        ISignatureTransfer permit2;
        IEngine engine;
        mapping(address => int256) balances;
        int256 totalLedger;
        /// Net deposits (6 dp) backing the staged-launch caps.
        uint256 totalDeposited;
        mapping(address => uint256) netDeposited;
        /// 0 = deposits closed (the launch default until verification passes).
        uint256 depositCap;
        uint256 accountDepositCap;
        mapping(address => bool) capExempt;
        mapping(address => CollateralConfig) collateral;
        IInsurance insurance;
    }

    // keccak256(abi.encode(uint256(keccak256("kryon.storage.Vault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x7f207f143c1bc375b7d1bdbc77ab69de6859641d301143575ea5f6e73a498c00;

    event Deposited(
        address indexed payer, address indexed account, uint256 amount, int256 internalAmount
    );
    event Withdrawn(
        address indexed account, address indexed to, uint256 amount, int256 internalAmount
    );
    event PnlApplied(address indexed account, int256 amount, int256 balanceAfter);
    event InternalTransfer(
        address indexed from, address indexed to, int256 amount, bytes32 indexed reason
    );
    event DepositCapsSet(uint256 total, uint256 perAccount);
    event CapExemptSet(address indexed account, bool exempt);
    event CollateralSet(address indexed token, bool active);
    event EngineSet(address indexed engine);
    event InsuranceSet(address indexed insurance);

    function _s() private pure returns (VaultStorage storage $) {
        assembly ("memory-safe") {
            $.slot := STORAGE_LOCATION
        }
    }

    function initialize(address admin, address usdc_, address permit2_) external initializer {
        if (usdc_ == address(0) || permit2_ == address(0)) revert Errors.ZeroAddress();
        __KryonUpgradeable_init(admin);
        VaultStorage storage $ = _s();
        $.usdc = IERC20(usdc_);
        $.permit2 = ISignatureTransfer(permit2_);
        $.collateral[usdc_] = CollateralConfig({listed: true, active: true});
        emit CollateralSet(usdc_, true);
        emit DepositCapsSet(0, 0);
    }

    // ---------------------------------------------------------------- config

    function setEngine(address engine_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (engine_ == address(0)) revert Errors.ZeroAddress();
        _s().engine = IEngine(engine_);
        emit EngineSet(engine_);
    }

    /// @notice Insurance is told when a deposit repays a negative balance, so
    ///         its recorded bad debt never outlives the debt itself.
    function setInsurance(address insurance_) external onlyRole(Roles.DEFAULT_ADMIN_ROLE) {
        if (insurance_ == address(0)) revert Errors.ZeroAddress();
        _s().insurance = IInsurance(insurance_);
        emit InsuranceSet(insurance_);
    }

    /// @notice Staged-launch caps in USDC (6 dp). 0 closes deposits;
    ///         `UNCAPPED` removes the limit.
    function setDepositCaps(uint256 total, uint256 perAccount)
        external
        onlyRole(Roles.RISK_ADMIN_ROLE)
    {
        _s().depositCap = total;
        _s().accountDepositCap = perAccount;
        emit DepositCapsSet(total, perAccount);
    }

    /// @notice Protocol accounts (insurance, fee router) bypass the caps.
    function setCapExempt(address account, bool exempt)
        external
        onlyRole(Roles.DEFAULT_ADMIN_ROLE)
    {
        _s().capExempt[account] = exempt;
        emit CapExemptSet(account, exempt);
    }

    /// @notice Collateral registry. Only the settlement asset (USDC) is
    ///         supported; the interface is kept for a future upgrade that adds
    ///         haircut-valued assets (e.g. EURC).
    function setCollateral(address token, bool active) external onlyRole(Roles.RISK_ADMIN_ROLE) {
        if (token != address(_s().usdc)) revert Errors.CollateralNotSupported(token);
        _s().collateral[token] = CollateralConfig({listed: true, active: active});
        emit CollateralSet(token, active);
    }

    // -------------------------------------------------------------- deposits

    function deposit(uint256 amount) external {
        _pullAndCredit(msg.sender, msg.sender, amount);
    }

    /// @notice Deposit on behalf of `account`. Used by protocol contracts
    ///         (insurance) and by integrators funding a user.
    function depositFor(address account, uint256 amount) external {
        _pullAndCredit(msg.sender, account, amount);
    }

    /// @notice EIP-2612 permit + deposit in one transaction.
    /// @dev A front-run permit consumes the nonce and makes `permit` revert;
    ///      the deposit still goes through if the allowance is already there.
    function depositWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try IERC20Permit(address(_s().usdc)).permit(
            msg.sender, address(this), amount, deadline, v, r, s
        ) {} catch {}
        _pullAndCredit(msg.sender, msg.sender, amount);
    }

    /// @notice Permit2 signature-transfer deposit, for wallets without 2612.
    function depositWithPermit2(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        VaultStorage storage $ = _s();
        if (permit.permitted.token != address($.usdc)) {
            revert Errors.CollateralNotSupported(permit.permitted.token);
        }
        uint256 amount = permit.permitted.amount;
        _checkDeposit(msg.sender, amount);
        $.permit2.permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: amount}),
            msg.sender,
            signature
        );
        _credit(msg.sender, msg.sender, amount);
    }

    function _pullAndCredit(address payer, address account, uint256 amount)
        private
        nonReentrant
        whenNotPaused
    {
        _checkDeposit(account, amount);
        _s().usdc.safeTransferFrom(payer, address(this), amount);
        _credit(payer, account, amount);
    }

    function _checkDeposit(address account, uint256 amount) private view {
        VaultStorage storage $ = _s();
        if (account == address(0)) revert Errors.ZeroAddress();
        if (amount == 0) revert Errors.InvalidAmount();
        if (!$.collateral[address($.usdc)].active) revert Errors.AssetDisabled();
        if ($.capExempt[account]) return;
        if ($.totalDeposited + amount > $.depositCap) revert Errors.DepositCapExceeded();
        if ($.netDeposited[account] + amount > $.accountDepositCap) {
            revert Errors.DepositCapExceeded();
        }
    }

    function _credit(address payer, address account, uint256 amount) private {
        VaultStorage storage $ = _s();
        int256 internalAmount = Decimals.toInternal(amount);
        if (!$.capExempt[account]) {
            $.totalDeposited += amount;
            $.netDeposited[account] += amount;
        }
        bool wasNegative = $.balances[account] < 0;
        _move(account, internalAmount);
        emit Deposited(payer, account, amount, internalAmount);
        if (wasNegative && address($.insurance) != address(0)) $.insurance.refreshDebt(account);
    }

    // ------------------------------------------------------------ withdrawals

    function withdraw(uint256 amount) external {
        _withdraw(msg.sender, msg.sender, amount);
    }

    /// @notice Withdraw the caller's balance to another address. Protocol
    ///         contracts use this to pay out claims and unstakes.
    function withdrawTo(address to, uint256 amount) external {
        _withdraw(msg.sender, to, amount);
    }

    function _withdraw(address account, address to, uint256 amount) private nonReentrant whenNotPaused {
        VaultStorage storage $ = _s();
        if (to == address(0)) revert Errors.ZeroAddress();
        if (amount == 0) revert Errors.InvalidAmount();
        int256 internalAmount = Decimals.toInternal(amount);
        if ($.balances[account] < internalAmount) revert Errors.InsufficientCollateral();
        // Reverts unless equity after the withdrawal still covers initial margin.
        $.engine.validateWithdrawal(account, internalAmount);

        _move(account, -internalAmount);
        if (!$.capExempt[account]) {
            $.totalDeposited = $.totalDeposited > amount ? $.totalDeposited - amount : 0;
            uint256 net = $.netDeposited[account];
            $.netDeposited[account] = net > amount ? net - amount : 0;
        }
        emit Withdrawn(account, to, amount, internalAmount);
        $.usdc.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------ ledger ops

    /// @notice Credit or debit realized trading PnL. Engine only.
    /// @dev Not zero-sum on its own: its counterpart is the change in the
    ///      engine's cost basis (see the accounting identity above).
    function applyPnl(address account, int256 amount) external whenNotPaused {
        if (msg.sender != address(_s().engine)) revert Errors.Unauthorized();
        if (amount == 0) return;
        _move(account, amount);
        emit PnlApplied(account, amount, _s().balances[account]);
    }

    /// @notice Zero-sum move between two ledger accounts (fees, funding,
    ///         penalties, insurance cover). Protocol contracts only.
    function transferInternal(address from, address to, int256 amount, bytes32 reason)
        external
        onlyRole(Roles.LEDGER_ROLE)
        whenNotPaused
    {
        if (amount < 0) revert Errors.InvalidAmount();
        if (amount == 0 || from == to) return;
        VaultStorage storage $ = _s();
        $.balances[from] = M.sub($.balances[from], amount);
        $.balances[to] = M.add($.balances[to], amount);
        emit InternalTransfer(from, to, amount, reason);
    }

    function _move(address account, int256 amount) private {
        VaultStorage storage $ = _s();
        $.balances[account] = M.add($.balances[account], amount);
        $.totalLedger = M.add($.totalLedger, amount);
    }

    // ------------------------------------------------------------------ views

    function balanceOf(address account) external view returns (int256) {
        return _s().balances[account];
    }

    /// @notice Largest whole-token amount `account` holds (ignores margin).
    function withdrawableBalance(address account) external view returns (uint256) {
        int256 b = _s().balances[account];
        return b <= 0 ? 0 : Decimals.toTokenDown(b);
    }

    function totalLedger() external view returns (int256) {
        return _s().totalLedger;
    }

    /// @notice Both sides of the accounting identity, in 1e18 units.
    ///         `assets >= liabilities` always; equal unless USDC was donated.
    function solvency() external view returns (int256 assets, int256 liabilities) {
        VaultStorage storage $ = _s();
        assets = Decimals.toInternal($.usdc.balanceOf(address(this)));
        liabilities = $.totalLedger - $.engine.netCostBasis();
    }

    function usdc() external view returns (address) {
        return address(_s().usdc);
    }

    function permit2() external view returns (address) {
        return address(_s().permit2);
    }

    function engine() external view returns (address) {
        return address(_s().engine);
    }

    function insurance() external view returns (address) {
        return address(_s().insurance);
    }

    function depositCaps() external view returns (uint256 total, uint256 perAccount) {
        return (_s().depositCap, _s().accountDepositCap);
    }

    function totalDeposited() external view returns (uint256) {
        return _s().totalDeposited;
    }

    function netDeposited(address account) external view returns (uint256) {
        return _s().netDeposited[account];
    }

    function isCapExempt(address account) external view returns (bool) {
        return _s().capExempt[account];
    }

    function collateral(address token) external view returns (bool listed, bool active) {
        CollateralConfig memory c = _s().collateral[token];
        return (c.listed, c.active);
    }
}
