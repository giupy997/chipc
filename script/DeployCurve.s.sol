// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RH4Curve} from "../src/curve/RH4Curve.sol";
import {CurveFeeVault} from "../src/curve/CurveFeeVault.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";

/**
 * Deploy del launchpad a curva: RH4Curve + CurveFeeVault, legati fra loro,
 * con WETH aperta come quota (minimo 0.01 ETH di target). Le altre quote si
 * aprono dopo con setQuote, dall'owner.
 *
 *   OWNER=0x...     apre/chiude le quote (rh4-dev2); niente altro puo' fare
 *   EXECUTOR=0x...  il keeper: convert / buyback nel vault delle fee
 *
 *   forge script script/DeployCurve.s.sol --rpc-url $RPC --broadcast
 *
 * Chi lancia deve essere l'OWNER: setFeeVault e setQuote girano nello stesso script.
 */
contract DeployCurve is Script {
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant V3F = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address executor = vm.envAddress("EXECUTOR");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(vm.addr(pk) == owner, "deploy from the OWNER key");

        vm.startBroadcast(pk);
        RH4Curve curve = new RH4Curve(WETH, V3F, NPM, owner);
        CurveFeeVault vault = new CurveFeeVault(
            INPM(NPM), FACTORY, RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK,
            address(curve), executor
        );
        curve.setFeeVault(address(vault));
        curve.setQuote(WETH, true, 0.01 ether);
        curve.setQuote(USDG, true, 100e6);
        vm.stopBroadcast();

        console.log("RH4Curve", address(curve));
        console.log("CurveFeeVault", address(vault));
        console.log("owner", owner);
        console.log("executor", executor);
    }
}
