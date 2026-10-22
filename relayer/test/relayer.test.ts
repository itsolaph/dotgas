import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  encodeErrorResult,
  encodeFunctionResult,
  decodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { Relayer, type RelayerOptions } from '../src/relayer.ts';
import { StateStore } from '../src/state.ts';
import { silentLogger } from '../src/log.ts';
import { ViemDest, type DestChain, type FillReceipt, type FillSimulation, type GateOrder, type OnBroadcast, type OpenedEvent, type SourceChain } from '../src/chains.ts';
import type { ApprovalState, DryRunResult, RulesClient } from '../src/rules.ts';
import { dockAbi, gateAbi, GateStatus } from '../src/abi.ts';
import { evmToNative, loadConfig } from '../src/config.ts';

const RECIPIENT = '0x00000000000000000000000000000000000a11ce' as Address;
const USER = '0x000000000000000000000000000000000000b0b0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const txh = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0').slice(0, 64)}` as Hex;
const TPOT = 10n ** 18n;

/** A viem revert error carrying a decoded custom error, like the real adapters throw. */
function revert(abi: Abi, errorName: string, args: readonly unknown[] = []) {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  return new ContractFunctionRevertedError({ abi, data, functionName: 'x' });
}

/** Shared action trace across the fakes, to check ordering. */
type Trace = string[];

/** Models LandfallGate: Open -> Reserved -> Filled / Refunded, with reserveSafety and reserveTimeout. */
class FakeGate implements SourceChain {
  head = 100n;
  now = 1_000_000n;
  reserveSafety = 120n;
  timeout = 86_400n;
  orders = new Map<Hex, GateOrder>();
  events: OpenedEvent[] = [];
  claims: Array<{ orderId: Hex; ref: Hex }> = [];
  reserves: Hex[] = [];
  releases: Hex[] = [];
  failReserve: Error | null = null;
  readonly trace: Trace;
  constructor(trace: Trace) {
    this.trace = trace;
  }

  open(n: number, ttl = 1800n, block = 10n, dstAmount = 5n * TPOT) {
    const orderId = id(n);
    const o: GateOrder = { user: USER, recipient: RECIPIENT, token: ZERO, tier: 1, status: GateStatus.Open, deadline: this.now + ttl, reservedAt: 0n, amount: 10n ** 15n, dstAmount };
    this.orders.set(orderId, o);
    this.events.push({ orderId, ...o, txHash: txh(`open${n}`), blockNumber: block });
    return orderId;
  }
  o(orderId: Hex) {
    return this.orders.get(orderId)!;
  }
  async headBlock() {
    return this.head;
  }
  async latestTimestamp() {
    return this.now;
  }
  async openedLogs(from: bigint, to: bigint) {
    return this.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
  }
  async getOrder(orderId: Hex) {
    const o = this.orders.get(orderId);
    return o ? { ...o } : { user: ZERO, recipient: ZERO, token: ZERO, tier: 0, status: 0, deadline: 0n, reservedAt: 0n, amount: 0n, dstAmount: 0n };
  }
  async reserveTimeout() {
    return this.timeout;
  }
  async reserve(orderId: Hex, dryRun: boolean, onBroadcast?: OnBroadcast) {
    if (this.failReserve) throw this.failReserve;
    const o = this.o(orderId);
    if (o.status !== GateStatus.Open) throw revert(gateAbi, 'NotOpen', [orderId]);
    if (this.now + this.reserveSafety > o.deadline) throw revert(gateAbi, 'ReserveWindowClosed', [orderId]);
    if (dryRun) return null;
    const h = txh(`reserve${this.reserves.length + 1}`);
    onBroadcast?.(h);
    o.status = GateStatus.Reserved;
    o.reservedAt = this.now;
    this.reserves.push(orderId);
    this.trace.push('reserve');
    return h;
  }
  async release(orderId: Hex, dryRun: boolean) {
    const o = this.o(orderId);
    if (o.status !== GateStatus.Reserved) throw revert(gateAbi, 'NotReserved', [orderId]);
    if (dryRun) return null;
    o.status = GateStatus.Open;
    o.reservedAt = 0n;
    this.releases.push(orderId);
    this.trace.push('release');
    return txh(`release${this.releases.length}`);
  }
  async claim(orderId: Hex, ref: Hex, dryRun: boolean, onBroadcast?: OnBroadcast) {
    const o = this.o(orderId);
    if (o.status !== GateStatus.Reserved) throw revert(gateAbi, 'NotReserved', [orderId]);
    if (dryRun) return null;
    const h = txh(`claim${this.claims.length + 1}`);
    onBroadcast?.(h);
    o.status = GateStatus.Filled;
    this.claims.push({ orderId, ref });
    this.trace.push('claim');
    return h;
  }
  /** What a user could do on chain. */
  userRefund(orderId: Hex) {
    const o = this.o(orderId);
    const ok =
      (o.status === GateStatus.Open && this.now > o.deadline) ||
      (o.status === GateStatus.Reserved && this.now > o.reservedAt + this.timeout);
    if (ok) o.status = GateStatus.Refunded;
    return ok;
  }
}

/** Models LandfallDock plus the Portaldot chain (blocks, receipts, mempool). */
class FakeDock implements DestChain {
  head = 1000n;
  pool = 100n * TPOT;
  maxPerFill = 20n * TPOT;
  cap = 30n * TPOT;
  paused = false;
  filled = new Map<Hex, Hex>();
  received = new Map<Address, bigint>();
  receipts = new Map<Hex, FillReceipt & { block: bigint }>();
  pending = new Set<Hex>();
  fills: Array<{ orderId: Hex; recipient: Address; amount: bigint }> = [];
  simulations = 0;
  failNext: Error | null = null;
  /** Broadcast, then the receipt wait fails (relayer crash / RPC drop). The tx still mines. */
  crashAfterBroadcast = false;
  /** Broadcast, then the tx is never mined. */
  dropNext = false;
  readonly trace: Trace;
  constructor(trace: Trace) {
    this.trace = trace;
  }

  private check(orderId: Hex, recipient: Address, amount: bigint): Error | null {
    if (this.paused) return revert(dockAbi, 'EnforcedPause');
    if (this.filled.has(orderId)) return revert(dockAbi, 'AlreadyFilled', [orderId]);
    if (amount > this.maxPerFill) return revert(dockAbi, 'AboveMaxPerFill', [amount, this.maxPerFill]);
    const after = (this.received.get(recipient) ?? 0n) + amount;
    if (after > this.cap) return revert(dockAbi, 'RecipientCapExceeded', [recipient, after, this.cap]);
    if (amount > this.pool) return revert(dockAbi, 'InsufficientPool', [amount, this.pool]);
    return null;
  }
  mine(n = 1) {
    this.head += BigInt(n);
  }
  async isFilled(orderId: Hex) {
    return this.filled.has(orderId);
  }
  async findFillTx(orderId: Hex) {
    return this.filled.get(orderId) ?? null;
  }
  async fillReceipt(hash: Hex) {
    const r = this.receipts.get(hash);
    return r ? { ...r, confirmations: this.head - r.block } : null;
  }
  async txPending(hash: Hex) {
    return this.pending.has(hash);
  }
  async simulateFill(orderId: Hex, recipient: Address, amount: bigint): Promise<FillSimulation> {
    this.simulations++;
    this.trace.push('simulateFill');
    const e = this.check(orderId, recipient, amount);
    if (!e) return { ok: true };
    const name = (e as ContractFunctionRevertedError).data!.errorName;
    return { ok: false, error: name, permanent: ['AboveMaxPerFill', 'RecipientCapExceeded'].includes(name) };
  }
  async poolBalance() {
    return this.pool;
  }
  async dockStats() {
    return { totalFilled: 0n, fillCount: BigInt(this.fills.length), paused: this.paused, maxPerFill: this.maxPerFill, recipientCap: this.cap };
  }
  /** Record a fill made outside the relayer's view (earlier process, other tx). */
  externalFill(orderId: Hex, hash: Hex, amount = 5n * TPOT) {
    this.head++;
    this.filled.set(orderId, hash);
    this.receipts.set(hash, { success: true, blockNumber: this.head, block: this.head, confirmations: 0n, filledOrderIds: [orderId] });
    this.received.set(RECIPIENT, (this.received.get(RECIPIENT) ?? 0n) + amount);
    this.pool -= amount;
  }
  async fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean, onBroadcast?: OnBroadcast) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const e = this.check(orderId, recipient, amount);
    if (e) throw e;
    if (dryRun) return null;
    const h = txh(`fill${this.fills.length + 1}-${this.receipts.size}`);
    onBroadcast?.(h);
    if (this.dropNext) {
      this.dropNext = false;
      throw new Error('tx dropped');
    }
    this.head++;
    this.filled.set(orderId, h);
    this.receipts.set(h, { success: true, blockNumber: this.head, block: this.head, confirmations: 0n, filledOrderIds: [orderId] });
    this.received.set(recipient, (this.received.get(recipient) ?? 0n) + amount);
    this.pool -= amount;
    this.fills.push({ orderId, recipient, amount });
    this.trace.push('fill');
    if (this.crashAfterBroadcast) {
      this.crashAfterBroadcast = false;
      throw new Error('connection reset while waiting for receipt');
    }
    return h;
  }
}

class FakeRules implements RulesClient {
  readonly mode = 'on' as const;
  approved = new Map<Hex, { native: bigint; final: boolean }>();
  reject: string | null = null;
  finalizeOnApprove = true;
  calls: string[] = [];
  onApprove: (() => void) | null = null;
  readonly trace: Trace;
  constructor(trace: Trace) {
    this.trace = trace;
  }
  async approvalState(orderId: Hex): Promise<ApprovalState> {
    const a = this.approved.get(orderId);
    return !a ? 'none' : a.final ? 'finalized' : 'included';
  }
  async dryRunApprove(): Promise<DryRunResult> {
    this.calls.push('dryRun');
    return this.reject ? { ok: false, error: this.reject } : { ok: true };
  }
  async approve(orderId: Hex, _r: Address, native: bigint) {
    this.calls.push('approve');
    this.trace.push('approve');
    this.approved.set(orderId, { native, final: this.finalizeOnApprove });
    this.onApprove?.();
    return { txHash: '0xabc', blockHash: '0xdef', finalized: this.finalizeOnApprove };
  }
  finalizeAll() {
    for (const a of this.approved.values()) a.final = true;
  }
  async stats() {
    return null;
  }
  async close() {}
}

const OPTS: RelayerOptions = {
  safetyWindowSec: 300,
  confirmations: 0,
  dstConfirmations: 0,
  startBlock: 0n,
  logChunk: 50n,
  maxAttempts: 3,
  retryBackoffMs: 0,
  retryBackoffMaxMs: 0,
  requireFinalizedApproval: true,
  dryRun: false,
};

function setup(opts: Partial<RelayerOptions> = {}, stateFile: string | null = null) {
  const trace: Trace = [];
  const src = new FakeGate(trace);
  const dst = new FakeDock(trace);
  const rules = new FakeRules(trace);
  const state = new StateStore(stateFile, !opts.dryRun);
  const r = new Relayer({ src, dst, rules, state, log: silentLogger }, { ...OPTS, ...opts });
  return { src, dst, rules, state, r, trace };
}

/** Put an order into "reserved on Base" without the relayer having recorded anything (crash / lost state). */
function reserveBehindTheRelayersBack(src: FakeGate, orderId: Hex) {
  const o = src.o(orderId);
  o.status = GateStatus.Reserved;
  o.reservedAt = src.now;
}

// ---------------------------------------------------------------- happy path and ordering

test('happy path: reserve on Base -> approve on rules -> fill on Portaldot -> claim on Base', async () => {
  const { src, dst, rules, state, r, trace } = setup();
  const oid = src.open(1);
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'claimed');
  assert.deepEqual(
    trace.filter((t) => t !== 'simulateFill'),
    ['reserve', 'approve', 'fill', 'claim'],
  );
  assert.ok(rec.reserveTx);
  assert.equal(rec.reservedAt, Number(src.now));
  assert.equal(rules.approved.get(oid)!.native, evmToNative(5n * TPOT));
  assert.deepEqual(dst.fills, [{ orderId: oid, recipient: RECIPIENT, amount: 5n * TPOT }]);
  assert.equal(src.claims.length, 1);
  assert.equal(src.claims[0].ref, rec.fillTx);
  assert.equal(rec.claimTx, txh('claim1'));
});

test('dock fill is simulated before the rules approval (budget never burned on a failing fill)', async () => {
  const { src, r, trace } = setup();
  src.open(1);
  await r.tick();
  const approveAt = trace.indexOf('approve');
  assert.ok(approveAt > 0);
  assert.equal(trace[approveAt - 1], 'simulateFill');
});

test('idempotent: repeated ticks never reserve or fill twice', async () => {
  const { src, dst, r } = setup();
  src.open(1);
  src.open(2, 1800n, 11n);
  await r.tick();
  await r.tick();
  await r.tick();
  assert.equal(src.reserves.length, 2);
  assert.equal(dst.fills.length, 2);
  assert.equal(src.claims.length, 2);
});

// ---------------------------------------------------------------- pre-payout decisions

test('skips orders whose deadline is inside the safety window (nothing reserved)', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1, 200n);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'skipped');
  assert.equal(src.reserves.length, 0);
  assert.equal(dst.fills.length, 0);
  assert.equal(rules.calls.length, 0);
});

test('a Gate ReserveWindowClosed revert marks the order skipped', async () => {
  const { src, dst, state, r } = setup({ safetyWindowSec: 0 });
  const oid = src.open(1, 100n); // 100s left < 120s Gate reserveSafety
  await r.tick();
  assert.equal(state.get(oid)!.status, 'skipped');
  assert.match(state.get(oid)!.reason!, /reserve window/);
  assert.equal(dst.fills.length, 0);
});

test('expired orders are marked expired, not reserved or filled', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1, 1800n);
  await r.scan();
  src.now += 2000n;
  await r.processAll();
  assert.equal(state.get(oid)!.status, 'expired');
  assert.equal(src.reserves.length, 0);
  assert.equal(dst.fills.length, 0);
});

test('rules rejection is detected before reserving: escrow stays refundable at the deadline', async () => {
  const { src, dst, rules, state, r } = setup();
  rules.reject = 'CooldownActive';
  const oid = src.open(1);
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'rejected');
  assert.match(rec.reason!, /CooldownActive/);
  assert.equal(src.reserves.length, 0);
  assert.equal(dst.fills.length, 0);
  assert.equal(src.o(oid).status, GateStatus.Open);
});

test('dock policy rejection is detected before reserving and before any rules approval', async () => {
  const { src, dst, rules, state, r } = setup();
  dst.cap = 4n * TPOT;
  const oid = src.open(1);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'rejected');
  assert.match(state.get(oid)!.reason!, /RecipientCapExceeded/);
  assert.equal(src.reserves.length, 0);
  assert.deepEqual(rules.calls, []);
});

test('rules rejection after reserving releases the reservation', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  reserveBehindTheRelayersBack(src, oid);
  rules.reject = 'DailyBudgetExceeded';
  await r.tick();
  assert.equal(state.get(oid)!.status, 'rejected');
  assert.ok(state.get(oid)!.releaseTx);
  assert.equal(src.o(oid).status, GateStatus.Open);
  assert.equal(dst.fills.length, 0);
});

test('dock simulation failing after reservation: no approval; transient errors retry, permanent ones release', async () => {
  const { src, dst, rules, state, r } = setup({ maxAttempts: 1 });
  const oid = src.open(1);
  reserveBehindTheRelayersBack(src, oid);
  dst.pool = 0n; // InsufficientPool: transient
  await r.tick();
  assert.deepEqual(rules.calls, []);
  assert.equal(state.get(oid)!.status, 'reserved'); // committed: never `failed`
  assert.match(state.get(oid)!.reason!, /InsufficientPool/);

  dst.pool = 100n * TPOT;
  dst.maxPerFill = 1n * TPOT; // AboveMaxPerFill: permanent
  await r.tick();
  assert.deepEqual(rules.calls, []);
  assert.equal(state.get(oid)!.status, 'rejected');
  assert.equal(src.o(oid).status, GateStatus.Open);
});

// ---------------------------------------------------------------- fill safety

test('never fills an order it could not reserve', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  src.failReserve = new Error('base rpc timeout');
  await r.tick();
  assert.equal(dst.fills.length, 0);
  assert.equal(rules.calls.includes('approve'), false);
  assert.equal(state.get(oid)!.status, 'pending');
});

test('re-reads the Gate right before filling and does not fill if no longer reserved', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  rules.onApprove = () => {
    src.o(oid).status = GateStatus.Open; // reservation vanished (e.g. Base reorg) between approve and fill
  };
  await r.process(oid).catch(() => {});
  await r.scan();
  await r.process(oid).catch(() => {});
  assert.equal(dst.fills.length, 0);
  assert.notEqual(state.get(oid)!.status, 'filled');
});

test('does not start a fill when the reservation is about to time out; releases instead', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1);
  await r.scan();
  reserveBehindTheRelayersBack(src, oid);
  src.now += src.timeout - 100n; // < safety window left on the reservation
  await r.processAll();
  assert.equal(dst.fills.length, 0);
  assert.equal(state.get(oid)!.status, 'expired');
  assert.equal(src.o(oid).status, GateStatus.Open);
  assert.ok(src.userRefund(oid), 'user can refund immediately (original deadline long gone)');
});

test('claims a reserved+filled order after the original deadline (crash between fill and claim)', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1, 1800n);
  dst.crashAfterBroadcast = true; // fill lands, relayer dies before recording the receipt
  await r.tick();
  assert.equal(dst.fills.length, 1);
  assert.equal(state.get(oid)!.status, 'filling');
  assert.ok(state.get(oid)!.fillTx, 'fill tx hash persisted at broadcast');

  src.now += 3600n; // well past the original deadline
  assert.equal(src.userRefund(oid), false, 'user cannot refund a reserved order before the timeout');
  await r.tick();
  assert.equal(state.get(oid)!.status, 'claimed');
  assert.equal(dst.fills.length, 1);
  assert.equal(src.claims[0].ref, state.get(oid)!.fillTx);
});

// ---------------------------------------------------------------- fill verification

test('crash recovery: an existing Dock fill for a reserved order is found, verified and claimed', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  reserveBehindTheRelayersBack(src, oid);
  dst.externalFill(oid, txh('earlierfill'));
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'claimed');
  assert.equal(rec.fillTx, txh('earlierfill'));
  assert.equal(dst.fills.length, 0);
  assert.equal(rules.calls.length, 0);
  assert.equal(src.claims[0].ref, txh('earlierfill'));
});

test('stored fill hash is not trusted: Dock filled by another tx -> claim cites the real fill', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1);
  await r.scan();
  reserveBehindTheRelayersBack(src, oid);
  state.update(oid, { status: 'filling', fillTx: txh('bogus') });
  dst.externalFill(oid, txh('realfill'));
  await r.processAll();
  assert.equal(state.get(oid)!.status, 'claimed');
  assert.equal(src.claims[0].ref, txh('realfill'));
});

test('stored fill hash that never filled (dropped) is cleared and the order is filled once', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1);
  dst.dropNext = true;
  await r.tick(); // broadcast, then dropped
  assert.equal(state.get(oid)!.status, 'filling');
  assert.equal(dst.fills.length, 0);
  assert.equal(src.claims.length, 0, 'no claim on an unproven fill');
  await r.tick();
  assert.equal(dst.fills.length, 1);
  assert.equal(state.get(oid)!.status, 'claimed');
  assert.equal(src.claims[0].ref, dst.filled.get(oid));
});

test('stored fill hash whose receipt is reverted or fills another order is never claimed against', async () => {
  const { src, dst, state, r } = setup();
  const other = src.open(1, 1800n, 10n);
  await r.tick();
  const otherFill = state.get(other)!.fillTx!;
  assert.equal(state.get(other)!.status, 'claimed');

  const a = src.open(2, 1800n, 120n);
  const b = src.open(3, 1800n, 121n);
  src.head = 200n;
  await r.scan();
  for (const oid of [a, b]) reserveBehindTheRelayersBack(src, oid);
  dst.receipts.set(txh('reverted'), { success: false, blockNumber: dst.head, block: dst.head, confirmations: 0n, filledOrderIds: [] });
  state.update(a, { status: 'filling', fillTx: txh('reverted') });
  state.update(b, { status: 'filling', fillTx: otherFill }); // success receipt, but for `other`
  await r.processAll();
  for (const oid of [a, b]) {
    const claim = src.claims.find((c) => c.orderId === oid)!;
    assert.equal(claim.ref, dst.filled.get(oid), 'claim cites the tx that filled this order');
    assert.notEqual(claim.ref, otherFill);
  }
  assert.equal(dst.fills.length, 3);
});

test('pending fill tx: waits, neither refills nor claims', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1);
  await r.scan();
  reserveBehindTheRelayersBack(src, oid);
  state.update(oid, { status: 'filling', fillTx: txh('inmempool') });
  dst.pending.add(txh('inmempool'));
  await r.processAll();
  assert.equal(dst.fills.length, 0);
  assert.equal(src.claims.length, 0);
  assert.equal(state.get(oid)!.status, 'filling');
});

test('claim waits for Portaldot confirmations', async () => {
  const { src, dst, state, r } = setup({ dstConfirmations: 2 });
  const oid = src.open(1);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'filled');
  assert.equal(src.claims.length, 0);
  dst.mine(1);
  await r.tick();
  assert.equal(src.claims.length, 0);
  dst.mine(1);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'claimed');
});

// ---------------------------------------------------------------- rules finality

test('fills only after the rules approval is finalized', async () => {
  const { src, dst, rules, state, r } = setup();
  rules.finalizeOnApprove = false;
  const oid = src.open(1);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'reserved');
  assert.equal(dst.fills.length, 0);
  await r.tick();
  assert.equal(dst.fills.length, 0);
  assert.deepEqual(rules.calls.filter((c) => c === 'approve'), ['approve'], 'approval not re-sent while waiting');
  rules.finalizeAll();
  await r.tick();
  assert.equal(state.get(oid)!.status, 'claimed');
});

test('RULES_FINALITY=inblock fills on inclusion', async () => {
  const { src, dst, rules, r } = setup({ requireFinalizedApproval: false });
  rules.finalizeOnApprove = false;
  src.open(1);
  await r.tick();
  assert.equal(dst.fills.length, 1);
});

test('restart re-checks the approval on chain instead of trusting the stored approveTx', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  await r.scan();
  reserveBehindTheRelayersBack(src, oid);
  state.update(oid, { status: 'approved', approveTx: '0xstale', approveBlock: '0xorphaned' }); // not on chain
  await r.processAll();
  assert.deepEqual(rules.calls, ['dryRun', 'approve']);
  assert.equal(dst.fills.length, 1);
  assert.equal(state.get(oid)!.status, 'claimed');
});

test('pre-existing on-chain approval is not re-submitted', async () => {
  const { src, rules, state, r } = setup();
  const oid = src.open(1);
  rules.approved.set(oid, { native: 1n, final: true });
  await r.tick();
  assert.equal(state.get(oid)!.status, 'claimed');
  assert.equal(state.get(oid)!.approveTx, 'pre-existing');
  assert.deepEqual(rules.calls, []);
});

// ---------------------------------------------------------------- settlement outcomes

test('order refunded or claimed elsewhere is detected', async () => {
  const { src, dst, state, r } = setup();
  const a = src.open(1);
  const b = src.open(2, 1800n, 11n);
  src.o(a).status = GateStatus.Refunded;
  src.o(b).status = GateStatus.Filled;
  await r.tick();
  assert.equal(state.get(a)!.status, 'refunded');
  assert.equal(state.get(b)!.status, 'claimed');
  assert.equal(dst.fills.length, 0);
});

// ---------------------------------------------------------------- retries

test('pre-payout errors are retried, then marked failed after maxAttempts', async () => {
  const { src, dst, state, r } = setup({ maxAttempts: 2 });
  const oid = src.open(1);
  src.failReserve = new Error('rpc timeout');
  await r.tick();
  assert.equal(state.get(oid)!.status, 'pending');
  assert.equal(state.get(oid)!.attempts, 1);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'failed');
  assert.equal(dst.fills.length, 0);
});

test('a reserved or paid order is never marked failed, however many attempts fail', async () => {
  const { src, dst, state, r } = setup({ maxAttempts: 2 });
  const reservedOnly = src.open(1);
  dst.failNext = new Error('portaldot rpc down');
  await r.tick(); // reserved + approved, fill throws
  for (let i = 0; i < 5; i++) {
    dst.failNext = new Error('portaldot rpc down');
    await r.tick();
  }
  const rec = state.get(reservedOnly)!;
  assert.equal(rec.status, 'approved');
  assert.ok(rec.attempts >= 5);
  await r.tick(); // RPC back
  assert.equal(state.get(reservedOnly)!.status, 'claimed');

  // Paid on Portaldot, Base claim keeps failing.
  const paid = src.open(2, 1800n, 150n);
  src.head = 200n;
  const realClaim = src.claim.bind(src);
  src.claim = async () => {
    throw new Error('base rpc down');
  };
  for (let i = 0; i < 6; i++) await r.tick();
  assert.equal(state.get(paid)!.status, 'filled');
  assert.ok(state.get(paid)!.attempts >= 6);
  src.claim = realClaim;
  await r.tick();
  assert.equal(state.get(paid)!.status, 'claimed');
  assert.equal(dst.fills.length, 2);
});

test('retry counters reset on stage progress', async () => {
  const { src, dst, state, r } = setup({ maxAttempts: 3 });
  const oid = src.open(1);
  src.failReserve = new Error('rpc timeout');
  await r.tick();
  await r.tick();
  assert.equal(state.get(oid)!.attempts, 2);
  src.failReserve = null;
  dst.failNext = new Error('portaldot rpc down');
  await r.tick(); // reserves (progress -> counter reset), approves, then the fill fails once
  assert.equal(state.get(oid)!.status, 'approved');
  assert.equal(state.get(oid)!.attempts, 1);
});

test('retries back off exponentially', async () => {
  let clock = 1_000_000;
  const { src, state, r } = setup({ retryBackoffMs: 1000, retryBackoffMaxMs: 4000, maxAttempts: 10, now: () => clock });
  const oid = src.open(1);
  src.failReserve = new Error('rpc timeout');
  await r.tick();
  assert.equal(state.get(oid)!.nextAttemptAt, clock + 1000);
  await r.tick(); // too early: skipped
  assert.equal(state.get(oid)!.attempts, 1);
  clock += 1000;
  await r.tick();
  assert.equal(state.get(oid)!.attempts, 2);
  assert.equal(state.get(oid)!.nextAttemptAt, clock + 2000);
  clock += 2000;
  await r.tick();
  clock += 4000;
  await r.tick();
  assert.equal(state.get(oid)!.nextAttemptAt, clock + 4000, 'capped at retryBackoffMaxMs');
});

// ---------------------------------------------------------------- dry-run, persistence, rebuild

test('dry-run sends nothing and writes no state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'landfall-'));
  const file = join(dir, 's.json');
  const { src, dst, rules, r } = setup({ dryRun: true }, file);
  src.open(1);
  await r.tick();
  assert.equal(src.reserves.length, 0);
  assert.equal(dst.fills.length, 0);
  assert.equal(src.claims.length, 0);
  assert.deepEqual(rules.calls, ['dryRun']);
  assert.equal(existsSync(file), false);
});

test('resumes from the state file after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'landfall-'));
  const file = join(dir, 's.json');
  const first = setup({}, file);
  first.src.open(1);
  await first.r.scan(); // seen but not processed ("crash" here)
  assert.equal(new StateStore(file).lastScannedBlock, 100n);

  const state = new StateStore(file);
  const r2 = new Relayer({ src: first.src, dst: first.dst, rules: first.rules, state, log: silentLogger }, OPTS);
  assert.equal(state.open().length, 1);
  await r2.tick();
  assert.equal(first.dst.fills.length, 1);
  assert.equal(new StateStore(file).open().length, 0);
});

test('lost state file: first scan starts at the Gate deploy block and rebuilds open and reserved orders', async () => {
  const { src, dst, rules, trace } = setup();
  const settled = src.open(1, 1800n, 5n);
  src.o(settled).status = GateStatus.Filled;
  const reservedAndFilled = src.open(2, 1800n, 6n);
  reserveBehindTheRelayersBack(src, reservedAndFilled);
  dst.externalFill(reservedAndFilled, txh('beforecrash'));
  const reservedOnly = src.open(3, 1800n, 7n);
  reserveBehindTheRelayersBack(src, reservedOnly);
  const open = src.open(4, 1800n, 8n);
  src.head = 5000n; // far past the deploy block

  const state = new StateStore(null, false);
  const r = new Relayer({ src, dst, rules, state, log: silentLogger }, { ...OPTS, startBlock: 5n, logChunk: 1000n });
  await r.tick();
  assert.equal(state.get(settled)!.status, 'claimed');
  assert.equal(state.get(reservedAndFilled)!.status, 'claimed');
  assert.equal(src.claims.find((c) => c.orderId === reservedAndFilled)!.ref, txh('beforecrash'));
  assert.equal(state.get(reservedOnly)!.status, 'claimed');
  assert.equal(state.get(open)!.status, 'claimed');
  assert.equal(dst.fills.length, 2, 'only the two unfilled orders were filled');
  assert.equal(trace.filter((t) => t === 'reserve').length, 1, 'only the open order needed a reservation');
});

// ---------------------------------------------------------------- ViemDest.findFillTx

function dockWithRpc(filledAt: bigint, head: bigint) {
  const ranges: Array<[bigint, bigint]> = [];
  const cfg = loadConfig({
    RULES_MODE: 'off',
    BASE_RPC_URL: 'http://localhost:1',
    PORTALDOT_EVM_RPC_URL: 'http://localhost:2',
    GATE_ADDRESS: '0x' + '11'.repeat(20),
    GATE_DEPLOY_BLOCK: '0',
    DOCK_ADDRESS: '0x' + '22'.repeat(20),
    DOCK_DEPLOY_BLOCK: '100',
    PORTALDOT_LOG_CHUNK: '2000',
    RELAYER_PRIVATE_KEY: '0x' + '33'.repeat(32),
  });
  const dock = new ViemDest(cfg);
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const pub = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: any }) {
        if (method === 'eth_blockNumber') return hex(head);
        if (method === 'eth_call') {
          const { functionName } = decodeFunctionData({ abi: dockAbi, data: params[0].data ?? params[0].input });
          assert.equal(functionName, 'filledAt');
          return encodeFunctionResult({ abi: dockAbi, functionName: 'filledAt', result: filledAt });
        }
        if (method === 'eth_getLogs') {
          const from = BigInt(params[0].fromBlock);
          const to = BigInt(params[0].toBlock);
          ranges.push([from, to]);
          return [];
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  (dock as unknown as { pub: unknown }).pub = pub;
  return { dock, ranges };
}

test('findFillTx: uses Dock.filledAt for a one-block lookup', async () => {
  const { dock, ranges } = dockWithRpc(1234n, 9000n);
  await dock.findFillTx(id(1));
  assert.deepEqual(ranges[0], [1234n, 1234n]);
});

test('findFillTx: without filledAt, scans from the deploy block in PORTALDOT_LOG_CHUNK chunks', async () => {
  const { dock, ranges } = dockWithRpc(0n, 4500n);
  assert.equal(await dock.findFillTx(id(1)), null);
  assert.deepEqual(ranges, [
    [100n, 2099n],
    [2100n, 4099n],
    [4100n, 4500n],
  ]);
});

// ---------------------------------------------------------------- config

test('config: required/optional settings, defaults and unit conversion 18 -> 14 decimals', () => {
  const env = {
    RULES_MODE: 'off',
    BASE_RPC_URL: 'http://localhost:1',
    PORTALDOT_EVM_RPC_URL: 'http://localhost:2',
    GATE_ADDRESS: '0x' + '11'.repeat(20),
    GATE_DEPLOY_BLOCK: '1234',
    DOCK_ADDRESS: '0x' + '22'.repeat(20),
    RELAYER_PRIVATE_KEY: '0x' + '33'.repeat(32),
  };
  const cfg = loadConfig(env, ['--dry-run']);
  assert.equal(cfg.rules.mode, 'off');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.portaldotKey, cfg.relayerKey);
  assert.equal(cfg.base.deployBlock, 1234n);
  assert.equal(cfg.portaldot.confirmations, 2);
  assert.equal(cfg.portaldot.logChunk, 2000n);
  assert.equal(cfg.rules.finality, 'finalized');
  assert.equal(evmToNative(10n ** 18n), 10n ** 14n);
  assert.throws(() => loadConfig({ RULES_MODE: 'on' }), /missing required env var/);
  const { GATE_DEPLOY_BLOCK: _, ...noDeployBlock } = env;
  assert.throws(() => loadConfig(noDeployBlock), /GATE_DEPLOY_BLOCK/);
  assert.throws(() => loadConfig({ ...env, RULES_FINALITY: 'soon' }), /RULES_FINALITY/);
  assert.equal(loadConfig({ ...env, RULES_FINALITY: 'inblock', PORTALDOT_CONFIRMATIONS: '0' }).portaldot.confirmations, 0);
});
