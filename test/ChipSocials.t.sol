// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipSocials, IChipFactoryOwner} from "../src/ChipSocials.sol";
import {ChipFactory8, IRH8GateArray} from "../src/ChipFactory8.sol";
import {RH8GateArray} from "../src/RH8Gates.sol";

/// La fabbrica e' vera: il registro deve fidarsi di lei per sapere chi
/// ha coniato e chi possiede, non di un mock compiacente.
contract ChipSocialsTest is Test {
    RH8GateArray gates;
    ChipFactory8 factory;
    ChipSocials socials;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        gates = new RH8GateArray();
        factory = new ChipFactory8(IRH8GateArray(address(gates)), address(this));
        vm.roll(block.number + 1);
        socials = new ChipSocials(IChipFactoryOwner(address(factory)));

        uint256[128] memory rom;
        rom[0] = 0x1500000;
        vm.prank(alice);
        factory.mint(rom, "Social", "SOC", "", 2000, 1_000_000);
    }

    function test_ilConiatoreScriveIlink() public {
        vm.prank(alice);
        socials.setLinks(1, "https://x.com/soc", "https://soc.chip", "https://t.me/soc");
        (string memory x, string memory w, string memory t) = socials.links(1);
        assertEq(x, "https://x.com/soc");
        assertEq(w, "https://soc.chip");
        assertEq(t, "https://t.me/soc");
    }

    function test_unPassanteNonPuo() public {
        vm.prank(bob);
        vm.expectRevert(ChipSocials.NotChipOwner.selector);
        socials.setLinks(1, "https://x.com/bob", "", "");
    }

    /// Dopo il trasferimento dell'NFT scrivono entrambi: chi ha coniato e chi possiede.
    function test_dopoIlTrasferimentoScrivonoEntrambi() public {
        vm.prank(alice);
        factory.transferFrom(alice, bob, 1);

        vm.prank(bob);
        socials.setLinks(1, "https://x.com/bob", "", "");
        (string memory x,,) = socials.links(1);
        assertEq(x, "https://x.com/bob");

        vm.prank(alice);
        socials.setLinks(1, "https://x.com/alice", "", "");
        (x,,) = socials.links(1);
        assertEq(x, "https://x.com/alice", "il coniatore resta autorizzato");
    }

    function test_vuotoCancella() public {
        vm.startPrank(alice);
        socials.setLinks(1, "https://x.com/soc", "https://soc.chip", "https://t.me/soc");
        socials.setLinks(1, "", "", "");
        vm.stopPrank();
        (string memory x, string memory w, string memory t) = socials.links(1);
        assertEq(bytes(x).length, 0);
        assertEq(bytes(w).length, 0);
        assertEq(bytes(t).length, 0);
    }

    function test_linkCattiviRifiutati() public {
        vm.startPrank(alice);
        vm.expectRevert(ChipSocials.BadLink.selector);
        socials.setLinks(1, "http://x.com/soc", "", "");            // niente https
        vm.expectRevert(ChipSocials.BadLink.selector);
        socials.setLinks(1, "javascript:alert(1)", "", "");         // niente schemi strani
        vm.expectRevert(ChipSocials.BadLink.selector);
        socials.setLinks(1, "https://x.com/a\"onclick", "", "");    // niente virgolette
        vm.expectRevert(ChipSocials.BadLink.selector);
        socials.setLinks(1, "https://x.com/<b>", "", "");           // niente angolari
        vm.expectRevert(ChipSocials.BadLink.selector);
        socials.setLinks(1, "https://x.com/a b", "", "");           // niente spazi
        vm.stopPrank();
    }

    function test_chipInesistente() public {
        vm.prank(alice);
        vm.expectRevert();
        socials.setLinks(99, "https://x.com/soc", "", "");
    }
}
