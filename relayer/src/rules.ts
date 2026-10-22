import { readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import type { Logger } from './log.ts';

export interface RulesStats {
  approvals: string;
  totalApproved: string;
  spentToday: string;
  remainingToday: string;
  dailyBudget: string;
  recipientCap: string;
  cooldownBlocks: number;
  paused: boolean;
}

export type DryRunResult = { ok: true } | { ok: false; error: string };

/** The WASM (ink!) policy + audit ledger, or a no-op stand-in when RULES_MODE=off. */
export interface RulesClient {
  readonly mode: 'on' | 'off';
  isApproved(orderId: Hex): Promise<boolean>;
  dryRunApprove(orderId: Hex, recipient: Address, nativeAmount: bigint): Promise<DryRunResult>;
  approve(orderId: Hex, recipient: Address, nativeAmount: bigint): Promise<{ txHash: string; blockHash: string }>;
  stats(): Promise<RulesStats | null>;
  close(): Promise<void>;
}

export class OffRules implements RulesClient {
  readonly mode = 'off' as const;
  async isApproved() {
    return false;
  }
  async dryRunApprove(): Promise<DryRunResult> {
    return { ok: true };
  }
  async approve() {
    return { txHash: 'off', blockHash: 'off' };
  }
  async stats() {
    return null;
  }
  async close() {}
}

/**
 * ink! v5 contract on Portaldot's pallet-contracts, reached over the Substrate WS endpoint.
 * Every approval is dry-run first so policy rejections never cost a transaction.
 */
export class InkRules implements RulesClient {
  readonly mode = 'on' as const;
  // Typed loosely: @polkadot/api types are heavy and this module is only loaded when RULES_MODE=on.
  private api: any;
  private contract: any;
  private pair: any;
  private log: Logger;

  private constructor(api: any, contract: any, pair: any, log: Logger) {
    this.api = api;
    this.contract = contract;
    this.pair = pair;
    this.log = log;
  }

  static async connect(opts: { wsUrl: string; address: string; metadataPath: string; suri: string; log: Logger }) {
    const [{ ApiPromise, WsProvider }, { ContractPromise }, { Keyring }, { cryptoWaitReady }] = await Promise.all([
      import('@polkadot/api'),
      import('@polkadot/api-contract'),
      import('@polkadot/keyring'),
      import('@polkadot/util-crypto'),
    ]);
    await cryptoWaitReady();
    const api = await ApiPromise.create({ provider: new WsProvider(opts.wsUrl), noInitWarn: true });
    const metadata = JSON.parse(readFileSync(opts.metadataPath, 'utf8'));
    const contract = new ContractPromise(api, metadata, opts.address);
    const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(opts.suri);
    opts.log.info('rules connected', { rules: opts.address, signer: pair.address });
    return new InkRules(api, contract, pair, opts.log);
  }

  private queryOpts() {
    const max = this.api.consts.system.blockWeights.maxBlock;
    return {
      gasLimit: this.api.registry.createType('WeightV2', { refTime: max.refTime, proofSize: max.proofSize }),
      storageDepositLimit: null,
    };
  }

  private async query(method: string, ...args: unknown[]) {
    const { result, output } = await this.contract.query[method](this.pair.address, this.queryOpts(), ...args);
    if (result.isErr) throw new Error(`rules.${method} query failed: ${result.asErr.toString()}`);
    // ink! wraps every message result in Result<T, LangError>
    const json = output?.toJSON() as { ok?: unknown; err?: unknown } | null;
    if (json && 'err' in json && json.err !== undefined) throw new Error(`rules.${method} LangError ${JSON.stringify(json.err)}`);
    return json?.ok;
  }

  async isApproved(orderId: Hex) {
    return Boolean(await this.query('isApproved', orderId));
  }

  async dryRunApprove(orderId: Hex, recipient: Address, nativeAmount: bigint): Promise<DryRunResult> {
    const { result, output } = await this.contract.query.approve(
      this.pair.address,
      this.queryOpts(),
      orderId,
      recipient,
      nativeAmount,
    );
    if (result.isErr) return { ok: false, error: `dispatch: ${result.asErr.toString()}` };
    const json = output?.toJSON() as { ok?: { ok?: unknown; err?: unknown }; err?: unknown } | null;
    if (!json || json.err !== undefined) return { ok: false, error: `lang: ${JSON.stringify(json?.err)}` };
    if (json.ok && 'err' in json.ok && json.ok.err !== undefined) return { ok: false, error: String(json.ok.err) };
    return { ok: true };
  }

  async approve(orderId: Hex, recipient: Address, nativeAmount: bigint) {
    const dry = await this.contract.query.approve(this.pair.address, this.queryOpts(), orderId, recipient, nativeAmount);
    const gasLimit = this.api.registry.createType('WeightV2', {
      // 20% headroom over the dry-run estimate
      refTime: (dry.gasRequired.refTime.toBigInt() * 12n) / 10n,
      proofSize: (dry.gasRequired.proofSize.toBigInt() * 12n) / 10n,
    });
    const tx = this.contract.tx.approve({ gasLimit, storageDepositLimit: null }, orderId, recipient, nativeAmount);
    return new Promise<{ txHash: string; blockHash: string }>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      tx.signAndSend(this.pair, (res: any) => {
        if (res.dispatchError) {
          let msg = res.dispatchError.toString();
          if (res.dispatchError.isModule) {
            const d = this.api.registry.findMetaError(res.dispatchError.asModule);
            msg = `${d.section}.${d.name}`;
          }
          unsub?.();
          reject(new Error(`rules.approve failed: ${msg}`));
          return;
        }
        if (res.status.isInBlock || res.status.isFinalized) {
          const blockHash = (res.status.isInBlock ? res.status.asInBlock : res.status.asFinalized).toHex();
          this.log.debug('rules approve included', { blockHash });
          unsub?.();
          resolve({ txHash: tx.hash.toHex(), blockHash });
        }
      })
        .then((u: () => void) => {
          unsub = u;
        })
        .catch(reject);
    });
  }

  async stats(): Promise<RulesStats | null> {
    const s = (await this.query('stats')) as Record<string, string | number | boolean>;
    const big = (v: unknown) => BigInt(String(v)).toString();
    return {
      approvals: big(s.approvals),
      totalApproved: big(s.totalApproved),
      spentToday: big(s.spentToday),
      remainingToday: big(s.remainingToday),
      dailyBudget: big(s.dailyBudget),
      recipientCap: big(s.recipientCap),
      cooldownBlocks: Number(s.cooldownBlocks),
      paused: Boolean(s.paused),
    };
  }

  async close() {
    await this.api.disconnect();
  }
}
