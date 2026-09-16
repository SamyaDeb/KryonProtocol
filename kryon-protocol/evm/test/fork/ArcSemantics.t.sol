// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Metadata as IERC20} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {Vault} from "../../src/Vault.sol";
import {ISignatureTransfer} from "../../src/interfaces/IKryon.sol";
import {Order} from "../../src/libraries/OrderLib.sol";
import {FundingState} from "../../src/libraries/Types.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {KryonTest} from "../utils/KryonTest.sol";

interface IUSDCPermit {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice G4: Arc execution semantics against a fork of Arc testnet, with the
///         real USDC (0x3600…) and Permit2. Read-only fork: nothing is sent.
///
///   ARC_TESTNET_RPC_URL=... arc-forge test --network arc \
///     --match-path "test/fork/*" --no-match-path "test/differential/*"
contract ArcSemanticsForkTest is KryonTest {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant ARC_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function _deployTokens() internal override {
        vm.createSelectFork(vm.envOr("ARC_TESTNET_RPC_URL", string("https://rpc.testnet.arc.io")));
        require(block.chainid == 5_042_002, "not Arc testnet");
        usdc = MockUSDC(ARC_USDC); // typed handle only: fund() never mints
        permit2 = MockPermit2(ARC_PERMIT2);
        vm.warp(block.timestamp); // keep the fork's clock; setUp's warp moves it forward
    }

    /// USDC is the native gas token: `deal` sets the 18-decimal native balance,
    /// which the 6-decimal ERC-20 interface reads as the same money.
    function fund(address user, uint256 amount6) internal override {
        vm.deal(user, user.balance + amount6 * 1e12);
        vm.startPrank(user);
        IERC20(ARC_USDC).approve(address(vault), amount6);
        vault.deposit(amount6);
        vm.stopPrank();
    }

    function test_usdc_dual_interface_shares_one_balance() public {
        address a = makeAddr("dual");
        vm.deal(a, 3_500_000_000_000_000_001); // 3.500000000000000001 USDC native
        assertEq(IERC20(ARC_USDC).balanceOf(a), 3_500_000, "ERC-20 view truncates to 6 dp");
        assertEq(IERC20(ARC_USDC).decimals(), 6);

        vm.startPrank(a);
        IERC20(ARC_USDC).approve(address(vault), 3_500_000);
        vault.deposit(3_500_000);
        vm.stopPrank();
        assertEq(bal(a), 35 * P / 10, "credited at the ERC-20 amount, exactly");
        assertEq(address(vault).balance, 3_500_000 * 1e12, "vault holds native units 1:1e12");
        assertEq(a.balance, 1, "sub-6dp native dust stays with the sender");
        assertSolvencyExact();

        vm.prank(a);
        vault.withdraw(3_500_000);
        assertEq(a.balance, 3_500_000_000_000_000_001);
        assertSolvencyExact();
    }

    function test_native_value_is_rejected_and_zero_address_transfers_revert() public {
        address a = makeAddr("native");
        vm.deal(a, 10e18);
        vm.prank(a);
        (bool ok,) = address(vault).call{value: 1e18}("");
        assertFalse(ok, "vault refuses native USDC");
        vm.prank(a);
        (ok,) = address(0).call{value: 1}("");
        assertFalse(ok, "Arc: value transfers to 0x0 revert");
        vm.prank(a);
        vm.expectRevert();
        IERC20(ARC_USDC).transfer(address(0), 1);
    }

    function test_real_usdc_permit_deposit() public {
        (address owner, uint256 key) = makeAddrAndKey("permitter");
        vm.deal(owner, 25e18);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDCPermit(ARC_USDC).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                        ),
                        owner,
                        address(vault),
                        25e6,
                        IUSDCPermit(ARC_USDC).nonces(owner),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(owner);
        vault.depositWithPermit(25e6, deadline, v, r, s);
        assertEq(bal(owner), 25 * P);
        assertEq(IERC20(ARC_USDC).allowance(owner, address(vault)), 0, "permit fully consumed");
    }

    function test_real_permit2_deposit() public {
        (address owner, uint256 key) = makeAddrAndKey("p2");
        vm.deal(owner, 12e18);
        vm.prank(owner);
        IERC20(ARC_USDC).approve(ARC_PERMIT2, type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: ARC_USDC, amount: 12e6}),
            nonce: 1,
            deadline: block.timestamp + 600
        });
        bytes32 tokenPerms = keccak256(
            abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), ARC_USDC, 12e6)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                ),
                tokenPerms,
                address(vault),
                uint256(1),
                permit.deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IPermit2Domain(ARC_PERMIT2).DOMAIN_SEPARATOR(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(owner);
        vault.depositWithPermit2(permit, abi.encodePacked(r, s, v));
        assertEq(bal(owner), 12 * P);
    }

    /// Several updates can share one Arc timestamp; nothing may revert on dt == 0.
    function test_equal_timestamps_do_not_break_funding_or_oracle() public {
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, P, 101 * P);
        vm.warp(block.timestamp + 600);
        push(BTC_ID, 100 * P);
        vm.startPrank(keeper);
        FundingState memory a = engine.updateFunding(BTC);
        FundingState memory b = engine.updateFunding(BTC); // same block, same second
        vm.stopPrank();
        assertEq(a.longIndex, b.longIndex);
        // Two fills in the same second keep the TWAP well-defined.
        trade(alice, bob, BTC, true, P, 100 * P);
        trade(alice, bob, BTC, false, P, 100 * P);
        assertSolvencyExact();
    }

    function test_base_fee_is_at_least_the_20_gwei_floor() public view {
        assertGe(block.basefee, 20 gwei);
    }

    /// Settlement moves no tokens, so a counterparty the USDC contract would
    /// refuse (blocklisted) can't block the batch. Withdrawal is where Arc's
    /// blocklist bites; see VaultTest for the revert path.
    function test_full_flow_with_real_usdc() public {
        fund(alice, 5000e6);
        fund(bob, 1100e6);
        trade(alice, bob, BTC, true, 100 * P, 100 * P);
        vm.warp(block.timestamp + 1);
        push(BTC_ID, 10 * P);
        vm.prank(liquidator);
        liquidation.liquidate(bob, BTC, type(uint256).max);
        assertEq(engine.positionCount(bob), 0);
        feeRouter.claimTreasury();
        assertGt(IERC20(ARC_USDC).balanceOf(treasury), 0);
        assertSolvencyExact();
        (int256 assets,) = vault.solvency();
        assertEq(assets, int256(IERC20(ARC_USDC).balanceOf(address(vault))) * 1e12);
    }

    function test_order_digest_binds_arc_chain_id() public {
        Order memory o = makeOrder(alice, BTC, true, P, 100 * P);
        bytes32 onTestnet = gateway.hashOrder(o);
        vm.chainId(5042);
        assertTrue(gateway.hashOrder(o) != onTestnet, "a testnet signature never replays on mainnet");
        vm.chainId(5_042_002);
    }
}
