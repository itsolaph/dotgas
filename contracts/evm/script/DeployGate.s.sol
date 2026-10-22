// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DotGasGate} from "../src/DotGasGate.sol";

/// @notice Deploys DotGasGate on the source chain (Base Sepolia) and configures default tiers.
///
/// Env (keys are only ever read from the environment):
///   DEPLOYER_PRIVATE_KEY  required
///   RELAYER_ADDRESS       required
///   TREASURY_ADDRESS      default: deployer
///   PAYMENT_TOKEN         default: Circle test USDC on Base Sepolia (set to 0x0 to disable token payments)
///   ORDER_TTL             seconds, default 1800
///   RESERVE_SAFETY        seconds that must remain before the deadline to reserve, default: contract default (120)
///   RESERVE_TIMEOUT       seconds a reservation blocks the refund, default: contract default (86400)
///   TIER{1,2,3}_PRICE_WEI / TIER{1,2,3}_PRICE_TOKEN / TIER{1,2,3}_DST  optional tier overrides
contract DeployGate is Script {
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (DotGasGate gate) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address token = vm.envOr("PAYMENT_TOKEN", BASE_SEPOLIA_USDC);
        uint64 ttl = uint64(vm.envOr("ORDER_TTL", uint256(1800)));

        vm.startBroadcast(pk);
        gate = new DotGasGate(deployer, relayer, treasury, token, ttl);
        // Defaults: tPOT amounts are 18-decimal EVM-side units, multiples of 1e4 (native tPOT has 14 decimals).
        _tier(gate, 1, 0.0002 ether, 500_000, 2 ether); // "Starter": 0.5 USDC -> 2 tPOT
        _tier(gate, 2, 0.0005 ether, 1_000_000, 5 ether); // "Explorer": 1 USDC -> 5 tPOT
        _tier(gate, 3, 0.001 ether, 2_000_000, 12 ether); // "Builder": 2 USDC -> 12 tPOT
        uint256 safety = vm.envOr("RESERVE_SAFETY", uint256(type(uint256).max));
        if (safety != type(uint256).max) gate.setReserveSafety(uint64(safety));
        uint256 timeout = vm.envOr("RESERVE_TIMEOUT", uint256(0));
        if (timeout != 0) gate.setReserveTimeout(uint64(timeout));
        vm.stopBroadcast();

        console2.log("DotGasGate", address(gate));
        // The relayer needs this as GATE_DEPLOY_BLOCK to rebuild its order set from events.
        console2.log("GATE_DEPLOY_BLOCK", block.number);
        _writeDeployment(address(gate), relayer, treasury, token);
    }

    function _tier(DotGasGate gate, uint8 id, uint256 priceWei, uint256 priceToken, uint256 dst) internal {
        string memory n = vm.toString(id);
        gate.setTier(
            id,
            vm.envOr(string.concat("TIER", n, "_PRICE_WEI"), priceWei),
            vm.envOr(string.concat("TIER", n, "_PRICE_TOKEN"), priceToken),
            vm.envOr(string.concat("TIER", n, "_DST"), dst),
            true
        );
    }

    function _writeDeployment(address gate, address relayer, address treasury, address token) internal {
        string memory k = "gate";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "relayer", relayer);
        vm.serializeAddress(k, "treasury", treasury);
        vm.serializeAddress(k, "paymentToken", token);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "DotGasGate", gate);
        vm.writeJson(json, string.concat("deployments/gate-", vm.toString(block.chainid), ".json"));
    }
}
