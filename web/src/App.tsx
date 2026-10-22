import { useCallback, useEffect, useState } from 'react';
import { formatEther, formatUnits, isAddress, parseEventLogs, zeroHash, type Address, type Hex } from 'viem';
import { erc20Abi, gateAbi } from './abi.ts';
import { baseChain, config, isConfigured, portaldotChain } from './config.ts';
import { basePublic, connect, ensureChain, hasWallet, portaldotPublic, shortHex, walletFor } from './wallet.ts';
import { Timeline, type GateOrderView, type RelayerRecord } from './components/Timeline.tsx';
import { FirstTx } from './components/FirstTx.tsx';
import { StatusPanel } from './components/StatusPanel.tsx';
import { TxRef } from './components/TxRef.tsx';

interface Tier {
  id: number;
  priceWei: bigint;
  priceToken: bigint;
  dstAmount: bigint;
}

const TIER_NAMES: Record<number, string> = { 1: 'Starter', 2: 'Explorer', 3: 'Builder' };
const STORAGE_KEY = 'landfall:lastOrder';

const fmt = (v: bigint | null, decimals = 18, digits = 4) =>
  v === null ? '—' : Number(formatUnits(v, decimals)).toLocaleString(undefined, { maximumFractionDigits: digits });

export function App() {
  const [account, setAccount] = useState<Address | null>(null);
  const [recipient, setRecipient] = useState('');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [tierId, setTierId] = useState(1);
  const [payWith, setPayWith] = useState<'ETH' | 'USDC'>('ETH');
  const [bal, setBal] = useState<{ eth: bigint | null; usdc: bigint | null; tpot: bigint | null }>({ eth: null, usdc: null, tpot: null });
  const [orderId, setOrderId] = useState<Hex | null>(null);
  const [openTx, setOpenTx] = useState<Hex | undefined>();
  const [order, setOrder] = useState<GateOrderView | null>(null);
  const [record, setRecord] = useState<RelayerRecord | null>(null);
  const [fillRef, setFillRef] = useState<Hex | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Restore the last order across reloads.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const { orderId, openTx } = JSON.parse(saved) as { orderId: Hex; openTx?: Hex };
      setOrderId(orderId);
      setOpenTx(openTx);
    }
  }, []);

  // Tiers are owner-set on LandfallGate; read them from chain.
  useEffect(() => {
    if (!isConfigured) return;
    (async () => {
      const out: Tier[] = [];
      for (const id of [1, 2, 3, 4, 5]) {
        try {
          const [priceWei, priceToken, dstAmount, active] = await basePublic.readContract({
            address: config.gate,
            abi: gateAbi,
            functionName: 'tiers',
            args: [id],
          });
          if (active && dstAmount > 0n) out.push({ id, priceWei, priceToken, dstAmount });
        } catch {
          break;
        }
      }
      setTiers(out);
      if (out[0]) setTierId(out[0].id);
    })();
  }, []);

  const target = (isAddress(recipient) ? recipient : account) as Address | null;

  const refresh = useCallback(async () => {
    setNow(Math.floor(Date.now() / 1000));
    const safe = async <T,>(f: () => Promise<T>) => {
      try {
        return await f();
      } catch {
        return null;
      }
    };
    if (account) {
      const [eth, usdc] = await Promise.all([
        safe(() => basePublic.getBalance({ address: account })),
        safe(() => basePublic.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] })),
      ]);
      const tpot = target ? await safe(() => portaldotPublic.getBalance({ address: target })) : null;
      setBal({ eth, usdc, tpot });
    }
    if (orderId && isConfigured) {
      const o = await safe(() => basePublic.readContract({ address: config.gate, abi: gateAbi, functionName: 'getOrder', args: [orderId] }));
      if (o) setOrder({ status: o.status, deadline: o.deadline, dstAmount: o.dstAmount, recipient: o.recipient });
      const ref = await safe(() => basePublic.readContract({ address: config.gate, abi: gateAbi, functionName: 'fillTxRefOf', args: [orderId] }));
      setFillRef(ref && ref !== zeroHash ? ref : null);
      const r = await safe(async () => {
        const res = await fetch(`${config.relayerStatusUrl}/orders/${orderId}`);
        return res.ok ? ((await res.json()) as RelayerRecord) : null;
      });
      setRecord(r);
    }
  }, [account, orderId, target]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr(e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const onConnect = () =>
    run('Connecting', async () => {
      const a = await connect();
      setAccount(a);
      if (!recipient) setRecipient(a);
    });

  const tier = tiers.find((t) => t.id === tierId);

  const onOpen = () =>
    run('Opening order', async () => {
      if (!account || !tier || !target) return;
      await ensureChain(baseChain);
      const wallet = walletFor(baseChain, account);
      let hash: Hex;
      if (payWith === 'ETH') {
        hash = await wallet.writeContract({
          address: config.gate,
          abi: gateAbi,
          functionName: 'open',
          args: [target, tier.id],
          value: tier.priceWei,
          account,
          chain: baseChain,
        });
      } else {
        const allowance = await basePublic.readContract({
          address: config.usdc,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [account, config.gate],
        });
        if (allowance < tier.priceToken) {
          setBusy('Approving USDC');
          const a = await wallet.writeContract({
            address: config.usdc,
            abi: erc20Abi,
            functionName: 'approve',
            args: [config.gate, tier.priceToken],
            account,
            chain: baseChain,
          });
          await basePublic.waitForTransactionReceipt({ hash: a });
          setBusy('Opening order');
        }
        hash = await wallet.writeContract({
          address: config.gate,
          abi: gateAbi,
          functionName: 'openUSDC',
          args: [target, tier.id],
          account,
          chain: baseChain,
        });
      }
      const rcpt = await basePublic.waitForTransactionReceipt({ hash });
      const [ev] = parseEventLogs({ abi: gateAbi, logs: rcpt.logs, eventName: 'Opened' });
      if (!ev) throw new Error('Opened event not found in receipt');
      setOrderId(ev.args.orderId);
      setOpenTx(hash);
      setOrder(null);
      setRecord(null);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ orderId: ev.args.orderId, openTx: hash }));
    });

  const onRefund = () =>
    run('Refunding', async () => {
      if (!account || !orderId) return;
      await ensureChain(baseChain);
      const hash = await walletFor(baseChain, account).writeContract({
        address: config.gate,
        abi: gateAbi,
        functionName: 'refund',
        args: [orderId],
        account,
        chain: baseChain,
      });
      await basePublic.waitForTransactionReceipt({ hash });
    });

  const canRefund = order?.status === 1 && Number(order.deadline) < now;
  const price = tier ? (payWith === 'ETH' ? tier.priceWei : tier.priceToken) : 0n;
  const payDisabled = !tier || !target || price === 0n || !!busy || !isConfigured;

  return (
    <main>
      <header>
        <div>
          <h1>⛴ Landfall</h1>
          <p className="muted">Pay on Base Sepolia, get tPOT gas on Portaldot. Your first Portaldot transaction just works.</p>
        </div>
        {account ? (
          <span className="pill">{shortHex(account, 4)}</span>
        ) : (
          <button className="primary" onClick={onConnect} disabled={!hasWallet()}>
            {hasWallet() ? 'Connect MetaMask' : 'No wallet detected'}
          </button>
        )}
      </header>

      {!isConfigured && <p className="note">Set VITE_GATE_ADDRESS and friends in .env (see .env.example).</p>}

      <section className="card balances">
        <div>
          <span className="muted small">{baseChain.name} ETH</span>
          <b>{fmt(bal.eth)}</b>
        </div>
        <div>
          <span className="muted small">{baseChain.name} USDC</span>
          <b>{fmt(bal.usdc, 6, 2)}</b>
        </div>
        <div>
          <span className="muted small">
            {portaldotChain.name} tPOT {target && <code>({shortHex(target, 3)})</code>}
          </span>
          <b>{fmt(bal.tpot)}</b>
        </div>
      </section>

      <section className="card">
        <h2>1 · Pick your gas tier</h2>
        <div className="tiers">
          {tiers.length === 0 && <p className="muted">No active tiers found on LandfallGate.</p>}
          {tiers.map((t) => (
            <button key={t.id} className={`tier ${t.id === tierId ? 'selected' : ''}`} onClick={() => setTierId(t.id)}>
              <div className="tier-name">{TIER_NAMES[t.id] ?? `Tier ${t.id}`}</div>
              <div className="tier-amt">{fmt(t.dstAmount, 18, 2)} tPOT</div>
              <div className="muted small">
                {t.priceWei > 0n ? `${formatEther(t.priceWei)} ETH` : '—'} · {t.priceToken > 0n ? `${formatUnits(t.priceToken, 6)} USDC` : '—'}
              </div>
            </button>
          ))}
        </div>
        <div className="row">
          <label className="grow">
            <span className="muted small">Portaldot recipient (EVM address, defaults to your account)</span>
            <input value={recipient} placeholder="0x…" onChange={(e) => setRecipient(e.target.value.trim())} />
          </label>
          <div className="seg">
            {(['ETH', 'USDC'] as const).map((p) => (
              <button key={p} className={payWith === p ? 'on' : ''} onClick={() => setPayWith(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
        {recipient && !isAddress(recipient) && <p className="err small">Not a valid address.</p>}
        <button className="primary wide" onClick={account ? onOpen : onConnect} disabled={account ? payDisabled : !hasWallet()}>
          {busy ??
            (account
              ? tier
                ? `Pay ${payWith === 'ETH' ? formatEther(tier.priceWei) : formatUnits(tier.priceToken, 6)} ${payWith} → get ${fmt(tier.dstAmount, 18, 2)} tPOT`
                : 'Pick a tier'
              : 'Connect MetaMask')}
        </button>
        {err && <p className="err">{err}</p>}
      </section>

      {orderId && (
        <section className="card">
          <h2>2 · Order status</h2>
          <p className="muted small">
            Order <TxRef hash={orderId} />
          </p>
          <Timeline openTx={openTx} order={order} record={record} fillRef={fillRef} nowSec={now} />
          {canRefund && (
            <button className="danger" onClick={onRefund} disabled={!!busy}>
              Deadline passed — refund my payment
            </button>
          )}
        </section>
      )}

      <FirstTx account={account} tpot={bal.tpot} />
      <StatusPanel />

      <footer className="muted small">
        Intent-bridge model: an operator-run relayer fills on Portaldot and is repaid on Base; if it does not fill in time, you can refund
        on-chain after the deadline. Testnet only.
      </footer>
    </main>
  );
}
