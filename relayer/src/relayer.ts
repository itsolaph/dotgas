import type { Address, Hex } from 'viem';
import { GateStatus } from './abi.ts';
import { revertName, type DestChain, type SourceChain } from './chains.ts';
import { evmToNative } from './config.ts';
import type { Logger } from './log.ts';
import type { RulesClient } from './rules.ts';
import { TERMINAL, type OrderRecord, type StateStore } from './state.ts';

export interface RelayerOptions {
  safetyWindowSec: number;
  confirmations: number;
  startBlock: bigint | null;
  logChunk: bigint;
  maxAttempts: number;
  dryRun: boolean;
}

/** Dock errors that will not go away by retrying. */
const PERMANENT_DOCK_ERRORS = new Set(['AboveMaxPerFill', 'RecipientCapExceeded', 'ZeroAddress', 'ZeroAmount', 'NotRelayer']);

export class Relayer {
  readonly src: SourceChain;
  readonly dst: DestChain;
  readonly rules: RulesClient;
  readonly state: StateStore;
  readonly log: Logger;
  readonly opts: RelayerOptions;
  private running = false;

  constructor(deps: { src: SourceChain; dst: DestChain; rules: RulesClient; state: StateStore; log: Logger }, opts: RelayerOptions) {
    this.src = deps.src;
    this.dst = deps.dst;
    this.rules = deps.rules;
    this.state = deps.state;
    this.log = deps.log;
    this.opts = opts;
  }

  /** Pull new `Opened` events from Base into the state file. Returns the number of new orders. */
  async scan(): Promise<number> {
    const head = await this.src.headBlock();
    const safeHead = head - BigInt(this.opts.confirmations);
    if (safeHead < 0n) return 0;
    let from = this.state.lastScannedBlock !== null ? this.state.lastScannedBlock + 1n : (this.opts.startBlock ?? safeHead);
    let added = 0;
    while (from <= safeHead) {
      const to = from + this.opts.logChunk - 1n < safeHead ? from + this.opts.logChunk - 1n : safeHead;
      const events = await this.src.openedLogs(from, to);
      for (const e of events) {
        const isNew = this.state.add({
          orderId: e.orderId,
          user: e.user,
          recipient: e.recipient,
          tier: e.tier,
          token: e.token,
          amount: e.amount.toString(),
          dstAmount: e.dstAmount.toString(),
          deadline: Number(e.deadline),
          openTx: e.txHash,
          openBlock: e.blockNumber.toString(),
        });
        if (isNew) {
          added++;
          this.log.info('order opened', { orderId: e.orderId, recipient: e.recipient, dstAmount: e.dstAmount, deadline: e.deadline, tx: e.txHash });
        }
      }
      this.state.lastScannedBlock = to;
      from = to + 1n;
    }
    return added;
  }

  /** Advance every non-terminal order as far as possible. */
  async processAll(): Promise<void> {
    for (const rec of this.state.open()) {
      try {
        await this.process(rec.orderId);
      } catch (err) {
        const attempts = (this.state.get(rec.orderId)?.attempts ?? 0) + 1;
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        const failed = attempts >= this.opts.maxAttempts;
        if (!this.opts.dryRun) this.state.update(rec.orderId, { attempts, reason: message, ...(failed ? { status: 'failed' } : {}) });
        this.log.error('order processing error', { orderId: rec.orderId, attempts, failed, error: message });
      }
    }
  }

  async tick(): Promise<void> {
    await this.scan();
    await this.processAll();
  }

  private set(rec: OrderRecord, patch: Partial<OrderRecord>, msg: string, fields: Record<string, unknown> = {}) {
    if (this.opts.dryRun) {
      this.log.info(`[dry-run] ${msg}`, { orderId: rec.orderId, ...patch, ...fields });
      Object.assign(rec, patch);
      return rec;
    }
    this.log.info(msg, { orderId: rec.orderId, ...patch, ...fields });
    return this.state.update(rec.orderId, patch);
  }

