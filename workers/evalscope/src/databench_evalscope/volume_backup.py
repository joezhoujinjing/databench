"""Validation for root-extracted offline EvalScope volume backups."""

from __future__ import annotations

import tarfile
from pathlib import Path, PurePosixPath


class VolumeArchiveError(ValueError):
    """The offline volume archive is not safe to extract as root."""


def validate_volume_archive(path: Path) -> int:
    """Require an exact outputs/inputs regular-file tree without link semantics."""

    seen: set[str] = set()
    root_directories: set[str] = set()
    try:
        with tarfile.open(path, mode='r:') as source:
            members = source.getmembers()
            if not members:
                raise VolumeArchiveError('EvalScope volume archive is empty')
            for member in members:
                member_path = PurePosixPath(member.name)
                if (
                    member_path.is_absolute()
                    or not member_path.parts
                    or any(part in {'', '.', '..'} for part in member_path.parts)
                    or member_path.parts[0] not in {'outputs', 'inputs'}
                ):
                    raise VolumeArchiveError('EvalScope volume archive contains an unsafe path')
                canonical_name = member_path.as_posix()
                if canonical_name in seen:
                    raise VolumeArchiveError('EvalScope volume archive contains a duplicate path')
                seen.add(canonical_name)
                if not (member.isdir() or member.isreg()) or member.linkname or member.sparse is not None:
                    raise VolumeArchiveError('EvalScope volume archive contains an unsupported member type')
                if len(member_path.parts) == 1:
                    if not member.isdir():
                        raise VolumeArchiveError('EvalScope volume archive root must be a directory')
                    root_directories.add(member_path.parts[0])
    except (OSError, tarfile.TarError) as error:
        raise VolumeArchiveError('EvalScope volume archive cannot be read') from error
    if root_directories != {'outputs', 'inputs'}:
        raise VolumeArchiveError('EvalScope volume archive must contain both root directories')
    return len(seen)
