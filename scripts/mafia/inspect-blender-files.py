"""Reopen every saved Blender project and check portable source/rig data."""
import json
import sys
from pathlib import Path

import bpy

root = Path(sys.argv[sys.argv.index('--') + 1])
reports = []
for manifest_path in sorted(root.glob('*/manifest.json')):
    manifest = json.loads(manifest_path.read_text())
    path = manifest_path.parent / manifest['blend']
    bpy.ops.wm.open_mainfile(filepath=str(path))
    metadata = json.loads(bpy.context.scene['asset_manifest'])
    assert metadata['name'] == manifest['name']
    assert metadata['triangles'] == manifest['triangles']
    images = [image for image in bpy.data.images if image.source == 'FILE']
    assert len(images) == 15, f'{path}: expected 15 PBR maps'
    assert all(image.packed_file and tuple(image.size) == (2048, 2048) for image in images)
    meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'source_part' in obj]
    assert meshes and all(obj.data.uv_layers and obj.data.color_attributes.get('Pigment') for obj in meshes)
    assert any(obj.modifiers.get('High-poly surface refinement') for obj in meshes)
    pivot = bpy.data.objects.get('HeadPivot')
    assert pivot and pivot.parent and pivot.parent['identity'] == manifest['name']
    assert all(obj.parent == pivot for obj in meshes if obj['head_part'])
    closed = [obj for obj in meshes if not obj['default_visible']]
    assert closed and all(tuple(obj.scale) == (0, 0, 0) and obj.hide_render for obj in closed)
    assert bpy.context.scene.camera and bpy.context.scene.render.engine == 'CYCLES'
    report = {'name': manifest['name'], 'packed_maps': len(images), 'editable_meshes': len(meshes), 'head_pivot': True}
    reports.append(report)
    print('BLEND_OK ' + json.dumps(report), flush=True)
assert len(reports) == 11, f'Expected 11 sources, found {len(reports)}'
(root / 'blender-validation.json').write_text(json.dumps(reports, indent=2) + '\n')
