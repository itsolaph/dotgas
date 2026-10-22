// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DotGasDock
/// @notice Destination-chain (Portaldot, pallet-revive EVM) side of DotGas. Holds a pool of native tPOT
///         and pays it out to new users when the relayer fills a DotGasGate order.
/// @dev    Amounts are in the 18-decimal EVM-side unit. Portaldot's native token has 14 decimals, so fill
///         amounts should be multiples of 1e4 wei to map cleanly onto native balances.
contract DotGasDock is Ownable2Step, Pausable, ReentrancyGuard {
    address public relayer;
    uint256 public maxPerFill;
    uint256 public recipientCap; // lifetime cap per recipient address

    uint256 public totalFilled;
    uint256 public fillCount;

    mapping(bytes32 => bool) public filled;
    /// @notice Block number of the fill, 0 if not filled. Lets off-chain readers find the `Filled` event in
    ///         a one-block range instead of scanning from the deploy block.
    mapping(bytes32 => uint256) public filledAt;
    mapping(address => uint256) public receivedBy;

    event Funded(address indexed from, uint256 amount);
    event Filled(bytes32 indexed orderId, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event RelayerUpdated(address indexed previous, address indexed current);
    event LimitsUpdated(uint256 maxPerFill, uint256 recipientCap);

    error NotRelayer();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyFilled(bytes32 orderId);
    error AboveMaxPerFill(uint256 amount, uint256 max);
    error RecipientCapExceeded(address recipient, uint256 wouldReceive, uint256 cap);
    error InsufficientPool(uint256 amount, uint256 available);
    error TransferFailed();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address owner_, address relayer_, uint256 maxPerFill_, uint256 recipientCap_)
        Ownable(owner_)
    {
        if (relayer_ == address(0)) revert ZeroAddress();
        relayer = relayer_;
        maxPerFill = maxPerFill_;
        recipientCap = recipientCap_;
        emit RelayerUpdated(address(0), relayer_);
        emit LimitsUpdated(maxPerFill_, recipientCap_);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Deliver `amount` tPOT to `recipient` for a DotGasGate order. Each order id can fill once.
    function fill(bytes32 orderId, address payable recipient, uint256 amount)
        external
        nonReentrant
        onlyRelayer
        whenNotPaused
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (filled[orderId]) revert AlreadyFilled(orderId);
        if (amount > maxPerFill) revert AboveMaxPerFill(amount, maxPerFill);
        uint256 after_ = receivedBy[recipient] + amount;
        if (after_ > recipientCap) revert RecipientCapExceeded(recipient, after_, recipientCap);
        if (amount > address(this).balance) revert InsufficientPool(amount, address(this).balance);

        filled[orderId] = true;
        filledAt[orderId] = block.number;
        receivedBy[recipient] = after_;
        totalFilled += amount;
        fillCount += 1;
        emit Filled(orderId, recipient, amount);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ---------------------------------------------------------------- owner

    function withdraw(address payable to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert ZeroAddress();
        emit RelayerUpdated(relayer, relayer_);
        relayer = relayer_;
    }

    function setLimits(uint256 maxPerFill_, uint256 recipientCap_) external onlyOwner {
        maxPerFill = maxPerFill_;
        recipientCap = recipientCap_;
        emit LimitsUpdated(maxPerFill_, recipientCap_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
