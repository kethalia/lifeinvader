// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DeterministicDeployment } from "../src/DeterministicDeployment.sol";

interface BroadcastVm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Foundry entrypoint for permissionless deterministic deployment.
contract DeployLifeinvader {
    BroadcastVm private constant vm =
        BroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event ProtocolReady(address indexed protocol);

    function run() external returns (address protocol) {
        vm.startBroadcast();
        protocol = DeterministicDeployment.deploy();
        vm.stopBroadcast();

        emit ProtocolReady(protocol);
    }
}
