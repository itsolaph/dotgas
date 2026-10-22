// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {DotGasDock} from "../src/DotGasDock.sol";
import {FirstSteps} from "../src/FirstSteps.sol";

/// @notice Deploys DotGasDock + FirstSteps on Portaldot's EVM (pallet-revive via eth-rpc).
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  required
///   RELAYER_ADDRESS       required
///   DOCK_MAX_PER_FILL     default 20 tPOT (18-decimal units)
///   DOCK_RECIPIENT_CAP    default 30 tPOT
///   DOCK_INITIAL_FUND     tPOT to seed the pool with, default 0
///
/// Portaldot gas estimates are very large numbers; never pass a fixed --gas-limit, let the RPC estimate.
contract DeployPortaldot is Script {
    function run() external returns (DotGasDock dock, FirstSteps book) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        uint256 maxPerFill = vm.envOr("DOCK_MAX_PER_FILL", uint256(20 ether));
        uint256 cap = vm.envOr("DOCK_RECIPIENT_CAP", uint256(30 ether));
        uint256 fund = vm.envOr("DOCK_INITIAL_FUND", uint256(0));

        vm.startBroadcast(pk);
        dock = new DotGasDock(deployer, relayer, maxPerFill, cap);
        book = new FirstSteps();
        if (fund > 0) {
            (bool ok,) = address(dock).call{value: fund}("");
            require(ok, "fund failed");
        }
        vm.stopBroadcast();

        console2.log("DotGasDock", address(dock));
        console2.log("FirstSteps", address(book));
        console2.log("DOCK_DEPLOY_BLOCK", block.number);

        string memory k = "portaldot";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeAddress(k, "relayer", relayer);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "FirstSteps", address(book));
        string memory json = vm.serializeAddress(k, "DotGasDock", address(dock));
        vm.writeJson(json, string.concat("deployments/portaldot-", vm.toString(block.chainid), ".json"));
    }
}
