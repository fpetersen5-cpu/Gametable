"""Authored, tileable 2K council PBR surfaces (Blender + bundled NumPy).

Irregular pores/grain replace the old sinusoidal skin pattern. Texture colour is
a multiplier over the character's original vertex pigment, not a replacement.
"""
import math
from pathlib import Path

import bpy
import numpy as np

SIZE = 2048
REVISION = 'surfaces-v2'


def noise(rng, cells):
    """Smooth periodic value noise; no directional bands on organic surfaces."""
    grid = rng.random((cells, cells), dtype=np.float32)
    t = np.arange(SIZE, dtype=np.float32) * cells / SIZE
    index = t.astype(np.int32)
    f = t - index
    f = f * f * (3 - 2 * f)
    a = grid[index[:, None], index[None, :]]
    b = grid[index[:, None], (index[None, :] + 1) % cells]
    c = grid[(index[:, None] + 1) % cells, index[None, :]]
    d = grid[(index[:, None] + 1) % cells, (index[None, :] + 1) % cells]
    return (a * (1 - f) + b * f) * (1 - f[:, None]) + (c * (1 - f) + d * f) * f[:, None]


def write(path, values, color):
    image = bpy.data.images.new(path.stem, SIZE, SIZE, alpha=False)
    image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    rgba = np.ones((SIZE, SIZE, 4), dtype=np.float32)
    rgba[:, :, :3] = values[:, :, None] if values.ndim == 2 else values
    image.pixels.foreach_set(np.clip(rgba, 0, 1).ravel())
    image.filepath_raw = str(path)
    image.file_format = 'PNG'
    image.save()
    bpy.data.images.remove(image)


def surfaces(folder: Path, kind: str, seed: int):
    folder = folder / REVISION
    folder.mkdir(parents=True, exist_ok=True)
    paths = {key: folder / f'{kind}_{seed}_{key}.png' for key in ['BaseColor', 'Roughness', 'Normal']}
    if all(path.exists() for path in paths.values()):
        return paths
    rng = np.random.default_rng(seed)
    fine = noise(rng, 512)
    medium = noise(rng, 96)
    broad = noise(rng, 12)
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE
    if kind == 'Skin':
        pores = np.maximum(0, fine - 0.63) ** 2 * 8
        height = medium * 0.04 - pores * 0.16 + fine * 0.025
        # Low-contrast warm pigmentation and tiny, irregular freckles.
        freckles = np.maximum(0, noise(rng, 180) - 0.79) * 0.22
        base = np.stack([0.965 + broad * 0.025 - freckles,
                         0.94 + broad * 0.035 - freckles * 1.3,
                         0.935 + broad * 0.035 - freckles * 1.4], axis=2)
        roughness = 0.54 + medium * 0.10 + pores * 0.035
        strength = 1.2
    elif kind == 'Fabric':
        warp = np.cos(x * math.tau * 192)
        weft = np.cos(y * math.tau * 192)
        over = (np.floor(x * 192) + np.floor(y * 192)) % 2
        height = (warp * over + weft * (1 - over)) * 0.07 + fine * 0.018
        base = 0.91 + broad * 0.035 + height * 0.11
        roughness = 0.78 + medium * 0.1
        strength = 1.0
    elif kind == 'Hair':
        # Fine directional strands, with varying width and a muted satin finish.
        strand = np.cos(x * math.tau * 320 + np.sin(y * math.tau * 2) * 0.25)
        height = strand * 0.14 + medium * 0.025
        base = 0.84 + strand * 0.12 + broad * 0.055
        roughness = 0.54 + medium * 0.12
        strength = 1.2
    elif kind == 'Leather':
        grain = noise(rng, 220)
        height = grain * 0.11 + fine * 0.025
        base = 0.88 + broad * 0.05 + grain * 0.025
        roughness = 0.49 + grain * 0.12
        strength = 1.8
    else:
        brushed = noise(rng, 1024).mean(axis=0)[None, :]
        height = np.broadcast_to(brushed * 0.12, (SIZE, SIZE)) + fine * 0.008
        base = 0.94 + broad * 0.035
        roughness = 0.29 + medium * 0.1
        strength = 0.6
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    normal = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normal /= np.linalg.norm(normal, axis=2)[:, :, None]
    write(paths['BaseColor'], base, True)
    write(paths['Roughness'], roughness, False)
    write(paths['Normal'], normal * 0.5 + 0.5, False)
    return paths
