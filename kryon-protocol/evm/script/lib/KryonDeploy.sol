// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {Engine} from "../../src/Engine.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Insurance} from "../../src/Insurance.sol";
import {Liquidation} from "../../src/Liquidation.sol";
import {OracleAdapter} from "../../src/OracleAdapter.sol";
import {OrderGateway} from "../../src/OrderGateway.sol";
import {RiskParams} from "../../src/RiskParams.sol";
import {Vault} from "../../src/Vault.sol";
import {KryonTimelock} from "../../src/governance/KryonTimelock.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {FundingConfig, MarketParams} from "../../src/libraries/Types.sol";

/// @notice One market as configured at deploy time.
struct MarketConfig {
    uint32 id;
    string symbol;
    MarketParams params;
    FundingConfig funding;
    uint256 oiPolicyBps;
    OracleAdapter.FeedConfig feed;
    OracleAdapter.ReferenceFeed ref;
}

/// @notice Everything the deploy scripts need, loaded from
///         infra/deploy/environments/<network>.toml (or built in tests).
struct DeployConfig {
    uint256 chainId;
    address usdc;
    address permit2;
    uint256 timelockDelay;
    address[] proposers;
    address[] executors;
    address guardian;
    address treasury;
    address[] operators;
    address[] publishers;
    address[] fundingKeepers;
    address[] feeTierBots;
    uint256 depositCap;
    uint256 accountDepositCap;
    bool openDepositsAtDeploy;
    uint16 maxRewardBps;
    uint16 partialLiquidationBps;
    int32 takerRate;
    int32 makerRate;
    int256 minNetRate;
    bool rebatesEnabled;
    bool referralsEnabled;
    uint16 splitTreasuryBps;
    uint16 splitInsuranceBps;
    uint16 splitReferralBps;
    uint16 liquidationInsuranceBps;
    uint256 maxTotalOiPolicyBps;
    MarketConfig[] markets;
}

struct Implementations {
    address vault;
    address engine;
    address gateway;
    address oracle;
    address liquidation;
    address insurance;
    address risk;
    address feeRouter;
}

struct Deployment {
    KryonTimelock timelock;
    Vault vault;
    Engine engine;
    OrderGateway gateway;
    OracleAdapter oracle;
    Liquidation liquidation;
    Insurance insurance;
    RiskParams risk;
    FeeRouter feeRouter;
}

