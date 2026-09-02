// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipFeeVault, INPM} from "../src/ChipFeeVault.sol";
import {ChipToken} from "../src/ChipToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Un NPM finto quanto basta: registra una posizione e consegna le fee
/// che gli diciamo di avere in pancia.
contract MockNPM {
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

contract ChipFeeVaultTest is Test {
    MockNPM npm;
    ChipFeeVault vault;
    ChipToken chip;   // il token del chip: in fabbrica diventa riserva
    ChipToken quote;  // la controparte: in fabbrica resta sepolta

    address constant FACTORY = address(0xFAB);

    function setUp() public {
        npm = new MockNPM();
        vault = new ChipFeeVault(INPM(address(npm)), FACTORY);
        chip = new ChipToken("Chip", "CHIP", 7, 1_000_000e18, address(this), 1_000_000e18, address(this));
        quote = new ChipToken("Quote", "Q", 8, 1_000_000e18, address(this), 1_000_000e18, address(this));
        // le "fee maturate" vivono nel finto NPM
        chip.transfer(address(npm), 500e18);
        quote.transfer(address(npm), 3e18);
        npm.set(address(chip), address(quote), 500e18, 3e18);
    }

    /// Chiunque riscuote, tutto finisce alla fabbrica: il token del chip
    /// allunga la riserva, la controparte resta sepolta li' dentro.
    function test_leFeeTornanoTutteAllaFabbrica() public {
        vm.prank(address(0xBEEF)); // un passante qualsiasi
        (uint256 a0, uint256 a1) = vault.collect(1);

        assertEq(a0, 500e18);
        assertEq(a1, 3e18);
        assertEq(chip.balanceOf(FACTORY), 500e18, "la riserva non si e' allungata");
        assertEq(quote.balanceOf(FACTORY), 3e18, "la controparte non e' sepolta");
        assertEq(chip.balanceOf(address(vault)), 0, "il vault non deve trattenere nulla");
        assertEq(quote.balanceOf(address(vault)), 0);
    }

    /// Il vault accetta posizioni ERC-721. E non ha NESSUNA funzione per
    /// farle uscire o togliere liquidita': la garanzia e' l'assenza.
    function test_accettaLePosizioniENonLeRestituisceMai() public {
        assertEq(
            vault.onERC721Received(address(0), address(0), 1, ""),
            ChipFeeVault.onERC721Received.selector
        );
        // niente transferFrom, niente decreaseLiquidity, niente owner:
        // il contratto ha esattamente due funzioni esterne, e si vede.
    }

    function test_collectSenzaFeeNonEsplode() public {
        npm.set(address(chip), address(quote), 0, 0);
        vault.collect(1);
        assertEq(chip.balanceOf(FACTORY), 0);
    }
}
