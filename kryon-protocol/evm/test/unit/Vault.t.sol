// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {Vault} from "../../src/Vault.sol";
import {Roles} from "../../src/governance/Roles.sol";
import {ISignatureTransfer} from "../../src/interfaces/IKryon.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {KryonTest} from "../utils/KryonTest.sol";

contract VaultTest is KryonTest {
    function test_deposit_increases_internal_balance_after_token_transfer() public {
        fund(alice, 100e6);
        assertEq(bal(alice), 100 * P);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(vault.totalLedger(), 100 * P);
        assertSolvencyExact();
    }

    function test_withdraw_round_trip_is_exact() public {
        fund(alice, 123_456_789);
        vm.prank(alice);
        vault.withdraw(123_456_789);
        assertEq(bal(alice), 0);
        assertEq(usdc.balanceOf(alice), 123_456_789);
        assertSolvencyExact();
    }

    function test_withdraw_rejects_unrealized_loss_even_with_token_balance() public {
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, 10 * P, 100 * P); // bob long 10 @ 100
        push(BTC_ID, 10 * P);
        // Bob's balance is ~1000 but his unrealized loss is 900: he can't take 100 out.
        vm.prank(bob);
        vm.expectRevert(Errors.InsufficientCollateral.selector);
        vault.withdraw(100e6);
    }

    function test_withdraw_more_than_balance_reverts() public {
        fund(alice, 10e6);
        vm.prank(alice);
        vm.expectRevert(Errors.InsufficientCollateral.selector);
        vault.withdraw(10e6 + 1);
    }

    function test_withdraw_keeps_initial_margin() public {
        fund(alice, 1000e6);
        fund(bob, 1000e6);
        trade(alice, bob, BTC, true, 50 * P, 100 * P); // notional 5000, IM 500
        (, int256 tf) = fees(50 * P, 100 * P);
        int256 free = bal(bob) - 500 * P;
        assertEq(free, 500 * P - tf);
        vm.startPrank(bob);
        vm.expectRevert(Errors.InsufficientCollateral.selector);
        vault.withdraw(uint256(free / 1e12) + 1);
        vault.withdraw(uint256(free / 1e12));
        vm.stopPrank();
    }

    // --- pause (H4) ---

    function test_paused_vault_rejects_deposit_and_withdraw() public {
        fund(alice, 100e6);
        vm.prank(guardian);
        vault.pause();
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.deposit(1e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.withdraw(1e6);
        vm.stopPrank();
    }

    function test_guardian_can_pause_but_not_unpause_and_stranger_cannot_pause() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.PAUSER_ROLE
            )
        );
        vault.pause();

        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                guardian,
                Roles.DEFAULT_ADMIN_ROLE
            )
        );
        vault.unpause();

        asGov();
        vault.unpause();
        assertFalse(vault.paused());
        fund(alice, 1e6);
    }

    // --- staged-launch caps ---

    function test_deposit_cap_blocks_over_cap_and_withdraw_frees_headroom() public {
        asGov();
        vault.setDepositCaps(100e6, 90e6);
        fund(alice, 80e6);
        assertEq(vault.totalDeposited(), 80e6);

        usdc.mint(alice, 30e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.expectRevert(Errors.DepositCapExceeded.selector);
        vault.deposit(30e6); // global cap 100
        vm.expectRevert(Errors.DepositCapExceeded.selector);
        vault.deposit(11e6); // per-account cap 90
        vault.deposit(10e6);
        vault.withdraw(50e6);
        assertEq(vault.totalDeposited(), 40e6);
        vault.deposit(20e6);
        vm.stopPrank();
    }

    function test_zero_cap_means_deposits_closed() public {
        asGov();
        vault.setDepositCaps(0, 0);
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert(Errors.DepositCapExceeded.selector);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    function test_cap_exempt_accounts_bypass_caps() public {
        asGov();
        vault.setDepositCaps(0, 0);
        assertTrue(vault.isCapExempt(address(insurance)));
        usdc.mint(address(this), 5e6);
        usdc.approve(address(insurance), 5e6);
        insurance.donate(5e6);
        assertEq(bal(address(insurance)), 5 * P);
    }

    // --- collateral registry ---

    function test_set_collateral_only_accepts_usdc() public {
        asGov();
        vm.expectRevert(abi.encodeWithSelector(Errors.CollateralNotSupported.selector, address(0xE0C)));
        vault.setCollateral(address(0xE0C), true);

        asGov();
        vault.setCollateral(address(usdc), false);
        usdc.mint(alice, 1e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1e6);
        vm.expectRevert(Errors.AssetDisabled.selector);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    // --- ledger access control ---

    function test_only_engine_applies_pnl_and_only_ledger_role_transfers() public {
        vm.expectRevert(Errors.Unauthorized.selector);
        vault.applyPnl(alice, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Roles.LEDGER_ROLE
            )
        );
        vault.transferInternal(alice, bob, 1, "X");
    }

    function test_internal_transfer_is_zero_sum_and_rejects_negative() public {
        fund(alice, 10e6);
        vm.prank(address(engine));
        vault.transferInternal(alice, bob, 3 * P, "TEST");
        assertEq(bal(alice), 7 * P);
        assertEq(bal(bob), 3 * P);
        assertEq(vault.totalLedger(), 10 * P);
        vm.prank(address(engine));
        vm.expectRevert(Errors.InvalidAmount.selector);
        vault.transferInternal(alice, bob, -1, "TEST");
    }

    // --- Arc: native value is rejected, USDC custody is ERC-20 only ---

    function test_native_value_is_rejected() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
        vm.prank(alice);
        (ok,) = address(vault).call{value: 1}(abi.encodeWithSignature("deposit(uint256)", 1));
        assertFalse(ok);
        (ok,) = address(vault).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok);
    }

    // --- permit flows ---

    function test_deposit_with_eip2612_permit() public {
        usdc.mint(alice, 50e6);
        uint256 deadline = _now() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                        ),
                        alice,
                        address(vault),
                        50e6,
                        usdc.nonces(alice),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        vm.prank(alice);
        vault.depositWithPermit(50e6, deadline, v, r, s);
        assertEq(bal(alice), 50 * P);
    }

    function test_front_run_permit_still_deposits() public {
        usdc.mint(alice, 5e6);
        vm.prank(alice);
        usdc.approve(address(vault), 5e6);
        // Garbage permit: the call is swallowed and the existing allowance is used.
        vm.prank(alice);
        vault.depositWithPermit(5e6, _now(), 27, bytes32(0), bytes32(0));
        assertEq(bal(alice), 5 * P);
    }

    function test_deposit_with_permit2() public {
        usdc.mint(alice, 7e6);
        vm.prank(alice);
        usdc.approve(address(permit2), type(uint256).max);
        ISignatureTransfer.PermitTransferFrom memory p = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(usdc), amount: 7e6}),
            nonce: 9,
            deadline: _now() + 60
        });
        vm.prank(alice);
        vault.depositWithPermit2(p, abi.encode(alice, uint256(9)));
        assertEq(bal(alice), 7 * P);

        p.permitted.token = address(0xBEEF);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Errors.CollateralNotSupported.selector, address(0xBEEF)));
        vault.depositWithPermit2(p, "");
    }

    // --- Arc: blocklisted accounts ---

    function test_blocklisted_account_cannot_withdraw_but_ledger_is_unaffected() public {
        fund(alice, 10e6);
        usdc.setBlocked(alice, true);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(1e6);
        assertEq(bal(alice), 10 * P);
        assertSolvencyExact();
    }

    function test_deposit_for_credits_beneficiary() public {
        usdc.mint(address(this), 3e6);
        usdc.approve(address(vault), 3e6);
        vault.depositFor(carol, 3e6);
        assertEq(bal(carol), 3 * P);
        vm.expectRevert(Errors.InvalidAmount.selector);
        vault.depositFor(carol, 0);
        vm.expectRevert(Errors.ZeroAddress.selector);
        vault.depositFor(address(0), 1);
    }

    function test_withdrawable_balance_rounds_down() public {
        fund(alice, 1e6);
        vm.prank(address(engine));
        vault.transferInternal(alice, bob, 1, "DUST");
        assertEq(vault.withdrawableBalance(alice), 1e6 - 1);
        assertEq(vault.withdrawableBalance(bob), 0);
    }
}
