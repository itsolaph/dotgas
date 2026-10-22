#!/usr/bin/env node
/**
 * Deploy the ink! `dotgas_rules` contract to Portaldot's pallet-contracts (WASM).
 *
 * Env (secrets come from the environment only):
 *   PORTALDOT_WS_URL        default wss://test-node-v3.portaldot.dev
 *   RULES_DEPLOYER_SURI     required, substrate secret URI of the deployer (becomes owner)
 *   RULES_RELAYER_SS58      required, account allowed to call approve()
 *   RULES_DAILY_BUDGET      native units (14 decimals), default 1000 tPOT
 *   RULES_RECIPIENT_CAP     native units, default 30 tPOT
 *   RULES_COOLDOWN_BLOCKS   default 10
 *   RULES_CONTRACT_BUNDLE   default ../contracts/ink/dotgas_rules/artifacts/dotgas_rules.contract
 *
 * Usage: node --env-file-if-exists=../.env deploy-rules.ts [--dry-run]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { CodePromise } from '@polkadot/api-contract';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, randomAsU8a } from '@polkadot/util-crypto';

const here = dirname(fileURLToPath(import.meta.url));
const UNIT = 10n ** 14n;

function env(k: string, d?: string): string {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`missing env ${k}`);
  return v;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const wsUrl = env('PORTALDOT_WS_URL', 'wss://test-node-v3.portaldot.dev');
  const bundlePath = env('RULES_CONTRACT_BUNDLE', join(here, '../contracts/ink/dotgas_rules/artifacts/dotgas_rules.contract'));
  const relayer = env('RULES_RELAYER_SS58');
  const budget = BigInt(env('RULES_DAILY_BUDGET', (1000n * UNIT).toString()));
  const cap = BigInt(env('RULES_RECIPIENT_CAP', (30n * UNIT).toString()));
  const cooldown = Number(env('RULES_COOLDOWN_BLOCKS', '10'));

  await cryptoWaitReady();
  const pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(env('RULES_DEPLOYER_SURI'));
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl), noInitWarn: true });
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const code = new CodePromise(api, bundle, bundle.source.wasm);

  const args = [relayer, budget, cap, cooldown];
  const data = code.abi.findConstructor('new').toU8a(args);
  const salt = randomAsU8a(32);

  // Ask the node for the real weight + storage deposit instead of hardcoding limits.
  const dry: any = await api.call.contractsApi.instantiate(pair.address, 0, null, null, { Upload: code.code }, data, salt);
  if (dry.result.isErr) throw new Error(`instantiate dry-run failed: ${dry.result.asErr.toString()}`);
  if (dry.result.asOk.result.flags.isRevert) throw new Error('constructor reverted in dry-run');
  const gasLimit: any = api.registry.createType('WeightV2', {
    refTime: (dry.gasRequired.refTime.toBigInt() * 12n) / 10n,
    proofSize: (dry.gasRequired.proofSize.toBigInt() * 12n) / 10n,
  });
  const deposit = dry.storageDeposit.isCharge ? dry.storageDeposit.asCharge.toBigInt() : 0n;
  console.log(JSON.stringify({ step: 'dry-run', deployer: pair.address, gasRequired: dry.gasRequired.toHuman(), storageDeposit: deposit.toString() }));
  if (dryRun) {
    await api.disconnect();
    return;
  }

  const tx = code.tx.new({ gasLimit, storageDepositLimit: null, salt }, ...args);
  const { address, blockHash } = await new Promise<{ address: string; blockHash: string }>((resolve, reject) => {
    tx.signAndSend(pair, (res: any) => {
      if (res.dispatchError) {
        const e = res.dispatchError.isModule ? api.registry.findMetaError(res.dispatchError.asModule) : null;
        reject(new Error(e ? `${e.section}.${e.name}` : res.dispatchError.toString()));
      } else if (res.status.isInBlock && res.contract) {
        resolve({ address: res.contract.address.toString(), blockHash: res.status.asInBlock.toHex() });
      }
    }).catch(reject);
  });

  const out = { network: 'portaldot-testnet-v3', dotgas_rules: address, blockHash, txHash: tx.hash.toHex(), relayer, budget: budget.toString(), cap: cap.toString(), cooldown };
  const file = join(here, '../contracts/ink/dotgas_rules/deployments/portaldot.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ step: 'deployed', ...out }));
  await api.disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
