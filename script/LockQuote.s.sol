// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFactoryLock {
    function mint(uint256[128] calldata words, bytes32 label, bytes32 ticker, string calldata logoURI, uint16 liquidityBps, uint64 targetCycles)
        external payable returns (uint256 id, address token);
    function attachToken(uint256 id, address token, uint96 rewardPerCycle) external;
    function tick(uint256 id, uint8 inPort) external returns (uint16, uint8, bool);
    function chipByToken(address) external view returns (uint256);
    function mintPrice() external view returns (uint256);
}
interface IWETHLock { function deposit() external payable; }

/**
 * Occupa lo slot di una quota nella fabbrica, prima che lo faccia un estraneo.
 *
 * La fabbrica lascia agganciare a un chip senza token un ERC20 qualsiasi
 * (attachToken): chi aggancia WETH si prende meta' delle fee di ogni posizione
 * con WETH come token0 nei vault buyback v2, e il resto lo tira fuori dalla
 * fabbrica con un tick. Qui il team aggancia la quota a un chip il cui
 * programma e' un solo HLT: ricompensa 1 wei, il primo tick lo ferma per
 * sempre, e chipByToken(quota) resta nostro. La quota che i vecchi vault
 * mandano in fabbrica resta li' sepolta: meglio sepolta che rubata.
 *
 *   QUOTE=0x...  TICKER=LOCKWETH  forge script script/LockQuote.s.sol --rpc-url $RPC --broadcast
 *
 * Per WETH il wei di riserva si crea con deposit(); per un'azione il deployer
 * deve averne almeno 1 wei nel wallet.
 */
contract LockQuote is Script {
    address constant FACTORY = 0x265A4D74DbF6C10f40ecf7d870df7677CB6fF65B;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint256 constant HLT = 28 << 20;   // opcode [24:20] = 28: il programma si ferma al primo ciclo

    function run() external {
        address quote = vm.envAddress("QUOTE");
        string memory tickerStr = vm.envString("TICKER");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        IFactoryLock f = IFactoryLock(FACTORY);
        require(f.chipByToken(quote) == 0, "quote already attached");
        require(bytes(tickerStr).length > 0 && bytes(tickerStr).length <= 8, "ticker 1-8");
        bytes32 ticker; bytes32 label;
        assembly { ticker := mload(add(tickerStr, 32)) }
        label = bytes32("quote lock");
        uint256[128] memory words;
        words[0] = HLT;

        vm.startBroadcast(pk);
        if (quote == WETH) IWETHLock(WETH).deposit{value: 1}();
        IERC20(quote).transfer(FACTORY, 1);
        (uint256 id, ) = f.mint{value: f.mintPrice()}(words, label, ticker, "", 0, 0);
        f.attachToken(id, quote, 1);
        f.tick(id, 0);   // esegue HLT: da ora tick() rifiuta AlreadyHalted, per sempre
        vm.stopBroadcast();

        console.log("chip", id);
        console.log("quote locked", quote);
        console.log("chipByToken", f.chipByToken(quote));
    }
}
