// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipBuybackVault4} from "../src/ChipBuybackVault4.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Tok is ERC20 {
    constructor(string memory s) ERC20(s, s) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}
contract ChipTok is Tok {
    address public factory; uint256 public chipId;
    constructor(address f, uint256 id) Tok("CHIP") { factory = f; chipId = id; }
}
contract MockWETH is ERC20 {
    constructor() ERC20("WETH", "WETH") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 a) external { _burn(msg.sender, a); (bool ok, ) = msg.sender.call{value: a}(""); require(ok); }
}
contract MockNPM {
    address public t0; address public t1; uint256 public f0; uint256 public f1;
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
contract MockFactory {
    address public owner;
    mapping(address => uint256) public chipByToken;
    mapping(uint256 => address) public minterOf;
    constructor(address o) { owner = o; }
    function setChip(address token, uint256 id, address minter) external { chipByToken[token] = id; minterOf[id] = minter; }
    function chip(uint256 id) external view returns (IChipFactoryLite.Chip memory c) { c.minter = minterOf[id]; }
}

/// Il caso del 7 settembre, sul vault 50/50: NVDA agganciata a mano al chip 28.
/// Nel v2 il coniatore del 28 incassava meta' delle fee di ogni posizione con
/// NVDA come token0, e l'altra meta' di NVDA finiva in fabbrica. Nel v3 no.
contract ChipBuybackVault4Test is Test {
    ChipBuybackVault4 vault; MockNPM npm; MockWETH weth; ChipTok chipTok; Tok nvda; Tok rh4; MockFactory factory;
    address keeper = makeAddr("keeper");
    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        weth = new MockWETH(); nvda = new Tok("NVDA"); rh4 = new Tok("RH4"); npm = new MockNPM();
        factory = new MockFactory(address(this));
        chipTok = new ChipTok(address(factory), 7);
        factory.setChip(address(chipTok), 7, creator);
        factory.setChip(address(nvda), 28, attacker);        // l'aggancio a mano
        vault = new ChipBuybackVault4(INPM(address(npm)), IChipFactoryLite(address(factory)), address(rh4), address(weth),
            ISwapRouter02(address(0)), IPoolManager(address(0)), address(0), keeper, 5000, address(0xF8));
    }

    function test_attached_stock_does_not_hijack_creator_or_reserve() public {
        assertEq(vault.chipOf(address(nvda)), 0);
        assertEq(vault.chipOf(address(chipTok)), 7);
        // posizione con NVDA come token0 (il caso peggiore del v2)
        nvda.mint(address(npm), 10e18); chipTok.mint(address(npm), 100e18);
        npm.set(address(nvda), address(chipTok), 10e18, 100e18);
        vault.collect(1);
        // il creator vero incassa la meta', l'attaccante niente
        assertEq(vault.claimable(creator, address(nvda)), 5e18);
        assertEq(vault.claimable(creator, address(chipTok)), 50e18);
        assertEq(vault.claimable(attacker, address(nvda)), 0);
        assertEq(vault.claimable(attacker, address(chipTok)), 0);
        // l'altra meta': il chip token in riserva, NVDA in attesa di conversione (non in fabbrica)
        assertEq(chipTok.balanceOf(address(factory)), 50e18);
        assertEq(nvda.balanceOf(address(factory)), 0);
        assertEq(vault.pending(address(nvda)), 5e18);
    }

    function test_weth_squat_does_not_hijack_either() public {
        factory.setChip(address(weth), 29, attacker);      // WETH agganciata a un chip fresco
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}(); weth.transfer(address(npm), 1 ether); chipTok.mint(address(npm), 100e18);
        npm.set(address(weth), address(chipTok), 1 ether, 100e18);   // WETH e' token0
        vault.collect(1);
        assertEq(vault.claimable(creator, address(weth)), 0.5 ether);
        assertEq(vault.claimable(attacker, address(weth)), 0);
        assertEq(weth.balanceOf(address(factory)), 0);
        assertEq(address(vault).balance, 0.5 ether);      // pronto per il buyback, come deve
    }

    function test_rh4_sink_is_the_mother_factory_not_the_chip_factory() public {
        assertEq(vault.rh4Sink(), address(0xF8));
        assertTrue(vault.rh4Sink() != address(vault.factory()));
    }

    function test_foreign_position_all_to_buyback() public {
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}(); weth.transfer(address(npm), 1 ether); nvda.mint(address(npm), 2e18);
        npm.set(address(weth), address(nvda), 1 ether, 2e18);
        vault.collect(1);
        assertEq(address(vault).balance, 1 ether);
        assertEq(vault.pending(address(nvda)), 2e18);
        assertEq(nvda.balanceOf(address(factory)), 0);
    }
}
