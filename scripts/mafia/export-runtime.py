"""Export game geometry from the finished Blender sources; never modify the sources.

Run in Blender, then run package-runtime.py with ordinary Python/Pillow.
"""
import argparse
import json
import sys
import importlib.util
from pathlib import Path

import bpy

spec = importlib.util.spec_from_file_location('runtime_surfaces', Path(__file__).with_name('runtime-surfaces.py'))
surfaces = importlib.util.module_from_spec(spec)
spec.loader.exec_module(surfaces)

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--only', type=int, nargs='+')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.output.mkdir(parents=True, exist_ok=True)
for path in sorted(args.source.glob('*/manifest.json')):
    manifest = json.loads(path.read_text())
    if args.only and manifest['style_index'] + 1 not in args.only:
        continue
    bpy.ops.wm.open_mainfile(filepath=str(path.parent / manifest['blend']))
    objects = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'source_part' in obj]
    detail_groups = {}
    for obj in objects:
        if obj.get('oni_generated'):
            key = (obj.parent, obj['surface'])
            detail_groups.setdefault(key, []).append(obj)
    for (parent, surface), group in detail_groups.items():
        if len(group) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in group:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        bpy.ops.object.join()
        group[0].name = f'Oni {surface} {"face" if parent.name == "HeadPivot" else "tailoring"}'
    objects = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'source_part' in obj]
    for obj in objects:
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        # Evaluate the actual smoothed Blender surface, including rounded fingers,
        # eyelids, tailoring and hair. Do not decimate the coarse control cage.
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.data.calc_loop_triangles()
        count = len(obj.data.loop_triangles)
        target = {'Fabric': 85000, 'Skin': 45000, 'Leather': 25000, 'Metal': 20000}.get(obj['surface'], 30000)
        if obj['source_part'] == 'sculpted-head':
            target = 100000 if obj['surface'] == 'Skin' else 80000
        if obj['source_part'] in {'open-eyes', 'closed-eyes'}:
            target = 12000
        if count > target:
            modifier = obj.modifiers.new('Runtime surface budget', 'DECIMATE')
            modifier.ratio = target / count
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        if any(len(polygon.vertices) > 4 for polygon in obj.data.polygons):
            triangulate = obj.modifiers.new('Export tangent topology', 'TRIANGULATE')
            bpy.ops.object.modifier_apply(modifier=triangulate.name)
    # glTF multiplies the base texture by COLOR_0 automatically.
    for mat in {mat for obj in objects for mat in obj.data.materials}:
        shader = mat.node_tree.nodes.get('Principled BSDF')
        if mat.name in {'Skin', 'Fabric', 'Hair', 'Leather', 'Metal'}:
            seed = 1201 + manifest['style_index'] * 91 if mat.name == 'Skin' else 817 + ['Fabric', 'Hair', 'Leather', 'Metal'].index(mat.name)
            maps = surfaces.surfaces(args.output / 'textures', mat.name, seed)
            for node in mat.node_tree.nodes:
                if node.type != 'TEX_IMAGE':
                    continue
                key = next((key for key in maps if key in node.image.name), None)
                if key:
                    node.image = bpy.data.images.load(str(maps[key]), check_existing=True)
                    node.image.colorspace_settings.name = 'sRGB' if key == 'BaseColor' else 'Non-Color'
            for node in mat.node_tree.nodes:
                if node.type == 'NORMAL_MAP':
                    node.inputs['Strength'].default_value = 0.8 if mat.name == 'Skin' else 0.65
        base = next((n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and 'BaseColor' in n.image.name), None)
        if base:
            mat.node_tree.links.new(base.outputs['Color'], shader.inputs['Base Color'])
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    pivot = bpy.data.objects['HeadPivot']
    pivot.select_set(True)
    pivot.parent.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(args.output / f"{manifest['name']}.glb"), export_format='GLB',
        use_selection=True, export_apply=True, export_extras=True, export_yup=True,
        export_texcoords=True, export_normals=True,
        export_tangents=pivot.parent.get('asset_revision') != 'oni-v1', export_materials='EXPORT',
        export_vertex_color='NAME', export_vertex_color_name='Pigment')
    print('RUNTIME_EXPORTED ' + manifest['name'], flush=True)