  /** State machine for a single order. Every step is idempotent and re-checks on-chain truth first. */
  async process(orderId: Hex): Promise<void> {
    let rec = this.state.get(orderId);
    if (!rec || TERMINAL.has(rec.status)) return;
    const dry = this.opts.dryRun;

    const onchain = await this.src.getOrder(orderId);
    if (onchain.status === GateStatus.Filled) {
      this.set(rec, { status: 'claimed' }, 'order already claimed on Base');
      return;
    }
    if (onchain.status === GateStatus.Refunded) {
      this.set(rec, { status: 'refunded' }, 'order refunded by user');
      return;
    }
    if (onchain.status !== GateStatus.Open) {
      this.log.warn('order not found on gate (reorg?)', { orderId });
      return;
    }

    const now = await this.src.latestTimestamp();
    const deadline = onchain.deadline;
    const recipient = onchain.recipient as Address;
    const amount = onchain.dstAmount;

    // Recover a fill that happened before a crash (tx sent, state not yet written).
    let fillTx = rec.fillTx ?? null;
    if (!fillTx && (await this.dst.isFilled(orderId))) {
      fillTx = await this.dst.findFillTx(orderId);
      if (!fillTx) throw new Error('dock says filled but no Filled event found');
      rec = this.set(rec, { status: 'filled', fillTx }, 'recovered existing fill from Portaldot');
    }

    if (!fillTx) {
      if (now > deadline) {
        this.set(rec, { status: 'expired', reason: 'deadline passed before fill' }, 'order expired; user can refund');
        return;
      }
      if (deadline - now < BigInt(this.opts.safetyWindowSec)) {
        this.set(
          rec,
          { status: 'skipped', reason: `deadline in ${deadline - now}s < safety window ${this.opts.safetyWindowSec}s` },
          'order skipped: deadline too close',
        );
        return;
      }

      // (a) WASM rules: dry-run, then approve.
      if (this.rules.mode === 'on' && !rec.approveTx) {
        const native = evmToNative(amount);
        if (await this.rules.isApproved(orderId)) {
          rec = this.set(rec, { status: 'approved', approveTx: 'pre-existing' }, 'rules approval already on-chain');
        } else {
          const res = await this.rules.dryRunApprove(orderId, recipient, native);
          if (!res.ok) {
            this.set(rec, { status: 'rejected', reason: `rules: ${res.error}` }, 'rules rejected order');
            return;
          }
          if (dry) {
            this.log.info('[dry-run] would approve on rules', { orderId, recipient, native });
          } else {
            const { txHash, blockHash } = await this.rules.approve(orderId, recipient, native);
            rec = this.set(rec, { status: 'approved', approveTx: txHash, approveBlock: blockHash }, 'rules approved');
          }
        }
      } else if (this.rules.mode === 'off' && !rec.approveTx) {
        rec = this.set(rec, { status: 'approved', approveTx: 'off' }, 'rules step skipped (RULES_MODE=off)');
      }

      // (b) Fill on Portaldot.
      try {
        fillTx = await this.dst.fill(orderId, recipient, amount, dry);
      } catch (err) {
        const name = revertName(err);
        if (name === 'AlreadyFilled') {
          fillTx = await this.dst.findFillTx(orderId);
        } else if (name && PERMANENT_DOCK_ERRORS.has(name)) {
          this.set(rec, { status: 'rejected', reason: `dock: ${name}` }, 'dock rejected order');
          return;
        } else {
          throw err;
        }
      }
      if (dry || !fillTx) {
        if (dry) this.log.info('[dry-run] fill simulation ok; would fill and claim', { orderId, recipient, amount });
        return;
      }
      rec = this.set(rec, { status: 'filled', fillTx }, 'filled on Portaldot', { recipient, amount });
    }

    // (c) Claim on Base with the Portaldot tx hash as reference.
    const now2 = await this.src.latestTimestamp();
    if (now2 > deadline) {
      this.set(rec, { status: 'unclaimable', reason: 'claim window closed after fill' }, 'claim window missed (relayer bears the loss)');
      return;
    }
    const claimTx = await this.src.claim(orderId, fillTx, dry);
    if (claimTx) this.set(rec, { status: 'claimed', claimTx }, 'claimed on Base');
  }

  /** Poll loop. Resolves when `stop()` is called. */
  async run(intervalMs: number): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error('tick failed', { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
