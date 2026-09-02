// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { DeterministicDeployment } from "../src/DeterministicDeployment.sol";
import { Lifeinvader } from "../src/Lifeinvader.sol";

interface DeploymentVm {
    function chainId(uint256 newChainId) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function expectRevert(bytes calldata revertData) external;
    function prank(address sender) external;
}

contract DeploymentHarness {
    function deploy() external returns (address) {
        return DeterministicDeployment.deploy();
    }
}

contract DeterministicDeploymentTest {
    DeploymentVm private constant vm =
        DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes private constant FACTORY_RUNTIME_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    DeploymentHarness private harness;

    function setUp() public {
        vm.etch(DeterministicDeployment.factoryAddress(), FACTORY_RUNTIME_CODE);
        harness = new DeploymentHarness();
    }

    function test_frozenArtifactsProduceThePublishedAddress() public pure {
        _assertEq(
            keccak256(type(Lifeinvader).creationCode),
            DeterministicDeployment.expectedInitCodeHash()
        );
        _assertEq(
            keccak256(type(Lifeinvader).runtimeCode),
            DeterministicDeployment.expectedRuntimeCodeHash()
        );
        _assertEq(
            DeterministicDeployment.computedProtocolAddress(),
            DeterministicDeployment.expectedProtocolAddress()
        );
        _assertEq(
            keccak256(FACTORY_RUNTIME_CODE), DeterministicDeployment.expectedFactoryCodeHash()
        );
    }

    function test_deploymentDataContainsSaltAndFrozenInitCode() public pure {
        bytes memory data = DeterministicDeployment.deploymentData();
        bytes32 encodedSalt;
        bytes32 encodedInitCodeHash;

        assembly ("memory-safe") {
            encodedSalt := mload(add(data, 0x20))
            encodedInitCodeHash := keccak256(add(data, 0x40), sub(mload(data), 0x20))
        }

        _assertEq(data.length, type(Lifeinvader).creationCode.length + 32);
        _assertEq(encodedSalt, DeterministicDeployment.deploymentSalt());
        _assertEq(encodedInitCodeHash, DeterministicDeployment.expectedInitCodeHash());
    }

    function test_anyAccountCanDeployAtThePublishedAddress() public {
        vm.prank(address(0xA11CE));
        address deployed = harness.deploy();

        _assertEq(deployed, DeterministicDeployment.expectedProtocolAddress());
        _assertEq(deployed.codehash, DeterministicDeployment.expectedRuntimeCodeHash());
        _assertEq(Lifeinvader(deployed).nextPostId(), 1);
    }

    function test_deploymentIsIdempotent() public {
        address first = harness.deploy();
        address second = harness.deploy();

        _assertEq(first, second);
        _assertEq(second.codehash, DeterministicDeployment.expectedRuntimeCodeHash());
    }

    function test_addressDoesNotDependOnChainId() public {
        vm.chainId(1);
        address mainnetAddress = DeterministicDeployment.computedProtocolAddress();

        vm.chainId(8453);
        address baseAddress = DeterministicDeployment.computedProtocolAddress();

        _assertEq(mainnetAddress, baseAddress);
        _assertEq(baseAddress, DeterministicDeployment.expectedProtocolAddress());
    }

    function test_rejectsAChainWithoutTheCanonicalFactory() public {
        address factory = DeterministicDeployment.factoryAddress();
        vm.etch(factory, bytes(""));
        bytes32 actualCodeHash = factory.codehash;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeterministicDeployment.UnexpectedFactoryCode.selector,
                factory,
                actualCodeHash,
                DeterministicDeployment.expectedFactoryCodeHash()
            )
        );
        harness.deploy();
    }

    function test_rejectsUnexpectedFactoryCode() public {
        address factory = DeterministicDeployment.factoryAddress();
        vm.etch(factory, hex"00");
        bytes32 actualCodeHash = factory.codehash;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeterministicDeployment.UnexpectedFactoryCode.selector,
                factory,
                actualCodeHash,
                DeterministicDeployment.expectedFactoryCodeHash()
            )
        );
        harness.deploy();
    }

    function test_rejectsUnexpectedCodeAtThePublishedAddress() public {
        address protocol = DeterministicDeployment.expectedProtocolAddress();
        vm.etch(protocol, hex"00");
        bytes32 actualCodeHash = protocol.codehash;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeterministicDeployment.UnexpectedProtocolCode.selector,
                protocol,
                actualCodeHash,
                DeterministicDeployment.expectedRuntimeCodeHash()
            )
        );
        harness.deploy();
    }

    function _assertEq(address actual, address expected) private pure {
        assert(actual == expected);
    }

    function _assertEq(bytes32 actual, bytes32 expected) private pure {
        assert(actual == expected);
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        assert(actual == expected);
    }
}
