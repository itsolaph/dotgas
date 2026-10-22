import { parseAbi } from 'viem';

export const gateAbi = parseAbi([
  'event Opened(bytes32 indexed orderId, address indexed user, address indexed recipient, uint8 tier, address token, uint256 amount, uint256 dstAmount, uint64 deadline)',
  'event Reserved(bytes32 indexed orderId, address indexed relayer, uint64 reservedAt)',
  'event Released(bytes32 indexed orderId, address indexed relayer)',
  'event Claimed(bytes32 indexed orderId, address indexed relayer, bytes32 fillTxRef, uint256 amount)',
  'event Refunded(bytes32 indexed orderId, address indexed user, uint256 amount)',
  'struct Order { address user; address recipient; address token; uint8 tier; uint8 status; uint64 deadline; uint64 reservedAt; uint256 amount; uint256 dstAmount; }',
  'function getOrder(bytes32 orderId) view returns (Order)',
  'function reserve(bytes32 orderId)',
  'function release(bytes32 orderId)',
  'function claim(bytes32 orderId, bytes32 fillTxRef)',
  'function refund(bytes32 orderId)',
  'function relayer() view returns (address)',
  'function reserveSafety() view returns (uint64)',
  'function reserveTimeout() view returns (uint64)',
  'error NotRelayer()',
  'error NotOpen(bytes32 orderId)',
  'error NotReserved(bytes32 orderId)',
  'error ReserveWindowClosed(bytes32 orderId)',
  'error DeadlineNotReached(bytes32 orderId)',
  'error ReservationActive(bytes32 orderId)',
]);

export const dockAbi = parseAbi([
  'event Filled(bytes32 indexed orderId, address indexed recipient, uint256 amount)',
  'function fill(bytes32 orderId, address recipient, uint256 amount)',
  'function filled(bytes32 orderId) view returns (bool)',
  'function filledAt(bytes32 orderId) view returns (uint256)',
  'function poolBalance() view returns (uint256)',
  'function maxPerFill() view returns (uint256)',
  'function recipientCap() view returns (uint256)',
  'function receivedBy(address) view returns (uint256)',
  'function totalFilled() view returns (uint256)',
  'function fillCount() view returns (uint256)',
  'function paused() view returns (bool)',
  'error NotRelayer()',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error AlreadyFilled(bytes32 orderId)',
  'error AboveMaxPerFill(uint256 amount, uint256 max)',
  'error RecipientCapExceeded(address recipient, uint256 wouldReceive, uint256 cap)',
  'error InsufficientPool(uint256 amount, uint256 available)',
  'error TransferFailed()',
  'error EnforcedPause()',
]);

/** Mirrors DotGasGate.Status */
export const GateStatus = { None: 0, Open: 1, Filled: 2, Refunded: 3, Reserved: 4 } as const;
