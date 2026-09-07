// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RH4Curve} from "../../src/curve/RH4Curve.sol";
import {CurveToken} from "../../src/curve/CurveToken.sol";
import {CurveFeeVault} from "../../src/curve/CurveFeeVault.sol";
import {INPM} from "../../src/ChipFeeVault.sol";
import {ISwapRouter02, IPoolManager} from "../../src/ChipBuybackVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Tok is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); (bool ok, ) = msg.sender.call{value: a}(""); require(ok); }
}

/// Position manager finto: il pool e' un indirizzo qualunque, il mint prende
/// tutto quello che gli si offre (come un range pieno) e consegna l'NFT.
contract MockNPM {
    uint256 public nextId = 1;
    uint160 public lastSqrt;
    address public lastRecipient;
    address public t0; address public t1; uint256 public f0; uint256 public f1;
    function createAndInitializePoolIfNecessary(address a, address b, uint24, uint160 sqrtP) external payable returns (address) {
        lastSqrt = sqrtP;
        return address(uint160(uint256(keccak256(abi.encode(a, b)))));
    }
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    function mint(MintParams calldata p) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        IERC20(p.token0).transferFrom(msg.sender, address(this), p.amount0Desired);
        IERC20(p.token1).transferFrom(msg.sender, address(this), p.amount1Desired);
        lastRecipient = p.recipient;
        return (nextId++, 1, p.amount0Desired, p.amount1Desired);
    }
    // per i test del vault: una posizione con fee da riscuotere
    function set(address a, address b, uint256 x, uint256 y) external { t0 = a; t1 = b; f0 = x; f1 = y; }
    function positions(uint256) external view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128) {
        return (0, address(0), t0, t1, 10000, 0, 0, 0, 0, 0, 0, 0);
    }
    function collect(INPM.CollectParams calldata p) external returns (uint256 a0, uint256 a1) {
        a0 = f0; a1 = f1; f0 = 0; f1 = 0;
        if (a0 > 0) IERC20(t0).transfer(p.recipient, a0);
        if (a1 > 0) IERC20(t1).transfer(p.recipient, a1);
    }
}

contract MockFactory { address public owner; constructor(address o) { owner = o; } }
/// La fabbrica v3 finta: nessun pool esiste prima della graduazione.
contract MockV3F { function getPool(address, address, uint24) external pure returns (address) { return address(0); } }

