// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4Memory} from "../src/RH4Memory.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Tok is ERC20 {
    constructor() ERC20("RH4", "RH4") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract RH4MemoryTest is Test {
    RH4Memory mem; Tok rh4;
    address sink = makeAddr("factory");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        rh4 = new Tok();
        mem = new RH4Memory(IERC20(address(rh4)), sink, address(this));
        mem.setKind(0, "4K", 4096, true, 2000e18, true);
        mem.setKind(1, "64K", 65536, true, 20000e18, true);
        mem.setKind(2, "32M", 0, false, 5000e18, true);
        rh4.mint(alice, 1_000_000e18);
        vm.prank(alice); rh4.approve(address(mem), type(uint256).max);
    }

    function _card(uint256 kind) internal returns (uint256 id) {
        vm.prank(alice);
        id = mem.mint(kind, "notes");
    }

    function test_mint_pays_rh4_to_the_factory() public {
        uint256 id = _card(0);
        assertEq(id, 1);
        assertEq(mem.ownerOf(1), alice);
        assertEq(rh4.balanceOf(sink), 2000e18);
        RH4Memory.Card memory c = mem.card(1);
        assertEq(c.kind, 0); assertEq(c.used, 0); assertFalse(c.locked); assertEq(c.label, bytes32("notes"));
        vm.expectRevert(RH4Memory.NoSuchKind.selector);
        vm.prank(alice); mem.mint(9, "x");
        mem.setKind(0, "4K", 4096, true, 2000e18, false);
        vm.expectRevert(RH4Memory.KindDisabled.selector);
        vm.prank(alice); mem.mint(0, "x");
    }

    function test_write_and_read_across_slot_boundaries() public {
        uint256 id = _card(0);
        bytes memory msg1 = bytes("hello, chain");   // 12 byte
        vm.prank(alice); mem.write(id, 30, msg1);     // a cavallo fra lo slot 0 e l'1
        assertEq(mem.read(id, 30, 12), msg1);
        assertEq(mem.card(id).used, 42);
        assertEq(mem.readAll(id).length, 42);
        assertEq(mem.read(id, 0, 30), new bytes(30));   // prima: zeri
        // sovrascrittura parziale nel mezzo
        vm.prank(alice); mem.write(id, 37, bytes("CHAIN"));
        assertEq(mem.read(id, 30, 12), bytes("hello, CHAIN"));
        // i byte fuori dalla scrittura non si toccano
        assertEq(mem.read(id, 42, 10), new bytes(10));
        assertEq(mem.card(id).writes, 2);
    }

    function test_bounds_and_permissions() public {
        uint256 id = _card(0);
        vm.prank(alice);
        vm.expectRevert(RH4Memory.OutOfBounds.selector);
        mem.write(id, 4090, bytes("toolong"));
        vm.prank(alice);
        mem.write(id, 4089, bytes("toolong"));   // esattamente fino a 4096
        vm.prank(bob);
        vm.expectRevert(RH4Memory.NotCardOwner.selector);
        mem.write(id, 0, bytes("x"));
        vm.expectRevert(RH4Memory.OutOfBounds.selector);
        mem.read(id, 4000, 100);
        vm.expectRevert(RH4Memory.NoSuchCard.selector);
        mem.read(99, 0, 1);
    }

    function test_seal_is_forever() public {
        uint256 id = _card(0);
        vm.prank(alice); mem.write(id, 0, bytes("final"));
        vm.prank(alice); mem.seal(id);
        assertTrue(mem.card(id).locked);
        vm.prank(alice); vm.expectRevert(RH4Memory.CardSealed.selector); mem.write(id, 0, bytes("x"));
        vm.prank(alice); vm.expectRevert(RH4Memory.CardSealed.selector); mem.clear(id);
        vm.prank(alice); vm.expectRevert(RH4Memory.CardSealed.selector); mem.setLabel(id, "y");
        // la card viaggia con i dati, e resta sigillata
        vm.prank(alice); mem.transferFrom(alice, bob, id);
        assertEq(mem.read(id, 0, 5), bytes("final"));
        vm.prank(bob); vm.expectRevert(RH4Memory.CardSealed.selector); mem.write(id, 0, bytes("x"));
    }

    function test_clear_wipes_used_bytes() public {
        uint256 id = _card(0);
        vm.prank(alice); mem.write(id, 100, bytes("secret"));
        vm.prank(alice); mem.clear(id);
        assertEq(mem.card(id).used, 0);
        assertEq(mem.read(id, 100, 6), new bytes(6));
    }

    function test_pinned_card_holds_hash_and_uri_and_a_name() public {
        uint256 id = _card(2);
        vm.prank(alice);
        vm.expectRevert(RH4Memory.NotOnChain.selector);
        mem.write(id, 0, bytes("x"));
        vm.prank(alice);
        mem.setContent(id, keccak256("site"), "ipfs://bafy123");
        (bytes32 h, string memory u) = mem.contentOf(id);
        assertEq(h, keccak256("site")); assertEq(u, "ipfs://bafy123");
        vm.prank(alice); mem.setName(id, "my-site");
        assertEq(mem.cardOfName("my-site"), id);
        assertEq(mem.nameOf(id), "my-site");
        // il nome e' unico
        uint256 other = _card(2);
        vm.prank(alice); vm.expectRevert(abi.encodeWithSelector(RH4Memory.NameTaken.selector, id)); mem.setName(other, "my-site");
        // rinominare libera il vecchio
        vm.prank(alice); mem.setName(id, "new-name");
        assertEq(mem.cardOfName("my-site"), 0);
        vm.prank(alice); mem.setName(other, "my-site");
        // nomi cattivi
        vm.prank(alice); vm.expectRevert(RH4Memory.BadName.selector); mem.setName(id, "ab");
        vm.prank(alice); vm.expectRevert(RH4Memory.BadName.selector); mem.setName(id, "-bad");
        vm.prank(alice); vm.expectRevert(RH4Memory.BadName.selector); mem.setName(id, "Bad.Name");
        // una on-chain non prende contenuti esterni
        uint256 oc = _card(0);
        vm.prank(alice); vm.expectRevert(RH4Memory.NotPinned.selector); mem.setContent(oc, bytes32(0), "ipfs://x");
    }

    function test_tokenURI_is_data_json() public {
        uint256 id = _card(1);
        vm.prank(alice); mem.write(id, 0, bytes("abc"));
        string memory u = mem.tokenURI(id);
        assertEq(bytes(u).length > 100, true);
        assertEq(keccak256(bytes(substr(u, 0, 29))), keccak256("data:application/json;base64,"));
    }

    function test_gas_of_writes() public {
        uint256 id = _card(1);
        bytes memory kb = new bytes(1024);
        for (uint256 i; i < 1024; ++i) kb[i] = bytes1(uint8(i));
        vm.prank(alice);
        uint256 g0 = gasleft(); mem.write(id, 0, kb); uint256 g1 = g0 - gasleft();
        emit log_named_uint("gas per 1 KB (fresh slots)", g1);
        vm.prank(alice);
        g0 = gasleft(); mem.write(id, 0, kb); uint256 g2 = g0 - gasleft();
        emit log_named_uint("gas per 1 KB (overwrite)", g2);
        assertLt(g1, 3_000_000);
        assertEq(mem.read(id, 0, 1024), kb);
    }

    function substr(string memory s, uint256 from, uint256 len) internal pure returns (string memory) {
        bytes memory b = bytes(s); bytes memory o = new bytes(len);
        for (uint256 i; i < len; ++i) o[i] = b[from + i];
        return string(o);
    }
}
