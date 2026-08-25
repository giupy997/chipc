// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ChipFactory} from "./ChipFactory.sol";
import {RH4State} from "./RH4State.sol";

/**
 * @title ChipRenderer — l'immagine del chip, disegnata on-chain
 *
 * Niente IPFS, niente server: il PNG non esiste, c'e' un SVG costruito ogni
 * volta a partire dai 79 bit veri del processore. Le quattro luci sono la
 * porta di uscita in quel preciso istante, e il conteggio dei cicli e' quello
 * che gli sponsor hanno davvero pagato.
 *
 * Ne segue una cosa che vale la pena dire: **l'immagine cambia da sola**.
 * Un chip fermo e un chip che qualcuno tiene acceso non si somigliano.
 */
contract ChipRenderer {
    using Strings for uint256;

    /**
     * @notice Dove vive il chip sul web. Finisce in `external_url`, il campo
     *         con cui marketplace ed explorer rimandano al progetto.
     * @dev Fissato alla nascita e senza setter: per cambiarlo si deploya un
     *      renderer nuovo e si chiama setRenderer sulla fabbrica. Costa meno
     *      di quanto costerebbe tenersi un pezzo mutabile in giro.
     */
    string public baseURL;

    constructor(string memory baseURL_) {
        baseURL = baseURL_;
    }

    string private constant MINT = "#8fe8b0";
    string private constant PANEL = "#0c0d0b";
    string private constant LINE = "#272a25";
    string private constant DIM = "#6f7669";

    function tokenURI(
        uint256 id,
        ChipFactory.Chip calldata chip,
        uint256[16] calldata
    ) external view returns (string memory) {
        uint256 state = chip.machine & ((uint256(1) << 79) - 1);
        uint256 cycles = (chip.machine >> 80) & ((uint256(1) << 48) - 1);
        bool halted = RH4State.halted(state);

        string memory ticker = _label(chip.ticker);
        string memory name = _label(chip.label);
        if (bytes(name).length == 0) {
            name = bytes(ticker).length != 0 ? ticker : string.concat("CHIP #", id.toString());
        }

        string memory json = string.concat(
            '{"name":"', bytes(ticker).length != 0
                ? string.concat(name, " (", ticker, ")")
                : name,
            '","description":"A real 4-bit processor living inside the chain. 1,029 NAND gates, 79 flip-flops, one clock tick per block. Nobody owns the clock: anyone can pay a cycle, and the sponsor is written into the Cycle event forever. A chip nobody advances is dead silicon.',
            '","external_url":"', _chipURL(id),
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(id, name, ticker, state, cycles, halted))),
            '","attributes":', _attributes(state, cycles, halted, chip),
            "}"
        );

        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(json))
        );
    }

    /// @dev Link al singolo chip, non alla home: chi arriva dall'NFT deve
    ///      trovarsi davanti quel processore, non un altro.
    function _chipURL(uint256 id) internal view returns (string memory) {
        if (bytes(baseURL).length == 0) return "";
        return string.concat(baseURL, "?chip=", id.toString());
    }

    // ---- immagine -----------------------------------------------------------

    /// @dev Spezzata in tre: un solo string.concat con tutti i pezzi
    ///      manda in stack too deep il compilatore senza via-ir.
    function _svg(
        uint256 id,
        string memory name,
        string memory ticker,
        uint256 state,
        uint256 cycles,
        bool halted
    ) internal pure returns (string memory) {
        return string.concat(
            _svgHead(id, ticker),
            _svgFace(name, state),
            _svgNumbers(state, cycles, halted)
        );
    }

    function _svgHead(uint256 id, string memory ticker)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420" width="420" height="420">',
            '<rect width="420" height="420" fill="', PANEL, '"/>',
            '<rect x="24" y="24" width="372" height="372" fill="none" stroke="', LINE, '" stroke-width="1.5"/>',
            '<g font-family="ui-monospace,monospace">',
            '<rect x="24" y="24" width="372" height="34" fill="none" stroke="', LINE, '" stroke-width="1.5"/>',
            '<rect x="40" y="37" width="7" height="7" fill="', MINT, '"/>',
            _t(56, 46, 10, DIM, "RH-4 / GATE ARRAY"),
            _t(380, 46, 10, DIM, string.concat("#", id.toString()), "end"),
            // la sigla serigrafata sul package, come su un chip vero
            bytes(ticker).length == 0
                ? ""
                : string.concat(
                    '<rect x="40" y="76" width="', (26 + bytes(ticker).length * 11).toString(),
                    '" height="22" fill="', MINT, '"/>',
                    _t(53, 92, 13, PANEL, ticker)
                  )
        );
    }

    function _svgFace(string memory name, uint256 state)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            _t(40, 134, 26, "#efeee6", name),
            _t(40, 156, 10, DIM, "1029 NAND / 79 FLIP-FLOPS"),
            _leds(RH4State.out(state))
        );
    }

    function _svgNumbers(uint256 state, uint256 cycles, bool halted)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            _row(250, "CYCLES", cycles.toString()),
            _row(288, "PC", string.concat("0x", _hex2(RH4State.pc(state)))),
            _row(326, "OUT", uint256(RH4State.out(state)).toString()),
            halted
                ? string.concat(
                    '<rect x="40" y="348" width="120" height="24" fill="#f5c842"/>',
                    _t(52, 365, 11, PANEL, "HALTED")
                  )
                : _t(40, 365, 11, MINT, "RUNNING / 1 TICK PER BLOCK"),
            "</g></svg>"
        );
    }

    function _leds(uint8 out) internal pure returns (string memory) {
        string memory s = "";
        for (uint256 i; i < 4; ++i) {
            // il bit piu' significativo sta a sinistra, come sui pannelli veri
            bool on = (out >> (3 - i)) & 1 == 1;
            s = string.concat(
                s,
                '<rect x="', (40 + i * 56).toString(), '" y="176" width="44" height="44" ',
                on
                    ? string.concat('fill="', MINT, '"/>')
                    : string.concat('fill="#14171a" stroke="', LINE, '" stroke-width="1.5"/>')
            );
        }
        return s;
    }

    function _row(uint256 y, string memory k, string memory v)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<line x1="40" y1="', (y - 20).toString(),
            '" x2="380" y2="', (y - 20).toString(),
            '" stroke="', LINE, '" stroke-width="1.5"/>',
            _t(40, y, 10, DIM, k),
            _t(380, y, 16, MINT, v, "end")
        );
    }

    // ---- attributi ----------------------------------------------------------

    function _attributes(
        uint256 state,
        uint256 cycles,
        bool halted,
        ChipFactory.Chip calldata chip
    ) internal pure returns (string memory) {
        return string.concat(
            '[{"trait_type":"Ticker","value":"', _label(chip.ticker),
            '"},{"trait_type":"Cycles","value":', cycles.toString(),
            '},{"trait_type":"Program counter","value":', uint256(RH4State.pc(state)).toString(),
            '},{"trait_type":"Output","value":', uint256(RH4State.out(state)).toString(),
            '},{"trait_type":"Status","value":"', halted ? "Halted" : "Running",
            '"},{"trait_type":"Restarts","value":', uint256(chip.resets).toString(),
            '},{"trait_type":"Born at block","value":', uint256(chip.bornBlock).toString(),
            "}]"
        );
    }

    // ---- utilita' -----------------------------------------------------------

    function _t(uint256 x, uint256 y, uint256 size, string memory fill, string memory body)
        internal pure returns (string memory)
    {
        return _t(x, y, size, fill, body, "start");
    }

    function _t(
        uint256 x,
        uint256 y,
        uint256 size,
        string memory fill,
        string memory body,
        string memory anchor
    ) internal pure returns (string memory) {
        return string.concat(
            '<text x="', x.toString(), '" y="', y.toString(),
            '" font-size="', size.toString(),
            '" fill="', fill,
            '" letter-spacing="1.4" text-anchor="', anchor, '">',
            body, "</text>"
        );
    }

    /// @dev bytes32 -> stringa, tagliando gli zeri di coda. I caratteri fuori
    ///      dall'ASCII stampabile diventano spazi: un'etichetta non deve poter
    ///      iniettare markup dentro l'SVG.
    function _label(bytes32 raw) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && raw[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint8 ch = uint8(raw[i]);
            bool safe = ch >= 0x20 && ch <= 0x7e
                && ch != 0x3c && ch != 0x3e && ch != 0x26 // < > &
                && ch != 0x22 && ch != 0x27;              // " '
            out[i] = safe ? bytes1(ch) : bytes1(" ");
        }
        return string(out);
    }

    function _hex2(uint8 v) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(2);
        out[0] = digits[v >> 4];
        out[1] = digits[v & 0xf];
        return string(out);
    }
}
