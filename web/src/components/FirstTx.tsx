import { useEffect, useState } from 'react';
import { formatEther, type Address, type Hex } from 'viem';
import { firstStepsAbi } from '../abi.ts';
import { config, portaldotChain } from '../config.ts';
import { ensureChain, portaldotPublic, shortHex, walletFor } from '../wallet.ts';
import { TxRef } from './TxRef.tsx';

interface Entry {
  signer: Address;
  blockNumber: bigint;
  message: string;
}

/** The finale: the user's very first Portaldot transaction, paid with the tPOT Ferry delivered. */
export function FirstTx({ account, tpot }: { account: Address | null; tpot: bigint | null }) {
  const [msg, setMsg] = useState('gm Portaldot — arrived by Ferry ⛴');
  const [tx, setTx] = useState<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [count, setCount] = useState<bigint | null>(null);

  const load = async () => {
    try {
      const [c, l] = await Promise.all([
        portaldotPublic.readContract({ address: config.firstSteps, abi: firstStepsAbi, functionName: 'count' }),
        portaldotPublic.readContract({ address: config.firstSteps, abi: firstStepsAbi, functionName: 'latest', args: [5n] }),
      ]);
      setCount(c);
      setEntries(l.map((e) => ({ signer: e.signer, blockNumber: e.blockNumber, message: e.message })));
    } catch {
      /* contract not configured or RPC down: keep the panel usable */
    }
  };

  useEffect(() => {
    void load();
  }, [tx]);

  const sign = async () => {
    if (!account) return;
    setBusy(true);
    setErr(null);
    try {
      await ensureChain(portaldotChain);
      const wallet = walletFor(portaldotChain, account);
      // No fixed gas limit: Portaldot's estimates are large, let the node estimate.
      const hash = await wallet.writeContract({
        address: config.firstSteps,
        abi: firstStepsAbi,
        functionName: 'sign',
        args: [msg],
        account,
        chain: portaldotChain,
      });
      setTx(hash);
      await portaldotPublic.waitForTransactionReceipt({ hash });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>3 · Make your first Portaldot tx</h2>
      <p className="muted">
        Adds Portaldot ({portaldotChain.id}) to MetaMask and signs the on-chain <em>FirstSteps</em> guestbook using the tPOT you
        just received.
        {tpot !== null && <> Your balance: <b>{formatEther(tpot)} tPOT</b>.</>}
      </p>
      <div className="row">
        <input value={msg} maxLength={280} onChange={(e) => setMsg(e.target.value)} />
        <button className="primary" disabled={!account || busy || !msg || tpot === 0n} onClick={sign}>
          {busy ? 'Signing…' : 'Sign the guestbook'}
        </button>
      </div>
      {tpot === 0n && <p className="muted small">You need tPOT first — open an order above.</p>}
      {tx && (
        <p className="ok">
          🎉 First Portaldot transaction: <TxRef hash={tx} explorer={config.portaldotExplorer || undefined} />
        </p>
      )}
      {err && <p className="err">{err}</p>}
      {count !== null && (
        <div className="guestbook">
          <div className="muted small">{count.toString()} signatures so far</div>
          {entries.map((e, i) => (
            <div key={i} className="entry">
              <code>{shortHex(e.signer, 4)}</code> <span>{e.message}</span>{' '}
              <span className="muted small">#{e.blockNumber.toString()}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
