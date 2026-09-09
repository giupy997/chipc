// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RH4Memory} from "../src/RH4Memory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Deploy delle memory card. L'RH4 pagato va nella ChipFactory8, la riserva
 * della madre. I tagli e i prezzi si cambiano dopo con setKind (owner).
 *
 *   OWNER=0x... forge script script/DeployMemory.s.sol --rpc-url $RPC --broadcast
 *
 * Prezzi di partenza, in RH4 (a ~0.0006 $/RH4: 4K ~1 $, 64K ~12 $, 32M pinned ~3 $):
 *   0  4K     on-chain   2,000 RH4
 *   1  16K    on-chain   6,000 RH4
 *   2  64K    on-chain  20,000 RH4
 *   3  256K   on-chain  60,000 RH4
 *   4  32M    pinned     5,000 RH4
 *   5  256M   pinned    30,000 RH4
 */
contract DeployMemory is Script {
    address constant RH4 = 0xe76a12bcd2f0E6d3db9F9012321642198E6cBd1B;
    address constant FACTORY8 = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;

    function run() external {
        address owner = vm.envAddress("OWNER");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        require(vm.addr(pk) == owner, "deploy from the OWNER key");
        vm.startBroadcast(pk);
        RH4Memory mem = new RH4Memory(IERC20(RH4), FACTORY8, owner);
        mem.setKind(0, "4K", 4096, true, 2_000e18, true);
        mem.setKind(1, "16K", 16384, true, 6_000e18, true);
        mem.setKind(2, "64K", 65536, true, 20_000e18, true);
        mem.setKind(3, "256K", 262144, true, 60_000e18, true);
        mem.setKind(4, "32M", 0, false, 5_000e18, true);
        mem.setKind(5, "256M", 0, false, 30_000e18, true);
        vm.stopBroadcast();
        console.log("RH4Memory", address(mem));
        console.log("owner", owner);
        console.log("sink (mother's factory)", FACTORY8);
    }
}
