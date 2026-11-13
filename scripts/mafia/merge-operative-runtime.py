"""Merge prepared operative GLBs into the existing Mafia runtime.

Run with ordinary Python after import-operative-glb.py:

  python3 scripts/mafia/merge-operative-runtime.py \
    /tmp/opencode/mafia-operative assets/mafia/runtime/mafia-characters

The three GLBs replace vanguard/liaison/veteran. Their embedded 4K maps are
converted to 2K PNGs, geometry is split into .gltf/.bin, and the runtime
manifest is updated while the other eight characters are left untouched.
"""
import argparse
import hashlib
import io
import json
import re
import struct
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--texture-size', type=int, default=2048)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
textures = args.output / 'textures'
textures.mkdir(exist_ok=True)

names = {'vanguard', 'liaison', 'veteran'}
manifest_path = args.output / 'manifest.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'characters': []}
entries = {entry['name']: entry for entry in manifest.get('characters', [])}
reports = []
converted = {}

for path in sorted(args.source.glob('*.glb')):
    if path.stem not in names:
        continue
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67 or version != 2:
        raise SystemExit(f'not a glTF 2.0 GLB: {path}')
    json_length, json_type = struct.unpack_from('<II', data, 12)
    if json_type != 0x4E4F534A:
        raise SystemExit(f'missing JSON chunk: {path}')
    gltf = json.loads(data[20:20 + json_length].decode('utf-8').rstrip('\x00 '))
    bin_offset = 20 + json_length
    bin_length, bin_type = struct.unpack_from('<II', data, bin_offset)
    if bin_type != 0x004E4942:
        raise SystemExit(f'missing BIN chunk: {path}')
    binary = data[bin_offset + 8:bin_offset + 8 + bin_length]

    image_views = set()
    for image in gltf.get('images', []):
        index = image.pop('bufferView')
        image_views.add(index)
        view = gltf['bufferViews'][index]
        start = view.get('byteOffset', 0)
        source = binary[start:start + view['byteLength']]
        source_hash = hashlib.sha256(source).digest()
        name = converted.get(source_hash)
        if name is None:
            pixels = Image.open(io.BytesIO(source)).convert('RGB')
            if pixels.size != (args.texture_size, args.texture_size):
                pixels = pixels.resize((args.texture_size, args.texture_size), Image.LANCZOS)
            out = io.BytesIO()
            pixels.save(out, format='PNG', optimize=True)
            png = out.getvalue()
            name = hashlib.sha256(png).hexdigest()[:24] + '.png'
            (textures / name).write_bytes(png)
            converted[source_hash] = name
        image['uri'] = 'textures/' + name
        image['name'] = name
        image['mimeType'] = 'image/png'

    packed = bytearray()
    views = []
    indices = {}
    for index, view in enumerate(gltf['bufferViews']):
        if index in image_views:
            continue
        start = view.get('byteOffset', 0)
        chunk = binary[start:start + view['byteLength']]
        packed.extend(b'\0' * (-len(packed) % 4))
        indices[index] = len(views)
        views.append({**view, 'byteOffset': len(packed)})
        packed.extend(chunk)
    for accessor in gltf['accessors']:
        accessor['bufferView'] = indices[accessor['bufferView']]
    gltf['bufferViews'] = views
    gltf['buffers'] = [{'byteLength': len(packed), 'uri': path.stem + '.bin'}]
    # The operative pipeline rotates every source to face glTF +Z; record that
    # so tests can assert the facing contract without rendering.
    gltf.setdefault('asset', {}).setdefault('extras', {})['facing'] = '+Z'

    triangles = sum(
        gltf['accessors'][primitive['indices']]['count'] // 3
        for mesh in gltf['meshes']
        for primitive in mesh['primitives']
    )
    if not 200_000 < triangles < 550_000:
        raise SystemExit(f'{path.stem}: unexpected triangle count {triangles}')

    (args.output / (path.stem + '.bin')).write_bytes(packed)
    (args.output / (path.stem + '.gltf')).write_text(
        json.dumps(gltf, separators=(',', ':')) + '\n',
    )
    entries[path.stem] = {
        'name': path.stem,
        'triangles': triangles,
        'geometry_bytes': len(packed),
    }
    reports.append(entries[path.stem])
    print(f'{path.stem}: {triangles:,} triangles / {len(packed):,} geometry bytes')

if len(reports) != len(names):
    raise SystemExit(f'expected {len(names)} operative GLBs, found {len(reports)}')

# Remove only maps that no runtime glTF references any more.
referenced = set()
for path in args.output.glob('*.gltf'):
    for image in json.loads(path.read_text()).get('images', []):
        uri = image.get('uri')
        if isinstance(uri, str) and re.fullmatch(r'textures/[a-f0-9]{24}\.png', uri):
            referenced.add(uri)
for path in textures.glob('*.png'):
    uri = f'textures/{path.name}'
    if re.fullmatch(r'textures/[a-f0-9]{24}\.png', uri) and uri not in referenced:
        path.unlink()

manifest['characters'] = [
    entries.get(entry['name'], entry) for entry in manifest.get('characters', [])
]
manifest['texture_size'] = args.texture_size
manifest['surface_revision'] = 'oni-v3-operative'
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'updated {manifest_path} with {len(manifest["characters"])} characters')
