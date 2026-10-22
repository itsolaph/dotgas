# Progress log

- Scaffold: monorepo layout (contracts/evm, contracts/ink, relayer, web, scripts), .gitignore, MIT LICENSE.
- EVM contracts: FerryGate, FerryDock, FirstSteps + forge deploy scripts. forge test: 60 passed, 0 failed (incl. 6 fuzz).
- Relayer (TypeScript, viem + polkadot-js): scan/approve/fill/claim state machine, JSON state, /status server, --dry-run. node --test: 12 passed; tsc clean.
