# DotGas: top-level tasks. Targets run sequentially on purpose (cargo builds are heavy).
.PHONY: all deps build build-evm build-ink build-web test test-evm test-ink test-relayer test-e2e typecheck \
        deploy-base deploy-portaldot deploy-rules relayer web clean

INK_DIR := contracts/ink/dotgas_rules
EVM_DIR := contracts/evm

all: build

deps:
	git submodule update --init --recursive
	npm install

# ------------------------------------------------------------------ build
build: build-evm build-ink build-web

build-evm:
	cd $(EVM_DIR) && forge build

# Requires cargo-contract 5.x (cargo install cargo-contract --version ^5 --locked).
# The toolchain is pinned by $(INK_DIR)/rust-toolchain.toml.
build-ink:
	cd $(INK_DIR) && cargo contract build --release
	mkdir -p $(INK_DIR)/artifacts
	cp $(INK_DIR)/target/ink/dotgas_rules.contract $(INK_DIR)/target/ink/dotgas_rules.json $(INK_DIR)/target/ink/dotgas_rules.wasm $(INK_DIR)/artifacts/

build-web:
	npm --workspace web run build

# ------------------------------------------------------------------ test
test: test-evm test-ink test-relayer test-e2e
	@echo "all DotGas test suites passed"

test-evm:
	cd $(EVM_DIR) && forge test

test-ink:
	cd $(INK_DIR) && cargo test

test-relayer:
	npm --workspace relayer test

test-e2e:
	node scripts/e2e/run.ts

typecheck:
	npm --workspaces --if-present run typecheck

# ------------------------------------------------------------------ deploy (keys from env / .env only)
deploy-base:
	cd $(EVM_DIR) && set -a && . ../../.env && set +a && \
	  forge script script/DeployGate.s.sol:DeployGate --rpc-url "$$BASE_RPC_URL" --broadcast --slow

# Portaldot: never pass --gas-limit; estimates come from the eth-rpc and are very large numbers.
deploy-portaldot:
	cd $(EVM_DIR) && set -a && . ../../.env && set +a && \
	  forge script script/DeployPortaldot.s.sol:DeployPortaldot --rpc-url "$$PORTALDOT_EVM_RPC_URL" --broadcast --slow --legacy

deploy-rules:
	npm --workspace scripts run deploy:rules

# ------------------------------------------------------------------ run
relayer:
	npm --workspace relayer start

web:
	npm --workspace web run dev

clean:
	cd $(EVM_DIR) && forge clean
	rm -rf web/dist relayer-state relayer/relayer-state
