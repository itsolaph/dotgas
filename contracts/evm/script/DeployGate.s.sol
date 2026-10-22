// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LandfallGate} from "../src/LandfallGate.sol";

/// @notice Deploys LandfallGate on the source chain (Base Sepolia) and configures default tiers.
///
/// Env (keys are only ever read from the environment):
///   DEPLOYER_PRIVATE_KEY  required
///   RELAYER_ADDRESS       required
///   TREASURY_ADDRESS      default: deployer
///   PAYMENT_TOKEN         default: Circle test USDC on Base Sepolia (set to 0x0 to disable token payments)
///   ORDER_TTL             seconds, default 1800
///   TIER{1,2,3}_PRICE_WEI / TIER{1,2,3}_PRICE_TOKEN / TIER{1,2,3}_DST  optional tier overrides
contract DeployGate is Script {
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (LandfallGate gate) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address token = vm.envOr("PAYMENT_TOKEN", BASE_SEPOLIA_USDC);
        uint64 ttl = uint64(vm.envOr("ORDER_TTL", uint256(1800)));

        vm.startBroadcast(pk);
        gate = new LandfallGate(deployer, relayer, treasury, token, ttl);
        // Defaults: tPOT amounts are 18-decimal EVM-side units, multiples of 1e4 (native tPOT has 14 decimals).
        _tier(gate, 1, 0.0002 ether, 500_000, 2 ether); // "Starter": 0.5 USDC -> 2 tPOT
        _tier(gate, 2, 0.0005 ether, 1_000_000, 5 ether); // "Explorer": 1 USDC -> 5 tPOT
        _tier(gate, 3, 0.001 ether, 2_000_000, 12 ether); // "Builder": 2 USDC -> 12 tPOT
        vm.stopBroadcast();

        console2.log("LandfallGate", address(gate));
        _writeDeployment(address(gate), relayer, treasury, token);
    }

    function _tier(LandfallGate gate, uint8 id, uint256 priceWei, uint256 priceToken, uint256 dst) internal {
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
        string memory json = vm.serializeAddress(k, "LandfallGate", gate);
        vm.writeJson(json, string.concat("deployments/gate-", vm.toString(block.chainid), ".json"));
    }
}
