"""Split high-detail GLBs into local glTF/buffers and lossless shared 2K maps."""
import argparse
import hashlib
import io
import json
import struct
import re
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
textures = args.output / 'textures'
textures.mkdir(exist_ok=True)
previous_maps = {
    image['uri'] for path in args.output.glob('*.gltf')
    for image in json.loads(path.read_text()).get('images', [])
    if re.fullmatch(r'textures/[a-f0-9]{24}\.png', image.get('uri', ''))
}
current_maps = set()
reports = []
converted = {}
for path in sorted(args.source.glob('*.glb')):
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    # Blender's exporter emits the white sheen tint at full strength, omitting
    # our Principled shader's 0.22 Sheen Weight. glTF encodes both in this factor.
    for material in gltf['materials']:
        sheen = material.get('extensions', {}).get('KHR_materials_sheen')
        if material['name'] == 'Fabric' and sheen:
            sheen['sheenColorFactor'] = [channel * 0.22 for channel in sheen['sheenColorFactor']]
    binary = data[28 + length:]
    image_views = set()
    for image in gltf['images']:
        index = image.pop('bufferView')
        image_views.add(index)
        view = gltf['bufferViews'][index]
        offset = view.get('byteOffset', 0)
        source = binary[offset:offset + view['byteLength']]
        source_hash = hashlib.sha256(source).digest()
        name = converted.get(source_hash)
        if name is None:
            pixels = Image.open(io.BytesIO(source)).convert('RGB')
            assert pixels.size == (2048, 2048), (path, pixels.size)
            out = io.BytesIO()
            pixels.save(out, format='PNG', optimize=True)
            png = out.getvalue()
            name = hashlib.sha256(png).hexdigest()[:24] + '.png'
            (textures / name).write_bytes(png)
            converted[source_hash] = name
        image['uri'] = 'textures/' + name
        image['name'] = name
        current_maps.add(image['uri'])
    # Repack just geometry, removing every embedded image and its bufferView.
    packed = bytearray()
    views = []
    indices = {}
    for index, view in enumerate(gltf['bufferViews']):
        if index in image_views:
            continue
        offset = view.get('byteOffset', 0)
        chunk = binary[offset:offset + view['byteLength']]
        packed.extend(b'\0' * (-len(packed) % 4))
        indices[index] = len(views)
        views.append({**view, 'byteOffset': len(packed)})
        packed.extend(chunk)
    for accessor in gltf['accessors']:
        accessor['bufferView'] = indices[accessor['bufferView']]
    gltf['bufferViews'] = views
    gltf['buffers'] = [{'byteLength': len(packed), 'uri': path.stem + '.bin'}]
    triangles = sum(gltf['accessors'][p['indices']]['count'] // 3 for m in gltf['meshes'] for p in m['primitives'])
    assert 350000 < triangles < 750000, (path, triangles)
    (args.output / (path.stem + '.bin')).write_bytes(packed)
    (args.output / (path.stem + '.gltf')).write_text(json.dumps(gltf, separators=(',', ':')) + '\n')
    reports.append({'name': path.stem, 'triangles': triangles, 'geometry_bytes': len(packed)})
    print(f'{path.stem}: {triangles:,} triangles / {len(packed):,} geometry bytes')
assert len(reports) == 11
for uri in previous_maps - current_maps:
    (args.output / uri).unlink(missing_ok=True)
(args.output / 'manifest.json').write_text(json.dumps({'characters': reports, 'texture_size': 2048, 'surface_revision': 'surfaces-v2'}, indent=2) + '\n')
print(f'{len(list(textures.glob("*.png")))} shared/individual texture maps')
