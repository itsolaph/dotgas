import { createServer, type Server } from 'node:http';
import type { Relayer } from './relayer.ts';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Snapshot used by the web UI. Chain reads are best-effort: a failing RPC yields `null`, not a 500. */
export async function buildStatus(relayer: Relayer, cfg: Pick<Config, 'base' | 'portaldot' | 'safetyWindowSec' | 'dryRun'>) {
  const safe = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  const [poolBalance, dock, rules] = await Promise.all([
    safe(() => relayer.dst.poolBalance()),
    safe(() => relayer.dst.dockStats()),
    safe(() => relayer.rules.stats()),
  ]);
  return {
    ok: true,
    dryRun: cfg.dryRun,
    safetyWindowSec: cfg.safetyWindowSec,
    base: { chainId: cfg.base.chainId, gate: cfg.base.gate, lastScannedBlock: relayer.state.lastScannedBlock },
    portaldot: { chainId: cfg.portaldot.chainId, dock: cfg.portaldot.dock },
    pool: { balanceWei: poolBalance, ...(dock ?? {}) },
    rules: { mode: relayer.rules.mode, ...(rules ?? {}), budgetLeft: rules?.remainingToday ?? null },
    orders: relayer.state.counts(),
    recentFills: relayer.state
      .recent(50)
      .filter((o) => o.fillTx)
      .slice(0, 10),
    recent: relayer.state.recent(20),
  };
}

export function startStatusServer(
  relayer: Relayer,
  cfg: Pick<Config, 'base' | 'portaldot' | 'safetyWindowSec' | 'dryRun'>,
  port: number,
  log: Logger,
): Server {
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/')) {
        res.end(json(await buildStatus(relayer, cfg)));
        return;
      }
      const m = url.pathname.match(/^\/orders\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === 'GET' && m) {
        const rec = relayer.state.get(m[1]);
        res.statusCode = rec ? 200 : 404;
        res.end(json(rec ?? { error: 'unknown order' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.end(json({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(json({ error: 'not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.end(json({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(port, () => log.info('status server listening', { port }));
  return server;
}
