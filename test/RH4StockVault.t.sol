// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4StockVault} from "../src/RH4StockVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Azione finta, WETH finto e router finto: qui si testano la contabilita',
/// gli split, le epoche e le prove Merkle. Gli swap veri stanno nel fork test.
contract Tok is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
}

/// Router finto: paga `rate` azioni per ogni WETH, rispettando il minOut.
contract MockRouter {
    Tok public stock; uint256 public rate; MockWETH public weth;
    constructor(Tok s, MockWETH w, uint256 r) { stock = s; weth = w; rate = r; }
    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        weth.transferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn * rate / 1e18;
        require(out >= p.amountOutMinimum, "Too little received");
        stock.mint(p.recipient, out);
    }
}

contract RH4StockVaultTest is Test {
    RH4StockVault vault;
    Tok nvda; Tok sndk; Tok rh4; MockWETH weth; MockRouter routerN; MockRouter routerS;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    address marketing = makeAddr("marketing");
    address factory = makeAddr("factory");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        nvda = new Tok("NVDA"); sndk = new Tok("SNDK"); rh4 = new Tok("RH4"); weth = new MockWETH();
        routerN = new MockRouter(nvda, weth, 4e18); // 1 ETH -> 4 NVDA
        vault = new RH4StockVault(
            owner, keeper, marketing, address(rh4), address(weth), factory,
            ISwapRouter02(address(routerN)), IPoolManager(address(0)), address(0),
            6000, 2000, 2000
        );
        vm.startPrank(owner);
        vault.setStock(address(nvda), true, 500);
        vault.setStock(address(sndk), true, 3000);
        vm.stopPrank();
    }

    // ---- albero Merkle a tre foglie, coppie ordinate come OpenZeppelin ----

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    struct Tree { bytes32 root; bytes32 la; bytes32 lb; bytes32 lc; }

    /// foglie: alice 600, bob 300, carol 100 (totale 1000)
    function _tree(uint256 id) internal view returns (Tree memory t) {
        t.la = vault.leaf(id, alice, 600e18);
        t.lb = vault.leaf(id, bob, 300e18);
        t.lc = vault.leaf(id, carol, 100e18);
        t.root = _pair(_pair(t.la, t.lb), t.lc);
    }

    function _proofAlice(Tree memory t) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2); p[0] = t.lb; p[1] = t.lc;
    }
    function _proofCarol(Tree memory t) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1); p[0] = _pair(t.la, t.lb);
    }

    function _fundAndAllocate(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok, ) = address(vault).call{value: amount}("");
        require(ok);
        vm.prank(keeper);
        vault.allocate();
    }

    // ---- split -------------------------------------------------------------

    function test_allocate_splits_60_20_20() public {
        _fundAndAllocate(10 ether);
        assertEq(vault.ethForStocks(), 6 ether);
        assertEq(vault.ethForBuyback(), 2 ether);
        assertEq(marketing.balance, 2 ether);
        assertEq(vault.unallocated(), 0);
    }

    function test_allocate_nothing_reverts() public {
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.NothingToDo.selector);
        vault.allocate();
    }

    function test_setSplits_marketing_capped() public {
        vm.prank(owner);
        vm.expectRevert(RH4StockVault.BadSplits.selector);
        vault.setSplits(5000, 2500, 2500);
        vm.prank(owner);
        vm.expectRevert(RH4StockVault.BadSplits.selector);
        vault.setSplits(5000, 2000, 2000);   // non somma 10000
        vm.prank(owner);
        vault.setSplits(8000, 1000, 1000);
        assertEq(vault.holdersBps(), 8000);
        vm.prank(alice);
        vm.expectRevert(RH4StockVault.NotOwner.selector);
        vault.setSplits(8000, 1000, 1000);
    }

    // ---- convert ------------------------------------------------------------

    function test_convert_buys_stock_into_undistributed() public {
        _fundAndAllocate(10 ether);
        vm.prank(keeper);
        vault.convert(address(nvda), 1 ether, 4e18);
        assertEq(vault.undistributed(address(nvda)), 4e18);
        assertEq(vault.ethForStocks(), 5 ether);
        assertEq(nvda.balanceOf(address(vault)), 4e18);
    }

    function test_convert_respects_minOut_and_buckets() public {
        _fundAndAllocate(10 ether);
        vm.prank(keeper);
        vm.expectRevert(bytes("Too little received"));
        vault.convert(address(nvda), 1 ether, 5e18);
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.TooMuch.selector);
        vault.convert(address(nvda), 7 ether, 0);      // solo 6 nel secchio holder
        vm.prank(alice);
        vm.expectRevert(RH4StockVault.NotExecutor.selector);
        vault.convert(address(nvda), 1 ether, 0);
        vm.prank(owner);
        vault.setStock(address(nvda), false, 500);
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.BadStock.selector);
        vault.convert(address(nvda), 1 ether, 0);
    }

    // ---- epoche e claim --------------------------------------------------------

    function _publishEpoch() internal returns (uint256 id, Tree memory t) {
        _fundAndAllocate(10 ether);
        vm.prank(keeper);
        vault.convert(address(nvda), 5 ether, 0);   // 20 NVDA
        sndk.mint(address(vault), 0);               // niente SNDK: il router finto compra solo NVDA
        t = _tree(0);
        address[] memory toks = new address[](1); toks[0] = address(nvda);
        uint256[] memory amts = new uint256[](1); amts[0] = 20e18;
        vm.prank(keeper);
        id = vault.publish(t.root, 1000e18, toks, amts, 30 days);
    }

    function test_publish_moves_stock_into_epoch() public {
        (uint256 id, ) = _publishEpoch();
        assertEq(id, 0);
        assertEq(vault.undistributed(address(nvda)), 0);
        (, uint256 total, , , address[] memory toks, uint256[] memory amts, , bool expired) = vault.epoch(0);
        assertEq(total, 1000e18); assertEq(toks[0], address(nvda)); assertEq(amts[0], 20e18); assertFalse(expired);
    }

    function test_publish_cannot_exceed_undistributed_or_be_short() public {
        _fundAndAllocate(10 ether);
        vm.prank(keeper);
        vault.convert(address(nvda), 1 ether, 0);   // 4 NVDA
        Tree memory t = _tree(0);
        address[] memory toks = new address[](1); toks[0] = address(nvda);
        uint256[] memory amts = new uint256[](1); amts[0] = 5e18;
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.TooMuch.selector);
        vault.publish(t.root, 1000e18, toks, amts, 30 days);
        amts[0] = 4e18;
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.BadEpoch.selector);
        vault.publish(t.root, 1000e18, toks, amts, 1 days);   // sotto la durata minima
    }

    function test_claim_pro_rata_by_anyone_to_account() public {
        (uint256 id, Tree memory t) = _publishEpoch();
        // bob chiama per alice: le azioni vanno ad alice
        vm.prank(bob);
        vault.claim(id, alice, 600e18, _proofAlice(t));
        assertEq(nvda.balanceOf(alice), 12e18);   // 20 * 600/1000
        assertEq(nvda.balanceOf(bob), 0);
        vault.claim(id, carol, 100e18, _proofCarol(t));
        assertEq(nvda.balanceOf(carol), 2e18);
        uint256[] memory share = vault.shareOf(id, 300e18);
        assertEq(share[0], 6e18);
    }

    function test_claim_rejects_bad_proof_double_claim_and_wrong_balance() public {
        (uint256 id, Tree memory t) = _publishEpoch();
        vm.expectRevert(RH4StockVault.BadProof.selector);
        vault.claim(id, alice, 700e18, _proofAlice(t));       // saldo diverso dalla foglia
        vm.expectRevert(RH4StockVault.BadProof.selector);
        vault.claim(id, bob, 600e18, _proofAlice(t));         // account diverso
        vault.claim(id, alice, 600e18, _proofAlice(t));
        vm.expectRevert(RH4StockVault.AlreadyClaimed.selector);
        vault.claim(id, alice, 600e18, _proofAlice(t));
        vm.expectRevert(RH4StockVault.BadEpoch.selector);
        vault.claim(7, alice, 600e18, _proofAlice(t));
    }

    function test_expire_returns_unclaimed_and_blocks_claims() public {
        (uint256 id, Tree memory t) = _publishEpoch();
        vault.claim(id, alice, 600e18, _proofAlice(t));       // 12 su 20 ritirati
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.NotYetExpired.selector);
        vault.expire(id);
        vm.warp(block.timestamp + 31 days);
        vm.prank(keeper);
        vault.expire(id);
        assertEq(vault.undistributed(address(nvda)), 8e18);
        vm.expectRevert(RH4StockVault.BadEpoch.selector);
        vault.claim(id, carol, 100e18, _proofCarol(t));
        // e i restanti rientrano in un'epoca nuova
        Tree memory t2 = _tree(1);
        address[] memory toks = new address[](1); toks[0] = address(nvda);
        uint256[] memory amts = new uint256[](1); amts[0] = 8e18;
        vm.prank(keeper);
        uint256 id2 = vault.publish(t2.root, 1000e18, toks, amts, 30 days);
        bytes32[] memory p = new bytes32[](1); p[0] = _pair(t2.la, t2.lb);
        vault.claim(id2, carol, 100e18, p);
        assertEq(nvda.balanceOf(carol), 0.8e18);
    }

    // ---- nessuna via d'uscita per l'owner ------------------------------------------

    function test_owner_cannot_drain() public {
        _fundAndAllocate(10 ether);
        vm.prank(keeper);
        vault.convert(address(nvda), 1 ether, 0);
        // nessuna funzione di prelievo: l'unico ETH uscito e' la quota marketing
        assertEq(address(vault).balance, 7 ether);
        assertEq(marketing.balance, 2 ether);
        // il marketing lo puo' cambiare solo l'owner, e non a zero
        vm.prank(owner);
        vm.expectRevert(RH4StockVault.ZeroAddress.selector);
        vault.setMarketing(address(0));
        vm.prank(keeper);
        vm.expectRevert(RH4StockVault.NotOwner.selector);
        vault.setMarketing(keeper);
    }

    function test_ownership_two_step() public {
        vm.prank(owner);
        vault.transferOwnership(alice);
        assertEq(vault.owner(), owner);
        vm.prank(bob);
        vm.expectRevert(RH4StockVault.NotOwner.selector);
        vault.acceptOwnership();
        vm.prank(alice);
        vault.acceptOwnership();
        assertEq(vault.owner(), alice);
    }
}
