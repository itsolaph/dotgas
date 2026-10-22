// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FerryDock} from "../src/FerryDock.sol";

/// @dev Recipient that re-enters `fill` from its receive hook (it is also made the relayer in the test).
contract ReentrantRecipient {
    FerryDock public dock;
    bool public reentered;

    constructor(FerryDock dock_) {
        dock = dock_;
    }

    function doFill(bytes32 id, uint256 amount) external {
        dock.fill(id, payable(address(this)), amount);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            dock.fill(keccak256("second"), payable(address(this)), msg.value);
        }
    }
}

contract FerryDockTest is Test {
    FerryDock dock;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant MAX_PER_FILL = 10 ether;
    uint256 constant RECIPIENT_CAP = 15 ether;

    event Filled(bytes32 indexed orderId, address indexed recipient, uint256 amount);
    event Funded(address indexed from, uint256 amount);

    function setUp() public {
        dock = new FerryDock(owner, relayer, MAX_PER_FILL, RECIPIENT_CAP);
        vm.deal(owner, 1000 ether);
        vm.prank(owner);
        (bool ok,) = address(dock).call{value: 100 ether}("");
        assertTrue(ok);
    }

    function _fill(bytes32 id, address to, uint256 amount) internal {
        vm.prank(relayer);
        dock.fill(id, payable(to), amount);
    }

    function test_receive_emitsFunded() public {
        vm.deal(bob, 1 ether);
        vm.expectEmit(address(dock));
        emit Funded(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(dock).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(dock.poolBalance(), 101 ether);
    }

    function test_fill_happyPath() public {
        bytes32 id = keccak256("order-1");
        vm.expectEmit(address(dock));
        emit Filled(id, alice, 5 ether);
        _fill(id, alice, 5 ether);
        assertEq(alice.balance, 5 ether);
        assertTrue(dock.filled(id));
        assertEq(dock.receivedBy(alice), 5 ether);
        assertEq(dock.totalFilled(), 5 ether);
        assertEq(dock.fillCount(), 1);
        assertEq(dock.poolBalance(), 95 ether);
    }

    function test_fill_replay_reverts() public {
        bytes32 id = keccak256("order-1");
        _fill(id, alice, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(FerryDock.AlreadyFilled.selector, id));
        dock.fill(id, payable(bob), 1 ether);
        assertEq(bob.balance, 0);
    }

    function test_fill_aboveMaxPerFill_reverts() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(FerryDock.AboveMaxPerFill.selector, MAX_PER_FILL + 1, MAX_PER_FILL)
        );
        dock.fill(keccak256("x"), payable(alice), MAX_PER_FILL + 1);
    }

    function test_fill_recipientCap() public {
        _fill(keccak256("a"), alice, 10 ether);
        _fill(keccak256("b"), alice, 5 ether); // exactly at cap
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                FerryDock.RecipientCapExceeded.selector, alice, RECIPIENT_CAP + 1, RECIPIENT_CAP
            )
        );
        dock.fill(keccak256("c"), payable(alice), 1);
        // other recipients are unaffected
        _fill(keccak256("d"), bob, 10 ether);
    }

    function test_fill_insufficientPool_reverts() public {
        vm.prank(owner);
        dock.withdraw(payable(owner), 99 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(FerryDock.InsufficientPool.selector, 2 ether, 1 ether));
        dock.fill(keccak256("x"), payable(alice), 2 ether);
    }

    function test_fill_zeroAmountOrRecipient_reverts() public {
        vm.startPrank(relayer);
        vm.expectRevert(FerryDock.ZeroAmount.selector);
        dock.fill(keccak256("x"), payable(alice), 0);
        vm.expectRevert(FerryDock.ZeroAddress.selector);
        dock.fill(keccak256("x"), payable(address(0)), 1 ether);
        vm.stopPrank();
    }

    function test_fill_onlyRelayer() public {
        vm.prank(alice);
        vm.expectRevert(FerryDock.NotRelayer.selector);
        dock.fill(keccak256("x"), payable(alice), 1 ether);
        vm.prank(owner);
        vm.expectRevert(FerryDock.NotRelayer.selector);
        dock.fill(keccak256("x"), payable(alice), 1 ether);
    }

    function test_pause_blocksFill() public {
        vm.prank(owner);
        dock.pause();
        vm.prank(relayer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        dock.fill(keccak256("x"), payable(alice), 1 ether);
        vm.prank(owner);
        dock.unpause();
        _fill(keccak256("x"), alice, 1 ether);
    }

    function test_reentrancy_blocked() public {
        ReentrantRecipient r = new ReentrantRecipient(dock);
        vm.prank(owner);
        dock.setRelayer(address(r));
        // Inner fill reverts on the guard -> receive reverts -> outer transfer fails.
        vm.expectRevert(FerryDock.TransferFailed.selector);
        r.doFill(keccak256("first"), 1 ether);
        assertFalse(dock.filled(keccak256("first")));
        assertFalse(dock.filled(keccak256("second")));
        assertEq(dock.poolBalance(), 100 ether);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        dock.withdraw(payable(alice), 1 ether);

        vm.prank(owner);
        dock.withdraw(payable(bob), 3 ether);
        assertEq(bob.balance, 3 ether);
        assertEq(dock.poolBalance(), 97 ether);
    }

    function test_ownerSetters_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer);
        vm.startPrank(relayer);
        vm.expectRevert(err);
        dock.setRelayer(relayer);
        vm.expectRevert(err);
        dock.setLimits(1, 1);
        vm.expectRevert(err);
        dock.pause();
        vm.stopPrank();
    }

    function test_rotateRelayer() public {
        address r2 = makeAddr("r2");
        vm.prank(owner);
        dock.setRelayer(r2);
        vm.prank(relayer);
        vm.expectRevert(FerryDock.NotRelayer.selector);
        dock.fill(keccak256("x"), payable(alice), 1 ether);
        vm.prank(r2);
        dock.fill(keccak256("x"), payable(alice), 1 ether);
    }

    function test_setLimits() public {
        vm.prank(owner);
        dock.setLimits(1 ether, 2 ether);
        assertEq(dock.maxPerFill(), 1 ether);
        assertEq(dock.recipientCap(), 2 ether);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(FerryDock.AboveMaxPerFill.selector, 2 ether, 1 ether));
        dock.fill(keccak256("x"), payable(alice), 2 ether);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_fill_respectsLimits(uint256 amount, address to) public {
        vm.assume(to != address(0) && to.code.length == 0 && uint160(to) > 0x100);
        vm.assume(to != address(dock) && to != owner && to != relayer);
        amount = bound(amount, 1, 50 ether);
        uint256 before = to.balance;
        vm.prank(relayer);
        (bool ok,) = address(dock).call(abi.encodeCall(FerryDock.fill, (keccak256("f"), payable(to), amount)));
        bool shouldPass = amount <= MAX_PER_FILL; // recipient cap (15) > max per fill (10)
        assertEq(ok, shouldPass);
        assertEq(to.balance - before, shouldPass ? amount : 0);
        assertEq(dock.poolBalance(), 100 ether - (shouldPass ? amount : 0));
    }

    function testFuzz_cumulativeCap(uint8 n, uint256 each) public {
        n = uint8(bound(n, 1, 40));
        each = bound(each, 0.1 ether, MAX_PER_FILL);
        uint256 received;
        for (uint256 i = 0; i < n; i++) {
            bool expectOk = received + each <= RECIPIENT_CAP;
            vm.prank(relayer);
            (bool ok,) =
                address(dock).call(abi.encodeCall(FerryDock.fill, (bytes32(i + 1), payable(alice), each)));
            assertEq(ok, expectOk);
            if (ok) received += each;
        }
        assertLe(dock.receivedBy(alice), RECIPIENT_CAP);
        assertEq(alice.balance, received);
    }
}
