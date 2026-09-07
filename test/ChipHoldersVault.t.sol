// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ChipHoldersVault} from "../src/ChipHoldersVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
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

/// Una posizione sola, con fee da riscuotere impostate dal test.
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
    constructor(address o) { owner = o; }
    function setChip(address token, uint256 id) external { chipByToken[token] = id; }
    function chip(uint256) external pure returns (IChipFactoryLite.Chip memory c) { c.minter = address(0xC0FFEE); }
}

contract ChipHoldersVaultTest is Test {
    ChipHoldersVault vault; MockNPM npm; MockWETH weth; Tok chipTok; Tok nvda; Tok rh4; MockFactory factory;
    address keeper = makeAddr("keeper");
    address alice = 0x1111111111111111111111111111111111111111;   // nella fixture merkle: 600
    address bob = 0x2222222222222222222222222222222222222222;     // 300

    function setUp() public {
        weth = new MockWETH(); chipTok = new Tok("CHIP"); nvda = new Tok("NVDA"); rh4 = new Tok("RH4"); npm = new MockNPM();
        factory = new MockFactory(address(this));
        factory.setChip(address(chipTok), 7);
        vault = new ChipHoldersVault(INPM(address(npm)), IChipFactoryLite(address(factory)), address(rh4), address(weth),
            ISwapRouter02(address(0)), IPoolManager(address(0)), address(0), keeper);
    }

    function _feesWeth(uint256 tokAmt, uint256 wethAmt) internal {
        chipTok.mint(address(npm), tokAmt);
        weth.deposit{value: wethAmt}(); weth.transfer(address(npm), wethAmt);
        bool chipIs0 = address(chipTok) < address(weth);
        npm.set(chipIs0 ? address(chipTok) : address(weth), chipIs0 ? address(weth) : address(chipTok),
                chipIs0 ? tokAmt : wethAmt, chipIs0 ? wethAmt : tokAmt);
    }

    // ---- collect: 80 agli holder, 20 riserva / buyback -----------------------------

    function test_collect_splits_80_20() public {
        vm.deal(address(this), 10 ether);
        _feesWeth(1000e18, 1 ether);
        vault.collect(1);
        assertEq(vault.undistributed(address(chipTok), address(chipTok)), 800e18);
        assertEq(vault.undistributed(address(chipTok), address(weth)), 0.8 ether);
        assertEq(chipTok.balanceOf(address(factory)), 200e18);     // riserva
        assertEq(address(vault).balance, 0.2 ether);               // gia' ETH per il buyback
        assertEq(weth.balanceOf(address(vault)), 0.8 ether);       // il WETH degli holder resta WETH
    }

    function test_collect_stock_quote_waits_for_convert() public {
        chipTok.mint(address(npm), 100e18); nvda.mint(address(npm), 10e18);
        bool chipIs0 = address(chipTok) < address(nvda);
        npm.set(chipIs0 ? address(chipTok) : address(nvda), chipIs0 ? address(nvda) : address(chipTok), chipIs0 ? 100e18 : 10e18, chipIs0 ? 10e18 : 100e18);
        vault.collect(1);
        assertEq(vault.undistributed(address(chipTok), address(nvda)), 8e18);
        assertEq(vault.pending(address(nvda)), 2e18);
    }

    function test_collect_rejects_foreign_position() public {
        npm.set(address(nvda), address(weth), 0, 0);
        vm.expectRevert(ChipHoldersVault.NotAChipPosition.selector);
        vault.collect(1);
    }

    // ---- epoche: publish, claim, expire ---------------------------------------------

    function _publishFixture() internal returns (bytes32 root, address[] memory assets, uint256[] memory amounts) {
        vm.deal(address(this), 10 ether);
        _feesWeth(1000e18, 1 ether);
        vault.collect(1);
        string memory json = vm.readFile("test/fixtures/merkle.json");
        root = vm.parseJsonBytes32(json, ".root");
        assets = new address[](2); assets[0] = address(weth); assets[1] = address(chipTok);
        amounts = new uint256[](2); amounts[0] = 0.8 ether; amounts[1] = 800e18;
        // la fixture e' l'epoca 3: apriamo tre epoche vuote-ma-valide prima? No: gli id sono globali,
        // quindi si pubblicano tre epoche minime per arrivare all'id 3.
        address[] memory a1 = new address[](1); a1[0] = address(chipTok);
        uint256[] memory m1 = new uint256[](1); m1[0] = 1;
        vm.startPrank(keeper);
        for (uint256 i; i < 3; ++i) vault.publish(address(chipTok), bytes32(uint256(1)), 1, a1, m1, 7 days);
        amounts[1] = 800e18 - 3;
        vault.publish(address(chipTok), root, 1000e18, assets, amounts, 7 days);
        vm.stopPrank();
    }

    function test_publish_claim_pays_pro_rata_and_anyone_can_push() public {
        (, address[] memory assets, uint256[] memory amounts) = _publishFixture();
        assertEq(vault.epochCount(), 4);
        assertEq(vault.undistributed(address(chipTok), address(weth)), 0);
        string memory json = vm.readFile("test/fixtures/merkle.json");
        bytes32[] memory pa = vm.parseJsonBytes32Array(json, ".leaves[0].proof");
        // il keeper spinge per alice (600 su 1000): 60%
        vm.prank(keeper);
        vault.claim(3, alice, 600e18, pa);
        assertEq(weth.balanceOf(alice), 0.48 ether);
        assertEq(chipTok.balanceOf(alice), amounts[1] * 600e18 / 1000e18);
        assertTrue(vault.hasClaimed(3, alice));
        vm.expectRevert(ChipHoldersVault.AlreadyClaimed.selector);
        vault.claim(3, alice, 600e18, pa);
        // bob ritira da solo, con la sua prova
        bytes32[] memory pb = vm.parseJsonBytes32Array(json, ".leaves[1].proof");
        vm.prank(bob);
        vault.claim(3, bob, 300e18, pb);
        assertEq(weth.balanceOf(bob), 0.24 ether);
        // prova sbagliata (saldo ritoccato): niente
        address carol = vm.parseJsonAddress(json, ".leaves[2].account");
        uint256 cbal = vm.parseJsonUint(json, ".leaves[2].balance");
        bytes32[] memory pc = vm.parseJsonBytes32Array(json, ".leaves[2].proof");
        vm.expectRevert(ChipHoldersVault.BadProof.selector);
        vault.claim(3, carol, cbal + 1, pc);
        (, , , , , address[] memory as_, , uint256[] memory claimed, ) = vault.epoch(3);
        assertEq(as_[0], assets[0]); assertEq(claimed[0], 0.72 ether);
    }

    function test_expire_returns_unclaimed_to_the_chip_pile() public {
        _publishFixture();
        string memory json = vm.readFile("test/fixtures/merkle.json");
        bytes32[] memory pa = vm.parseJsonBytes32Array(json, ".leaves[0].proof");
        vault.claim(3, alice, 600e18, pa);
        vm.prank(keeper);
        vm.expectRevert(ChipHoldersVault.NotYetExpired.selector);
        vault.expire(3);
        vm.warp(block.timestamp + 8 days);
        vm.prank(keeper);
        vault.expire(3);
        assertEq(vault.undistributed(address(chipTok), address(weth)), 0.32 ether);   // il 40% non ritirato
        vm.expectRevert(ChipHoldersVault.BadEpoch.selector);
        vault.claim(3, bob, 300e18, pa);
    }

    function test_publish_guards() public {
        vm.deal(address(this), 10 ether);
        _feesWeth(1000e18, 1 ether);
        vault.collect(1);
        address[] memory a = new address[](1); a[0] = address(weth);
        uint256[] memory m = new uint256[](1); m[0] = 0.8 ether + 1;
        vm.startPrank(keeper);
        vm.expectRevert(ChipHoldersVault.TooMuch.selector);
        vault.publish(address(chipTok), bytes32(uint256(1)), 1, a, m, 7 days);
        m[0] = 0.8 ether;
        vm.expectRevert(ChipHoldersVault.BadEpoch.selector);
        vault.publish(address(chipTok), bytes32(uint256(1)), 1, a, m, 6 days);
        // il mucchio e' per chip: da un altro chip token non si attinge
        vm.expectRevert(ChipHoldersVault.TooMuch.selector);
        vault.publish(address(nvda), bytes32(uint256(1)), 1, a, m, 7 days);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(ChipHoldersVault.NotExecutor.selector);
        vault.publish(address(chipTok), bytes32(uint256(1)), 1, a, m, 7 days);
    }

    function test_executor_named_by_factory_owner() public {
        vm.prank(alice);
        vm.expectRevert(ChipHoldersVault.NotFactoryOwner.selector);
        vault.setExecutor(alice);
        vault.setExecutor(alice);   // this = owner della fabbrica finta
        assertEq(vault.executor(), alice);
    }
}
