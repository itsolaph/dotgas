import type { Address, Hex } from 'viem';
import { GateStatus } from './abi.ts';
import { PERMANENT_DOCK_ERRORS, revertName, type DestChain, type FillReceipt, type GateOrder, type SourceChain } from './chains.ts';
import { evmToNative } from './config.ts';
import type { Logger } from './log.ts';
import type { RulesClient } from './rules.ts';
import { STAGE_RANK, TERMINAL, isCommitted, type OrderRecord, type StateStore } from './state.ts';

export interface RelayerOptions {
  safetyWindowSec: number;
  /** Base confirmations for scanning (reserve receipts are waited for in the source adapter). */
  confirmations: number;
  /** Portaldot blocks on top of the fill before it is claimed. */
  dstConfirmations: number;
  /** First block of the first scan (the Gate deploy block). */
  startBlock: bigint;
  logChunk: bigint;
  /** Pre-payout attempts before an unreserved order is marked `failed`. */
  maxAttempts: number;
  retryBackoffMs: number;
  retryBackoffMaxMs: number;
  /** Only fill once the ink! approval is finalized (RULES_FINALITY=finalized). */
  requireFinalizedApproval: boolean;
  dryRun: boolean;
  /** Wall clock in ms, injectable for tests. */
  now?: () => number;
}

type FillCheck = { kind: 'none' } | { kind: 'pending' } | { kind: 'done'; fillTx: Hex; receipt: FillReceipt };

