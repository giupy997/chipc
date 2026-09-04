// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipCreatorVault, IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {ChipFactory8, IRH8GateArray} from "../src/ChipFactory8.sol";
import {RH8GateArray} from "../src/RH8Gates.sol";
import {ChipToken} from "../src/ChipToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockNPM2 {
    address public t0;
    address public t1;
    uint256 public fee0;
    uint256 public fee1;

    function set(address token0_, address token1_, uint256 f0, uint256 f1) external {
        t0 = token0_; t1 = token1_; fee0 = f0; fee1 = f1;
    }

    function positions(uint256) external view returns (
        uint96, address, address, address, uint24, int24, int24, uint128,
        uint256, uint256, uint128, uint128
    ) {
        return (0, address(0), t0, t1, 10000, 0, 0, 0, 0, 0, 0, 0);
    }

    function collect(INPM.CollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        a0 = fee0; a1 = fee1;
        fee0 = 0; fee1 = 0;
        IERC20(t0).transfer(p.recipient, a0);
        IERC20(t1).transfer(p.recipient, a1);
    }
}

/// Qui la fabbrica e' VERA: il vault deve risalire dal token al chip e
/// pagare il coniatore inciso nella struct, non un mock compiacente.
contract ChipCreatorVaultTest is Test {
    RH8GateArray gates;
    ChipFactory8 factory;
    MockNPM2 npm;
    ChipCreatorVault vault;
    ChipToken quote;

    address alice = makeAddr("alice");

    function setUp() public {
        gates = new RH8GateArray();
        factory = new ChipFactory8(IRH8GateArray(address(gates)), address(this));
        vm.roll(block.number + 1);
        npm = new MockNPM2();
        vault = new ChipCreatorVault(INPM(address(npm)), IChipFactoryLite(address(factory)));
        quote = new ChipToken("Quote", "Q", 99, 1_000_000e18, address(this), 1_000_000e18, address(this));
    }

    function _mintChip() internal returns (address token) {
        uint256[128] memory rom;
        rom[0] = 0x1500000; // in r0: basta un programma qualsiasi
        vm.prank(alice);
        (, token) = factory.mint(rom, "Creator", "CRT", "", 2000, 1_000_000);
    }

    function test_metaAlConiatoreMetaAllaFabbrica() public {
        address token = _mintChip();
        uint256 factoryBefore = IERC20(token).balanceOf(address(factory));

        // fee maturate: 100 del token del chip, 4 di quote
        vm.prank(alice);
        IERC20(token).transfer(address(npm), 100e18);
        quote.transfer(address(npm), 4e18);
        npm.set(token, address(quote), 100e18, 4e18);

        vm.prank(address(0xBEEF)); // riscuote un passante
        vault.collect(1);

        assertEq(IERC20(token).balanceOf(alice) , 200_000_000e18 - 100e18 + 50e18, "meta' delle fee token al coniatore");
        assertEq(IERC20(token).balanceOf(address(factory)), factoryBefore + 50e18, "meta' alla riserva");
        assertEq(quote.balanceOf(alice), 2e18, "meta' della quote al coniatore");
        assertEq(quote.balanceOf(address(factory)), 2e18, "meta' della quote sepolta in fabbrica");
        assertEq(IERC20(token).balanceOf(address(vault)), 0, "il vault non trattiene nulla");
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    /// Il coniatore resta quello ORIGINALE anche se l'NFT del chip cambia mano.
    function test_pagaIlConiatoreOriginaleNonIlNuovoProprietario() public {
        address token = _mintChip();
        vm.prank(alice);
        factory.transferFrom(alice, address(0xCAFE), 1);

        vm.prank(alice);
        IERC20(token).transfer(address(npm), 10e18);
        quote.transfer(address(npm), 0);
        npm.set(token, address(quote), 10e18, 0);

        vault.collect(1);
        assertEq(IERC20(token).balanceOf(address(0xCAFE)), 0, "il nuovo proprietario non incassa");
        // alice: 200M - 10 mandati al mock + 5 di fee
        assertEq(IERC20(token).balanceOf(alice), 200_000_000e18 - 10e18 + 5e18, "il coniatore incassa sempre");
    }

    /// Posizione di token estranei alla fabbrica: tutto alla fabbrica,
    /// come il fratello semplice.
    function test_tokenSconosciutoTuttoAllaFabbrica() public {
        ChipToken alien = new ChipToken("Alien", "ALN", 1, 1_000_000e18, address(this), 1_000_000e18, address(this));
        alien.transfer(address(npm), 8e18);
        quote.transfer(address(npm), 2e18);
        npm.set(address(alien), address(quote), 8e18, 2e18);

        vault.collect(1);
        assertEq(alien.balanceOf(address(factory)), 8e18);
        assertEq(quote.balanceOf(address(factory)), 2e18);
    }
}
