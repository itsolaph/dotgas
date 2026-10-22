# Progress log

- Scaffold: monorepo layout (contracts/evm, contracts/ink, relayer, web, scripts), .gitignore, MIT LICENSE.
- EVM contracts: FerryGate, FerryDock, FirstSteps + forge deploy scripts. forge test: 60 passed, 0 failed (incl. 6 fuzz).
- Relayer (TypeScript, viem + polkadot-js): scan/approve/fill/claim state machine, JSON state, /status server, --dry-run. node --test: 12 passed; tsc clean.
- ink! ferry_rules (policy + audit ledger): cargo test 12 passed; `cargo contract build --release` OK with cargo-contract 5.0.3 on pinned Rust 1.89 (rustc 1.99 removed panic_immediate_abort used by cargo-contract 5). Artifacts committed under contracts/ink/ferry_rules/artifacts. polkadot-js deploy script (scripts/deploy-rules.ts) typechecks; not run against the live testnet (no funded key used in this session).
