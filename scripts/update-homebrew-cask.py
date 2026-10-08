#!/usr/bin/env python3
"""Update the Homebrew cask from a release tag and SHA256SUMS.txt."""

import argparse
from pathlib import Path
import re


def updated_cask(cask, tag, checksums):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Expected a release tag in vX.Y.Z format")
    matches = re.findall(
        r"^([0-9a-f]{64}) [ *]TerminalFlow-mac-arm64\.zip$", checksums, re.MULTILINE
    )
    if len(matches) != 1:
        raise ValueError("Expected one SHA-256 checksum for TerminalFlow-mac-arm64.zip")
    for stanza, value in (("version", tag[1:]), ("sha256", matches[0])):
        cask, count = re.subn(
            rf'^  {stanza} "[^"]+"$', f'  {stanza} "{value}"', cask, flags=re.MULTILINE
        )
        if count != 1:
            raise ValueError(f"Expected one {stanza} stanza in the cask")
    return cask


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("checksums", type=Path)
    args = parser.parse_args()
    path = Path(__file__).resolve().parents[1] / "Casks/terminalflow.rb"
    path.write_text(updated_cask(path.read_text(), args.tag, args.checksums.read_text()))
