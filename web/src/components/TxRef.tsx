import { shortHex } from '../wallet.ts';

/** Explorer-style transaction reference: short hash, link when an explorer is known, copy on click. */
export function TxRef({ hash, explorer, kind = 'tx' }: { hash?: string | null; explorer?: string; kind?: 'tx' | 'block' | 'address' }) {
  if (!hash) return null;
  const href = explorer ? `${explorer}/${kind}/${hash}` : undefined;
  return (
    <span className="txref" title={hash}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {shortHex(hash)}
        </a>
      ) : (
        <code>{shortHex(hash)}</code>
      )}
      <button className="copy" onClick={() => navigator.clipboard?.writeText(hash)} aria-label="copy">
        ⧉
      </button>
    </span>
  );
}
