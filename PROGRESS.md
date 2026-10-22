# Progress log

- Scaffold: monorepo layout (contracts/evm, contracts/ink, relayer, web, scripts), .gitignore, MIT LICENSE.
- EVM contracts: LandfallGate, LandfallDock, FirstSteps + forge deploy scripts. forge test: 60 passed, 0 failed (incl. 6 fuzz).
- Relayer (TypeScript, viem + polkadot-js): scan/approve/fill/claim state machine, JSON state, /status server, --dry-run. node --test: 12 passed; tsc clean.
- ink! landfall_rules (policy + audit ledger): cargo test 12 passed; `cargo contract build --release` OK with cargo-contract 5.0.3 on pinned Rust 1.89 (rustc 1.99 removed panic_immediate_abort used by cargo-contract 5). Artifacts committed under contracts/ink/landfall_rules/artifacts. polkadot-js deploy script (scripts/deploy-rules.ts) typechecks; not run against the live testnet (no funded key used in this session).
- Web (Vite + React + viem): connect MetaMask, balances, tiers from chain, open ETH/USDC order, live timeline from gate + relayer /orders/:id, refund after deadline, add Portaldot network + sign FirstSteps. `npm run build` (tsc + vite) OK.
- Local e2e (scripts/e2e/run.ts): two anvils + forge deploy scripts + relayer (RULES_MODE=off): dry-run, ETH fill+claim, first tx from a 0-balance address, /status, USDC path, Dock cap rejection + refund, restart/resume + safety-window skip + refund. 9/9 checks pass. `npm test` / `make test` runs forge + ink + relayer unit + e2e: all green.
- Docs: README (why, mermaid architecture + sequence, why both VMs, trust model/risks, local run, deploy, deployments table placeholders, roadmap, credits). Not done: live testnet deployment (no keys used in this session); ink! step not covered by e2e (needs a Substrate contracts node; RULES_MODE=off there).
