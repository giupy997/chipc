// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ChipFactory9, IRH8GateArray, ILegacyFactory, IChip8Renderer} from "../src/ChipFactory9.sol";
import {ChipSocials, IChipFactoryOwner} from "../src/ChipSocials.sol";
import {ChipBuybackVault4} from "../src/ChipBuybackVault4.sol";
import {ChipHoldersVault2} from "../src/ChipHoldersVault2.sol";
import {INPM} from "../src/ChipFeeVault.sol";
import {IChipFactoryLite} from "../src/ChipCreatorVault.sol";
import {ISwapRouter02, IPoolManager} from "../src/ChipBuybackVault.sol";

interface ITotal { function totalChips() external view returns (uint256); }

/**
 * La seconda fabbrica e tutto cio' che le gira intorno, in un colpo solo:
 *
 *   ChipFactory9      ticker a 12, id che continuano dalla v8, restart onesto,
 *                     riserva in pausa e non spenta, attach solo di token ammessi
 *   ChipSocials       i link dei chip nuovi (quelli vecchi restano sul vecchio)
 *   ChipBuybackVault4 x2   50/50 e 100% riserva, RH4 ricomprato -> ChipFactory8 (la madre)
 *   ChipHoldersVault2      80% agli holder, RH4 ricomprato -> ChipFactory8
 *
 * Silicio e renderer sono gia' in chain e si riusano. Chi lancia deve essere
 * l'OWNER (setRenderer gira qui dentro).
 *
 *   OWNER=0x... EXECUTOR=0x... forge script script/DeployFactory9.s.sol --rpc-url $RPC --broadcast
 */
contract DeployFactory9 is Script {
    address constant FACTORY8 = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant GATES = 0x31b9E8a34B9B6e67Af51044080ed6d684a415f8a;
    address constant RENDERER = 0xd6e71a902a927C2d36110d35769ed49bf8705b28;
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant ROUTER02 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address executor = vm.envAddress("EXECUTOR");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(vm.addr(pk) == owner, "deploy from the OWNER key");
        uint256 firstId = ITotal(FACTORY8).totalChips();

        vm.startBroadcast(pk);
        ChipFactory9 factory = new ChipFactory9(IRH8GateArray(GATES), owner, ILegacyFactory(FACTORY8), firstId);
        factory.setRenderer(IChip8Renderer(RENDERER));
        ChipSocials socials = new ChipSocials(IChipFactoryOwner(address(factory)));
        ChipBuybackVault4 creatorVault = new ChipBuybackVault4(INPM(NPM), IChipFactoryLite(address(factory)), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, executor, 5000, FACTORY8);
        ChipBuybackVault4 feeVault = new ChipBuybackVault4(INPM(NPM), IChipFactoryLite(address(factory)), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, executor, 0, FACTORY8);
        ChipHoldersVault2 holdersVault = new ChipHoldersVault2(INPM(NPM), IChipFactoryLite(address(factory)), RH4, WETH,
            ISwapRouter02(ROUTER02), IPoolManager(POOL_MANAGER), HOOK, executor, FACTORY8);
        vm.stopBroadcast();

        console.log("ChipFactory9", address(factory));
        console.log("firstId (ids continue after)", firstId);
        console.log("ChipSocials", address(socials));
        console.log("creatorVault 50/50", address(creatorVault));
        console.log("feeVault 100%", address(feeVault));
        console.log("holdersVault", address(holdersVault));
        console.log("owner", owner);
        console.log("executor", executor);
    }
}
