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

/** `none`: no approval on chain. `included`: in the best chain, not yet finalized. `finalized`: final. */
export type ApprovalState = 'none' | 'included' | 'finalized';

/** `finalized`: approve resolves on finalization. `inblock`: on inclusion (chains without usable finality). */
export type RulesFinality = 'finalized' | 'inblock';

/** The WASM (ink!) policy + audit ledger, or a no-op stand-in when RULES_MODE=off. */
export interface RulesClient {
  readonly mode: 'on' | 'off';
  /** Read from chain state every time; a stored approve tx hash is never trusted on its own. */
  approvalState(orderId: Hex): Promise<ApprovalState>;
  dryRunApprove(orderId: Hex, recipient: Address, nativeAmount: bigint): Promise<DryRunResult>;
  approve(orderId: Hex, recipient: Address, nativeAmount: bigint): Promise<{ txHash: string; blockHash: string; finalized: boolean }>;
  stats(): Promise<RulesStats | null>;
  close(): Promise<void>;
}

export class OffRules implements RulesClient {
  readonly mode = 'off' as const;
  async approvalState(): Promise<ApprovalState> {
    return 'none';
  }
  async dryRunApprove(): Promise<DryRunResult> {
    return { ok: true };
  }
  async approve() {
    return { txHash: 'off', blockHash: 'off', finalized: true };
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
  private finality: RulesFinality;
  private finalityTimeoutMs: number;

  private constructor(api: any, contract: any, pair: any, log: Logger, finality: RulesFinality, finalityTimeoutMs: number) {
    this.api = api;
    this.contract = contract;
    this.pair = pair;
    this.log = log;
    this.finality = finality;
    this.finalityTimeoutMs = finalityTimeoutMs;
  }

  static async connect(opts: {
    wsUrl: string;
    address: string;
    metadataPath: string;
    suri: string;
    finality: RulesFinality;
    finalityTimeoutMs: number;
    log: Logger;
  }) {
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
    opts.log.info('rules connected', { rules: opts.address, signer: pair.address, finality: opts.finality });
    return new InkRules(api, contract, pair, opts.log, opts.finality, opts.finalityTimeoutMs);
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

  /**
   * The ledger stores the block number of every approval. The best chain extends the finalized chain, so an
   * approval visible in best state whose block is at or below the finalized head is final.
   */
  async approvalState(orderId: Hex): Promise<ApprovalState> {
    const ap = (await this.query('approval', orderId)) as { block?: unknown } | null | undefined;
    if (!ap) return 'none';
    const finalizedHead = await this.api.rpc.chain.getHeader(await this.api.rpc.chain.getFinalizedHead());
    return BigInt(String(ap.block)) <= finalizedHead.number.toBigInt() ? 'finalized' : 'included';
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
    const waitFinal = this.finality === 'finalized';
    return new Promise<{ txHash: string; blockHash: string; finalized: boolean }>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      let done = false;
      let inBlock: string | null = null;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub?.();
        f();
      };
      // On timeout the relayer retries later and reads the approval state from chain, so nothing is lost.
      const timer = setTimeout(
        () => finish(() => reject(new Error(`rules.approve not ${waitFinal ? 'finalized' : 'included'} within ${this.finalityTimeoutMs}ms${inBlock ? ` (in block ${inBlock})` : ''}`))),
        this.finalityTimeoutMs,
      );
      tx.signAndSend(this.pair, (res: any) => {
        if (res.dispatchError) {
          let msg = res.dispatchError.toString();
          if (res.dispatchError.isModule) {
            const d = this.api.registry.findMetaError(res.dispatchError.asModule);
            msg = `${d.section}.${d.name}`;
          }
          finish(() => reject(new Error(`rules.approve failed: ${msg}`)));
          return;
        }
        if (res.status.isDropped || res.status.isInvalid || res.status.isUsurped) {
          finish(() => reject(new Error(`rules.approve ${res.status.type}`)));
          return;
        }
        if (res.status.isInBlock) {
          inBlock = res.status.asInBlock.toHex();
          this.log.debug('rules approve included', { blockHash: inBlock });
          if (!waitFinal) finish(() => resolve({ txHash: tx.hash.toHex(), blockHash: inBlock!, finalized: false }));
        }
        if (res.status.isFinalized) {
          const blockHash = res.status.asFinalized.toHex();
          this.log.debug('rules approve finalized', { blockHash });
          finish(() => resolve({ txHash: tx.hash.toHex(), blockHash, finalized: true }));
        }
      })
        .then((u: () => void) => {
          unsub = u;
          if (done) u();
        })
        .catch((e: unknown) => finish(() => reject(e)));
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
