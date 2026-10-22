import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { dockAbi, gateAbi } from './abi.ts';
import type { Config } from './config.ts';

export interface OpenedEvent {
  orderId: Hex;
  user: Address;
  recipient: Address;
  tier: number;
  token: Address;
  amount: bigint;
  dstAmount: bigint;
  deadline: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

export interface GateOrder {
  user: Address;
  recipient: Address;
  token: Address;
  tier: number;
  status: number;
  deadline: bigint;
  reservedAt: bigint;
  amount: bigint;
  dstAmount: bigint;
}

/** Called with the tx hash as soon as it is broadcast, before waiting for the receipt. */
export type OnBroadcast = (hash: Hex) => void;

/** Base Sepolia side (LandfallGate). */
export interface SourceChain {
  headBlock(): Promise<bigint>;
  latestTimestamp(): Promise<bigint>;
  openedLogs(from: bigint, to: bigint): Promise<OpenedEvent[]>;
  getOrder(orderId: Hex): Promise<GateOrder>;
  reserveTimeout(): Promise<bigint>;
  /** Simulates then sends `reserve`, waits for the receipt plus the configured confirmations. */
  reserve(orderId: Hex, dryRun: boolean, onBroadcast?: OnBroadcast): Promise<Hex | null>;
  /** Simulates then sends `release` (give a reservation back), waits for the receipt. */
  release(orderId: Hex, dryRun: boolean): Promise<Hex | null>;
  /** Simulates then sends `claim`, waits for the receipt. */
  claim(orderId: Hex, fillTxRef: Hex, dryRun: boolean, onBroadcast?: OnBroadcast): Promise<Hex | null>;
}

export interface FillReceipt {
  success: boolean;
  blockNumber: bigint;
  /** Blocks on top of the inclusion block (0 = just included). */
  confirmations: bigint;
  /** Order ids of the `Filled` events this tx emitted from the Dock. */
  filledOrderIds: Hex[];
}

export type FillSimulation = { ok: true } | { ok: false; error: string; permanent: boolean };

/** Portaldot EVM side (LandfallDock). */
export interface DestChain {
  isFilled(orderId: Hex): Promise<boolean>;
  findFillTx(orderId: Hex): Promise<Hex | null>;
  /** null while the tx is not mined (still pending, or dropped). */
  fillReceipt(hash: Hex): Promise<FillReceipt | null>;
  /** True if the node still knows the tx and it is not mined yet. */
  txPending(hash: Hex): Promise<boolean>;
  /** Checks pool balance, pause, maxPerFill and recipient cap, then eth_call's `fill` from the relayer. */
  simulateFill(orderId: Hex, recipient: Address, amount: bigint): Promise<FillSimulation>;
  poolBalance(): Promise<bigint>;
  dockStats(): Promise<{ totalFilled: bigint; fillCount: bigint; paused: boolean; maxPerFill: bigint; recipientCap: bigint }>;
  /** Simulates then sends `fill`, waits for the receipt. Returns null in dry-run after a successful simulation. */
  fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean, onBroadcast?: OnBroadcast): Promise<Hex | null>;
}

/** Dock errors that will not go away by retrying. */
export const PERMANENT_DOCK_ERRORS = new Set(['AboveMaxPerFill', 'RecipientCapExceeded', 'ZeroAddress', 'ZeroAmount', 'NotRelayer']);

/** Decoded custom-error name from a viem contract error, if any. */
export function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? 'reverted';
  }
  return null;
}

function chain(id: number, name: string, rpc: string): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name, symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
}

export class ViemSource implements SourceChain {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly gate: Address;
  readonly confirmations: number;

