import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor<T>(what: string, f: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 250): Promise<T> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

export interface Proc {
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Spawn a long-running process, teeing its output to a log file. */
export function start(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; logFile: string }): Proc {
  const out = createWriteStream(opts.logFile, { flags: 'a' });
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(out, { end: false });
  child.stderr!.pipe(out, { end: false });
  return {
    child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let step = 0;
export function ok(msg: string) {
  step++;
  console.log(`  ✔ ${String(step).padStart(2, '0')} ${msg}`);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`assertion failed: ${msg} (got ${String(a)}, expected ${String(b)})`);
}
