// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ChipFactory8} from "./ChipFactory8.sol";
import {RH8State} from "./RH8State.sol";

/**
 * @title Chip8Renderer — l'immagine di un chip a 8 bit, disegnata on-chain
 *
 * Se il chip ha un logo e' quello a fare da `image`: chi conia si aspetta di
 * vedere la propria immagine. La card viva non si perde — passa in
 * `animation_url`, dove continua a mostrare il processore: otto luci che
 * sono la porta di uscita in quel preciso istante, e il conteggio dei cicli
 * che gli sponsor hanno davvero pagato.
 */
contract Chip8Renderer {
    using Strings for uint256;

    string private constant MINT = "#8fe8b0";
    string private constant PANEL = "#0c0d0b";
    string private constant LINE = "#272a25";
    string private constant DIM = "#6f7669";

    string public baseURL;

    constructor(string memory baseURL_) {
        baseURL = baseURL_;
    }

    function tokenURI(
        uint256 id,
        ChipFactory8.Chip calldata chip,
        string calldata logo
    ) external view returns (string memory) {
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(_json(id, chip, logo)))
        );
    }

    function _json(uint256 id, ChipFactory8.Chip calldata chip, string calldata logo)
        internal
        view
        returns (string memory)
    {
        string memory card = _card(id, chip);
        return string.concat(
            _head(id, chip, bytes(logo).length != 0 ? logo : card),
            '","animation_url":"', card,
            '","attributes":', _attributes(chip),
            "}"
        );
    }

    function _card(uint256 id, ChipFactory8.Chip calldata chip)
        internal
        pure
        returns (string memory)
    {
        uint256 state = chip.machine & ((uint256(1) << 171) - 1);
        return string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(bytes(_svg(
                id,
                _displayName(id, chip),
                _label(chip.ticker),
                state,
                (chip.machine >> 176) & ((uint256(1) << 40) - 1),
                RH8State.halted(state)
            )))
        );
    }

    function _head(uint256 id, ChipFactory8.Chip calldata chip, string memory image)
        internal
        view
        returns (string memory)
    {
        string memory ticker = _label(chip.ticker);
        string memory name = _displayName(id, chip);
        return string.concat(
            '{"name":"',
            bytes(ticker).length != 0 ? string.concat(name, " (", ticker, ")") : name,
            '","description":"A real 8-bit processor living inside the chain. 2,368 NAND gates, 171 flip-flops, 256 bytes of RAM, one clock tick per block. Every tick carries a byte from whoever paid it, and the sponsor is written into the Cycle event forever. A chip nobody advances is dead silicon.',
            '"', _externalUrl(id),
            ',"image":"', image
        );
    }

    function _displayName(uint256 id, ChipFactory8.Chip calldata chip)
        internal
        pure
        returns (string memory)
    {
        string memory name = _label(chip.label);
        if (bytes(name).length != 0) return name;
        string memory ticker = _label(chip.ticker);
        return bytes(ticker).length != 0 ? ticker : string.concat("CHIP #", id.toString());
    }

    function _externalUrl(uint256 id) internal view returns (string memory) {
        if (bytes(baseURL).length == 0) return "";
        return string.concat(',"external_url":"', baseURL, "?chip=", id.toString(), '"');
    }

    // ---- immagine -----------------------------------------------------------

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
            _t(56, 46, 10, DIM, "RH-8 / GATE ARRAY"),
            _t(380, 46, 10, DIM, string.concat("#", id.toString()), "end"),
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
            _t(40, 156, 10, DIM, "2368 NAND / 171 FLIP-FLOPS / 256 B RAM"),
            _leds(RH8State.out(state))
        );
    }

    /// @dev Otto luci, il bit piu' significativo a sinistra come sui
    ///      pannelli veri: la porta di uscita si legge in binario.
    function _leds(uint8 out) internal pure returns (string memory) {
        string memory s = "";
        for (uint256 i; i < 8; ++i) {
            bool on = (out >> (7 - i)) & 1 == 1;
            s = string.concat(
                s,
                '<rect x="', (40 + i * 43).toString(), '" y="176" width="35" height="35" ',
                on
                    ? string.concat('fill="', MINT, '"/>')
                    : string.concat('fill="#14171a" stroke="', LINE, '" stroke-width="1.5"/>')
            );
        }
        return s;
    }

    function _svgNumbers(uint256 state, uint256 cycles, bool halted)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            _row(250, "CYCLES", cycles.toString()),
            _row(288, "PC", string.concat("0x", _hex3(RH8State.pc(state)))),
            _row(326, "OUT", uint256(RH8State.out(state)).toString()),
            halted
                ? string.concat(
                    '<rect x="40" y="348" width="120" height="24" fill="#f5c842"/>',
                    _t(52, 365, 11, PANEL, "HALTED")
                  )
                : _t(40, 365, 11, MINT, "RUNNING / 1 TICK PER BLOCK"),
            "</g></svg>"
        );
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

    function _attributes(ChipFactory8.Chip calldata chip)
        internal
        pure
        returns (string memory)
    {
        uint256 state = chip.machine & ((uint256(1) << 171) - 1);
        uint256 cycles = (chip.machine >> 176) & ((uint256(1) << 40) - 1);
        bool halted = RH8State.halted(state);
        return string.concat(
            '[{"trait_type":"Ticker","value":"', _label(chip.ticker),
            '"},{"trait_type":"Cycles","value":', cycles.toString(),
            '},{"trait_type":"Program counter","value":', uint256(RH8State.pc(state)).toString(),
            '},{"trait_type":"Output","value":', uint256(RH8State.out(state)).toString(),
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
        uint256 x, uint256 y, uint256 size,
        string memory fill, string memory body, string memory anchor
    ) internal pure returns (string memory) {
        return string.concat(
            '<text x="', x.toString(), '" y="', y.toString(),
            '" font-size="', size.toString(),
            '" fill="', fill,
            '" letter-spacing="1.4" text-anchor="', anchor, '">',
            body, "</text>"
        );
    }

    /// @dev bytes32 -> stringa, filtrando cio' che potrebbe iniettare markup.
    function _label(bytes32 raw) internal pure returns (string memory) {
        uint256 len;
        while (len < 32 && raw[len] != 0) ++len;
        bytes memory out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            uint8 ch = uint8(raw[i]);
            bool safe = ch >= 0x20 && ch <= 0x7e
                && ch != 0x3c && ch != 0x3e && ch != 0x26
                && ch != 0x22 && ch != 0x27;
            out[i] = safe ? bytes1(ch) : bytes1(" ");
        }
        return string(out);
    }

    function _hex3(uint16 v) internal pure returns (string memory) {
        bytes memory digits = "0123456789abcdef";
        bytes memory out = new bytes(3);
        out[0] = digits[(v >> 8) & 0xf];
        out[1] = digits[(v >> 4) & 0xf];
        out[2] = digits[v & 0xf];
        return string(out);
    }
}