/// @notice Deploy, wire, configure and hand over the protocol.
/// @dev Shared by the numbered scripts, DeployAll and the test suite, so the
///      tests exercise exactly the wiring that ships. Every step runs as
///      `deployer`, which holds admin roles only until `handover`.
library KryonDeploy {
    // ------------------------------------------------------------ 00 impls

    function deployImplementations() internal returns (Implementations memory i) {
        i.vault = address(new Vault());
        i.engine = address(new Engine());
        i.gateway = address(new OrderGateway());
        i.oracle = address(new OracleAdapter());
        i.liquidation = address(new Liquidation());
        i.insurance = address(new Insurance());
        i.risk = address(new RiskParams());
        i.feeRouter = address(new FeeRouter());
    }

    function deployTimelock(DeployConfig memory cfg) internal returns (KryonTimelock) {
        return new KryonTimelock(cfg.timelockDelay, cfg.proposers, cfg.executors, cfg.guardian);
    }

    // ---------------------------------------------------------- 01 proxies

    function deployProxies(
        Implementations memory i,
        DeployConfig memory cfg,
        address deployer,
        KryonTimelock timelock
    ) internal returns (Deployment memory d) {
        d.timelock = timelock;
        d.risk = RiskParams(_proxy(i.risk, abi.encodeCall(RiskParams.initialize, (deployer))));
        d.oracle =
            OracleAdapter(_proxy(i.oracle, abi.encodeCall(OracleAdapter.initialize, (deployer))));
        d.vault = Vault(
            _proxy(i.vault, abi.encodeCall(Vault.initialize, (deployer, cfg.usdc, cfg.permit2)))
        );
        d.engine = Engine(
            _proxy(
                i.engine,
                abi.encodeCall(
                    Engine.initialize,
                    (deployer, address(d.vault), address(d.oracle), address(d.risk))
                )
            )
        );
        d.insurance = Insurance(
            _proxy(
                i.insurance,
                abi.encodeCall(Insurance.initialize, (deployer, address(d.vault), cfg.usdc))
            )
        );
        d.feeRouter = FeeRouter(
            _proxy(
                i.feeRouter,
                abi.encodeCall(
                    FeeRouter.initialize,
                    (deployer, address(d.vault), cfg.treasury, address(d.insurance))
                )
            )
        );
        d.gateway = OrderGateway(
            _proxy(
                i.gateway,
                abi.encodeCall(
                    OrderGateway.initialize,
                    (deployer, address(d.engine), address(d.risk), address(d.feeRouter))
                )
            )
        );
        d.liquidation = Liquidation(
            _proxy(
                i.liquidation,
                abi.encodeCall(
                    Liquidation.initialize,
                    (
                        deployer,
                        address(d.engine),
                        address(d.vault),
                        address(d.risk),
                        address(d.feeRouter),
                        address(d.insurance),
                        cfg.maxRewardBps,
                        cfg.partialLiquidationBps
                    )
                )
            )
        );
    }

    function _proxy(address impl, bytes memory init) private returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }

    // -------------------------------------------------------------- 02 wire

    function wire(Deployment memory d, DeployConfig memory cfg, address deployer) internal {
        // Contract-to-contract wiring.
        d.vault.setEngine(address(d.engine));
        d.vault.setInsurance(address(d.insurance));
        d.engine.setGateway(address(d.gateway));
        d.engine.setLiquidation(address(d.liquidation));
        d.engine.setInsurance(address(d.insurance));
        d.insurance.setEngine(address(d.engine));
        d.insurance.setLiquidation(address(d.liquidation));
        d.insurance.setGateway(address(d.gateway));
        d.gateway.setBackstop(address(d.insurance));

        d.vault.grantRole(Roles.LEDGER_ROLE, address(d.engine));
        d.vault.grantRole(Roles.LEDGER_ROLE, address(d.feeRouter));
        d.vault.grantRole(Roles.LEDGER_ROLE, address(d.liquidation));
        d.vault.grantRole(Roles.LEDGER_ROLE, address(d.insurance));
        d.vault.setCapExempt(address(d.insurance), true);
        d.vault.setCapExempt(address(d.feeRouter), true);

        d.feeRouter.grantRole(Roles.FEE_SOURCE_ROLE, address(d.gateway));
        d.feeRouter.grantRole(Roles.FEE_SOURCE_ROLE, address(d.liquidation));

        // Service keys.
        for (uint256 k = 0; k < cfg.operators.length; ++k) {
            d.gateway.grantRole(Roles.OPERATOR_ROLE, cfg.operators[k]);
        }
        for (uint256 k = 0; k < cfg.fundingKeepers.length; ++k) {
            d.engine.grantRole(Roles.KEEPER_ROLE, cfg.fundingKeepers[k]);
        }
        for (uint256 k = 0; k < cfg.feeTierBots.length; ++k) {
            d.feeRouter.grantRole(Roles.FEE_TIER_ROLE, cfg.feeTierBots[k]);
        }

        // Guardian: pause only.
        address[8] memory targets = _all(d);
        for (uint256 k = 0; k < targets.length; ++k) {
            (bool ok,) = targets[k].call(
                abi.encodeWithSignature("grantRole(bytes32,address)", Roles.PAUSER_ROLE, cfg.guardian)
            );
            require(ok, "grant pauser");
        }

        // The deployer configures markets and fees before handover.
        d.risk.grantRole(Roles.RISK_ADMIN_ROLE, deployer);
        d.oracle.grantRole(Roles.RISK_ADMIN_ROLE, deployer);
        d.vault.grantRole(Roles.RISK_ADMIN_ROLE, deployer);
        d.liquidation.grantRole(Roles.RISK_ADMIN_ROLE, deployer);
        d.feeRouter.grantRole(Roles.FEE_ADMIN_ROLE, deployer);

        if (cfg.publishers.length > 0) d.oracle.setPublishers(cfg.publishers);
    }

    // ---------------------------------------------------- 03 configure markets

    function configureMarkets(Deployment memory d, DeployConfig memory cfg) internal {
        for (uint256 k = 0; k < cfg.markets.length; ++k) {
            MarketConfig memory m = cfg.markets[k];
            d.oracle.setFeed(m.params.oracleId, m.feed);
            if (m.ref.enabled) d.oracle.setReferenceFeed(m.params.oracleId, m.ref);
            d.risk.setMarket(m.id, m.params);
            d.risk.setFundingConfig(m.id, m.funding);
        }
        if (cfg.maxTotalOiPolicyBps != 0) d.risk.setMaxTotalOiPolicyBps(cfg.maxTotalOiPolicyBps);
        for (uint256 k = 0; k < cfg.markets.length; ++k) {
            if (cfg.markets[k].oiPolicyBps != 0) {
                d.risk.setOiPolicy(cfg.markets[k].id, cfg.markets[k].oiPolicyBps);
            }
        }
        if (cfg.openDepositsAtDeploy) {
            d.vault.setDepositCaps(cfg.depositCap, cfg.accountDepositCap);
        }
    }

    // ------------------------------------------------------- 04 configure fees

    function configureFees(Deployment memory d, DeployConfig memory cfg) internal {
        FeeRouter f = d.feeRouter;
        if (cfg.rebatesEnabled) f.setRebatesEnabled(true);
        if (cfg.referralsEnabled) f.setReferralsEnabled(true);
        f.setMinNetRate(cfg.minNetRate);
        f.setSplit(cfg.splitTreasuryBps, cfg.splitInsuranceBps, cfg.splitReferralBps);
        f.setLiquidationSplit(cfg.liquidationInsuranceBps);
        for (uint256 k = 0; k < cfg.markets.length; ++k) {
            f.setMarketFees(cfg.markets[k].id, cfg.makerRate, cfg.takerRate);
        }
    }

    // ------------------------------------------------------------ 05 handover

    /// @notice Give every admin role to the timelock and renounce the
    ///         deployer's, in the same run that configured everything.
    function handover(Deployment memory d, address deployer) internal {
        address tl = address(d.timelock);
        address[8] memory targets = _all(d);
        bytes32[4] memory adminRoles = [
            Roles.DEFAULT_ADMIN_ROLE,
            Roles.UPGRADER_ROLE,
            Roles.RISK_ADMIN_ROLE,
            Roles.FEE_ADMIN_ROLE
        ];
        for (uint256 k = 0; k < targets.length; ++k) {
            // Grant everything first, renounce DEFAULT_ADMIN last.
            for (uint256 r = 0; r < adminRoles.length; ++r) {
                _call(targets[k], abi.encodeWithSignature("grantRole(bytes32,address)", adminRoles[r], tl));
            }
            for (uint256 r = adminRoles.length; r > 0; --r) {
                _call(
                    targets[k],
                    abi.encodeWithSignature(
                        "renounceRole(bytes32,address)", adminRoles[r - 1], deployer
                    )
                );
            }
        }
    }

    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function proxies(Deployment memory d) internal pure returns (address[8] memory) {
        return _all(d);
    }

    function _all(Deployment memory d) private pure returns (address[8] memory) {
        return [
            address(d.vault),
            address(d.engine),
            address(d.gateway),
            address(d.oracle),
            address(d.liquidation),
            address(d.insurance),
            address(d.risk),
            address(d.feeRouter)
        ];
    }

    /// @notice The whole sequence, as `DeployAll` runs it.
    function deployAll(DeployConfig memory cfg, address deployer)
        internal
        returns (Deployment memory d, Implementations memory impls)
    {
        impls = deployImplementations();
        KryonTimelock timelock = deployTimelock(cfg);
        d = deployProxies(impls, cfg, deployer, timelock);
        wire(d, cfg, deployer);
        configureMarkets(d, cfg);
        configureFees(d, cfg);
        handover(d, deployer);
    }
}
