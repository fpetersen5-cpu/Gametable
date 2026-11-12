"""Prepare downloaded operative GLBs for the Mafia runtime.

Run inside Blender:

  flatpak run --filesystem="$PWD" --filesystem=/tmp/opencode \
    org.blender.Blender --background --factory-startup --python-exit-code 1 \
    --python scripts/mafia/import-operative-glb.py -- \
    "/home/takmikill/Hentet/mafia models" /tmp/opencode/mafia-operative

The downloaded models are static, high-poly meshes without the council rig.
This script joins their parts, decimates to the runtime triangle budget,
normalizes the height and floor position, and exports GLBs for
package-runtime.py.
"""
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--triangles', type=int, default=250_000)
parser.add_argument('--height', type=float, default=1.9)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.mkdir(parents=True, exist_ok=True)

# Download filename -> runtime character name.
MAPPING = {
    'Vanguard_Operative.glb': 'vanguard',
    'Liaison_Operative.glb': 'liaison',
    'Veteran_Operative.glb': 'veteran',
}


def bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return (
        Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners))),
        Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners))),
    )


for source_name, runtime_name in MAPPING.items():
    source = args.source / source_name
    if not source.exists():
        raise SystemExit(f'missing source: {source}')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not meshes:
        raise SystemExit(f'no mesh in {source}')
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    obj.data.calc_loop_triangles()
    triangles = len(obj.data.loop_triangles)
    if triangles > args.triangles:
        modifier = obj.modifiers.new('Runtime triangle budget', 'DECIMATE')
        modifier.decimate_type = 'COLLAPSE'
        modifier.ratio = args.triangles / triangles
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    low, high = bounds(obj)
    # Blender imports glTF Y-up as Z-up; the character's height is Z.
    scale = args.height / max(high.z - low.z, 1e-6)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(scale=True)
    low, high = bounds(obj)
    obj.location.x -= (low.x + high.x) / 2
    obj.location.y -= (low.y + high.y) / 2
    obj.location.z -= low.z
    bpy.ops.object.transform_apply(location=True)

    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    output = args.output / f'{runtime_name}.glb'
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
    )
    obj.data.calc_loop_triangles()
    print(
        f'OPERATIVE_EXPORTED {runtime_name} triangles={len(obj.data.loop_triangles)} '
        f'height={args.height} output={output}',
        flush=True,
    )
