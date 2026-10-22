// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DotGasGate} from "../src/DotGasGate.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";

/// @dev Receiver that tries to re-enter the gate when it gets ETH.
contract Reenterer {
    DotGasGate public gate;
    bytes32 public target;
    bool public attempted;
    bool public reentered;

    constructor(DotGasGate gate_) {
        gate = gate_;
    }

    function openOrder(uint8 tier) external payable returns (bytes32 id) {
        id = gate.open{value: msg.value}(address(0xBEEF), tier);
        target = id;
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try gate.refund(target) {
                reentered = true;
            } catch {}
        }
    }
}

contract RejectEth {
    receive() external payable {
        revert("no");
    }
}

contract DotGasGateTest is Test {
    DotGasGate gate;
    MockERC20 usdc;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address portaldotRecipient = address(0xA11CE);

    uint64 constant TTL = 30 minutes;
    uint256 constant PRICE_WEI = 0.001 ether;
    uint256 constant PRICE_USDC = 2_000_000; // 2 USDC
    uint256 constant DST = 5 ether; // 5 tPOT

    bytes32 constant FILL_REF = keccak256("portaldot-tx");

    event Opened(
        bytes32 indexed orderId,
        address indexed user,
        address indexed recipient,
        uint8 tier,
        address token,
        uint256 amount,
        uint256 dstAmount,
        uint64 deadline
    );
    event Reserved(bytes32 indexed orderId, address indexed relayer, uint64 reservedAt);
    event Released(bytes32 indexed orderId, address indexed relayer);
    event Claimed(bytes32 indexed orderId, address indexed relayer, bytes32 fillTxRef, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed user, uint256 amount);

    function setUp() public {
        usdc = new MockERC20();
        gate = new DotGasGate(owner, relayer, treasury, address(usdc), TTL);
        vm.startPrank(owner);
        gate.setTier(1, PRICE_WEI, PRICE_USDC, DST, true);
        gate.setTier(2, 0.002 ether, 4_000_000, 10 ether, true);
        gate.setTier(3, 0, PRICE_USDC, DST, true); // token-only tier
        vm.stopPrank();
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        usdc.mint(alice, 100_000_000);
    }

    function _openEth() internal returns (bytes32) {
        vm.prank(alice);
        return gate.open{value: PRICE_WEI}(portaldotRecipient, 1);
    }

    function _reserve(bytes32 id) internal {
        vm.prank(relayer);
        gate.reserve(id);
    }

    function _openUsdc() internal returns (bytes32) {
        vm.startPrank(alice);
        usdc.approve(address(gate), PRICE_USDC);
        bytes32 id = gate.openUSDC(portaldotRecipient, 1);
        vm.stopPrank();
        return id;
    }

    // ------------------------------------------------------------ constructor / config

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(DotGasGate.ZeroAddress.selector);
        new DotGasGate(owner, address(0), treasury, address(usdc), TTL);
        vm.expectRevert(DotGasGate.ZeroAddress.selector);
        new DotGasGate(owner, relayer, address(0), address(usdc), TTL);
    }

    function test_constructor_rejectsBadTtl() public {
        vm.expectRevert(DotGasGate.BadTtl.selector);
        new DotGasGate(owner, relayer, treasury, address(usdc), 1 minutes);
        vm.expectRevert(DotGasGate.BadTtl.selector);
        new DotGasGate(owner, relayer, treasury, address(usdc), 8 days);
    }

    // ------------------------------------------------------------ happy path (ETH)

    function test_open_eth_storesOrderAndEmits() public {
        bytes32 expectedId = gate.previewOrderId(0);
        vm.expectEmit(address(gate));
        emit Opened(
            expectedId,
            alice,
            portaldotRecipient,
            1,
            address(0),
            PRICE_WEI,
            DST,
            uint64(block.timestamp) + TTL
        );
        bytes32 id = _openEth();
        assertEq(id, expectedId);
        assertEq(gate.nonce(), 1);

        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(o.user, alice);
        assertEq(o.recipient, portaldotRecipient);
        assertEq(o.token, address(0));
        assertEq(o.tier, 1);
        assertEq(uint8(o.status), uint8(DotGasGate.Status.Open));
        assertEq(o.deadline, block.timestamp + TTL);
        assertEq(o.amount, PRICE_WEI);
        assertEq(o.dstAmount, DST);
        assertEq(address(gate).balance, PRICE_WEI);
    }

    function test_claim_eth_paysTreasury() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.expectEmit(address(gate));
        emit Claimed(id, relayer, FILL_REF, PRICE_WEI);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        assertEq(treasury.balance, PRICE_WEI);
        assertEq(address(gate).balance, 0);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Filled));
        assertEq(gate.fillTxRefOf(id), FILL_REF);
    }

    // ------------------------------------------------------------ reservation

    function test_reserve_happyPath() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + 10 minutes);
        vm.expectEmit(address(gate));
        emit Reserved(id, relayer, uint64(block.timestamp));
        _reserve(id);
        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(uint8(o.status), uint8(DotGasGate.Status.Reserved));
        assertEq(o.reservedAt, block.timestamp);
        assertEq(address(gate).balance, PRICE_WEI); // escrow untouched
    }

    function test_reserve_defaults() public view {
        assertEq(gate.reserveSafety(), 2 minutes);
        assertEq(gate.reserveTimeout(), 24 hours);
    }

    function test_reserve_atSafetyBoundary_ok() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL - gate.reserveSafety());
        _reserve(id);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Reserved));
    }

    function test_reserve_afterDeadlineMinusSafety_reverts() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL - gate.reserveSafety() + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReserveWindowClosed.selector, id));
        gate.reserve(id);
        vm.warp(block.timestamp + 1 hours); // past the deadline as well
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReserveWindowClosed.selector, id));
        gate.reserve(id);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Open));
    }

    function test_reserve_respectsConfiguredSafety() public {
        vm.prank(owner);
        gate.setReserveSafety(10 minutes);
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL - 10 minutes + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReserveWindowClosed.selector, id));
        gate.reserve(id);
        vm.warp(block.timestamp - 1);
        _reserve(id);
    }

    function test_noDoubleReserve() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.reserve(id);
    }

    function test_reserve_unknownOrClosedOrder_reverts() public {
        bytes32 unknown = keccak256("nope");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, unknown));
        gate.reserve(unknown);

        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.reserve(id);
    }

    function test_reserve_onlyRelayer() public {
        bytes32 id = _openEth();
        vm.prank(alice);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.reserve(id);
        vm.prank(owner);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.reserve(id);
    }

    function test_cannotRefundReserved_beforeTimeout() public {
        bytes32 id = _openEth();
        _reserve(id);
        uint256 reservedAt = block.timestamp;
        vm.warp(block.timestamp + TTL + 1); // original deadline passed
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReservationActive.selector, id));
        gate.refund(id);
        vm.warp(reservedAt + 24 hours); // exactly at the timeout: still blocked
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReservationActive.selector, id));
        gate.refund(id);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Reserved));
    }

    function test_canRefundReserved_afterTimeout() public {
        bytes32 id = _openEth();
        _reserve(id);
        uint256 before = alice.balance;
        vm.warp(block.timestamp + 24 hours + 1);
        vm.expectEmit(address(gate));
        emit Refunded(id, alice, PRICE_WEI);
        vm.prank(bob); // anyone may trigger
        gate.refund(id);
        assertEq(alice.balance, before + PRICE_WEI);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Refunded));
        // the relayer can no longer claim
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_refundReserved_usesConfiguredTimeout() public {
        vm.prank(owner);
        gate.setReserveTimeout(2 hours);
        bytes32 id = _openEth();
        _reserve(id);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.ReservationActive.selector, id));
        gate.refund(id);
        vm.warp(block.timestamp + 1);
        gate.refund(id);
    }

    function test_claimReserved_afterOriginalDeadline() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.warp(block.timestamp + TTL + 1 hours);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Filled));
        assertEq(treasury.balance, PRICE_WEI);
    }

    function test_claimReserved_afterTimeout_ifNotRefunded() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.refund(id);
    }

    function test_release_returnsOrderToOpen() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.expectEmit(address(gate));
        emit Released(id, relayer);
        vm.prank(relayer);
        gate.release(id);
        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(uint8(o.status), uint8(DotGasGate.Status.Open));
        assertEq(o.reservedAt, 0);
        // back to the normal deadline refund, no reservation timeout
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Refunded));
    }

    function test_release_onlyRelayer_andOnlyReserved() public {
        bytes32 id = _openEth();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.release(id);
        _reserve(id);
        vm.prank(alice);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.release(id);
        vm.prank(owner);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.release(id);
    }

    function test_reserveConfig_setters() public {
        vm.startPrank(owner);
        gate.setReserveSafety(0);
        assertEq(gate.reserveSafety(), 0);
        gate.setReserveSafety(1 days);
        vm.expectRevert(DotGasGate.BadReserveSafety.selector);
        gate.setReserveSafety(1 days + 1);
        gate.setReserveTimeout(1 hours);
        gate.setReserveTimeout(30 days);
        assertEq(gate.reserveTimeout(), 30 days);
        vm.expectRevert(DotGasGate.BadReserveTimeout.selector);
        gate.setReserveTimeout(1 hours - 1);
        vm.expectRevert(DotGasGate.BadReserveTimeout.selector);
        gate.setReserveTimeout(30 days + 1);
        vm.stopPrank();
    }

    function test_orderIdsAreUnique() public {
        bytes32 a = _openEth();
        bytes32 b = _openEth();
        assertTrue(a != b);
        assertEq(b, gate.previewOrderId(1));
    }

    // ------------------------------------------------------------ open validation

    function test_open_wrongValue_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.WrongPayment.selector, PRICE_WEI, PRICE_WEI + 1));
        gate.open{value: PRICE_WEI + 1}(portaldotRecipient, 1);
    }

    function test_open_inactiveTier_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.TierInactive.selector, 9));
        gate.open{value: PRICE_WEI}(portaldotRecipient, 9);
    }

    function test_open_ethDisabledForTier_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.WrongPayment.selector, 0, 0));
        gate.open{value: 0}(portaldotRecipient, 3);
    }

    function test_open_zeroRecipient_reverts() public {
        vm.prank(alice);
        vm.expectRevert(DotGasGate.ZeroAddress.selector);
        gate.open{value: PRICE_WEI}(address(0), 1);
    }

    function test_open_deactivatedTier_reverts() public {
        vm.prank(owner);
        gate.setTier(1, PRICE_WEI, PRICE_USDC, DST, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.TierInactive.selector, 1));
        gate.open{value: PRICE_WEI}(portaldotRecipient, 1);
    }

    function test_tierChange_doesNotAffectOpenOrder() public {
        bytes32 id = _openEth();
        vm.prank(owner);
        gate.setTier(1, 1 ether, 1, 1e4, true);
        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(o.amount, PRICE_WEI);
        assertEq(o.dstAmount, DST);
    }

    // ------------------------------------------------------------ refund path

    function test_refund_afterDeadline_returnsEth() public {
        bytes32 id = _openEth();
        uint256 before = alice.balance;
        vm.warp(block.timestamp + TTL + 1);
        vm.expectEmit(address(gate));
        emit Refunded(id, alice, PRICE_WEI);
        vm.prank(bob); // anyone may trigger
        gate.refund(id);
        assertEq(alice.balance, before + PRICE_WEI);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Refunded));
    }

    function test_refund_beforeDeadline_reverts() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.DeadlineNotReached.selector, id));
        gate.refund(id);
    }

    function test_noClaimFromOpen() public {
        bytes32 id = _openEth();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_noDoubleClaim() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.startPrank(relayer);
        gate.claim(id, FILL_REF);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
        vm.stopPrank();
    }

    function test_noDoubleRefund() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.refund(id);
    }

    function test_noRefundAfterClaim() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.refund(id);
    }

    function test_noClaimAfterRefund() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_unknownOrder_reverts() public {
        bytes32 id = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotOpen.selector, id));
        gate.refund(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.NotReserved.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_refund_reentrancyBlocked() public {
        Reenterer r = new Reenterer(gate);
        vm.deal(address(r), 1 ether);
        bytes32 id = r.openOrder{value: PRICE_WEI}(1);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        assertTrue(r.attempted());
        assertFalse(r.reentered());
        assertEq(address(gate).balance, 0);
    }

    function test_refund_toRejectingUser_reverts_andStaysOpen() public {
        RejectEth rej = new RejectEth();
        vm.deal(address(rej), 1 ether);
        vm.prank(address(rej));
        bytes32 id = gate.open{value: PRICE_WEI}(portaldotRecipient, 1);
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(DotGasGate.TransferFailed.selector);
        gate.refund(id);
        assertEq(uint8(gate.statusOf(id)), uint8(DotGasGate.Status.Open));
    }

    // ------------------------------------------------------------ USDC path

    function test_openUSDC_claim() public {
        bytes32 id = _openUsdc();
        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(o.token, address(usdc));
        assertEq(o.amount, PRICE_USDC);
        assertEq(usdc.balanceOf(address(gate)), PRICE_USDC);

        _reserve(id);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        assertEq(usdc.balanceOf(treasury), PRICE_USDC);
        assertEq(usdc.balanceOf(address(gate)), 0);
    }

    function test_openUSDC_refund() public {
        uint256 before = usdc.balanceOf(alice);
        bytes32 id = _openUsdc();
        assertEq(usdc.balanceOf(alice), before - PRICE_USDC);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        assertEq(usdc.balanceOf(alice), before);
    }

    function test_openUSDC_withoutApproval_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        gate.openUSDC(portaldotRecipient, 1);
    }

    function test_openUSDC_tokenDisabled_reverts() public {
        vm.prank(owner);
        gate.setPaymentToken(address(0));
        vm.prank(alice);
        vm.expectRevert(DotGasGate.TokenPaymentDisabled.selector);
        gate.openUSDC(portaldotRecipient, 1);
    }

    function test_openUSDC_tierWithoutTokenPrice_reverts() public {
        vm.prank(owner);
        gate.setTier(4, PRICE_WEI, 0, DST, true);
        vm.prank(alice);
        vm.expectRevert(DotGasGate.TokenPaymentDisabled.selector);
        gate.openUSDC(portaldotRecipient, 4);
    }

    function test_openUSDC_feeOnTransfer_reverts() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        fot.mint(alice, 100_000_000);
        vm.prank(owner);
        gate.setPaymentToken(address(fot));
        vm.startPrank(alice);
        fot.approve(address(gate), PRICE_USDC);
        vm.expectRevert(
            abi.encodeWithSelector(DotGasGate.WrongPayment.selector, PRICE_USDC, PRICE_USDC - PRICE_USDC / 100)
        );
        gate.openUSDC(portaldotRecipient, 1);
        vm.stopPrank();
    }

    function test_paymentTokenRotation_refundsInOriginalToken() public {
        bytes32 id = _openUsdc();
        MockERC20 other = new MockERC20();
        vm.prank(owner);
        gate.setPaymentToken(address(other));
        uint256 before = usdc.balanceOf(alice);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        assertEq(usdc.balanceOf(alice), before + PRICE_USDC);
    }

    // ------------------------------------------------------------ pause

    function test_pause_blocksOpen_butNotSettlement() public {
        bytes32 a = _openEth();
        bytes32 b = _openEth();
        bytes32 c = _openEth();
        vm.prank(owner);
        gate.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        gate.open{value: PRICE_WEI}(portaldotRecipient, 1);

        vm.startPrank(alice);
        usdc.approve(address(gate), PRICE_USDC);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        gate.openUSDC(portaldotRecipient, 1);
        vm.stopPrank();

        _reserve(a);
        vm.prank(relayer);
        gate.claim(a, FILL_REF);
        _reserve(c);
        vm.prank(relayer);
        gate.release(c);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(b);
        gate.refund(c);

        vm.prank(owner);
        gate.unpause();
        _openEth();
    }

    // ------------------------------------------------------------ access control

    function test_claim_onlyRelayer() public {
        bytes32 id = _openEth();
        _reserve(id);
        vm.prank(alice);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.claim(id, FILL_REF);
        vm.prank(owner);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.claim(id, FILL_REF);
    }

    function test_ownerSetters_onlyOwner() public {
        vm.startPrank(alice);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.expectRevert(err);
        gate.setTier(1, 1, 1, 1, true);
        vm.expectRevert(err);
        gate.setRelayer(alice);
        vm.expectRevert(err);
        gate.setTreasury(alice);
        vm.expectRevert(err);
        gate.setPaymentToken(alice);
        vm.expectRevert(err);
        gate.setOrderTtl(1 hours);
        vm.expectRevert(err);
        gate.setReserveSafety(1 minutes);
        vm.expectRevert(err);
        gate.setReserveTimeout(2 hours);
        vm.expectRevert(err);
        gate.pause();
        vm.expectRevert(err);
        gate.unpause();
        vm.stopPrank();
    }

    function test_rotateRelayer() public {
        bytes32 id = _openEth();
        _reserve(id); // a reservation by the old relayer can be claimed by the new one
        address newRelayer = makeAddr("newRelayer");
        vm.prank(owner);
        gate.setRelayer(newRelayer);
        vm.prank(relayer);
        vm.expectRevert(DotGasGate.NotRelayer.selector);
        gate.claim(id, FILL_REF);
        vm.prank(newRelayer);
        gate.claim(id, FILL_REF);
    }

    function test_setRelayer_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(DotGasGate.ZeroAddress.selector);
        gate.setRelayer(address(0));
    }

    function test_setOrderTtl() public {
        vm.prank(owner);
        gate.setOrderTtl(2 hours);
        bytes32 id = _openEth();
        assertEq(gate.getOrder(id).deadline, block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(DotGasGate.BadTtl.selector);
        gate.setOrderTtl(1);
    }

    function test_setTier_dstMustConvertTo14Decimals() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.BadDstAmount.selector, 5 ether + 1));
        gate.setTier(5, PRICE_WEI, PRICE_USDC, 5 ether + 1, true);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.BadDstAmount.selector, 9_999));
        gate.setTier(5, PRICE_WEI, PRICE_USDC, 9_999, true);
        gate.setTier(5, PRICE_WEI, PRICE_USDC, 1e4, true);
        gate.setTier(6, PRICE_WEI, PRICE_USDC, 0, false); // zero (disabled) is a multiple too
        vm.stopPrank();
        (,, uint256 dst,) = gate.tiers(5);
        assertEq(dst, 1e4);
    }

    function testFuzz_setTier_dstDivisibility(uint256 dst) public {
        vm.prank(owner);
        if (dst % 1e4 != 0) {
            vm.expectRevert(abi.encodeWithSelector(DotGasGate.BadDstAmount.selector, dst));
            gate.setTier(7, PRICE_WEI, 0, dst, true);
        } else {
            gate.setTier(7, PRICE_WEI, 0, dst, true);
            (,, uint256 stored,) = gate.tiers(7);
            assertEq(stored % 1e4, 0);
        }
    }

    function test_ownershipTransfer_isTwoStep() public {
        vm.prank(owner);
        gate.transferOwnership(bob);
        assertEq(gate.owner(), owner);
        vm.prank(bob);
        gate.acceptOwnership();
        assertEq(gate.owner(), bob);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_open_anyRecipientAndTier(address recipient, uint8 tier, uint96 price, uint96 dst)
        public
    {
        vm.assume(recipient != address(0));
        vm.assume(price > 0 && dst > 0);
        uint256 dstWei = uint256(dst) * 1e4;
        vm.prank(owner);
        gate.setTier(tier, price, 0, dstWei, true);
        vm.deal(alice, price);
        vm.prank(alice);
        bytes32 id = gate.open{value: price}(recipient, tier);
        DotGasGate.Order memory o = gate.getOrder(id);
        assertEq(o.recipient, recipient);
        assertEq(o.tier, tier);
        assertEq(o.amount, price);
        assertEq(o.dstAmount, dstWei);
    }

    /// Whatever the timing, an order settles exactly once: either the treasury or the user gets the escrow,
    /// never both. Claim needs a reservation, which needs `reserveSafety` before the deadline; refund of a
    /// reservation needs the reservation timeout.
    function testFuzz_settlesExactlyOnce(uint64 reserveAfter, uint64 elapsed, bool tryRefundFirst) public {
        reserveAfter = uint64(bound(reserveAfter, 0, 2 * TTL));
        elapsed = uint64(bound(elapsed, 0, 60 days));
        bytes32 id = _openEth();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + reserveAfter);
        bool canReserve = reserveAfter + gate.reserveSafety() <= TTL;
        vm.prank(relayer);
        (bool reserveOk,) = address(gate).call(abi.encodeCall(DotGasGate.reserve, (id)));
        assertEq(reserveOk, canReserve);

        vm.warp(t0 + reserveAfter + elapsed);
        bool refundable = reserveOk ? elapsed > gate.reserveTimeout() : reserveAfter + elapsed > TTL;

        bool refundOk;
        bool claimOk;
        if (tryRefundFirst) {
            (refundOk,) = address(gate).call(abi.encodeCall(DotGasGate.refund, (id)));
            vm.prank(relayer);
            (claimOk,) = address(gate).call(abi.encodeCall(DotGasGate.claim, (id, FILL_REF)));
        } else {
            vm.prank(relayer);
            (claimOk,) = address(gate).call(abi.encodeCall(DotGasGate.claim, (id, FILL_REF)));
            (refundOk,) = address(gate).call(abi.encodeCall(DotGasGate.refund, (id)));
        }
        assertFalse(claimOk && refundOk);
        assertEq(claimOk, reserveOk && !(tryRefundFirst && refundable));
        assertEq(refundOk, refundable && !(claimOk && !tryRefundFirst));

        // Funds always end up in at most one place, and nowhere else.
        uint256 paidOut = treasury.balance + (refundOk ? PRICE_WEI : 0);
        assertEq(paidOut + address(gate).balance, PRICE_WEI);
    }

    function testFuzz_wrongEthAmountReverts(uint256 value) public {
        vm.assume(value != PRICE_WEI);
        value = bound(value, 0, 10 ether);
        vm.assume(value != PRICE_WEI);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DotGasGate.WrongPayment.selector, PRICE_WEI, value));
        gate.open{value: value}(portaldotRecipient, 1);
    }
}
