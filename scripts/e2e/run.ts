#!/usr/bin/env node
/**
 * Local end-to-end test for DotGas.
 *
 *   anvil #1  = "Base"       (chain id 31337)  DotGasGate + mock USDC
 *   anvil #2  = "Portaldot"  (chain id 31338)  DotGasDock + FirstSteps, 1 s block time so the relayer's
 *               default PORTALDOT_CONFIRMATIONS=2 is exercised
 *   relayer   = relayer/src/index.ts with RULES_MODE=off (the ink! step needs a Substrate node)
 *
 * Contracts are deployed with the real forge deploy scripts. Scenarios:
 *   1. dry-run pass changes nothing (not even a reservation)
 *   2. ETH order -> reserved on Base -> filled on Portaldot -> claimed on Base; the zero-balance recipient
 *      then signs FirstSteps
 *   3. USDC order -> reserved -> filled -> claimed (treasury receives USDC)
 *   4. Dock policy rejection (recipient cap) is detected before reserving -> user refunds after the deadline
 *   5. relayer restart: resumes from the state file without double-filling, skips an order inside the
 *      safety window, user refunds after the deadline
 *   6. relayer crashes between fill and claim, restarts after the original deadline: the user cannot
 *      refund the reserved order, and the claim still succeeds
 *   7. same crash plus a lost state file: the relayer rebuilds from GATE_DEPLOY_BLOCK and claims
 *   8. a reservation that is never filled: refund is blocked until the reservation timeout, then works
 *
 * Only anvil's well-known development keys are used.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseEventLogs,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { assert, eq, freePort, ok, run, start, waitFor, type Proc } from './lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const EVM = join(ROOT, 'contracts/evm');

// anvil default development accounts (public, test-only)
const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  relayer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  user: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  treasury: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
} as const;
const acct = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, privateKeyToAccount(v)])) as Record<
  keyof typeof KEYS,
  ReturnType<typeof privateKeyToAccount>
>;

const gateAbi = parseAbi([
  'event Opened(bytes32 indexed orderId, address indexed user, address indexed recipient, uint8 tier, address token, uint256 amount, uint256 dstAmount, uint64 deadline)',
  'struct Order { address user; address recipient; address token; uint8 tier; uint8 status; uint64 deadline; uint64 reservedAt; uint256 amount; uint256 dstAmount; }',
  'function getOrder(bytes32) view returns (Order)',
  'function fillTxRefOf(bytes32) view returns (bytes32)',
  'function reserveTimeout() view returns (uint64)',
  'function reserve(bytes32 orderId)',
  'error ReservationActive(bytes32 orderId)',
  'error DeadlineNotReached(bytes32 orderId)',
  'function tiers(uint8) view returns (uint256 priceWei, uint256 priceToken, uint256 dstAmount, bool active)',
  'function open(address recipient, uint8 tier) payable returns (bytes32)',
  'function openUSDC(address recipient, uint8 tier) returns (bytes32)',
  'function refund(bytes32 orderId)',
]);
const dockAbi = parseAbi([
  'function filled(bytes32) view returns (bool)',
  'function fillCount() view returns (uint256)',
  'function receivedBy(address) view returns (uint256)',
]);
const erc20Abi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const firstStepsAbi = parseAbi([
  'struct Entry { address signer; uint64 blockNumber; uint64 timestamp; string message; }',
  'function sign(string message) returns (uint256)',
  'function count() view returns (uint256)',
  'function entry(uint256) view returns (Entry)',
]);

const STATUS = { Open: 1, Filled: 2, Refunded: 3, Reserved: 4 };
const ORDER_TTL = 600; // seconds (DotGasGate minimum is 300)
const SAFETY_WINDOW = 300;

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'dotgas-e2e-'));
  const procs: Proc[] = [];
  const logs = { anvilBase: join(tmp, 'anvil-base.log'), anvilPd: join(tmp, 'anvil-portaldot.log'), relayer: join(tmp, 'relayer.log') };
  let relayer: Proc | null = null;
  let success = false;

  try {
    console.log('dotgas e2e');
    const [basePort, pdPort, statusPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const baseRpc = `http://localhost:${basePort}`;
    const pdRpc = `http://localhost:${pdPort}`;
    procs.push(start('anvil', ['--port', String(basePort), '--chain-id', '31337'], { logFile: logs.anvilBase }));
    procs.push(start('anvil', ['--port', String(pdPort), '--chain-id', '31338', '--block-time', '1'], { logFile: logs.anvilPd }));

    const base = defineChain({ id: 31337, name: 'base-local', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [baseRpc] } } });
    const pd = defineChain({ id: 31338, name: 'portaldot-local', nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 }, rpcUrls: { default: { http: [pdRpc] } } });
    const basePub = createPublicClient({ chain: base, transport: http(), pollingInterval: 100 });
    const pdPub = createPublicClient({ chain: pd, transport: http(), pollingInterval: 100 });
    const baseTest = createTestClient({ chain: base, mode: 'anvil', transport: http() });
    const userBase = createWalletClient({ chain: base, transport: http(), account: acct.user });
    await waitFor('anvil base', () => basePub.getChainId());
    await waitFor('anvil portaldot', () => pdPub.getChainId());
    ok(`two anvil chains up (base :${basePort}, portaldot :${pdPort})`);

    // ------------------------------------------------------------------ deploy
    run('forge', ['build', '--quiet'], { cwd: EVM });
    const mockArtifact = JSON.parse(readFileSync(join(EVM, 'out/MockERC20.sol/MockERC20.json'), 'utf8'));
    const deployerBase = createWalletClient({ chain: base, transport: http(), account: acct.deployer });
    const usdcTx = await deployerBase.deployContract({ abi: mockArtifact.abi, bytecode: mockArtifact.bytecode.object });
    const usdc = (await basePub.waitForTransactionReceipt({ hash: usdcTx })).contractAddress as Address;

    const deployEnv = {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: KEYS.deployer,
      RELAYER_ADDRESS: acct.relayer.address,
      TREASURY_ADDRESS: acct.treasury.address,
      PAYMENT_TOKEN: usdc,
      ORDER_TTL: String(ORDER_TTL),
      DOCK_MAX_PER_FILL: parseEther('20').toString(),
      DOCK_RECIPIENT_CAP: parseEther('15').toString(),
      DOCK_INITIAL_FUND: parseEther('100').toString(),
    };
    run('forge', ['script', 'script/DeployGate.s.sol:DeployGate', '--rpc-url', baseRpc, '--broadcast', '--slow'], { cwd: EVM, env: deployEnv });
    run('forge', ['script', 'script/DeployPortaldot.s.sol:DeployPortaldot', '--rpc-url', pdRpc, '--broadcast', '--slow'], { cwd: EVM, env: deployEnv });
    const gateDep = JSON.parse(readFileSync(join(EVM, 'deployments/gate-31337.json'), 'utf8'));
    const pdDep = JSON.parse(readFileSync(join(EVM, 'deployments/portaldot-31338.json'), 'utf8'));
    const gate = gateDep.DotGasGate as Address;
    const dock = pdDep.DotGasDock as Address;
    const firstSteps = pdDep.FirstSteps as Address;
    eq(await pdPub.getBalance({ address: dock }), parseEther('100'), 'dock funded by deploy script');
    ok(`deployed via forge scripts: gate ${gate}, dock ${dock}, firstSteps ${firstSteps}`);

    const tier = async (id: number) => {
      const [priceWei, priceToken, dstAmount] = await basePub.readContract({ address: gate, abi: gateAbi, functionName: 'tiers', args: [id] });
      return { priceWei, priceToken, dstAmount };
    };
    const getOrder = (id: Hex) => basePub.readContract({ address: gate, abi: gateAbi, functionName: 'getOrder', args: [id] });
    const openEth = async (recipient: Address, tierId: number) => {
      const t = await tier(tierId);
      const hash = await userBase.writeContract({ address: gate, abi: gateAbi, functionName: 'open', args: [recipient, tierId], value: t.priceWei });
      const rcpt = await basePub.waitForTransactionReceipt({ hash });
      return { orderId: parseEventLogs({ abi: gateAbi, logs: rcpt.logs, eventName: 'Opened' })[0].args.orderId, tier: t, rcpt };
    };
    const warp = async (seconds: number) => {
      await baseTest.increaseTime({ seconds });
      await baseTest.mine({ blocks: 1 });
    };

    // ------------------------------------------------------------------ relayer
    const stateFile = join(tmp, 'relayer.state.json');
    const relayerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RULES_MODE: 'off',
      BASE_RPC_URL: baseRpc,
      BASE_CHAIN_ID: '31337',
      GATE_ADDRESS: gate,
      GATE_DEPLOY_BLOCK: String(gateDep.deployBlock),
      BASE_CONFIRMATIONS: '0',
      PORTALDOT_EVM_RPC_URL: pdRpc,
      PORTALDOT_CHAIN_ID: '31338',
      DOCK_ADDRESS: dock,
      DOCK_DEPLOY_BLOCK: String(pdDep.deployBlock),
      RELAYER_PRIVATE_KEY: KEYS.relayer,
      SAFETY_WINDOW_SEC: String(SAFETY_WINDOW),
      POLL_INTERVAL_MS: '300',
      RETRY_BACKOFF_MS: '200',
      RETRY_BACKOFF_MAX_MS: '1000',
      STATE_FILE: stateFile,
      STATUS_PORT: String(statusPort),
      LOG_LEVEL: 'debug',
    };
    const relayerMain = join(ROOT, 'relayer/src/index.ts');
    const startRelayer = async (extraEnv: NodeJS.ProcessEnv = {}) => {
      const p = start('node', [relayerMain], { cwd: join(ROOT, 'relayer'), env: { ...relayerEnv, ...extraEnv }, logFile: logs.relayer });
      await waitFor('relayer /status', async () => (await fetch(`http://localhost:${statusPort}/healthz`)).ok, 30_000);
      return p;
    };
    const statusUrl = `http://localhost:${statusPort}`;
    const relayerOrder = async (id: Hex) => {
      const r = await fetch(`${statusUrl}/orders/${id}`);
      return r.ok
        ? ((await r.json()) as { status: string; reason?: string; reserveTx?: Hex; fillTx?: Hex; claimTx?: Hex; approveTx?: string })
        : null;
    };
    const crash = async (p: Proc) => {
      await new Promise<void>((resolve) => {
        p.child.once('exit', () => resolve());
        p.child.kill('SIGKILL');
      });
    };
    const fillCount = () => pdPub.readContract({ address: dock, abi: dockAbi, functionName: 'fillCount' });
    /** The user's refund, simulated: returns the revert error name, or null if it would succeed. */
    const refundError = async (id: Hex) => {
      try {
        await basePub.simulateContract({ address: gate, abi: gateAbi, functionName: 'refund', args: [id], account: acct.user });
        return null;
      } catch (e) {
        const m = String((e as Error).message);
        return m.match(/ReservationActive|DeadlineNotReached|NotOpen/)?.[0] ?? m.slice(0, 120);
      }
    };
    // Lets the relayer fill but never claim: simulates a crash window between fill and claim.
    const NO_CLAIM = { PORTALDOT_CONFIRMATIONS: '1000000' };

    // ------------------------------------------------------------------ 1. dry-run
    const recipient1Key = generatePrivateKey();
    const recipient1 = privateKeyToAccount(recipient1Key);
    eq(await pdPub.getBalance({ address: recipient1.address }), 0n, 'fresh recipient starts at 0 tPOT');
    const o1 = await openEth(recipient1.address, 2);
    run('node', [relayerMain, '--dry-run', '--once'], { cwd: join(ROOT, 'relayer'), env: relayerEnv });
    eq(await pdPub.readContract({ address: dock, abi: dockAbi, functionName: 'fillCount' }), 0n, 'dry-run filled nothing');
    eq((await getOrder(o1.orderId)).status, STATUS.Open, 'dry-run reserved and claimed nothing');
    assert(!existsSync(stateFile), 'dry-run wrote no state file');
    ok('relayer --dry-run --once simulated the order and sent nothing');

    // ------------------------------------------------------------------ 2. ETH happy path + first tx
    const treasuryEthBefore = await basePub.getBalance({ address: acct.treasury.address });
    relayer = await startRelayer();
    await waitFor('order 1 claimed', async () => (await getOrder(o1.orderId)).status === STATUS.Filled, 30_000);
    eq(await pdPub.getBalance({ address: recipient1.address }), o1.tier.dstAmount, 'recipient received tier tPOT');
    eq(await basePub.getBalance({ address: acct.treasury.address }), treasuryEthBefore + o1.tier.priceWei, 'treasury got the ETH');
    const ref = await basePub.readContract({ address: gate, abi: gateAbi, functionName: 'fillTxRefOf', args: [o1.orderId] });
    const fillRcpt = await pdPub.getTransactionReceipt({ hash: ref });
    eq(fillRcpt.status, 'success', 'claim references a real Portaldot fill tx');
    eq(fillRcpt.to?.toLowerCase(), dock.toLowerCase(), 'fill tx went to the dock');
    const rec1 = await waitFor('relayer record claimed', async () => {
      const r = await relayerOrder(o1.orderId);
      return r?.status === 'claimed' ? r : null;
    });
    eq(rec1.fillTx, ref, 'relayer state fillTx matches on-chain ref');
    eq(rec1.approveTx, 'off', 'rules step skipped with RULES_MODE=off');
    assert(rec1.reserveTx, 'relayer recorded the reserve tx');
    const reserveRcpt = await basePub.getTransactionReceipt({ hash: rec1.reserveTx });
    eq(reserveRcpt.status, 'success', 'reserve tx succeeded');
    assert((await getOrder(o1.orderId)).reservedAt > 0n, 'gate stored reservedAt');
    const reserveBlock = await basePub.getBlock({ blockNumber: reserveRcpt.blockNumber });
    const fillBlock = await pdPub.getBlock({ blockNumber: fillRcpt.blockNumber });
    assert(reserveBlock.timestamp <= fillBlock.timestamp, 'reserved on Base before the Portaldot fill');
    ok(`ETH order: Opened -> Reserved -> Filled on Portaldot (${ref.slice(0, 10)}…) -> Claimed on Base`);

    const recipientPd = createWalletClient({ chain: pd, transport: http(), account: recipient1 });
    const signHash = await recipientPd.writeContract({ address: firstSteps, abi: firstStepsAbi, functionName: 'sign', args: ['gm Portaldot, arrived by DotGas'] });
    eq((await pdPub.waitForTransactionReceipt({ hash: signHash })).status, 'success', 'first tx succeeded');
    eq(await pdPub.readContract({ address: firstSteps, abi: firstStepsAbi, functionName: 'count' }), 1n, 'guestbook count');
    const entry = await pdPub.readContract({ address: firstSteps, abi: firstStepsAbi, functionName: 'entry', args: [0n] });
    eq(entry.signer, recipient1.address, 'guestbook signer is the new user');
    ok('recipient that started at 0 tPOT signed FirstSteps (first Portaldot tx)');

    const st = (await (await fetch(`${statusUrl}/status`)).json()) as { pool: { balanceWei: string }; orders: Record<string, number>; recentFills: unknown[] };
    eq(BigInt(st.pool.balanceWei), parseEther('100') - o1.tier.dstAmount, '/status pool balance');
    eq(st.orders.claimed, 1, '/status claimed count');
    eq(st.recentFills.length, 1, '/status recent fills');
    ok('/status reports pool balance, order counts and recent fills');

    // ------------------------------------------------------------------ 3. USDC path
    const deployerUsdc = { address: usdc, abi: erc20Abi } as const;
    await basePub.waitForTransactionReceipt({
      hash: await deployerBase.writeContract({ ...deployerUsdc, functionName: 'mint', args: [acct.user.address, 100_000_000n] }),
    });
    const t3 = await tier(3);
    await basePub.waitForTransactionReceipt({ hash: await userBase.writeContract({ ...deployerUsdc, functionName: 'approve', args: [gate, t3.priceToken] }) });
    const recipient2 = privateKeyToAccount(generatePrivateKey()).address;
    const usdcRcpt = await basePub.waitForTransactionReceipt({
      hash: await userBase.writeContract({ address: gate, abi: gateAbi, functionName: 'openUSDC', args: [recipient2, 3] }),
    });
    const o2 = parseEventLogs({ abi: gateAbi, logs: usdcRcpt.logs, eventName: 'Opened' })[0].args.orderId;
    await waitFor('usdc order claimed', async () => (await getOrder(o2)).status === STATUS.Filled, 30_000);
    eq(await pdPub.getBalance({ address: recipient2 }), t3.dstAmount, 'usdc recipient got tPOT');
    eq(await basePub.readContract({ ...deployerUsdc, functionName: 'balanceOf', args: [acct.treasury.address] }), t3.priceToken, 'treasury got USDC');
    ok('USDC order: filled on Portaldot and claimed in USDC');

    // ------------------------------------------------------------------ 4. dock rejection -> refund
    // recipient1 already holds 5 tPOT; tier 3 (12 tPOT) would exceed the 15 tPOT lifetime cap.
    const o3 = await openEth(recipient1.address, 3);
    const rec3 = await waitFor('order 3 rejected', async () => {
      const r = await relayerOrder(o3.orderId);
      return r?.status === 'rejected' ? r : null;
    });
    assert(rec3.reason?.includes('RecipientCapExceeded'), `rejection reason (${rec3.reason})`);
    eq((await getOrder(o3.orderId)).status, STATUS.Open, 'rejected order still open on Base');
    eq((await getOrder(o3.orderId)).reservedAt, 0n, 'rejected order was never reserved');
    const userBefore3 = await basePub.getBalance({ address: acct.user.address });
    await warp(ORDER_TTL + 1);
    const refundRcpt = await basePub.waitForTransactionReceipt({
      hash: await userBase.writeContract({ address: gate, abi: gateAbi, functionName: 'refund', args: [o3.orderId] }),
    });
    const gasCost = refundRcpt.gasUsed * refundRcpt.effectiveGasPrice;
    eq(await basePub.getBalance({ address: acct.user.address }), userBefore3 + o3.tier.priceWei - gasCost, 'user refunded in full');
    eq((await getOrder(o3.orderId)).status, STATUS.Refunded, 'order refunded');
    ok('Dock cap rejection caught before reserving -> nothing reserved or filled -> user refunded after the deadline');

    // ------------------------------------------------------------------ 5. restart + safety window
    await relayer.stop();
    relayer = null;
    const o4 = await openEth(privateKeyToAccount(generatePrivateKey()).address, 1);
    await warp(ORDER_TTL - SAFETY_WINDOW + 50); // 250s left < 300s safety window
    relayer = await startRelayer();
    const rec4 = await waitFor('order 4 skipped', async () => {
      const r = await relayerOrder(o4.orderId);
      return r?.status === 'skipped' ? r : null;
    });
    assert(rec4.reason?.includes('safety window'), 'skip reason mentions safety window');
    eq(await fillCount(), 2n, 'restart did not double-fill');
    eq((await relayerOrder(o1.orderId))?.status, 'claimed', 'state survived restart');
    await warp(SAFETY_WINDOW);
    await basePub.waitForTransactionReceipt({
      hash: await userBase.writeContract({ address: gate, abi: gateAbi, functionName: 'refund', args: [o4.orderId] }),
    });
    eq((await getOrder(o4.orderId)).status, STATUS.Refunded, 'order 4 refunded');
    ok('relayer restart resumed from state file; order inside safety window skipped and refunded');

    // ------------------------------------------------------------------ 6. crash between fill and claim
    await relayer.stop();
    relayer = await startRelayer(NO_CLAIM);
    const o5 = await openEth(privateKeyToAccount(generatePrivateKey()).address, 1);
    const rec5 = await waitFor('order 5 filled (claim held back)', async () => {
      const r = await relayerOrder(o5.orderId);
      return r?.status === 'filled' ? r : null;
    });
    await crash(relayer);
    relayer = null;
    eq((await getOrder(o5.orderId)).status, STATUS.Reserved, 'order 5 reserved, not claimed');
    eq(await pdPub.readContract({ address: dock, abi: dockAbi, functionName: 'filled', args: [o5.orderId] }), true, 'order 5 filled on Portaldot');
    await warp(ORDER_TTL + 60); // past the original deadline while the relayer is down
    eq(await refundError(o5.orderId), 'ReservationActive', 'user cannot refund a reserved order after the deadline');
    const fills5 = await fillCount();
    relayer = await startRelayer();
    await waitFor('order 5 claimed after restart', async () => (await getOrder(o5.orderId)).status === STATUS.Filled, 30_000);
    eq(await basePub.readContract({ address: gate, abi: gateAbi, functionName: 'fillTxRefOf', args: [o5.orderId] }), rec5.fillTx, 'claim cites the recorded fill');
    eq(await fillCount(), fills5, 'no second fill after the crash');
    ok('crash between fill and claim; restart after the original deadline still claims (no refund race)');

    // ------------------------------------------------------------------ 7. crash + lost state file
    await relayer.stop();
    relayer = await startRelayer(NO_CLAIM);
    const o6 = await openEth(privateKeyToAccount(generatePrivateKey()).address, 1);
    const rec6 = await waitFor('order 6 filled (claim held back)', async () => {
      const r = await relayerOrder(o6.orderId);
      return r?.status === 'filled' ? r : null;
    });
    await crash(relayer);
    relayer = null;
    rmSync(stateFile, { force: true });
    const fills6 = await fillCount();
    relayer = await startRelayer();
    await waitFor('order 6 claimed after state loss', async () => (await getOrder(o6.orderId)).status === STATUS.Filled, 30_000);
    eq(await basePub.readContract({ address: gate, abi: gateAbi, functionName: 'fillTxRefOf', args: [o6.orderId] }), rec6.fillTx, 'claim cites the fill found on Portaldot');
    eq(await fillCount(), fills6, 'no second fill after state loss');
    eq((await relayerOrder(o1.orderId))?.status, 'claimed', 'history rebuilt from GATE_DEPLOY_BLOCK');
    eq((await relayerOrder(o3.orderId))?.status, 'refunded', 'refunded order rebuilt from chain state');
    ok('lost state file: rebuilt from GATE_DEPLOY_BLOCK, fill recovered via Dock.filledAt, claimed once');

    // ------------------------------------------------------------------ 8. reservation never filled
    await relayer.stop();
    relayer = null;
    const o7 = await openEth(privateKeyToAccount(generatePrivateKey()).address, 1);
    const relayerBase = createWalletClient({ chain: base, transport: http(), account: acct.relayer });
    await basePub.waitForTransactionReceipt({
      hash: await relayerBase.writeContract({ address: gate, abi: gateAbi, functionName: 'reserve', args: [o7.orderId] }),
    });
    await warp(ORDER_TTL + 1);
    eq(await refundError(o7.orderId), 'ReservationActive', 'refund blocked while the reservation is active');
    const timeout = await basePub.readContract({ address: gate, abi: gateAbi, functionName: 'reserveTimeout' });
    await warp(Number(timeout));
    eq(await refundError(o7.orderId), null, 'refund possible after the reservation timeout');
    await basePub.waitForTransactionReceipt({
      hash: await userBase.writeContract({ address: gate, abi: gateAbi, functionName: 'refund', args: [o7.orderId] }),
    });
    eq((await getOrder(o7.orderId)).status, STATUS.Refunded, 'order 7 refunded');
    ok('reserved but never filled: refund unlocks after the reservation timeout');

    success = true;
    console.log('dotgas e2e: all scenarios passed');
  } finally {
    if (relayer) await relayer.stop();
    await Promise.all(procs.map((p) => p.stop()));
    for (const f of ['gate-31337.json', 'portaldot-31338.json']) rmSync(join(EVM, 'deployments', f), { force: true });
    if (!success) {
      console.error(`\n--- relayer log (${logs.relayer}) ---`);
      try {
        console.error(readFileSync(logs.relayer, 'utf8').split('\n').slice(-60).join('\n'));
      } catch {}
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`dotgas e2e FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
