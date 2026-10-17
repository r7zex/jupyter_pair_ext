"""Detach only the fixed Pair-owned loop volumes used by older installations."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from .system import InstallError, run, write


@dataclass
class VolumePlan:
    fstab: Path
    original: str
    retained: str
    images: list[Path]
    mounted: list[Path]


def plan(roots: tuple[Path, Path], fstab: Path = Path('/etc/fstab'), volume_root: Path = Path('/var/lib/pair-notebook-volumes')) -> VolumePlan:
    original = fstab.read_text() if fstab.exists() else ''
    expected = dict(zip(roots, (volume_root / 'server.ext4', volume_root / 'worker.ext4')))
    retained, images, mounted = [], [], []
    recorded = set()
    for line in original.splitlines(keepends=True):
        fields = line.split()
        target = Path(fields[1]) if len(fields) > 1 and not line.lstrip().startswith('#') else None
        if target not in expected:
            retained.append(line)
            continue
        image = expected[target]
        if target in recorded or len(fields) != 6 or fields[0] != str(image) or fields[2] != 'ext4' or 'loop' not in fields[3].split(','):
            raise InstallError('Unrecognized Pair storage mount; no installation files were removed.')
        if volume_root.is_symlink() or image.is_symlink() or not image.is_file() or image.resolve() != image:
            raise InstallError('Unsafe Pair storage volume.')
        recorded.add(target)
        images.append(image)
        if os.path.ismount(target):
            source = run('findmnt', '--noheadings', '--raw', '--mountpoint', str(target), '--output', 'SOURCE', capture=True)
            if not source.startswith('/dev/loop') or run('losetup', '--noheadings', '--raw', '--output', 'BACK-FILE', source, capture=True) != str(image):
                raise InstallError('Pair storage is mounted from an unexpected device.')
            mounted.append(target)
    if any(os.path.ismount(root) and root not in mounted for root in roots):
        raise InstallError('Unrecognized mounted storage; export and detach it before removal.')
    return VolumePlan(fstab, original, ''.join(retained), images, mounted)


def detach(plan: VolumePlan) -> None:
    for target in reversed(plan.mounted):
        run('umount', str(target))
    if plan.images:
        write(plan.fstab, plan.retained, 0o644)


def restore(plan: VolumePlan) -> None:
    if not plan.images:
        return
    write(plan.fstab, plan.original, 0o644)
    for target in plan.mounted:
        if not os.path.ismount(target):
            run('mount', str(target))


def remove_images(plan: VolumePlan) -> None:
    for image in plan.images:
        image.unlink()
    if plan.images and not any(plan.images[0].parent.iterdir()):
        plan.images[0].parent.rmdir()
