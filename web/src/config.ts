import { defineChain, type Address } from 'viem';

const env = import.meta.env;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export const config = {
  gate: (env.VITE_GATE_ADDRESS || ZERO) as Address,
  usdc: (env.VITE_USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Address,
  firstSteps: (env.VITE_FIRSTSTEPS_ADDRESS || ZERO) as Address,
  relayerStatusUrl: (env.VITE_RELAYER_STATUS_URL || 'http://localhost:8787').replace(/\/$/, ''),
  baseExplorer: (env.VITE_BASE_EXPLORER || 'https://sepolia.basescan.org').replace(/\/$/, ''),
  portaldotExplorer: (env.VITE_PORTALDOT_EXPLORER || '').replace(/\/$/, ''),
  substrateWs: env.VITE_PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev',
};

export const baseChain = defineChain({
  id: Number(env.VITE_BASE_CHAIN_ID || 84532),
  name: Number(env.VITE_BASE_CHAIN_ID || 84532) === 84532 ? 'Base Sepolia' : 'Base (local)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [env.VITE_BASE_RPC_URL || 'https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: config.baseExplorer } },
  testnet: true,
});

export const portaldotChain = defineChain({
  id: Number(env.VITE_PORTALDOT_CHAIN_ID || 420420777),
  name: 'Portaldot Testnet',
  // The EVM side exposes 18 decimals (native tPOT has 14; pallet-revive scales).
  nativeCurrency: { name: 'Test POT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [env.VITE_PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev'] } },
  ...(config.portaldotExplorer
    ? { blockExplorers: { default: { name: 'Portaldot explorer', url: config.portaldotExplorer } } }
    : {}),
  testnet: true,
});

export const isConfigured = config.gate !== ZERO;
