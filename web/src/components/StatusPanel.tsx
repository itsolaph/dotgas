import { useEffect, useState } from 'react';
import { formatEther, formatUnits } from 'viem';
import { config } from '../config.ts';
import { TxRef } from './TxRef.tsx';

interface Status {
  dryRun: boolean;
  pool: { balanceWei: string | null; fillCount?: string; paused?: boolean };
  rules: { mode: string; budgetLeft: string | null; dailyBudget?: string; approvals?: string };
  orders: Record<string, number>;
  recentFills: Array<{ orderId: string; recipient: string; dstAmount: string; fillTx?: string; status: string }>;
}

/** Live view of the relayer's /status endpoint. */
export function StatusPanel() {
  const [s, setS] = useState<Status | null>(null);
  const [down, setDown] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${config.relayerStatusUrl}/status`);
        if (!stop) {
          setS(await r.json());
          setDown(false);
        }
      } catch {
        if (!stop) setDown(true);
      }
    };
    void tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="card status">
      <h2>Relayer</h2>
      {down && <p className="err small">Relayer status unreachable at {config.relayerStatusUrl}</p>}
      {s && (
        <>
          <div className="stats">
            <div>
              <span className="muted small">Dock pool</span>
              <b>{s.pool.balanceWei ? `${Number(formatEther(BigInt(s.pool.balanceWei))).toFixed(2)} tPOT` : '—'}</b>
            </div>
            <div>
              <span className="muted small">Rules budget left today</span>
              <b>
                {s.rules.mode === 'off'
                  ? 'rules off'
                  : s.rules.budgetLeft
                    ? `${Number(formatUnits(BigInt(s.rules.budgetLeft), 14)).toFixed(2)} tPOT`
                    : '—'}
              </b>
            </div>
            <div>
              <span className="muted small">Orders</span>
              <b>
                {Object.entries(s.orders)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(' · ') || '0'}
              </b>
            </div>
          </div>
          {s.dryRun && <p className="note small">Relayer is in dry-run mode: nothing will be filled.</p>}
          {s.recentFills.length > 0 && (
            <div className="fills">
              <div className="muted small">Recent fills</div>
              {s.recentFills.map((f) => (
                <div key={f.orderId} className="entry small">
                  {Number(formatEther(BigInt(f.dstAmount))).toFixed(2)} tPOT → <code>{f.recipient.slice(0, 8)}…</code>{' '}
                  <TxRef hash={f.fillTx} explorer={config.portaldotExplorer || undefined} /> <span className="muted">{f.status}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
