import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Lifecycle of an order as seen by the relayer.
 *  pending  -> approved -> filled -> claimed      (happy path)
 *  pending  -> rejected   rules or dock policy refused; user refunds after the deadline
 *  pending  -> skipped    deadline too close to fill safely; user refunds after the deadline
 *  pending  -> expired    deadline passed before we got to it
 *  filled   -> unclaimable  filled on Portaldot but the claim window closed (relayer's loss)
 *  any open -> refunded   user refunded on Base
 */
export type OrderStatus =
  | 'pending'
  | 'approved'
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
  approveTx?: string; // substrate extrinsic hash (or "pre-existing" / "off")
  approveBlock?: string;
  fillTx?: `0x${string}`;
  claimTx?: `0x${string}`;
  attempts: number;
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
