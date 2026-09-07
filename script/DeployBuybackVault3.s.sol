// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ChipBuybackVault3} from "../src/ChipBuybackVault3.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";

/**
 * Deploy dei due vault buyback v3 (50/50 e 100% riserva), quelli che non si
 * fidano piu' della mappa della fabbrica: un chip token e' solo un token
 * nato dalla fabbrica. I v2 restano con le loro posizioni.
 *
 *   EXECUTOR=0x...  il keeper
 *   forge script script/DeployBuybackVault3.s.sol --rpc-url $RPC --broadcast
 */
contract DeployBuybackVault3 is Script {
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function run() external {
        address executor = vm.envAddress("EXECUTOR");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        ChipBuybackVault3 creator = new ChipBuybackVault3(INPM(NPM), IChipFactoryLite(FACTORY), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, executor, 5000);
        ChipBuybackVault3 reserve = new ChipBuybackVault3(INPM(NPM), IChipFactoryLite(FACTORY), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, executor, 0);
        vm.stopBroadcast();
        console.log("ChipBuybackVault3 50/50 (creatorVault)", address(creator));
        console.log("ChipBuybackVault3 100%  (feeVault)", address(reserve));
        console.log("executor", executor);
    }
}
