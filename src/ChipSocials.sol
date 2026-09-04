// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IChipFactoryOwner {
    struct Chip {
        uint256 machine;
        bytes32 label;
        bytes32 ticker;
        address minter;
        uint64 bornBlock;
        uint32 resets;
        address token;
        uint96 rewardPerCycle;
    }
    function chip(uint256 id) external view returns (Chip memory);
    function ownerOf(uint256 id) external view returns (address);
}

/**
 * @title ChipSocials — dove un chip dice chi e'
 *
 * La fabbrica e' immutabile e non ha posto per i social: questo registro
 * sta accanto. Tre link per chip — X, sito, Telegram — scrivibili solo dal
 * coniatore originale o da chi possiede l'NFT del chip oggi, leggibili da
 * chiunque: la pagina del chip, i terminali, gli indicizzatori.
 *
 * Ogni link o e' vuoto o comincia per https:// ed e' fatto di caratteri
 * ASCII stampabili senza virgolette, angolari o backslash: cosi' una
 * pagina che li inserisce in un href non puo' farsi male.
 */
contract ChipSocials {
    struct Links {
        string x;
        string website;
        string telegram;
    }

    IChipFactoryOwner public immutable factory;
    mapping(uint256 => Links) private _links;

    event LinksSet(uint256 indexed id, address indexed by, string x, string website, string telegram);

    error NotChipOwner();
    error BadLink();

    constructor(IChipFactoryOwner factory_) {
        factory = factory_;
    }

    /// @notice Scrive (o riscrive) i tre link di un chip. Stringa vuota = nessun link.
    function setLinks(uint256 id, string calldata x, string calldata website, string calldata telegram) external {
        if (msg.sender != factory.chip(id).minter && msg.sender != factory.ownerOf(id)) revert NotChipOwner();
        _check(x);
        _check(website);
        _check(telegram);
        _links[id] = Links(x, website, telegram);
        emit LinksSet(id, msg.sender, x, website, telegram);
    }

    function links(uint256 id) external view returns (string memory x, string memory website, string memory telegram) {
        Links storage l = _links[id];
        return (l.x, l.website, l.telegram);
    }

    function _check(string calldata s) internal pure {
        bytes calldata b = bytes(s);
        if (b.length == 0) return;
        if (b.length < 9 || b.length > 160) revert BadLink();
        if (bytes8(b[:8]) != bytes8("https://")) revert BadLink();
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x21 || c > 0x7e) revert BadLink();
            if (c == 0x22 || c == 0x27 || c == 0x3c || c == 0x3e || c == 0x5c) revert BadLink();
        }
    }
}
