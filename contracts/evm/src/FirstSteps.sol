// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FirstSteps
/// @notice A tiny on-chain guestbook on Portaldot. Signing it is the "first transaction" a Ferry user
///         makes with the gas they just received.
contract FirstSteps {
    struct Entry {
        address signer;
        uint64 blockNumber;
        uint64 timestamp;
        string message;
    }

    uint256 public constant MAX_LENGTH = 280;

    Entry[] private _entries;
    mapping(address => uint256) public signaturesOf;

    event Signed(uint256 indexed id, address indexed signer, uint256 blockNumber, string message);

    error EmptyMessage();
    error MessageTooLong(uint256 length);

    function sign(string calldata message) external returns (uint256 id) {
        uint256 len = bytes(message).length;
        if (len == 0) revert EmptyMessage();
        if (len > MAX_LENGTH) revert MessageTooLong(len);
        id = _entries.length;
        _entries.push(Entry(msg.sender, uint64(block.number), uint64(block.timestamp), message));
        signaturesOf[msg.sender] += 1;
        emit Signed(id, msg.sender, block.number, message);
    }

    function count() external view returns (uint256) {
        return _entries.length;
    }

    function entry(uint256 id) external view returns (Entry memory) {
        return _entries[id];
    }

    /// @notice Up to `n` most recent entries, newest first.
    function latest(uint256 n) external view returns (Entry[] memory out) {
        uint256 total = _entries.length;
        if (n > total) n = total;
        out = new Entry[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _entries[total - 1 - i];
        }
    }
}
