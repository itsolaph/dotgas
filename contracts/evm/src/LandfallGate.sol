// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title LandfallGate
/// @notice Source-chain (Base Sepolia) side of Landfall. A user pays a fixed tier price in ETH or in an
///         ERC20 (e.g. test USDC) and opens an order asking for tPOT gas to be delivered to a Portaldot
///         address. A trusted relayer fills the order on Portaldot and then claims the escrowed payment.
///         If the order is not claimed before its deadline, anyone can refund it back to the user.
/// @dev    Pausing only blocks new orders. Claims and refunds keep working so that in-flight orders can
///         always be settled one way or the other.
contract LandfallGate is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Filled,
        Refunded
    }

    struct Tier {
        uint256 priceWei; // price in native ETH, 0 = ETH payments disabled for this tier
        uint256 priceToken; // price in `paymentToken` units, 0 = token payments disabled for this tier
        uint256 dstAmount; // tPOT delivered on Portaldot (18-decimal EVM-side units)
        bool active;
    }

    struct Order {
        address user;
        address recipient; // Portaldot EVM (H160) address that receives tPOT
        address token; // address(0) for ETH
        uint8 tier;
        Status status;
        uint64 deadline;
        uint256 amount; // escrowed payment
        uint256 dstAmount; // tPOT promised, frozen at open time
    }

    uint64 public constant MIN_TTL = 5 minutes;
    uint64 public constant MAX_TTL = 7 days;

    address public relayer;
    address public treasury;
    IERC20 public paymentToken;
    uint64 public orderTtl;
    uint256 public nonce;

    mapping(uint8 => Tier) public tiers;
    mapping(bytes32 => Order) private _orders;
    mapping(bytes32 => bytes32) public fillTxRefOf;

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
    event TierSet(uint8 indexed tier, uint256 priceWei, uint256 priceToken, uint256 dstAmount, bool active);
    event RelayerUpdated(address indexed previous, address indexed current);
    event TreasuryUpdated(address indexed previous, address indexed current);
    event PaymentTokenUpdated(address indexed previous, address indexed current);
    event OrderTtlUpdated(uint64 previous, uint64 current);

    error NotRelayer();
    error ZeroAddress();
    error TierInactive(uint8 tier);
    error WrongPayment(uint256 expected, uint256 got);
    error TokenPaymentDisabled();
    error NotOpen(bytes32 orderId);
    error DeadlinePassed(bytes32 orderId);
    error DeadlineNotReached(bytes32 orderId);
    error BadTtl();
    error TransferFailed();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address owner_, address relayer_, address treasury_, address paymentToken_, uint64 orderTtl_)
        Ownable(owner_)
    {
        if (relayer_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (orderTtl_ < MIN_TTL || orderTtl_ > MAX_TTL) revert BadTtl();
        relayer = relayer_;
        treasury = treasury_;
        paymentToken = IERC20(paymentToken_);
        orderTtl = orderTtl_;
        emit RelayerUpdated(address(0), relayer_);
        emit TreasuryUpdated(address(0), treasury_);
        emit PaymentTokenUpdated(address(0), paymentToken_);
        emit OrderTtlUpdated(0, orderTtl_);
    }

    // ---------------------------------------------------------------- user

    /// @notice Open an order paying the tier price in native ETH (exact amount).
    function open(address recipient, uint8 tier)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32)
    {
        Tier memory t = _activeTier(tier);
        if (t.priceWei == 0 || msg.value != t.priceWei) revert WrongPayment(t.priceWei, msg.value);
        return _open(recipient, tier, address(0), msg.value, t.dstAmount);
    }

    /// @notice Open an order paying the tier price in `paymentToken`. Requires prior approval.
    function openUSDC(address recipient, uint8 tier) external nonReentrant whenNotPaused returns (bytes32) {
        Tier memory t = _activeTier(tier);
        IERC20 token = paymentToken;
        if (address(token) == address(0) || t.priceToken == 0) revert TokenPaymentDisabled();
        // Measure the received amount so fee-on-transfer tokens cannot under-fund the escrow.
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), t.priceToken);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != t.priceToken) revert WrongPayment(t.priceToken, received);
        return _open(recipient, tier, address(token), received, t.dstAmount);
    }

    /// @notice Return escrowed funds to the user once the deadline has passed. Callable by anyone.
    function refund(bytes32 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != Status.Open) revert NotOpen(orderId);
        if (block.timestamp <= o.deadline) revert DeadlineNotReached(orderId);
        o.status = Status.Refunded;
        emit Refunded(orderId, o.user, o.amount);
        _pay(o.token, o.user, o.amount);
    }

    // ---------------------------------------------------------------- relayer

    /// @notice Relayer claims the escrow after filling on Portaldot. `fillTxRef` is the Portaldot tx hash.
    function claim(bytes32 orderId, bytes32 fillTxRef) external nonReentrant onlyRelayer {
        Order storage o = _orders[orderId];
        if (o.status != Status.Open) revert NotOpen(orderId);
        if (block.timestamp > o.deadline) revert DeadlinePassed(orderId);
        o.status = Status.Filled;
        fillTxRefOf[orderId] = fillTxRef;
        emit Claimed(orderId, msg.sender, fillTxRef, o.amount);
        _pay(o.token, treasury, o.amount);
    }

    // ---------------------------------------------------------------- views

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function statusOf(bytes32 orderId) external view returns (Status) {
        return _orders[orderId].status;
    }

    /// @notice Order id that the next `open` call will produce. Unique across chains and gate deployments.
    function previewOrderId(uint256 n) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), n));
    }

    // ---------------------------------------------------------------- owner

    function setTier(uint8 tier, uint256 priceWei, uint256 priceToken, uint256 dstAmount, bool active)
        external
        onlyOwner
    {
        tiers[tier] = Tier(priceWei, priceToken, dstAmount, active);
        emit TierSet(tier, priceWei, priceToken, dstAmount, active);
    }

    function setRelayer(address relayer_) external onlyOwner {
        if (relayer_ == address(0)) revert ZeroAddress();
        emit RelayerUpdated(relayer, relayer_);
        relayer = relayer_;
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    /// @dev Existing orders keep the token they were paid in, so changing this never strands funds.
    function setPaymentToken(address token_) external onlyOwner {
        emit PaymentTokenUpdated(address(paymentToken), token_);
        paymentToken = IERC20(token_);
    }

    function setOrderTtl(uint64 ttl) external onlyOwner {
        if (ttl < MIN_TTL || ttl > MAX_TTL) revert BadTtl();
        emit OrderTtlUpdated(orderTtl, ttl);
        orderTtl = ttl;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- internal

    function _activeTier(uint8 tier) private view returns (Tier memory t) {
        t = tiers[tier];
        if (!t.active || t.dstAmount == 0) revert TierInactive(tier);
    }

    function _open(address recipient, uint8 tier, address token, uint256 amount, uint256 dstAmount)
        private
        returns (bytes32 orderId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        orderId = previewOrderId(nonce++);
        uint64 deadline = uint64(block.timestamp) + orderTtl;
        _orders[orderId] = Order({
            user: msg.sender,
            recipient: recipient,
            token: token,
            tier: tier,
            status: Status.Open,
            deadline: deadline,
            amount: amount,
            dstAmount: dstAmount
        });
        emit Opened(orderId, msg.sender, recipient, tier, token, amount, dstAmount, deadline);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
