import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { Relayer, type RelayerOptions } from '../src/relayer.ts';
import { StateStore } from '../src/state.ts';
import { silentLogger } from '../src/log.ts';
import type { DestChain, GateOrder, OpenedEvent, SourceChain } from '../src/chains.ts';
import type { DryRunResult, RulesClient } from '../src/rules.ts';
import { evmToNative, loadConfig } from '../src/config.ts';

const RECIPIENT = '0x00000000000000000000000000000000000a11ce' as Address;
const USER = '0x000000000000000000000000000000000000b0b0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const txh = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0').slice(0, 64)}` as Hex;

class FakeSource implements SourceChain {
  head = 100n;
  now = 1_000_000n;
  orders = new Map<Hex, GateOrder>();
  events: OpenedEvent[] = [];
  claims: Array<{ orderId: Hex; ref: Hex }> = [];

  open(n: number, ttl = 1800n, block = 10n, dstAmount = 5n * 10n ** 18n) {
    const orderId = id(n);
    const o: GateOrder = { user: USER, recipient: RECIPIENT, token: ZERO, tier: 1, status: 1, deadline: this.now + ttl, amount: 10n ** 15n, dstAmount };
    this.orders.set(orderId, o);
    this.events.push({ orderId, ...o, txHash: txh(`open${n}`), blockNumber: block });
    return orderId;
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
    return this.orders.get(orderId) ?? { ...this.orders.values().next().value!, status: 0 };
  }
  async claim(orderId: Hex, ref: Hex, dryRun: boolean) {
    const o = this.orders.get(orderId)!;
    if (o.status !== 1 || this.now > o.deadline) throw new Error('claim would revert');
    if (dryRun) return null;
    o.status = 2;
    this.claims.push({ orderId, ref });
    return txh(`claim${this.claims.length}`);
  }
}

class FakeDest implements DestChain {
  filled = new Map<Hex, Hex>();
  received = new Map<Address, bigint>();
  fills: Array<{ orderId: Hex; recipient: Address; amount: bigint }> = [];
  cap = 30n * 10n ** 18n;
  failNext: Error | null = null;
  async isFilled(orderId: Hex) {
    return this.filled.has(orderId);
  }
  async findFillTx(orderId: Hex) {
    return this.filled.get(orderId) ?? null;
  }
  async poolBalance() {
    return 100n;
  }
  async dockStats() {
    return { totalFilled: 0n, fillCount: BigInt(this.fills.length), paused: false, maxPerFill: 0n, recipientCap: this.cap };
  }
  async fill(orderId: Hex, recipient: Address, amount: bigint, dryRun: boolean) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    if (this.filled.has(orderId)) throw new Error('AlreadyFilled');
    if (dryRun) return null;
    const h = txh(`fill${this.fills.length + 1}`);
    this.filled.set(orderId, h);
    this.fills.push({ orderId, recipient, amount });
    return h;
  }
}

class FakeRules implements RulesClient {
  readonly mode = 'on' as const;
  approved = new Map<Hex, bigint>();
  reject: string | null = null;
  calls: string[] = [];
  async isApproved(orderId: Hex) {
    return this.approved.has(orderId);
  }
  async dryRunApprove(): Promise<DryRunResult> {
    this.calls.push('dryRun');
    return this.reject ? { ok: false, error: this.reject } : { ok: true };
  }
  async approve(orderId: Hex, _r: Address, native: bigint) {
    this.calls.push('approve');
    this.approved.set(orderId, native);
    return { txHash: '0xabc', blockHash: '0xdef' };
  }
  async stats() {
    return null;
  }
  async close() {}
}

const OPTS: RelayerOptions = { safetyWindowSec: 300, confirmations: 0, startBlock: 0n, logChunk: 50n, maxAttempts: 3, dryRun: false };

function setup(opts: Partial<RelayerOptions> = {}, stateFile: string | null = null) {
  const src = new FakeSource();
  const dst = new FakeDest();
  const rules = new FakeRules();
  const state = new StateStore(stateFile, !opts.dryRun);
  const r = new Relayer({ src, dst, rules, state, log: silentLogger }, { ...OPTS, ...opts });
  return { src, dst, rules, state, r };
}

test('happy path: approve on rules -> fill on Portaldot -> claim on Base', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'claimed');
  assert.deepEqual(rules.calls, ['dryRun', 'approve']);
  assert.equal(rules.approved.get(oid), evmToNative(5n * 10n ** 18n));
  assert.deepEqual(dst.fills, [{ orderId: oid, recipient: RECIPIENT, amount: 5n * 10n ** 18n }]);
  assert.equal(src.claims.length, 1);
  assert.equal(src.claims[0].ref, rec.fillTx);
  assert.equal(rec.claimTx, txh('claim1'));
});

test('idempotent: repeated ticks never fill twice', async () => {
  const { src, dst, r } = setup();
  src.open(1);
  src.open(2, 1800n, 11n);
  await r.tick();
  await r.tick();
  await r.tick();
  assert.equal(dst.fills.length, 2);
  assert.equal(src.claims.length, 2);
});

test('skips orders whose deadline is inside the safety window', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1, 200n);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'skipped');
  assert.equal(dst.fills.length, 0);
  assert.equal(rules.calls.length, 0);
});

test('expired orders are marked expired, not filled', async () => {
  const { src, dst, state, r } = setup();
  const oid = src.open(1, 1800n);
  await r.scan();
  src.now += 2000n;
  await r.processAll();
  assert.equal(state.get(oid)!.status, 'expired');
  assert.equal(dst.fills.length, 0);
});

test('rules rejection stops the order before any fill', async () => {
  const { src, dst, rules, state, r } = setup();
  rules.reject = 'CooldownActive';
  const oid = src.open(1);
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'rejected');
  assert.match(rec.reason!, /CooldownActive/);
  assert.equal(dst.fills.length, 0);
  assert.equal(src.claims.length, 0);
});

test('crash recovery: an existing Dock fill is reused and claimed', async () => {
  const { src, dst, rules, state, r } = setup();
  const oid = src.open(1);
  dst.filled.set(oid, txh('earlierfill'));
  await r.tick();
  const rec = state.get(oid)!;
  assert.equal(rec.status, 'claimed');
  assert.equal(rec.fillTx, txh('earlierfill'));
  assert.equal(dst.fills.length, 0);
  assert.equal(rules.calls.length, 0);
  assert.equal(src.claims[0].ref, txh('earlierfill'));
});

test('pre-existing rules approval is not re-submitted', async () => {
  const { src, rules, state, r } = setup();
  const oid = src.open(1);
  rules.approved.set(oid, 1n);
  await r.tick();
  assert.equal(state.get(oid)!.status, 'claimed');
  assert.equal(state.get(oid)!.approveTx, 'pre-existing');
  assert.deepEqual(rules.calls, []);
});

test('order refunded or claimed elsewhere is detected', async () => {
  const { src, dst, state, r } = setup();
  const a = src.open(1);
  const b = src.open(2, 1800n, 11n);
  src.orders.get(a)!.status = 3;
  src.orders.get(b)!.status = 2;
  await r.tick();
  assert.equal(state.get(a)!.status, 'refunded');
  assert.equal(state.get(b)!.status, 'claimed');
  assert.equal(dst.fills.length, 0);
});

test('transient errors are retried, then marked failed after maxAttempts', async () => {
  const { src, dst, state, r } = setup({ maxAttempts: 2 });
  const oid = src.open(1);
  dst.failNext = new Error('rpc timeout');
  await r.tick();
  assert.equal(state.get(oid)!.status, 'approved');
  assert.equal(state.get(oid)!.attempts, 1);
  await r.tick(); // succeeds now
  assert.equal(state.get(oid)!.status, 'claimed');

  const oid2 = src.open(2, 1800n, 150n);
  src.head = 200n;
  dst.failNext = new Error('rpc timeout');
  await r.tick();
  dst.failNext = new Error('rpc timeout');
  await r.tick();
  assert.equal(state.get(oid2)!.status, 'failed');
});

test('dry-run sends nothing and writes no state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-'));
  const file = join(dir, 's.json');
  const { src, dst, rules, r } = setup({ dryRun: true }, file);
  src.open(1);
  await r.tick();
  assert.equal(dst.fills.length, 0);
  assert.equal(src.claims.length, 0);
  assert.deepEqual(rules.calls, ['dryRun']);
  assert.equal(existsSync(file), false);
});

test('resumes from the state file after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-'));
  const file = join(dir, 's.json');
  const first = setup({}, file);
  first.src.open(1);
  await first.r.scan(); // seen but not processed ("crash" here)
  assert.equal(new StateStore(file).lastScannedBlock, 100n);

  // New process: same chains, fresh Relayer + StateStore from disk.
  const state = new StateStore(file);
  const r2 = new Relayer({ src: first.src, dst: first.dst, rules: first.rules, state, log: silentLogger }, OPTS);
  assert.equal(state.open().length, 1);
  await r2.tick();
  assert.equal(first.dst.fills.length, 1);
  assert.equal(new StateStore(file).open().length, 0);
});

test('config: RULES_MODE=off needs no substrate settings; unit conversion 18 -> 14 decimals', () => {
  const cfg = loadConfig({
    RULES_MODE: 'off',
    BASE_RPC_URL: 'http://localhost:1',
    PORTALDOT_EVM_RPC_URL: 'http://localhost:2',
    GATE_ADDRESS: '0x' + '11'.repeat(20),
    DOCK_ADDRESS: '0x' + '22'.repeat(20),
    RELAYER_PRIVATE_KEY: '0x' + '33'.repeat(32),
  }, ['--dry-run']);
  assert.equal(cfg.rules.mode, 'off');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.portaldotKey, cfg.relayerKey);
  assert.equal(evmToNative(10n ** 18n), 10n ** 14n);
  assert.throws(() => loadConfig({ RULES_MODE: 'on' }), /missing required env var/);
});
