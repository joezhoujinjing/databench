from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from databench_evalscope.volume_backup import VolumeArchiveError, validate_volume_archive


def _archive(path: Path, members: list[tuple[str, bytes | None, str | None]]) -> None:
    with tarfile.open(path, mode='w') as target:
        for name, body, linkname in members:
            member = tarfile.TarInfo(name)
            if linkname is not None:
                member.type = tarfile.SYMTYPE
                member.linkname = linkname
                target.addfile(member)
            elif body is None:
                member.type = tarfile.DIRTYPE
                target.addfile(member)
            else:
                member.size = len(body)
                target.addfile(member, io.BytesIO(body))


def test_volume_archive_accepts_only_the_exact_regular_tree(tmp_path: Path) -> None:
    archive = tmp_path / 'volume.tar'
    _archive(archive, [
        ('outputs', None, None),
        ('outputs/task/report.json', b'{}', None),
        ('inputs', None, None),
        ('inputs/task/data.jsonl', b'{}\n', None),
    ])
    assert validate_volume_archive(archive) == 4


@pytest.mark.parametrize('members', [
    [('outputs', None, None), ('inputs', None, None), ('../etc/passwd', b'x', None)],
    [('outputs', None, None), ('inputs', None, None), ('outputs/link', None, '/etc/passwd')],
    [('outputs', None, None), ('outputs', None, None), ('inputs', None, None)],
    [('outputs', b'not-a-directory', None), ('inputs', None, None)],
    [('outputs', None, None), ('other', None, None)],
])
def test_volume_archive_rejects_unsafe_members(
    tmp_path: Path,
    members: list[tuple[str, bytes | None, str | None]],
) -> None:
    archive = tmp_path / 'volume.tar'
    _archive(archive, members)
    with pytest.raises(VolumeArchiveError):
        validate_volume_archive(archive)
