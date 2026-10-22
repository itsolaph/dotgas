import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
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
  amount: bigint;
  dstAmount: bigint;
}

/** Base Sepolia side (LandfallGate). */
export interface SourceChain {
  headBlock(): Promise<bigint>;
  latestTimestamp(): Promise<bigint>;
  openedLogs(from: bigint, to: bigint): Promise<OpenedEvent[]>;
  getOrder(orderId: Hex): Promise<GateOrder>;
  /** Simulates then sends `claim`, waits for the receipt. */
  claim(orderId: Hex, fillTxRef: Hex, dryRun: boolean): Promise<Hex | null>;
}

/** Portaldot EVM side (LandfallDock). */
export interface DestChain {
  isFilled(orderId: Hex): Promise<boolean>;
  findFillTx(orderId: Hex): Promise<Hex | null>;
  poolBalance(): Promise<bigint>;
  dockStats(): Promise<{ totalFilled: bigint; fillCount: bigint; paused: boolean; maxPerFill: bigint; recipientCap: bigint }>;
  /** Simulates then sends `fill`, waits for the receipt. Returns null in dry-run after a successful simulation. */
  fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean): Promise<Hex | null>;
}

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

  constructor(cfg: Config) {
    const c = chain(cfg.base.chainId, 'base', cfg.base.rpcUrl);
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

  async claim(orderId: Hex, fillTxRef: Hex, dryRun: boolean): Promise<Hex | null> {
    const { request } = await this.pub.simulateContract({
      address: this.gate,
      abi: gateAbi,
      functionName: 'claim',
      args: [orderId, fillTxRef],
      account: this.account,
    });
    if (dryRun) return null;
    const hash = await this.wallet.writeContract(request);
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`claim tx ${hash} reverted`);
    return hash;
  }
}

export class ViemDest implements DestChain {
  readonly pub: PublicClient;
  readonly wallet: WalletClient;
  readonly account: Account;
  readonly dock: Address;
  readonly deployBlock: bigint;
  readonly legacy: boolean;

  constructor(cfg: Config) {
    const c = chain(cfg.portaldot.chainId, 'portaldot', cfg.portaldot.evmRpcUrl);
    this.account = privateKeyToAccount(cfg.portaldotKey);
    this.pub = createPublicClient({ chain: c, transport: http(cfg.portaldot.evmRpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain: c, transport: http(cfg.portaldot.evmRpcUrl), account: this.account });
    this.dock = cfg.portaldot.dock;
    this.deployBlock = cfg.portaldot.dockDeployBlock;
    this.legacy = cfg.portaldot.legacyTx;
  }

  isFilled(orderId: Hex) {
    return this.pub.readContract({ address: this.dock, abi: dockAbi, functionName: 'filled', args: [orderId] });
  }

  async findFillTx(orderId: Hex): Promise<Hex | null> {
    const logs = await this.pub.getContractEvents({
      address: this.dock,
      abi: dockAbi,
      eventName: 'Filled',
      args: { orderId },
      fromBlock: this.deployBlock,
      toBlock: 'latest',
    });
    return logs[0]?.transactionHash ?? null;
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

  async fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean): Promise<Hex | null> {
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
    const rcpt = await this.pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`fill tx ${hash} reverted`);
    return hash;
  }
}
