#!/usr/bin/env python3
"""Apply the locked text-only ms-swift downstream patch without OS packages."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

ALLOWED_FILES = {
    'setup.py',
    'swift/ui/app.py',
    'swift/ui/llm_train/dataset.py',
    'swift/ui/llm_train/hyper.py',
    'swift/ui/llm_train/runtime.py',
}
HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_root', type=Path)
    parser.add_argument('patch', type=Path)
    return parser.parse_args()


def apply_file(source_root: Path, relative_path: str, hunks: list[list[str]]) -> None:
    if relative_path not in ALLOWED_FILES:
        raise ValueError(f'Patch targets an unapproved file: {relative_path}')
    target = source_root / relative_path
    original = target.read_text(encoding='utf-8').splitlines(keepends=True)
    output: list[str] = []
    source_index = 0
    for hunk in hunks:
        match = HUNK.match(hunk[0])
        if match is None:
            raise ValueError(f'Invalid hunk header: {hunk[0].rstrip()}')
        old_start = int(match.group(1))
        old_count = int(match.group(2) or '1')
        new_count = int(match.group(4) or '1')
        target_index = old_start - 1
        if target_index < source_index:
            raise ValueError(f'Overlapping patch hunk for {relative_path}')
        output.extend(original[source_index:target_index])
        source_index = target_index
        consumed = 0
        emitted = 0
        for line in hunk[1:]:
            if line.startswith('\\ No newline at end of file'):
                continue
            marker, content = line[:1], line[1:]
            if marker in {' ', '-'}:
                if source_index >= len(original) or original[source_index] != content:
                    raise ValueError(f'Patch context mismatch for {relative_path} at line {source_index + 1}')
                source_index += 1
                consumed += 1
            if marker in {' ', '+'}:
                output.append(content)
                emitted += 1
            if marker not in {' ', '-', '+'}:
                raise ValueError(f'Invalid patch line for {relative_path}: {line.rstrip()}')
        if consumed != old_count or emitted != new_count:
            raise ValueError(f'Patch hunk count mismatch for {relative_path}')
    output.extend(original[source_index:])
    temporary = target.with_name(f'.{target.name}.databench-patch')
    temporary.write_text(''.join(output), encoding='utf-8')
    os.replace(temporary, target)


def parse_patch(contents: str) -> dict[str, list[list[str]]]:
    lines = contents.splitlines(keepends=True)
    files: dict[str, list[list[str]]] = {}
    index = 0
    while index < len(lines):
        if not lines[index].startswith('diff --git a/'):
            index += 1
            continue
        index += 1
        while index < len(lines) and not lines[index].startswith('--- a/'):
            index += 1
        if index + 1 >= len(lines) or not lines[index + 1].startswith('+++ b/'):
            raise ValueError('Patch file header is incomplete')
        old_path = lines[index][6:].strip()
        new_path = lines[index + 1][6:].strip()
        if old_path != new_path:
            raise ValueError('Patch cannot rename files')
        index += 2
        hunks: list[list[str]] = []
        while index < len(lines) and not lines[index].startswith('diff --git a/'):
            if not lines[index].startswith('@@ '):
                index += 1
                continue
            hunk = [lines[index]]
            index += 1
            while (
                index < len(lines)
                and not lines[index].startswith('@@ ')
                and not lines[index].startswith('diff --git a/')
            ):
                hunk.append(lines[index])
                index += 1
            hunks.append(hunk)
        if not hunks:
            raise ValueError(f'Patch contains no hunks for {old_path}')
        files[old_path] = hunks
    if not files or not set(files).issubset(ALLOWED_FILES):
        raise ValueError('Patch targets files outside the approved integration boundary')
    return files


def main() -> None:
    args = arguments()
    source_root = args.source_root.resolve(strict=True)
    patch = args.patch.resolve(strict=True)
    for relative_path, hunks in parse_patch(patch.read_text(encoding='utf-8')).items():
        apply_file(source_root, relative_path, hunks)


if __name__ == '__main__':
    main()
