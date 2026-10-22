// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {LandfallGate} from "../src/LandfallGate.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";

/// @dev Receiver that tries to re-enter the gate when it gets ETH.
contract Reenterer {
    LandfallGate public gate;
    bytes32 public target;
    bool public attempted;
    bool public reentered;

    constructor(LandfallGate gate_) {
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

contract LandfallGateTest is Test {
    LandfallGate gate;
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
    event Claimed(bytes32 indexed orderId, address indexed relayer, bytes32 fillTxRef, uint256 amount);
    event Refunded(bytes32 indexed orderId, address indexed user, uint256 amount);

    function setUp() public {
        usdc = new MockERC20();
        gate = new LandfallGate(owner, relayer, treasury, address(usdc), TTL);
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

    function _openUsdc() internal returns (bytes32) {
        vm.startPrank(alice);
        usdc.approve(address(gate), PRICE_USDC);
        bytes32 id = gate.openUSDC(portaldotRecipient, 1);
        vm.stopPrank();
        return id;
    }

    // ------------------------------------------------------------ constructor / config

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(LandfallGate.ZeroAddress.selector);
        new LandfallGate(owner, address(0), treasury, address(usdc), TTL);
        vm.expectRevert(LandfallGate.ZeroAddress.selector);
        new LandfallGate(owner, relayer, address(0), address(usdc), TTL);
    }

    function test_constructor_rejectsBadTtl() public {
        vm.expectRevert(LandfallGate.BadTtl.selector);
        new LandfallGate(owner, relayer, treasury, address(usdc), 1 minutes);
        vm.expectRevert(LandfallGate.BadTtl.selector);
        new LandfallGate(owner, relayer, treasury, address(usdc), 8 days);
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

        LandfallGate.Order memory o = gate.getOrder(id);
        assertEq(o.user, alice);
        assertEq(o.recipient, portaldotRecipient);
        assertEq(o.token, address(0));
        assertEq(o.tier, 1);
        assertEq(uint8(o.status), uint8(LandfallGate.Status.Open));
        assertEq(o.deadline, block.timestamp + TTL);
        assertEq(o.amount, PRICE_WEI);
        assertEq(o.dstAmount, DST);
        assertEq(address(gate).balance, PRICE_WEI);
    }

    function test_claim_eth_paysTreasury() public {
        bytes32 id = _openEth();
        vm.expectEmit(address(gate));
        emit Claimed(id, relayer, FILL_REF, PRICE_WEI);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        assertEq(treasury.balance, PRICE_WEI);
        assertEq(address(gate).balance, 0);
        assertEq(uint8(gate.statusOf(id)), uint8(LandfallGate.Status.Filled));
        assertEq(gate.fillTxRefOf(id), FILL_REF);
    }

    function test_claim_atExactDeadline_ok() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL);
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        assertEq(uint8(gate.statusOf(id)), uint8(LandfallGate.Status.Filled));
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
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.WrongPayment.selector, PRICE_WEI, PRICE_WEI + 1));
        gate.open{value: PRICE_WEI + 1}(portaldotRecipient, 1);
    }

    function test_open_inactiveTier_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.TierInactive.selector, 9));
        gate.open{value: PRICE_WEI}(portaldotRecipient, 9);
    }

    function test_open_ethDisabledForTier_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.WrongPayment.selector, 0, 0));
        gate.open{value: 0}(portaldotRecipient, 3);
    }

    function test_open_zeroRecipient_reverts() public {
        vm.prank(alice);
        vm.expectRevert(LandfallGate.ZeroAddress.selector);
        gate.open{value: PRICE_WEI}(address(0), 1);
    }

    function test_open_deactivatedTier_reverts() public {
        vm.prank(owner);
        gate.setTier(1, PRICE_WEI, PRICE_USDC, DST, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.TierInactive.selector, 1));
        gate.open{value: PRICE_WEI}(portaldotRecipient, 1);
    }

    function test_tierChange_doesNotAffectOpenOrder() public {
        bytes32 id = _openEth();
        vm.prank(owner);
        gate.setTier(1, 1 ether, 1, 1, true);
        LandfallGate.Order memory o = gate.getOrder(id);
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
        assertEq(uint8(gate.statusOf(id)), uint8(LandfallGate.Status.Refunded));
    }

    function test_refund_beforeDeadline_reverts() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.DeadlineNotReached.selector, id));
        gate.refund(id);
    }

    function test_claim_afterDeadline_reverts() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.DeadlinePassed.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_noDoubleClaim() public {
        bytes32 id = _openEth();
        vm.startPrank(relayer);
        gate.claim(id, FILL_REF);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
        gate.claim(id, FILL_REF);
        vm.stopPrank();
    }

    function test_noDoubleRefund() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
        gate.refund(id);
    }

    function test_noRefundAfterClaim() public {
        bytes32 id = _openEth();
        vm.prank(relayer);
        gate.claim(id, FILL_REF);
        vm.warp(block.timestamp + TTL + 1);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
        gate.refund(id);
    }

    function test_noClaimAfterRefund() public {
        bytes32 id = _openEth();
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
        gate.claim(id, FILL_REF);
    }

    function test_unknownOrder_reverts() public {
        bytes32 id = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
        gate.refund(id);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.NotOpen.selector, id));
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
        vm.expectRevert(LandfallGate.TransferFailed.selector);
        gate.refund(id);
        assertEq(uint8(gate.statusOf(id)), uint8(LandfallGate.Status.Open));
    }

    // ------------------------------------------------------------ USDC path

    function test_openUSDC_claim() public {
        bytes32 id = _openUsdc();
        LandfallGate.Order memory o = gate.getOrder(id);
        assertEq(o.token, address(usdc));
        assertEq(o.amount, PRICE_USDC);
        assertEq(usdc.balanceOf(address(gate)), PRICE_USDC);

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
        vm.expectRevert(LandfallGate.TokenPaymentDisabled.selector);
        gate.openUSDC(portaldotRecipient, 1);
    }

    function test_openUSDC_tierWithoutTokenPrice_reverts() public {
        vm.prank(owner);
        gate.setTier(4, PRICE_WEI, 0, DST, true);
        vm.prank(alice);
        vm.expectRevert(LandfallGate.TokenPaymentDisabled.selector);
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
            abi.encodeWithSelector(LandfallGate.WrongPayment.selector, PRICE_USDC, PRICE_USDC - PRICE_USDC / 100)
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

        vm.prank(relayer);
        gate.claim(a, FILL_REF);
        vm.warp(block.timestamp + TTL + 1);
        gate.refund(b);

        vm.prank(owner);
        gate.unpause();
        _openEth();
    }

    // ------------------------------------------------------------ access control

    function test_claim_onlyRelayer() public {
        bytes32 id = _openEth();
        vm.prank(alice);
        vm.expectRevert(LandfallGate.NotRelayer.selector);
        gate.claim(id, FILL_REF);
        vm.prank(owner);
        vm.expectRevert(LandfallGate.NotRelayer.selector);
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
        gate.pause();
        vm.expectRevert(err);
        gate.unpause();
        vm.stopPrank();
    }

    function test_rotateRelayer() public {
        bytes32 id = _openEth();
        address newRelayer = makeAddr("newRelayer");
        vm.prank(owner);
        gate.setRelayer(newRelayer);
        vm.prank(relayer);
        vm.expectRevert(LandfallGate.NotRelayer.selector);
        gate.claim(id, FILL_REF);
        vm.prank(newRelayer);
        gate.claim(id, FILL_REF);
    }

    function test_setRelayer_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(LandfallGate.ZeroAddress.selector);
        gate.setRelayer(address(0));
    }

    function test_setOrderTtl() public {
        vm.prank(owner);
        gate.setOrderTtl(2 hours);
        bytes32 id = _openEth();
        assertEq(gate.getOrder(id).deadline, block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(LandfallGate.BadTtl.selector);
        gate.setOrderTtl(1);
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
        vm.prank(owner);
        gate.setTier(tier, price, 0, dst, true);
        vm.deal(alice, price);
        vm.prank(alice);
        bytes32 id = gate.open{value: price}(recipient, tier);
        LandfallGate.Order memory o = gate.getOrder(id);
        assertEq(o.recipient, recipient);
        assertEq(o.tier, tier);
        assertEq(o.amount, price);
        assertEq(o.dstAmount, dst);
    }

    /// Claim and refund windows partition time exactly: at any moment exactly one of them is possible.
    function testFuzz_claimXorRefund(uint64 elapsed) public {
        elapsed = uint64(bound(elapsed, 0, 30 days));
        bytes32 id = _openEth();
        vm.warp(block.timestamp + elapsed);
        bool canClaim = elapsed <= TTL;

        vm.prank(relayer);
        (bool claimOk,) = address(gate).call(abi.encodeCall(LandfallGate.claim, (id, FILL_REF)));
        assertEq(claimOk, canClaim);

        (bool refundOk,) = address(gate).call(abi.encodeCall(LandfallGate.refund, (id)));
        assertEq(refundOk, !canClaim);

        // Funds always end up in exactly one place.
        assertEq(address(gate).balance, 0);
        assertEq(treasury.balance + (canClaim ? 0 : PRICE_WEI), PRICE_WEI);
    }

    function testFuzz_wrongEthAmountReverts(uint256 value) public {
        vm.assume(value != PRICE_WEI);
        value = bound(value, 0, 10 ether);
        vm.assume(value != PRICE_WEI);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LandfallGate.WrongPayment.selector, PRICE_WEI, value));
        gate.open{value: value}(portaldotRecipient, 1);
    }
}
