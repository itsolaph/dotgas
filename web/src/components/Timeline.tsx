import type { ReactNode } from 'react';
import { config } from '../config.ts';
import { TxRef } from './TxRef.tsx';

export interface GateOrderView {
  status: number; // 0 None, 1 Open, 2 Filled(claimed), 3 Refunded
  deadline: bigint;
  dstAmount: bigint;
  recipient: string;
}

/** Subset of the relayer's OrderRecord (GET /orders/:id). */
export interface RelayerRecord {
  status: string;
  reason?: string;
  openTx?: string;
  approveTx?: string;
  approveBlock?: string;
  fillTx?: string;
  claimTx?: string;
}

type StepState = 'done' | 'active' | 'todo' | 'failed';

const substrateExplorer = (blockHash: string) =>
  `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(config.substrateWs)}#/explorer/query/${blockHash}`;

export function Timeline({
  openTx,
  order,
  record,
  fillRef,
  nowSec,
}: {
  openTx?: string;
  order: GateOrderView | null;
  record: RelayerRecord | null;
  fillRef?: string | null;
  nowSec: number;
}) {
  const claimed = order?.status === 2 || record?.status === 'claimed';
  const refunded = order?.status === 3 || record?.status === 'refunded';
  const fillTx = record?.fillTx ?? fillRef ?? undefined;
  const approved = !!record?.approveTx || !!fillTx || claimed;
  const halted = record && ['rejected', 'skipped', 'expired', 'failed'].includes(record.status);

  const steps: Array<{ title: string; state: StepState; body: ReactNode }> = [
    {
      title: 'Opened on Base',
      state: openTx || order ? 'done' : 'active',
      body: <TxRef hash={openTx ?? record?.openTx} explorer={config.baseExplorer} />,
    },
    {
      title: 'Approved by rules (WASM / ink!)',
      state: approved ? 'done' : halted ? 'failed' : 'active',
      body:
        record?.approveTx === 'off' ? (
          <span className="muted">rules step disabled (RULES_MODE=off)</span>
        ) : record?.approveTx === 'pre-existing' ? (
          <span className="muted">already in the on-chain ledger</span>
        ) : record?.approveTx ? (
          <span>
            extrinsic <TxRef hash={record.approveTx} />{' '}
            {record.approveBlock && (
              <a href={substrateExplorer(record.approveBlock)} target="_blank" rel="noreferrer">
                block
              </a>
            )}
          </span>
        ) : halted ? (
          <span className="err">{record?.reason ?? record?.status}</span>
        ) : (
          <span className="muted">waiting for the relayer…</span>
        ),
    },
    {
      title: 'Filled on Portaldot (EVM)',
      state: fillTx ? 'done' : approved && !halted ? 'active' : halted ? 'failed' : 'todo',
      body: fillTx ? <TxRef hash={fillTx} explorer={config.portaldotExplorer || undefined} /> : null,
    },
    {
      title: 'Claimed on Base',
      state: claimed ? 'done' : fillTx ? 'active' : 'todo',
      body: record?.claimTx ? <TxRef hash={record.claimTx} explorer={config.baseExplorer} /> : null,
    },
  ];

  const left = order ? Number(order.deadline) - nowSec : null;

  return (
    <div className="timeline">
      {steps.map((s) => (
        <div key={s.title} className={`step ${s.state}`}>
          <span className="dot" />
          <div>
            <div className="step-title">{s.title}</div>
            {s.body && <div className="step-body">{s.body}</div>}
          </div>
        </div>
      ))}
      {refunded && <p className="note">Order refunded on Base.</p>}
      {order && order.status === 1 && left !== null && (
        <p className="muted small">
          {left > 0 ? `Refund unlocks in ${Math.floor(left / 60)}m ${left % 60}s if not filled.` : 'Deadline passed.'}
        </p>
      )}
    </div>
  );
}
