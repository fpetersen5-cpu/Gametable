"""Validate generated GLBs without a renderer or additional Python packages."""
import argparse
import json
import math
import struct
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--expected', type=int, default=11)
args = parser.parse_args()
names = set()
reports = []
for manifest_path in sorted(args.directory.glob('*/manifest.json')):
    manifest = json.loads(manifest_path.read_text())
    folder = manifest_path.parent
    assert manifest['name'] not in names, 'Repeated character identity'
    names.add(manifest['name'])
    blend = folder / manifest['blend']
    assert blend.stat().st_size > 1_000_000, f'Missing/empty Blender source: {blend}'
    for preview in ['portrait.png', 'full-body.png']:
        assert (folder / preview).read_bytes()[:8] == b'\x89PNG\r\n\x1a\n'
    data = (folder / manifest['glb']).read_bytes()
    magic, version, size = struct.unpack_from('<4sII', data)
    assert magic == b'glTF' and version == 2 and size == len(data)
    json_size, chunk_type = struct.unpack_from('<II', data, 12)
    assert chunk_type == 0x4E4F534A
    gltf = json.loads(data[20:20 + json_size])
    binary_size, binary_type = struct.unpack_from('<II', data, 20 + json_size)
    assert binary_type == 0x004E4942
    binary = data[28 + json_size:]
    assert len(binary) == binary_size
    types = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
    components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

    def accessor(index):
        a = gltf['accessors'][index]
        view = gltf['bufferViews'][a['bufferView']]
        code, size = types[a['componentType']]
        width = components[a['type']]
        offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = view.get('byteStride', width * size)
        for i in range(a['count']):
            yield struct.unpack_from('<' + code * width, binary, offset + stride * i)

    triangles = 0
    for mesh in gltf['meshes']:
        for primitive in mesh['primitives']:
            attrs = primitive['attributes']
            assert {'POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0'} <= attrs.keys(), f'Missing surface data: {mesh.get("name")}'
            count = gltf['accessors'][attrs['POSITION']]['count']
            for key in ['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0']:
                assert gltf['accessors'][attrs[key]]['count'] == count
                assert all(all(math.isfinite(v) for v in row) for row in accessor(attrs[key]))
            indices = primitive['indices']
            assert all(0 <= row[0] < count for row in accessor(indices))
            triangles += gltf['accessors'][indices]['count'] // 3
    assert 250_000 <= triangles < 3_000_000, f'Unexpected high-poly budget: {triangles}'
    assert any(n.get('name') == 'HeadPivot' for n in gltf['nodes'])
    closed = [n for n in gltf['nodes'] if n.get('extras', {}).get('default_visible') is False]
    assert closed and all(n.get('scale') == [0, 0, 0] for n in closed), 'Closed eyes obscure the resting face'
    for image in gltf['images']:
        assert 'uri' not in image and 'bufferView' in image, 'GLB must be self-contained'
        view = gltf['bufferViews'][image['bufferView']]
        offset = view.get('byteOffset', 0)
        png = binary[offset:offset + view['byteLength']]
        assert png[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack_from('>II', png, 16) == (2048, 2048)
    for surface in ['Fabric', 'Skin', 'Hair', 'Leather', 'Metal']:
        mat = next(m for m in gltf['materials'] if m['name'] == surface)
        pbr = mat['pbrMetallicRoughness']
        assert 'baseColorTexture' in pbr and 'metallicRoughnessTexture' in pbr
        assert 'normalTexture' in mat, f'Missing normal texture: {surface}'
    reports.append({'name': manifest['name'], 'triangles': triangles, 'embedded_textures': len(gltf['images']), 'glb_bytes': len(data)})
    print(f"OK {manifest['name']}: {triangles:,} triangles, {len(gltf['images'])} embedded 2K maps")
assert len(reports) == args.expected, f'Expected {args.expected} finished models; found {len(reports)}'
(args.directory / 'validation.json').write_text(json.dumps(reports, indent=2) + '\n')
print(f'Validated {len(reports)} independently textured characters.')
