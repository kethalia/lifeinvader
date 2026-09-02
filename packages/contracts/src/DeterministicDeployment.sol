// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Lifeinvader } from "./Lifeinvader.sol";

/// @title DeterministicDeployment
/// @notice Frozen constants and deployment logic for the Lifeinvader v1 protocol.
/// @dev Uses the raw-calldata deterministic factory documented by EIP-7997.
library DeterministicDeployment {
    address internal constant FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant FACTORY_CODE_HASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    bytes32 internal constant DEPLOYMENT_SALT =
        0x12f1d647ac2191038e16cc3e772d7674c8f6eb825ce09650b96d6dba48179059;
    bytes32 internal constant INIT_CODE_HASH =
        0xa9bdddbbb0824a6b64f118b0eeb6b2c6051394933c5593ace3ee9495f4cc805e;
    bytes32 internal constant RUNTIME_CODE_HASH =
        0x9289a8f9250caef94eb4c263b182f4540e50b62b713f83ab722237cfcbdb87c4;
    address internal constant PROTOCOL_ADDRESS = 0x779DEb5AD0B27BF40BDBFF3A81caB2d9049d7ad1;

    error UnexpectedInitCodeHash(bytes32 actual, bytes32 expected);
    error UnexpectedRuntimeCodeHash(bytes32 actual, bytes32 expected);
    error UnexpectedFactoryCode(address factory, bytes32 actual, bytes32 expected);
    error UnexpectedProtocolCode(address protocol, bytes32 actual, bytes32 expected);
    error DeploymentFailed();

    /// @notice Deploys v1 or returns the existing verified deployment.
    /// @dev The call is permissionless and idempotent. Any compiler-setting drift fails before the
    ///      external factory call, preserving the frozen address.
    function deploy() internal returns (address protocol) {
        _requireFrozenBuild();

        protocol = PROTOCOL_ADDRESS;
        if (protocol.code.length != 0) {
            _requireProtocolCode(protocol);
            return protocol;
        }

        bytes32 actualFactoryCodeHash = FACTORY.codehash;
        if (actualFactoryCodeHash != FACTORY_CODE_HASH) {
            revert UnexpectedFactoryCode(FACTORY, actualFactoryCodeHash, FACTORY_CODE_HASH);
        }

        (bool success,) = FACTORY.call(deploymentData());
        if (!success) revert DeploymentFailed();

        _requireProtocolCode(protocol);
    }

    /// @notice Returns the exact raw calldata expected by the EIP-7997 factory.
    function deploymentData() internal pure returns (bytes memory) {
        return abi.encodePacked(DEPLOYMENT_SALT, type(Lifeinvader).creationCode);
    }

    /// @notice Recomputes the EIP-1014 address from the frozen preimage components.
    function computedProtocolAddress() internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), FACTORY, DEPLOYMENT_SALT, INIT_CODE_HASH)
                    )
                )
            )
        );
    }

    function factoryAddress() internal pure returns (address) {
        return FACTORY;
    }

    function expectedFactoryCodeHash() internal pure returns (bytes32) {
        return FACTORY_CODE_HASH;
    }

    function deploymentSalt() internal pure returns (bytes32) {
        return DEPLOYMENT_SALT;
    }

    function expectedInitCodeHash() internal pure returns (bytes32) {
        return INIT_CODE_HASH;
    }

    function expectedRuntimeCodeHash() internal pure returns (bytes32) {
        return RUNTIME_CODE_HASH;
    }

    function expectedProtocolAddress() internal pure returns (address) {
        return PROTOCOL_ADDRESS;
    }

    function _requireFrozenBuild() private pure {
        bytes32 actualInitCodeHash = keccak256(type(Lifeinvader).creationCode);
        if (actualInitCodeHash != INIT_CODE_HASH) {
            revert UnexpectedInitCodeHash(actualInitCodeHash, INIT_CODE_HASH);
        }

        bytes32 actualRuntimeCodeHash = keccak256(type(Lifeinvader).runtimeCode);
        if (actualRuntimeCodeHash != RUNTIME_CODE_HASH) {
            revert UnexpectedRuntimeCodeHash(actualRuntimeCodeHash, RUNTIME_CODE_HASH);
        }
    }

    function _requireProtocolCode(address protocol) private view {
        bytes32 actualProtocolCodeHash = protocol.codehash;
        if (actualProtocolCodeHash != RUNTIME_CODE_HASH) {
            revert UnexpectedProtocolCode(protocol, actualProtocolCodeHash, RUNTIME_CODE_HASH);
        }
    }
}
