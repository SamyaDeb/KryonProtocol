// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControlEnumerable} from
    "@openzeppelin/contracts/access/extensions/IAccessControlEnumerable.sol";

import {FeeRouter} from "../../src/FeeRouter.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {KryonUpgradeable} from "../../src/governance/KryonUpgradeable.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {FundingConfig, MarketParams} from "../../src/libraries/Types.sol";
import {DeployConfig, Deployment, KryonDeploy, MarketConfig} from "./KryonDeploy.sol";

/// @notice Checks a live deployment against its environment config.
/// @dev Returns every failure rather than stopping at the first, so one run of
///      99_VerifyDeployment (or mainnet-preflight) reports the whole picture.
///      No cheatcodes: the same code runs in tests and in scripts.
library DeploymentVerifier {
    struct Report {
        string[] failures;
        uint256 count;
    }

    function verify(Deployment memory d, DeployConfig memory cfg, address deployer)
        internal
        view
        returns (string[] memory)
    {
        Report memory r = Report(new string[](256), 0);
        _roles(r, d, cfg, deployer);
        _timelock(r, d, cfg, deployer);
        _wiring(r, d, cfg);
        _fees(r, d, cfg);
        _markets(r, d, cfg);
        string[] memory out = new string[](r.count);
        for (uint256 i = 0; i < r.count; ++i) out[i] = r.failures[i];
        return out;
    }

    function _fail(Report memory r, string memory what) private pure {
        if (r.count < r.failures.length) r.failures[r.count++] = what;
    }

    function _check(Report memory r, bool ok, string memory what) private pure {
        if (!ok) _fail(r, what);
    }

    // ------------------------------------------------------------------ roles

    function _roles(Report memory r, Deployment memory d, DeployConfig memory cfg, address deployer)
        private
        view
    {
        address[8] memory all = KryonDeploy.proxies(d);
        string[8] memory names =
            ["Vault", "Engine", "OrderGateway", "OracleAdapter", "Liquidation", "Insurance", "RiskParams", "FeeRouter"];
        for (uint256 i = 0; i < all.length; ++i) {
            _adminRoles(r, IAccessControlEnumerable(all[i]), names[i], address(d.timelock));
            _pauser(r, all[i], names[i], cfg.guardian, deployer, d.timelock.getMinDelay());
        }

        _exactMembers(r, IAccessControlEnumerable(address(d.gateway)), Roles.OPERATOR_ROLE, cfg.operators, "OPERATOR_ROLE");
        _exactMembers(r, IAccessControlEnumerable(address(d.engine)), Roles.KEEPER_ROLE, cfg.fundingKeepers, "KEEPER_ROLE");
        _exactMembers(r, IAccessControlEnumerable(address(d.feeRouter)), Roles.FEE_TIER_ROLE, cfg.feeTierBots, "FEE_TIER_ROLE");
        _exactMembers(r, IAccessControlEnumerable(address(d.oracle)), Roles.PUBLISHER_ROLE, cfg.publishers, "PUBLISHER_ROLE");

        address[] memory ledger = new address[](4);
        (ledger[0], ledger[1], ledger[2], ledger[3]) =
            (address(d.engine), address(d.feeRouter), address(d.liquidation), address(d.insurance));
        _exactMembers(r, IAccessControlEnumerable(address(d.vault)), Roles.LEDGER_ROLE, ledger, "LEDGER_ROLE");
        address[] memory sources = new address[](2);
        (sources[0], sources[1]) = (address(d.gateway), address(d.liquidation));
        _exactMembers(r, IAccessControlEnumerable(address(d.feeRouter)), Roles.FEE_SOURCE_ROLE, sources, "FEE_SOURCE_ROLE");
    }

    function _adminRoles(Report memory r, IAccessControlEnumerable c, string memory name, address timelock)
        private
        view
    {
        bytes32[4] memory roles =
            [Roles.DEFAULT_ADMIN_ROLE, Roles.UPGRADER_ROLE, Roles.RISK_ADMIN_ROLE, Roles.FEE_ADMIN_ROLE];
        string[4] memory roleNames = ["DEFAULT_ADMIN_ROLE", "UPGRADER_ROLE", "RISK_ADMIN_ROLE", "FEE_ADMIN_ROLE"];
        for (uint256 k = 0; k < roles.length; ++k) {
            uint256 n = c.getRoleMemberCount(roles[k]);
            for (uint256 m = 0; m < n; ++m) {
                address holder = c.getRoleMember(roles[k], m);
                if (holder.code.length == 0) {
                    _fail(r, string.concat(name, ": an EOA holds ", roleNames[k]));
                } else if (holder != timelock) {
                    _fail(r, string.concat(name, ": a non-timelock contract holds ", roleNames[k]));
                }
            }
            _check(r, n == 1 && c.hasRole(roles[k], timelock),
                string.concat(name, ": timelock must be the sole ", roleNames[k]));
        }
    }

    function _pauser(
        Report memory r,
        address target,
        string memory name,
        address guardian,
        address deployer,
        uint256 timelockDelay
    ) private view {
        IAccessControlEnumerable c = IAccessControlEnumerable(target);
        _check(r, !c.hasRole(Roles.PAUSER_ROLE, deployer), string.concat(name, ": deployer is a pauser"));
        _check(
            r,
            c.getRoleMemberCount(Roles.PAUSER_ROLE) == 1 && c.hasRole(Roles.PAUSER_ROLE, guardian),
            string.concat(name, ": guardian must be the sole PAUSER_ROLE")
        );
        KryonUpgradeable k = KryonUpgradeable(target);
        (, bool indefinite, uint64 cooldownEndsAt) = k.pauseState();
        if (k.paused()) {
            _fail(r, string.concat(name, indefinite ? ": paused indefinitely" : ": guardian pause active"));
        } else if (block.timestamp < cooldownEndsAt) {
            _fail(r, string.concat(name, ": guardian pause cooldown active"));
        }
        // Governance must be able to schedule a longer pause before a guardian pause lapses.
        _check(r, k.GUARDIAN_PAUSE_DURATION() > timelockDelay, string.concat(name, ": guardian pause shorter than the timelock delay"));
    }

    function _exactMembers(
        Report memory r,
        IAccessControlEnumerable c,
        bytes32 role,
        address[] memory expected,
        string memory name
    ) private view {
        if (c.getRoleMemberCount(role) != expected.length) {
            _fail(r, string.concat(name, ": holder count differs from config"));
            return;
        }
        for (uint256 i = 0; i < expected.length; ++i) {
            _check(r, c.hasRole(role, expected[i]), string.concat(name, ": expected holder missing"));
        }
    }

    // --------------------------------------------------------------- timelock

    function _timelock(Report memory r, Deployment memory d, DeployConfig memory cfg, address deployer)
        private
        view
    {
        _check(r, d.timelock.getMinDelay() >= 48 hours, "Timelock: delay below 48h");
        _check(r, d.timelock.getMinDelay() == cfg.timelockDelay, "Timelock: delay differs from config");
        for (uint256 i = 0; i < cfg.proposers.length; ++i) {
            _check(r, d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), cfg.proposers[i]), "Timelock: proposer missing");
        }
        for (uint256 i = 0; i < cfg.executors.length; ++i) {
            _check(r, d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), cfg.executors[i]), "Timelock: executor missing");
        }
        _check(r, d.timelock.hasRole(Roles.PAUSER_ROLE, cfg.guardian), "Timelock: guardian cannot veto");
        _check(r, !d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), deployer), "Timelock: deployer is admin");
        _check(r, !d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), deployer), "Timelock: deployer is proposer");
        if (d.timelock.executionPaused()) {
            _fail(r, "Timelock: execution is vetoed");
        } else if (block.timestamp < d.timelock.vetoCooldownEndsAt()) {
            _fail(r, "Timelock: guardian veto cooldown active");
        }
        // Operations scheduled during a veto must fit inside the cooldown that follows it.
        _check(r, d.timelock.VETO_COOLDOWN() > d.timelock.getMinDelay(), "Timelock: veto cooldown not longer than the delay");
    }

    // ----------------------------------------------------------------- wiring

    function _wiring(Report memory r, Deployment memory d, DeployConfig memory cfg) private view {
        _check(r, d.vault.engine() == address(d.engine), "Vault: engine");
        _check(r, d.vault.insurance() == address(d.insurance), "Vault: insurance");
        _check(r, d.vault.usdc() == cfg.usdc, "Vault: usdc");
        _check(r, d.vault.permit2() == cfg.permit2, "Vault: permit2");
        _check(r, d.vault.isCapExempt(address(d.insurance)), "Vault: insurance not cap-exempt");
        _check(r, d.vault.isCapExempt(address(d.feeRouter)), "Vault: fee router not cap-exempt");
        (uint256 total, uint256 perAccount) = d.vault.depositCaps();
        if (cfg.openDepositsAtDeploy) {
            _check(r, total == cfg.depositCap && perAccount == cfg.accountDepositCap, "Vault: caps differ from config");
        } else {
            _check(r, total == 0 && perAccount == 0, "Vault: deposits must stay closed until verification");
        }

        (address v, address o, address rk, address ins, address gw, address liq) = d.engine.wiring();
        _check(r, v == address(d.vault) && o == address(d.oracle) && rk == address(d.risk), "Engine: core wiring");
        _check(r, ins == address(d.insurance) && gw == address(d.gateway) && liq == address(d.liquidation), "Engine: peers");

        _check(r, d.gateway.backstop() == address(d.insurance), "OrderGateway: backstop");
        _check(r, d.insurance.gateway() == address(d.gateway), "Insurance: gateway");
        (address ge, address gr, address gf) = d.gateway.wiring();
        _check(r, ge == address(d.engine) && gr == address(d.risk) && gf == address(d.feeRouter), "OrderGateway: wiring");

        (address le, address lv, address lr, address lf, address li) = d.liquidation.wiring();
        _check(
            r,
            le == address(d.engine) && lv == address(d.vault) && lr == address(d.risk) && lf == address(d.feeRouter)
                && li == address(d.insurance),
            "Liquidation: wiring"
        );
        (uint16 reward, uint16 partialBps) = d.liquidation.params();
        _check(r, reward == cfg.maxRewardBps && partialBps == cfg.partialLiquidationBps, "Liquidation: params");

        (address treasury, address insurance) = d.feeRouter.recipients();
        _check(r, treasury == cfg.treasury && insurance == address(d.insurance), "FeeRouter: recipients");
        _check(r, d.feeRouter.vault() == address(d.vault), "FeeRouter: vault");

        address[] memory pubs = d.oracle.publishers();
        _check(r, pubs.length == cfg.publishers.length, "OracleAdapter: publisher set differs");
    }

    // ------------------------------------------------------------------- fees

    function _fees(Report memory r, Deployment memory d, DeployConfig memory cfg) private view {
        FeeRouter f = d.feeRouter;
        _check(r, f.minNetRate() == cfg.minNetRate, "FeeRouter: min net rate");
        _check(r, f.rebatesEnabled() == cfg.rebatesEnabled, "FeeRouter: rebates flag");
        _check(r, f.referralsEnabled() == cfg.referralsEnabled, "FeeRouter: referrals flag");
        FeeRouter.Split memory s = f.split();
        _check(
            r,
            s.treasuryBps == cfg.splitTreasuryBps && s.insuranceBps == cfg.splitInsuranceBps
                && s.referralBps == cfg.splitReferralBps,
            "FeeRouter: split differs from config"
        );
        _check(r, f.liquidationInsuranceBps() == cfg.liquidationInsuranceBps, "FeeRouter: liquidation split");
        for (uint256 i = 0; i < cfg.markets.length; ++i) {
            FeeRouter.Rates memory rates = f.marketRates(cfg.markets[i].id);
            _check(
                r,
                rates.set && rates.makerRate == cfg.makerRate && rates.takerRate == cfg.takerRate,
                string.concat("FeeRouter: schedule differs for ", cfg.markets[i].symbol)
            );
        }
    }

    // ---------------------------------------------------------------- markets

    function _markets(Report memory r, Deployment memory d, DeployConfig memory cfg) private view {
        _check(r, d.risk.marketIds().length == cfg.markets.length, "RiskParams: market count differs");
        _check(r, d.risk.maxTotalOiPolicyBps() == cfg.maxTotalOiPolicyBps, "RiskParams: OI ceiling");
        for (uint256 i = 0; i < cfg.markets.length; ++i) {
            MarketConfig memory want = cfg.markets[i];
            string memory sym = want.symbol;
            if (!d.risk.isListed(want.id)) {
                _fail(r, string.concat("RiskParams: not listed: ", sym));
                continue;
            }
            MarketParams memory got = d.risk.market(want.id);
            _check(r, keccak256(abi.encode(got)) == keccak256(abi.encode(want.params)), string.concat("RiskParams: params differ for ", sym));
            FundingConfig memory fc = d.risk.fundingConfig(want.id);
            _check(
                r,
                fc.premiumCoeff == want.funding.premiumCoeff && fc.maxRatePerHour == want.funding.maxRatePerHour,
                string.concat("RiskParams: funding differs for ", sym)
            );
            _check(r, d.risk.oiPolicyBps(want.id) == want.oiPolicyBps, string.concat("RiskParams: OI policy for ", sym));

            OracleAdapter.FeedConfig memory feed = d.oracle.feed(want.params.oracleId);
            _check(r, keccak256(abi.encode(feed)) == keccak256(abi.encode(want.feed)), string.concat("OracleAdapter: feed differs for ", sym));
            OracleAdapter.ReferenceFeed memory ref = d.oracle.referenceFeed(want.params.oracleId);
            _check(r, keccak256(abi.encode(ref)) == keccak256(abi.encode(want.ref)), string.concat("OracleAdapter: reference differs for ", sym));
        }
    }
}
