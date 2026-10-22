import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Lifecycle of an order as seen by the relayer.
 *  pending -> reserved -> approved -> filling -> filled -> claimed     (happy path)
 *     reserved: locked on Base (Gate `Reserved`), refund blocked until the reservation timeout
 *     approved: ink! rules approval on chain (finalized unless RULES_FINALITY=inblock)
 *     filling:  Dock fill tx broadcast, hash persisted, not yet verified
 *     filled:   Dock recorded the fill (receipt + Filled event + Dock.filled); claim after confirmations
 *  pending  -> rejected     rules or dock policy refused (a reservation is released first)
 *  pending  -> skipped      deadline too close to reserve safely; user refunds after the deadline
 *  pending  -> expired      deadline (or reservation timeout) too close before anything was paid out
 *  pending  -> failed       pre-payout errors exhausted MAX_ATTEMPTS (never once reserved or paid)
 *  any      -> unclaimable  paid on Portaldot but the Gate order can no longer be claimed (relayer's loss)
 *  any      -> refunded     user refunded on Base
 */
export type OrderStatus =
  | 'pending'
  | 'reserved'
  | 'approved'
  | 'filling'
  | 'filled'
  | 'claimed'
  | 'rejected'
  | 'skipped'
  | 'expired'
  | 'unclaimable'
  | 'refunded'
  | 'failed';

export const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  'claimed',
  'rejected',
  'skipped',
  'expired',
  'unclaimable',
  'refunded',
  'failed',
]);

/** Forward progress through the happy path. A status change to a higher rank resets the retry counter. */
export const STAGE_RANK: Partial<Record<OrderStatus, number>> = {
  pending: 0,
  reserved: 1,
  approved: 2,
  filling: 3,
  filled: 4,
  claimed: 5,
};

/**
 * Past the point of no return for the user's escrow: reserved on Base or a fill tx exists. Errors on such
 * an order are settlement recovery, retried forever with backoff, never turned into a terminal `failed`.
 */
export function isCommitted(rec: OrderRecord): boolean {
  return Boolean(rec.reserveTx || rec.fillTx) || (STAGE_RANK[rec.status] ?? 0) >= STAGE_RANK.reserved!;
}

export interface OrderRecord {
  orderId: `0x${string}`;
  user: `0x${string}`;
  recipient: `0x${string}`;
  tier: number;
  token: `0x${string}`;
  amount: string; // decimal string (bigint)
  dstAmount: string; // decimal string, 18-decimal EVM-side tPOT units
  deadline: number; // unix seconds
  openTx: `0x${string}`;
  openBlock: string;
  status: OrderStatus;
  reason?: string;
  reserveTx?: `0x${string}`; // persisted as soon as broadcast
  reservedAt?: number; // unix seconds, from the Gate
  releaseTx?: `0x${string}`;
  approveTx?: string; // substrate extrinsic hash (or "pre-existing" / "off")
  approveBlock?: string;
  fillTx?: `0x${string}`; // persisted as soon as broadcast
  fillBlock?: string;
  claimTx?: `0x${string}`; // persisted as soon as broadcast
  attempts: number;
  nextAttemptAt?: number; // ms epoch; retry backoff
  createdAt: string;
  updatedAt: string;
}

export interface StateData {
  version: 1;
  lastScannedBlock: string | null;
  orders: Record<string, OrderRecord>;
}

const empty = (): StateData => ({ version: 1, lastScannedBlock: null, orders: {} });

/**
 * JSON-file state store. Writes are atomic (temp file + rename) so a crash never leaves a
 * half-written file. With `persist=false` (dry-run) everything stays in memory.
 */
export class StateStore {
  readonly path: string | null;
  data: StateData;

  constructor(path: string | null, persist = true) {
    this.path = persist ? path : null;
    this.data = path && existsSync(path) ? StateStore.load(path) : empty();
  }

  static load(path: string): StateData {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StateData;
    if (parsed.version !== 1) throw new Error(`unsupported state version ${String(parsed.version)}`);
    return parsed;
  }

  get lastScannedBlock(): bigint | null {
    return this.data.lastScannedBlock === null ? null : BigInt(this.data.lastScannedBlock);
  }

  set lastScannedBlock(b: bigint | null) {
    this.data.lastScannedBlock = b === null ? null : b.toString();
    this.save();
  }

  get(orderId: string): OrderRecord | undefined {
    return this.data.orders[orderId.toLowerCase()];
  }

  /** Inserts a new order; returns false if it was already known. */
  add(rec: Omit<OrderRecord, 'status' | 'attempts' | 'createdAt' | 'updatedAt'>): boolean {
    const key = rec.orderId.toLowerCase();
    if (this.data.orders[key]) return false;
    const now = new Date().toISOString();
    this.data.orders[key] = { ...rec, status: 'pending', attempts: 0, createdAt: now, updatedAt: now };
    this.save();
    return true;
  }

  update(orderId: string, patch: Partial<OrderRecord>): OrderRecord {
    const key = orderId.toLowerCase();
    const cur = this.data.orders[key];
    if (!cur) throw new Error(`unknown order ${orderId}`);
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.data.orders[key] = next;
    this.save();
    return next;
  }

  open(): OrderRecord[] {
    return Object.values(this.data.orders)
      .filter((o) => !TERMINAL.has(o.status))
      .sort((a, b) => Number(BigInt(a.openBlock) - BigInt(b.openBlock)));
  }

  recent(n: number): OrderRecord[] {
    return Object.values(this.data.orders)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, n);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of Object.values(this.data.orders)) out[o.status] = (out[o.status] ?? 0) + 1;
    return out;
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