  constructor(cfg: Config) {
    const c = chain(cfg.base.chainId, 'base', cfg.base.rpcUrl);
    this.confirmations = cfg.base.confirmations;
    this.account = privateKeyToAccount(cfg.relayerKey);
    this.pub = createPublicClient({ chain: c, transport: http(cfg.base.rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain: c, transport: http(cfg.base.rpcUrl), account: this.account });
    this.gate = cfg.base.gate;
  }

  headBlock() {
    return this.pub.getBlockNumber({ cacheTime: 0 });
  }

  async latestTimestamp() {
    return (await this.pub.getBlock({ blockTag: 'latest' })).timestamp;
  }

  async openedLogs(from: bigint, to: bigint): Promise<OpenedEvent[]> {
    const logs = await this.pub.getContractEvents({
      address: this.gate,
      abi: gateAbi,
      eventName: 'Opened',
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    return logs.map((l) => ({
      orderId: l.args.orderId,
      user: l.args.user,
      recipient: l.args.recipient,
      tier: l.args.tier,
      token: l.args.token,
      amount: l.args.amount,
      dstAmount: l.args.dstAmount,
      deadline: l.args.deadline,
      txHash: l.transactionHash,
      blockNumber: l.blockNumber,
    }));
  }

  async getOrder(orderId: Hex): Promise<GateOrder> {
    const o = await this.pub.readContract({ address: this.gate, abi: gateAbi, functionName: 'getOrder', args: [orderId] });
    return { ...o };
  }

  reserveTimeout() {
    return this.pub.readContract({ address: this.gate, abi: gateAbi, functionName: 'reserveTimeout' });
  }

  private async send(
    functionName: 'reserve' | 'release' | 'claim',
    args: readonly [Hex] | readonly [Hex, Hex],
    dryRun: boolean,
    confirmations: number,
    onBroadcast?: OnBroadcast,
  ): Promise<Hex | null> {
    const { request } = await this.pub.simulateContract({
      address: this.gate,
      abi: gateAbi,
      functionName,
      args: args as never,
      account: this.account,
    });
    if (dryRun) return null;
    const hash = await this.wallet.writeContract(request);
    onBroadcast?.(hash);
    // viem counts the inclusion block as the first confirmation.
    const rcpt = await this.pub.waitForTransactionReceipt({ hash, confirmations: confirmations + 1 });
    if (rcpt.status !== 'success') throw new Error(`${functionName} tx ${hash} reverted`);
    return hash;
  }

  reserve(orderId: Hex, dryRun: boolean, onBroadcast?: OnBroadcast) {
    return this.send('reserve', [orderId], dryRun, this.confirmations, onBroadcast);
  }

  release(orderId: Hex, dryRun: boolean) {
    return this.send('release', [orderId], dryRun, 0);
  }

  claim(orderId: Hex, fillTxRef: Hex, dryRun: boolean, onBroadcast?: OnBroadcast) {
    return this.send('claim', [orderId, fillTxRef], dryRun, 0, onBroadcast);
  }
}

export class ViemDest implements DestChain {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly dock: Address;
  readonly deployBlock: bigint;
  readonly logChunk: bigint;
  readonly legacy: boolean;

  constructor(cfg: Config) {
    const c = chain(cfg.portaldot.chainId, 'portaldot', cfg.portaldot.evmRpcUrl);
    this.account = privateKeyToAccount(cfg.portaldotKey);
    this.pub = createPublicClient({ chain: c, transport: http(cfg.portaldot.evmRpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain: c, transport: http(cfg.portaldot.evmRpcUrl), account: this.account });
    this.dock = cfg.portaldot.dock;
    this.deployBlock = cfg.portaldot.dockDeployBlock;
    this.logChunk = cfg.portaldot.logChunk;
    this.legacy = cfg.portaldot.legacyTx;
  }

  isFilled(orderId: Hex) {
    return this.pub.readContract({ address: this.dock, abi: dockAbi, functionName: 'filled', args: [orderId] });
  }

  private async filledLog(orderId: Hex, fromBlock: bigint, toBlock: bigint): Promise<Hex | null> {
    const logs = await this.pub.getContractEvents({ address: this.dock, abi: dockAbi, eventName: 'Filled', args: { orderId }, fromBlock, toBlock });
    return logs[0]?.transactionHash ?? null;
  }

  /** Uses `Dock.filledAt` for a one-block lookup; falls back to a chunked scan from the deploy block. */
  async findFillTx(orderId: Hex): Promise<Hex | null> {
    const at = await this.pub
      .readContract({ address: this.dock, abi: dockAbi, functionName: 'filledAt', args: [orderId] })
      .catch(() => 0n);
    if (at > 0n) {
      const hit = await this.filledLog(orderId, at, at);
      if (hit) return hit;
    }
    const head = await this.pub.getBlockNumber({ cacheTime: 0 });
    for (let from = this.deployBlock; from <= head; from += this.logChunk) {
      const to = from + this.logChunk - 1n < head ? from + this.logChunk - 1n : head;
      const hit = await this.filledLog(orderId, from, to);
      if (hit) return hit;
    }
    return null;
  }

  async fillReceipt(hash: Hex): Promise<FillReceipt | null> {
    let rcpt;
    try {
      rcpt = await this.pub.getTransactionReceipt({ hash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
    const head = await this.pub.getBlockNumber({ cacheTime: 0 });
    const dockLogs = rcpt.logs.filter((l) => l.address.toLowerCase() === this.dock.toLowerCase());
    return {
      success: rcpt.status === 'success',
      blockNumber: rcpt.blockNumber,
      confirmations: head > rcpt.blockNumber ? head - rcpt.blockNumber : 0n,
      filledOrderIds: parseEventLogs({ abi: dockAbi, logs: dockLogs, eventName: 'Filled' }).map((l) => l.args.orderId),
    };
  }

  async txPending(hash: Hex): Promise<boolean> {
    try {
      const tx = await this.pub.getTransaction({ hash });
      return tx.blockNumber === null;
    } catch {
      return false;
    }
  }

  async simulateFill(orderId: Hex, recipient: Address, amount: bigint): Promise<FillSimulation> {
    const [{ paused, maxPerFill, recipientCap }, received, pool] = await Promise.all([
      this.dockStats(),
      this.pub.readContract({ address: this.dock, abi: dockAbi, functionName: 'receivedBy', args: [recipient] }),
      this.pub.getBalance({ address: this.dock }),
    ]);
    if (amount > maxPerFill) return { ok: false, error: 'AboveMaxPerFill', permanent: true };
    if (received + amount > recipientCap) return { ok: false, error: 'RecipientCapExceeded', permanent: true };
    if (paused) return { ok: false, error: 'EnforcedPause', permanent: false };
    if (amount > pool) return { ok: false, error: 'InsufficientPool', permanent: false };
    try {
      await this.pub.simulateContract({ address: this.dock, abi: dockAbi, functionName: 'fill', args: [orderId, recipient, amount], account: this.account });
    } catch (err) {
      const name = revertName(err);
      if (!name) throw err; // RPC trouble, not a verdict on the fill
      return { ok: false, error: name, permanent: PERMANENT_DOCK_ERRORS.has(name) };
    }
    return { ok: true };
  }

  poolBalance() {
    return this.pub.getBalance({ address: this.dock });
  }

  async dockStats() {
    const r = (fn: 'totalFilled' | 'fillCount' | 'maxPerFill' | 'recipientCap') =>
      this.pub.readContract({ address: this.dock, abi: dockAbi, functionName: fn });
    const [totalFilled, fillCount, maxPerFill, recipientCap, paused] = await Promise.all([
      r('totalFilled'),
      r('fillCount'),
      r('maxPerFill'),
      r('recipientCap'),
      this.pub.readContract({ address: this.dock, abi: dockAbi, functionName: 'paused' }),
    ]);
    return { totalFilled, fillCount, paused, maxPerFill, recipientCap };
  }

  async fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean, onBroadcast?: OnBroadcast): Promise<Hex | null> {
    // Gas is always estimated by the node: Portaldot (pallet-revive) estimates are huge and must not be hardcoded.
    const { request } = await this.pub.simulateContract({
      address: this.dock,
      abi: dockAbi,
      functionName: 'fill',
      args: [orderId, recipient, amount],
      account: this.account,
    });
    if (dryRun) return null;
    const hash = this.legacy
      ? await this.wallet.writeContract({
          address: this.dock,
          abi: dockAbi,
          functionName: 'fill',
          args: [orderId, recipient, amount],
          account: this.account,
          chain: this.wallet.chain,
          type: 'legacy',
        })
      : await this.wallet.writeContract(request);
    onBroadcast?.(hash);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`fill tx ${hash} reverted`);
    return hash;
  }
}
