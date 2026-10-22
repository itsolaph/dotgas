import { isAddress, isHex, type Address, type Hex } from 'viem';
import type { Level } from './log.ts';

export type RulesMode = 'on' | 'off';

export interface Config {
  base: { rpcUrl: string; chainId: number; gate: Address; startBlock: bigint | null; confirmations: number; logChunk: bigint };
  portaldot: {
    evmRpcUrl: string;
    chainId: number;
    dock: Address;
    dockDeployBlock: bigint;
    legacyTx: boolean;
  };
  rules: {
    mode: RulesMode;
    wsUrl: string;
    address: string;
    metadataPath: string;
    suri: string;
  };
  relayerKey: Hex;
  portaldotKey: Hex;
  safetyWindowSec: number;
  pollIntervalMs: number;
  maxAttempts: number;
  stateFile: string;
  statusPort: number;
  logLevel: Level;
  dryRun: boolean;
  once: boolean;
}

type Env = Record<string, string | undefined>;

function req(env: Env, k: string): string {
  const v = env[k];
  if (v === undefined || v === '') throw new Error(`missing required env var ${k}`);
  return v;
}

function addr(env: Env, k: string): Address {
  const v = req(env, k);
  if (!isAddress(v)) throw new Error(`${k} is not an address`);
  return v;
}

function key(env: Env, k: string, fallback?: string): Hex {
  const v = env[k] || fallback;
  if (!v) throw new Error(`missing required env var ${k}`);
  const h = (v.startsWith('0x') ? v : `0x${v}`) as Hex;
  if (!isHex(h) || h.length !== 66) throw new Error(`${k} must be a 32-byte hex private key`);
  return h;
}

function int(env: Env, k: string, d: number): number {
  const v = env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
  return n;
}

export const DEFAULT_SAFETY_WINDOW_SEC = 300;

export function loadConfig(env: Env, argv: string[] = []): Config {
  const rulesMode = (env.RULES_MODE ?? 'on').toLowerCase();
  if (rulesMode !== 'on' && rulesMode !== 'off') throw new Error('RULES_MODE must be "on" or "off"');
  const relayerKey = key(env, 'RELAYER_PRIVATE_KEY');
  return {
    base: {
      rpcUrl: req(env, 'BASE_RPC_URL'),
      chainId: int(env, 'BASE_CHAIN_ID', 84532),
      gate: addr(env, 'GATE_ADDRESS'),
      startBlock: env.BASE_START_BLOCK ? BigInt(env.BASE_START_BLOCK) : null,
      confirmations: int(env, 'BASE_CONFIRMATIONS', 2),
      logChunk: BigInt(int(env, 'BASE_LOG_CHUNK', 2000)),
    },
    portaldot: {
      evmRpcUrl: req(env, 'PORTALDOT_EVM_RPC_URL'),
      chainId: int(env, 'PORTALDOT_CHAIN_ID', 420420777),
      dock: addr(env, 'DOCK_ADDRESS'),
      dockDeployBlock: BigInt(env.DOCK_DEPLOY_BLOCK ?? '0'),
      legacyTx: (env.PORTALDOT_LEGACY_TX ?? 'true') === 'true',
    },
    rules: {
      mode: rulesMode,
      wsUrl: rulesMode === 'on' ? req(env, 'PORTALDOT_WS_URL') : (env.PORTALDOT_WS_URL ?? ''),
      address: rulesMode === 'on' ? req(env, 'RULES_ADDRESS') : (env.RULES_ADDRESS ?? ''),
      metadataPath: env.RULES_METADATA ?? 'contracts/ink/ferry_rules/target/ink/ferry_rules.json',
      suri: rulesMode === 'on' ? req(env, 'RULES_SURI') : '',
    },
    relayerKey,
    portaldotKey: key(env, 'PORTALDOT_RELAYER_PRIVATE_KEY', relayerKey),
    safetyWindowSec: int(env, 'SAFETY_WINDOW_SEC', DEFAULT_SAFETY_WINDOW_SEC),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MS', 4000),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 5),
    stateFile: env.STATE_FILE ?? 'relayer-state/ferry.state.json',
    statusPort: int(env, 'STATUS_PORT', 8787),
    logLevel: (env.LOG_LEVEL as Level) ?? 'info',
    dryRun: argv.includes('--dry-run') || env.DRY_RUN === 'true',
    once: argv.includes('--once'),
  };
}

/** EVM side shows 18 decimals; native tPOT has 14. ink! rules work in native units. */
export const EVM_TO_NATIVE = 10n ** 4n;

export function evmToNative(wei: bigint): bigint {
  return wei / EVM_TO_NATIVE;
}
