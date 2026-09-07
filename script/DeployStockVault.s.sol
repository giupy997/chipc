// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RH4StockVault} from "../src/RH4StockVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";

/**
 * Deploy del RH4StockVault. Chi lancia lo script e' il deployer; owner,
 * executor e marketing arrivano dall'ambiente:
 *
 *   OWNER=0x...     chi regola split, azioni, marketing, executor (mai preleva)
 *   EXECUTOR=0x...  il keeper (allocate / convert / buyback / publish)
 *   MARKETING=0x... dove va la quota marketing (default: OWNER)
 *
 *   forge script script/DeployStockVault.s.sol --rpc-url $RPC --broadcast
 *
 * Split iniziale 60 / 20 / 20 (holder / marketing / buyback), azioni NVDA e
 * SNDK attive con i tier dei loro pool WETH piu' fondi.
 */
contract DeployStockVault is Script {
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SNDK = 0xB90A19fF0Af67f7779afF50A882A9CfF42446400;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address executor = vm.envAddress("EXECUTOR");
        address marketing = vm.envOr("MARKETING", owner);
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        require(deployer == owner, "deploy from the OWNER key so setStock can run in the same script");

        vm.startBroadcast(pk);
        RH4StockVault vault = new RH4StockVault(
            owner, executor, marketing, RH4, WETH, FACTORY,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK,
            6000, 2000, 2000
        );
        vault.setStock(NVDA, true, 500);
        vault.setStock(SNDK, true, 3000);
        vm.stopBroadcast();

        console.log("RH4StockVault", address(vault));
        console.log("owner", owner);
        console.log("executor", executor);
        console.log("marketing", marketing);
    }
}