const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err));

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

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Pull new `Opened` events from Base into the state file. Returns the number of new orders. The first scan
   * starts at the Gate deploy block, so a fresh or lost state file is rebuilt from events; each order's
   * current Gate state (open, reserved, settled) is then read by `process`.
   */
  async scan(): Promise<number> {
    const head = await this.src.headBlock();
    const safeHead = head - BigInt(this.opts.confirmations);
    if (safeHead < 0n) return 0;
    let from = this.state.lastScannedBlock !== null ? this.state.lastScannedBlock + 1n : this.opts.startBlock;
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
      if (rec.nextAttemptAt && rec.nextAttemptAt > this.now()) continue;
      try {
        await this.process(rec.orderId);
      } catch (err) {
        this.onError(rec.orderId, err);
      }
    }
  }

  /**
   * Pre-payout failures (nothing reserved, nothing sent to Portaldot) may end in a terminal `failed`.
   * Once an order is reserved or has a fill tx, the user's escrow is locked or tPOT has left the pool, so
   * the relayer never gives up: it keeps retrying with backoff and logs every failure as an error.
   */
  private onError(orderId: Hex, err: unknown) {
    const cur = this.state.get(orderId);
    if (!cur) return;
    const attempts = (cur.attempts ?? 0) + 1;
    const committed = isCommitted(cur);
    const failed = !committed && attempts >= this.opts.maxAttempts;
    const delay = Math.min(this.opts.retryBackoffMs * 2 ** Math.min(attempts - 1, 30), this.opts.retryBackoffMaxMs);
    const message = errMsg(err);
    if (!this.opts.dryRun) {
      this.state.update(orderId, { attempts, reason: message, nextAttemptAt: failed ? undefined : this.now() + delay, ...(failed ? { status: 'failed' } : {}) });
    }
    const fields = { orderId, status: cur.status, attempts, retryInMs: failed ? null : delay, error: message };
    if (committed) this.log.error('SETTLEMENT RECOVERY: reserved/paid order failed a step, retrying until settled', fields);
    else this.log.error('order processing error', { ...fields, failed });
  }

  async tick(): Promise<void> {
    await this.scan();
    await this.processAll();
  }

  private set(rec: OrderRecord, patch: Partial<OrderRecord>, msg: string, fields: Record<string, unknown> = {}) {
    const progressed = patch.status !== undefined && (STAGE_RANK[patch.status] ?? -1) > (STAGE_RANK[rec.status] ?? -1);
    const full: Partial<OrderRecord> = progressed ? { attempts: 0, nextAttemptAt: undefined, reason: undefined, ...patch } : patch;
    if (this.opts.dryRun) {
      this.log.info(`[dry-run] ${msg}`, { orderId: rec.orderId, ...patch, ...fields });
      Object.assign(rec, full);
      return rec;
    }
    this.log.info(msg, { orderId: rec.orderId, ...patch, ...fields });
    return this.state.update(rec.orderId, full);
  }

  /** State machine for a single order. Every step is idempotent and re-checks on-chain truth first. */
  async process(orderId: Hex): Promise<void> {
    const rec = this.state.get(orderId);
    if (!rec || TERMINAL.has(rec.status)) return;

    const onchain = await this.src.getOrder(orderId);
    switch (onchain.status) {
      case GateStatus.Filled:
        this.set(rec, { status: 'claimed' }, 'order claimed on Base');
        return;
      case GateStatus.Refunded:
        if (rec.fillTx || (await this.dst.isFilled(orderId))) {
          this.log.error('order refunded on Base after it was filled on Portaldot (relayer loss)', { orderId, fillTx: rec.fillTx });
        }
        this.set(rec, { status: 'refunded' }, 'order refunded by user');
        return;
      case GateStatus.Open:
        return this.processOpen(rec, onchain);
      case GateStatus.Reserved:
        return this.processReserved(rec, onchain);
      default:
        this.log.warn('order not found on gate (reorg?)', { orderId });
    }
  }

  /** Gate says `Open`: decide whether to reserve. Nothing has been paid out unless a fill already exists. */
  private async processOpen(rec: OrderRecord, o: GateOrder): Promise<void> {
    const orderId = rec.orderId;
    const dry = this.opts.dryRun;
    const recipient = o.recipient as Address;
    const amount = o.dstAmount;

    if (rec.reserveTx) {
      // Broadcast earlier but not (or no longer) visible on the Gate: dropped, reverted or reorged out.
      this.log.warn('reserve tx not reflected on the Gate, reserving again', { orderId, reserveTx: rec.reserveTx });
    }

    const now = await this.src.latestTimestamp();
    const deadline = o.deadline;
    const paid = Boolean(rec.fillTx) || (await this.dst.isFilled(orderId));
    if (paid) {
      // Not reachable through this relayer's own flow (it only fills reserved orders). Try to reserve so the
      // payment can still be claimed; if the window is gone the relayer bears the loss.
      this.log.error('order filled on Portaldot while open on Base, reserving to claim', { orderId, fillTx: rec.fillTx });
    } else {
      if (now > deadline) {
        this.set(rec, { status: 'expired', reason: 'deadline passed before reservation' }, 'order expired; user can refund');
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
      // Cheap pre-checks so an order that would be refused is never reserved (a reservation delays the refund).
      const sim = await this.dst.simulateFill(orderId, recipient, amount);
      if (!sim.ok) {
        if (sim.permanent) {
          this.set(rec, { status: 'rejected', reason: `dock: ${sim.error}` }, 'dock would reject order');
          return;
        }
        throw new Error(`dock fill simulation failed: ${sim.error}`);
      }
      if (this.rules.mode === 'on' && (await this.rules.approvalState(orderId)) === 'none') {
        const res = await this.rules.dryRunApprove(orderId, recipient, evmToNative(amount));
        if (!res.ok) {
          this.set(rec, { status: 'rejected', reason: `rules: ${res.error}` }, 'rules rejected order');
          return;
        }
      }
    }

    if (dry) {
      await this.src.reserve(orderId, true).catch((err) => this.log.warn('[dry-run] reserve simulation failed', { orderId, error: errMsg(err) }));
      this.log.info('[dry-run] checks ok; would reserve, approve, fill and claim', { orderId, recipient, amount });
      return;
    }

    try {
      await this.src.reserve(orderId, false, (hash) => {
        rec = this.set(rec, { reserveTx: hash }, 'reserve broadcast on Base');
      });
    } catch (err) {
      const name = revertName(err);
      if (name === 'ReserveWindowClosed') {
        const status = paid ? 'unclaimable' : 'skipped';
        this.set(rec, { status, reason: 'Gate reserve window closed' }, paid ? 'cannot reserve a filled order (relayer loss)' : 'order skipped: Gate reserve window closed');
        return;
      }
      if (name === 'NotOpen') return; // state moved under us; the next pass re-reads it
      throw err;
    }
    // Re-read: only continue once the Gate itself shows the reservation.
    const after = await this.src.getOrder(orderId);
    if (after.status !== GateStatus.Reserved) throw new Error(`reserve confirmed but Gate status is ${after.status}`);
    rec = this.set(rec, { status: 'reserved', reservedAt: Number(after.reservedAt) }, 'reserved on Base');
    await this.processReserved(rec, after);
  }

  /** Gate says `Reserved`: the escrow is locked for us. Fill (once) and claim, or release if we will not. */
  private async processReserved(rec: OrderRecord, o: GateOrder): Promise<void> {
    if (STAGE_RANK[rec.status] === STAGE_RANK.pending) {
      rec = this.set(rec, { status: 'reserved', reservedAt: Number(o.reservedAt) }, 'adopted on-chain reservation');
    }
    let fill = await this.checkFill(rec);
    if (fill.kind === 'pending') {
      this.log.debug('fill tx pending on Portaldot', { orderId: rec.orderId, fillTx: rec.fillTx });
      return;
    }
    if (fill.kind === 'none') {
      const sent = await this.payout(rec, o);
      if (!sent) return;
      fill = await this.checkFill(this.state.get(rec.orderId) ?? rec);
      if (fill.kind !== 'done') return;
    }
    await this.settle(this.state.get(rec.orderId) ?? rec, fill);
  }

  /**
   * Has the Dock recorded the fill for this order, and which tx did it? The stored hash is only trusted if
   * its receipt succeeded, it emitted `Filled(orderId)` from the Dock, and `Dock.filled(orderId)` is true.
   */
  private async checkFill(rec: OrderRecord): Promise<FillCheck> {
    const orderId = rec.orderId;
    const onDock = await this.dst.isFilled(orderId);
    if (rec.fillTx) {
      const r = await this.dst.fillReceipt(rec.fillTx);
      if (onDock && r?.success && r.filledOrderIds.includes(orderId)) return { kind: 'done', fillTx: rec.fillTx, receipt: r };
      if (!onDock) {
        if (r === null && (await this.dst.txPending(rec.fillTx))) return { kind: 'pending' };
        // Dropped or reverted. Sending a new fill is safe: the Dock's replay guard rejects a second fill.
        this.log.warn('stored fill tx did not fill the order, will fill again', { orderId, fillTx: rec.fillTx, mined: r !== null, success: r?.success });
        // Status stays `filling` (no stage progress), so retry backoff keeps growing if fills keep failing.
        this.set(rec, { fillTx: undefined, fillBlock: undefined, status: 'filling' }, 'cleared failed fill tx');
        return { kind: 'none' };
      }
      this.log.warn('stored fill tx does not prove the fill, looking it up on Portaldot', { orderId, fillTx: rec.fillTx });
    }
    if (!onDock) return { kind: 'none' };
    const found = await this.dst.findFillTx(orderId);
    if (!found) throw new Error('dock says filled but no Filled event found');
    const r = await this.dst.fillReceipt(found);
    if (!r?.success || !r.filledOrderIds.includes(orderId)) throw new Error(`Filled event tx ${found} does not verify`);
    if (found !== rec.fillTx) this.set(rec, { fillTx: found, fillBlock: r.blockNumber.toString(), status: 'filled' }, 'recovered fill from Portaldot');
    return { kind: 'done', fillTx: found, receipt: r };
  }

  /** Give the reservation back so the user can refund at the original deadline instead of the timeout. */
  private async releaseWith(rec: OrderRecord, patch: Partial<OrderRecord>, msg: string) {
    let releaseTx: Hex | null = null;
    if (!this.opts.dryRun) {
      try {
        releaseTx = await this.src.release(rec.orderId, false);
      } catch (err) {
        if (revertName(err) !== 'NotReserved') throw err;
      }
    }
    this.set(rec, { ...patch, ...(releaseTx ? { releaseTx } : {}) }, msg);
  }

  /** Reserved, nothing paid yet: approve on the rules, then fill on Portaldot. Returns true once a fill landed. */
  private async payout(rec: OrderRecord, o: GateOrder): Promise<boolean> {
    const orderId = rec.orderId;
    const dry = this.opts.dryRun;
    const recipient = o.recipient as Address;
    const amount = o.dstAmount;

    // Never start a fill that could land after the reservation times out (the user could refund meanwhile).
    const now = await this.src.latestTimestamp();
    const expiresAt = o.reservedAt + (await this.src.reserveTimeout());
    if (now + BigInt(this.opts.safetyWindowSec) > expiresAt) {
      await this.releaseWith(rec, { status: 'expired', reason: 'reservation too close to its timeout to fill' }, 'reservation released: too late to fill');
      return false;
    }

    // (a) Simulate the Dock fill before touching the rules budget.
    const sim = await this.dst.simulateFill(orderId, recipient, amount);
    if (!sim.ok) {
      if (sim.permanent) {
        await this.releaseWith(rec, { status: 'rejected', reason: `dock: ${sim.error}` }, 'dock would reject order; reservation released');
        return false;
      }
      throw new Error(`dock fill simulation failed: ${sim.error}`);
    }

    // (b) WASM rules. Chain state decides, not the stored approveTx.
    if (this.rules.mode === 'on') {
      const native = evmToNative(amount);
      let approval = await this.rules.approvalState(orderId);
      if (approval === 'none') {
        if (rec.approveTx) this.log.warn('stored rules approval not found on chain, approving again', { orderId, approveTx: rec.approveTx });
        const res = await this.rules.dryRunApprove(orderId, recipient, native);
        if (!res.ok) {
          await this.releaseWith(rec, { status: 'rejected', reason: `rules: ${res.error}` }, 'rules rejected order; reservation released');
          return false;
        }
        if (dry) {
          this.log.info('[dry-run] would approve on rules', { orderId, recipient, native });
          return false;
        }
        const { txHash, blockHash, finalized } = await this.rules.approve(orderId, recipient, native);
        rec = this.set(rec, { approveTx: txHash, approveBlock: blockHash }, finalized ? 'rules approval finalized' : 'rules approval included');
        approval = await this.rules.approvalState(orderId);
        if (approval === 'none') throw new Error('rules approve returned but no approval is on chain');
      }
      if (this.opts.requireFinalizedApproval && approval !== 'finalized') {
        this.log.info('waiting for rules approval finality', { orderId, approveBlock: rec.approveBlock });
        return false;
      }
      if (rec.status === 'reserved') rec = this.set(rec, { status: 'approved', approveTx: rec.approveTx ?? 'pre-existing' }, 'rules approval on chain');
    } else if (rec.status === 'reserved') {
      rec = this.set(rec, { status: 'approved', approveTx: 'off' }, 'rules step skipped (RULES_MODE=off)');
    }

    // (c) Re-read the Gate right before paying: only fill an order that is still reserved for us.
    const gate = await this.src.getOrder(orderId);
    if (gate.status !== GateStatus.Reserved) {
      this.log.warn('gate no longer reserved right before fill, not filling', { orderId, status: gate.status });
      return false;
    }

    // (d) Fill on Portaldot. The hash is persisted the moment it is broadcast.
    let fillTx: Hex | null;
    try {
      fillTx = await this.dst.fill(orderId, recipient, amount, dry, (hash) => {
        rec = this.set(rec, { fillTx: hash, status: 'filling' }, 'fill broadcast on Portaldot');
      });
    } catch (err) {
      const name = revertName(err);
      if (name === 'AlreadyFilled') return true; // checkFill will locate and verify it
      if (name && PERMANENT_DOCK_ERRORS.has(name) && !rec.fillTx) {
        await this.releaseWith(rec, { status: 'rejected', reason: `dock: ${name}` }, 'dock rejected order; reservation released');
        return false;
      }
      throw err;
    }
    if (dry || !fillTx) {
      if (dry) this.log.info('[dry-run] fill simulation ok; would fill and claim', { orderId, recipient, amount });
      return false;
    }
    this.log.info('fill mined on Portaldot', { orderId, fillTx, recipient, amount });
    return true;
  }

  /** Fill verified on Portaldot: wait for confirmations, then claim on Base citing the fill tx. */
  private async settle(rec: OrderRecord, fill: { fillTx: Hex; receipt: FillReceipt }): Promise<void> {
    const orderId = rec.orderId;
    if (rec.status !== 'filled' || rec.fillTx !== fill.fillTx) {
      rec = this.set(rec, { status: 'filled', fillTx: fill.fillTx, fillBlock: fill.receipt.blockNumber.toString() }, 'fill verified on Portaldot');
    }
    if (fill.receipt.confirmations < BigInt(this.opts.dstConfirmations)) {
      this.log.debug('waiting for Portaldot confirmations before claim', { orderId, have: fill.receipt.confirmations, need: this.opts.dstConfirmations });
      return;
    }
    if (this.opts.dryRun) {
      await this.src.claim(orderId, fill.fillTx, true);
      this.log.info('[dry-run] claim simulation ok', { orderId });
      return;
    }
    const claimTx = await this.src.claim(orderId, fill.fillTx, false, (hash) => {
      rec = this.set(rec, { claimTx: hash }, 'claim broadcast on Base');
    });
    if (claimTx) this.set(rec, { status: 'claimed', claimTx }, 'claimed on Base');
  }

  /** Poll loop. Resolves when `stop()` is called. */
  async run(intervalMs: number): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error('tick failed', { error: errMsg(err) });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop() {
    this.running = false;
  }
}
