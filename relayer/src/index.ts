#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { ViemDest, ViemSource } from './chains.ts';
import { createLogger } from './log.ts';
import { Relayer } from './relayer.ts';
import { InkRules, OffRules, type RulesClient } from './rules.ts';
import { StateStore } from './state.ts';
import { startStatusServer } from './status.ts';

const HELP = `ferry-relayer [--dry-run] [--once]

  --dry-run   read chains and simulate every step, send nothing, do not write the state file
  --once      run a single scan + process pass and exit

Configuration is read from environment variables, see .env.example.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const cfg = loadConfig(process.env, argv);
  const log = createLogger(cfg.logLevel, { svc: 'ferry-relayer' });
  const src = new ViemSource(cfg);
  const dst = new ViemDest(cfg);
  const rules: RulesClient =
    cfg.rules.mode === 'on'
      ? await InkRules.connect({ ...cfg.rules, log })
      : new OffRules();
  const state = new StateStore(cfg.stateFile, !cfg.dryRun);

  log.info('starting', {
    dryRun: cfg.dryRun,
    rulesMode: cfg.rules.mode,
    gate: cfg.base.gate,
    dock: cfg.portaldot.dock,
    relayer: src.account.address,
    safetyWindowSec: cfg.safetyWindowSec,
    resumeFrom: state.lastScannedBlock,
    openOrders: state.open().length,
  });

  const relayer = new Relayer(
    { src, dst, rules, state, log },
    {
      safetyWindowSec: cfg.safetyWindowSec,
      confirmations: cfg.base.confirmations,
      startBlock: cfg.base.startBlock,
      logChunk: cfg.base.logChunk,
      maxAttempts: cfg.maxAttempts,
      dryRun: cfg.dryRun,
    },
  );

  if (cfg.once) {
    await relayer.tick();
    await rules.close();
    return;
  }

  const server = startStatusServer(relayer, cfg, cfg.statusPort, log);
  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    relayer.stop();
    server.close();
    await rules.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await relayer.run(cfg.pollIntervalMs);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'fatal', error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