contract RH4CurveTest is Test {
    RH4Curve curve; CurveFeeVault vault; MockNPM npm; MockWETH weth; Tok nvda; Tok rh4; MockFactory factory;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    uint256 constant THRESHOLD = 4.2 ether;

    function setUp() public {
        weth = new MockWETH(); nvda = new Tok("NVDA"); rh4 = new Tok("RH4"); npm = new MockNPM();
        factory = new MockFactory(address(this));
        curve = new RH4Curve(address(weth), address(new MockV3F()), address(npm), address(this));
        vault = new CurveFeeVault(INPM(address(npm)), address(factory), address(rh4), address(weth), ISwapRouter02(address(0)), IPoolManager(address(0)), address(0), address(curve), keeper);
        curve.setFeeVault(address(vault));
        curve.setQuote(address(weth), true, 0.1 ether);
        curve.setQuote(address(nvda), true, 1e18);
        vm.deal(alice, 100 ether); vm.deal(bob, 100 ether);
    }

    function _launch() internal returns (address token) {
        vm.prank(creator);
        token = curve.launch("Meme", "MEME", address(weth), THRESHOLD, 5000);
    }

    // ---- lancio ----------------------------------------------------------------

    function test_launch_mints_supply_to_curve_and_registers() public {
        address token = _launch();
        assertEq(IERC20(token).balanceOf(address(curve)), curve.SUPPLY());
        (address c, uint16 bps) = vault.registry(token);
        assertEq(c, creator); assertEq(bps, 5000);
        assertEq(curve.count(), 1);
        // prezzo iniziale = Vq0 / Vt0
        assertEq(curve.price(token), (THRESHOLD * 30 / 85) * 1e18 / curve.VIRTUAL_TOKENS());
    }

    function test_launch_guards() public {
        vm.expectRevert(RH4Curve.QuoteNotAllowed.selector);
        curve.launch("a", "A", address(rh4), 1 ether, 5000);
        vm.expectRevert(RH4Curve.ThresholdTooLow.selector);
        curve.launch("a", "A", address(weth), 0.01 ether, 5000);
        vm.expectRevert(RH4Curve.BadCreatorBps.selector);
        curve.launch("a", "A", address(weth), 1 ether, 2500);
        vm.expectRevert(RH4Curve.BadName.selector);
        curve.launch("", "A", address(weth), 1 ether, 5000);
        vm.expectRevert(RH4Curve.ThresholdTooLow.selector);
        curve.setQuote(address(rh4), true, 0);
        vm.expectRevert(RH4Curve.NotOwner.selector);
        vm.prank(alice);
        curve.setQuote(address(rh4), true, 0);
    }

    // ---- comprare, vendere, fee -------------------------------------------------

    function test_buy_with_eth_matches_quote_and_routes_fee() public {
        address token = _launch();
        vm.roll(block.number + 101);
        (uint256 expected, uint256 fee) = curve.quoteBuy(token, 1 ether);
        vm.prank(alice);
        uint256 got = curve.buy{value: 1 ether}(token, 0, expected);
        assertEq(got, expected);
        assertEq(IERC20(token).balanceOf(alice), expected);
        assertEq(fee, 0.01 ether);
        // meta' della fee al creator (in WETH), l'altra meta' gia' ETH nel vault per il buyback
        assertEq(vault.claimable(creator, address(weth)), fee / 2);
        assertEq(address(vault).balance, fee - fee / 2);
        (, , , , , , , , uint256 raised, uint256 sold, , ) = curve.launches(token);
        assertEq(raised, 1 ether - fee); assertEq(sold, expected);
    }

    function test_buy_with_erc20_quote() public {
        vm.prank(creator);
        address token = curve.launch("N", "N", address(nvda), 10e18, 0);
        vm.roll(block.number + 101);
        nvda.mint(alice, 5e18);
        vm.startPrank(alice);
        nvda.approve(address(curve), 5e18);
        uint256 got = curve.buy(token, 2e18, 0);
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(nvda.balanceOf(alice), 3e18);
        // creatorBps 0: tutta la fee resta in attesa di conversione
        assertEq(vault.pending(address(nvda)), 0.02e18);
        assertEq(vault.claimable(creator, address(nvda)), 0);
    }

    function test_sell_round_trip_returns_net_of_fees() public {
        address token = _launch();
        vm.roll(block.number + 101);
        vm.startPrank(alice);
        uint256 got = curve.buy{value: 1 ether}(token, 0, 0);
        IERC20(token).approve(address(curve), got);
        (uint256 expectOut, ) = curve.quoteSell(token, got);
        uint256 before = alice.balance;
        uint256 out = curve.sell(token, got, expectOut);
        vm.stopPrank();
        assertEq(out, expectOut);
        assertEq(alice.balance - before, out);
        // netto delle due fee dell'1%: circa 0.98 ETH
        assertApproxEqRel(out, 0.98 ether, 0.001e18);
        (, , , , , , , , uint256 raised, uint256 sold, , ) = curve.launches(token);
        assertEq(sold, 0);
        assertLe(raised, 1);   // solo polvere di arrotondamento
    }

    function test_early_buy_cap_then_free() public {
        address token = _launch();
        // una compra che prenderebbe piu' del 2% nei primi 100 blocchi non passa
        (uint256 big, ) = curve.quoteBuy(token, 0.2 ether);
        assertGt(big, curve.MAX_EARLY_BUY());
        vm.prank(alice);
        vm.expectRevert(RH4Curve.EarlyBuyTooBig.selector);
        curve.buy{value: 0.2 ether}(token, 0, 0);
        vm.prank(alice);
        curve.buy{value: 0.02 ether}(token, 0, 0);   // piccola: ok
        // ...ma spezzare non aiuta: il tetto e' per blocco, sommando le compre
        (uint256 more, ) = curve.quoteBuy(token, 0.15 ether);
        assertGt(more + curve.soldInBlock(token, block.number), curve.MAX_EARLY_BUY());
        vm.prank(bob);
        vm.expectRevert(RH4Curve.EarlyBuyTooBig.selector);
        curve.buy{value: 0.15 ether}(token, 0, 0);
        vm.roll(block.number + 100);
        vm.prank(alice);
        curve.buy{value: 0.2 ether}(token, 0, 0);    // dopo: libera
    }

    function test_slippage_guard() public {
        address token = _launch();
        vm.roll(block.number + 101);
        (uint256 expected, ) = curve.quoteBuy(token, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RH4Curve.TooLittleOut.selector, expected, expected + 1));
        curve.buy{value: 1 ether}(token, 0, expected + 1);
    }

    // ---- il lucchetto sui pool prima della graduazione --------------------------

    function test_transfers_to_pools_locked_until_graduation() public {
        address token = _launch();
        vm.roll(block.number + 101);
        vm.prank(alice);
        curve.buy{value: 1 ether}(token, 0, 0);
        address[4] memory pools = curve.poolsOf(token);
        vm.prank(alice);
        vm.expectRevert(CurveToken.LockedUntilGraduation.selector);
        IERC20(token).transfer(pools[3], 1e18);
        vm.prank(alice);
        vm.expectRevert(CurveToken.LockedUntilGraduation.selector);
        IERC20(token).transfer(address(npm), 1e18);
        vm.prank(alice);
        IERC20(token).transfer(bob, 1e18);   // fra persone: libero
        assertEq(IERC20(token).balanceOf(bob), 1e18);
    }

    // ---- graduazione ------------------------------------------------------------

    function test_graduation_refunds_excess_and_seeds_pool() public {
        address token = _launch();
        vm.roll(block.number + 101);
        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 got = curve.buy{value: 20 ether}(token, 0, 0);   // molto piu' del necessario
        assertEq(got, curve.CURVE_SUPPLY());
        assertTrue(curve.graduated(token));
        uint256 spent = before - alice.balance;
        // la raccolta a fine curva vale ~1.03 x la soglia (piu' l'1% di fee)
        assertApproxEqRel(spent, THRESHOLD * 1034 / 1000 * 10100 / 10000, 0.01e18);
        // il pool ha i 200M e (quasi) tutta la raccolta; la LP e' nel vault
        (, , , , , , , , uint256 raised, , uint256 lpId, address pool) = curve.launches(token);
        assertEq(IERC20(token).balanceOf(address(npm)), curve.LP_SUPPLY());
        assertEq(weth.balanceOf(address(npm)), raised);
        assertEq(npm.lastRecipient(), address(vault));
        assertEq(lpId, 1);
        assertTrue(pool != address(0));
        // prezzo del pool = raccolta / 200M, letto dallo sqrtPrice passato al NPM
        _checkPoolPrice(npm.lastSqrt(), token < address(weth), raised, curve.LP_SUPPLY());
        // dopo: la curva e' chiusa, i pool sono aperti
        vm.prank(bob);
        vm.expectRevert(RH4Curve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(token, 0, 0);
        address[4] memory pools = curve.poolsOf(token);
        vm.prank(alice);
        IERC20(token).transfer(pools[3], 1e18);   // ora si puo'
    }

    function test_graduation_by_exact_last_buy() public {
        address token = _launch();
        vm.roll(block.number + 101);
        vm.prank(alice);
        curve.buy{value: 1 ether}(token, 0, 0);
        (, , , , , , , , , uint256 sold, , ) = curve.launches(token);
        (uint256 cost, ) = curve.costFor(token, curve.CURVE_SUPPLY() - sold);
        vm.prank(bob);
        uint256 got = curve.buy{value: cost}(token, 0, 0);
        assertEq(got, curve.CURVE_SUPPLY() - sold);
        assertTrue(curve.graduated(token));
    }


    /// prezzo del pool letto dallo sqrtPrice: deve valere raccolta / 200M, in entrambi gli ordini dei token
    function _checkPoolPrice(uint160 sqrtP, bool tokenIs0, uint256 raised, uint256 lp) internal pure {
        uint256 priceX96 = (uint256(sqrtP) * uint256(sqrtP)) >> 96;         // token1 per token0, X96
        if (tokenIs0) assertApproxEqRel((priceX96 * lp) >> 96, raised, 0.001e18);   // weth/token * 200M = raccolta
        else assertApproxEqRel((priceX96 * raised) >> 96, lp, 0.001e18);            // token/weth * raccolta = 200M
    }

    // ---- il vault: fee post-graduazione, creator e fuoco --------------------------

    function test_vault_collect_splits_creator_burns_token_half() public {
        address token = _launch();
        vm.roll(block.number + 101);
        vm.prank(alice);
        curve.buy{value: 20 ether}(token, 0, 0);
        // fee di 1000 token + 1 WETH sulla posizione
        vm.prank(alice);
        IERC20(token).transfer(address(npm), 1000e18);   // graduato: passa
        weth.deposit{value: 1 ether}(); weth.transfer(address(npm), 1 ether);
        npm.set(token < address(weth) ? token : address(weth), token < address(weth) ? address(weth) : token,
                token < address(weth) ? 1000e18 : 1 ether, token < address(weth) ? 1 ether : 1000e18);
        uint256 deadBefore = IERC20(token).balanceOf(vault.DEAD());
        uint256 ethBefore = address(vault).balance;
        uint256 wethBefore = vault.claimable(creator, address(weth));   // gia' maturato dalla fase a curva
        vault.collect(1);
        assertEq(vault.claimable(creator, token), 500e18);
        assertEq(vault.claimable(creator, address(weth)) - wethBefore, 0.5 ether);
        assertEq(IERC20(token).balanceOf(vault.DEAD()) - deadBefore, 500e18);
        assertEq(address(vault).balance - ethBefore, 0.5 ether);
        vm.prank(creator);
        vault.claim(token);
        assertEq(IERC20(token).balanceOf(creator), 500e18);
    }

    function test_vault_only_curve_can_register_or_deposit() public {
        vm.expectRevert(CurveFeeVault.NotCurve.selector);
        vault.register(address(1), alice, 5000);
        vm.expectRevert(CurveFeeVault.NotCurve.selector);
        vault.deposit(address(1), address(weth), 1);
    }
}
