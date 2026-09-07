// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4StockVault} from "../src/RH4StockVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// L'albero lo costruisce tools/snapshot.js con la libreria OpenZeppelin:
/// qui si prova che le sue foglie e le sue prove sono quelle che il vault
/// ricostruisce e verifica on-chain.
contract RH4StockVaultMerkleTest is Test {
    function test_js_tree_matches_contract_leaf() public {
        string memory json = vm.readFile("test/fixtures/merkle.json");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        RH4StockVault vault = new RH4StockVault(
            address(1), address(2), address(3), address(4), address(5), address(6),
            ISwapRouter02(address(0)), IPoolManager(address(0)), address(0), 6000, 2000, 2000
        );
        for (uint256 i; i < 4; ++i) {
            string memory k = string.concat(".leaves[", vm.toString(i), "]");
            address account = vm.parseJsonAddress(json, string.concat(k, ".account"));
            uint256 balance = vm.parseJsonUint(json, string.concat(k, ".balance"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(k, ".proof"));
            assertTrue(MerkleProof.verify(proof, root, vault.leaf(3, account, balance)), "proof must verify");
            assertFalse(MerkleProof.verify(proof, root, vault.leaf(4, account, balance)), "other epoch must fail");
            assertFalse(MerkleProof.verify(proof, root, vault.leaf(3, account, balance + 1)), "other balance must fail");
        }
    }
}
