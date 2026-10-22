import { parseAbi } from 'viem';

export const gateAbi = parseAbi([
  'event Opened(bytes32 indexed orderId, address indexed user, address indexed recipient, uint8 tier, address token, uint256 amount, uint256 dstAmount, uint64 deadline)',
  'struct Order { address user; address recipient; address token; uint8 tier; uint8 status; uint64 deadline; uint64 reservedAt; uint256 amount; uint256 dstAmount; }',
  'function getOrder(bytes32 orderId) view returns (Order)',
  'function tiers(uint8) view returns (uint256 priceWei, uint256 priceToken, uint256 dstAmount, bool active)',
  'function fillTxRefOf(bytes32) view returns (bytes32)',
  'function reserveTimeout() view returns (uint64)',
  'function open(address recipient, uint8 tier) payable returns (bytes32)',
  'function openUSDC(address recipient, uint8 tier) returns (bytes32)',
  'function refund(bytes32 orderId)',
  'function paused() view returns (bool)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const firstStepsAbi = parseAbi([
  'struct Entry { address signer; uint64 blockNumber; uint64 timestamp; string message; }',
  'event Signed(uint256 indexed id, address indexed signer, uint256 blockNumber, string message)',
  'function sign(string message) returns (uint256)',
  'function count() view returns (uint256)',
  'function latest(uint256 n) view returns (Entry[])',
]);

export const STATUS = ['None', 'Open', 'Filled', 'Refunded', 'Reserved'] as const;
