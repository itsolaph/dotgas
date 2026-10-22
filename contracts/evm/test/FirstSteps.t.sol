// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FirstSteps} from "../src/FirstSteps.sol";

contract FirstStepsTest is Test {
    FirstSteps book;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event Signed(uint256 indexed id, address indexed signer, uint256 blockNumber, string message);

    function setUp() public {
        book = new FirstSteps();
    }

    function test_sign_storesEntry() public {
        vm.roll(42);
        vm.expectEmit(address(book));
        emit Signed(0, alice, 42, "gm portaldot");
        vm.prank(alice);
        uint256 id = book.sign("gm portaldot");
        assertEq(id, 0);
        assertEq(book.count(), 1);
        FirstSteps.Entry memory e = book.entry(0);
        assertEq(e.signer, alice);
        assertEq(e.blockNumber, 42);
        assertEq(e.message, "gm portaldot");
        assertEq(book.signaturesOf(alice), 1);
    }

    function test_latest_newestFirst() public {
        vm.prank(alice);
        book.sign("one");
        vm.prank(bob);
        book.sign("two");
        vm.prank(alice);
        book.sign("three");
        FirstSteps.Entry[] memory l = book.latest(2);
        assertEq(l.length, 2);
        assertEq(l[0].message, "three");
        assertEq(l[1].message, "two");
        assertEq(book.latest(10).length, 3);
        assertEq(book.signaturesOf(alice), 2);
    }

    function test_sign_rejectsEmptyAndTooLong() public {
        vm.expectRevert(FirstSteps.EmptyMessage.selector);
        book.sign("");
        bytes memory long = new bytes(281);
        for (uint256 i = 0; i < long.length; i++) {
            long[i] = "a";
        }
        vm.expectRevert(abi.encodeWithSelector(FirstSteps.MessageTooLong.selector, 281));
        book.sign(string(long));
    }

    function test_entry_outOfRange_reverts() public {
        vm.expectRevert();
        book.entry(0);
    }

    function testFuzz_sign(string calldata message) public {
        uint256 len = bytes(message).length;
        vm.assume(len > 0 && len <= 280);
        uint256 id = book.sign(message);
        assertEq(book.entry(id).message, message);
        assertEq(book.count(), 1);
    }
}
