"""Refine the council sources into high-fidelity anime-cyberpunk operatives.

Run with Blender after build-characters.py. Dense anatomical surfaces and PBR
materials are preserved; tailored hard-surface detail is modeled in real geometry.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--only', type=int, nargs='+')
parser.add_argument('--samples', type=int, default=40)
parser.add_argument('--no-render', action='store_true')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])

FABRIC = {
    'vanguard': (0.055, 0.105, 0.18), 'liaison': (0.48, 0.50, 0.55),
    'veteran': (0.38, 0.41, 0.39), 'ember': (0.19, 0.035, 0.055),
    'analyst': (0.32, 0.39, 0.41), 'navigator': (0.15, 0.095, 0.27),
    'nightfall': (0.035, 0.15, 0.26), 'sentinel': (0.085, 0.105, 0.13),
    'courier': (0.32, 0.12, 0.19), 'envoy': (0.44, 0.46, 0.42),
    'silver': (0.09, 0.21, 0.33),
}
HAIR = {
    'vanguard': (0.012, 0.018, 0.035), 'liaison': (0.09, 0.025, 0.14),
    'veteran': (0.42, 0.48, 0.55), 'ember': (0.38, 0.025, 0.015),
    'analyst': (0.055, 0.08, 0.04), 'navigator': (0.42, 0.25, 0.06),
    'nightfall': (0.015, 0.09, 0.28), 'sentinel': (0.025, 0.03, 0.04),
    'courier': (0.18, 0.055, 0.12), 'envoy': (0.025, 0.04, 0.065),
    'silver': (0.50, 0.60, 0.70),
}


def active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply(obj, modifier):
    active(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def pigment(obj, color=None):
    attribute = obj.data.color_attributes.get('Pigment')
    if attribute is None:
        attribute = obj.data.color_attributes.new(name='Pigment', type='FLOAT_COLOR', domain='POINT')
    if color is not None:
        for item in attribute.data:
            item.color = (*color, 1)
    return attribute


def ensure_uv(obj, smart=False):
    if obj.data.uv_layers:
        return
    if smart:
        active(obj)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.015)
        bpy.ops.object.mode_set(mode='OBJECT')
    else:
        obj.data.uv_layers.new(name='SurfaceUV')


def tune_materials():
    for name in ['Fabric', 'Skin', 'Hair', 'Leather', 'Metal', 'Eyes']:
        mat = bpy.data.materials.get(name)
        if not mat:
            continue
        shader = mat.node_tree.nodes.get('Principled BSDF')
        if name == 'Skin':
            shader.inputs['Subsurface Weight'].default_value = 0.11
            shader.inputs['Subsurface Scale'].default_value = 0.028
            shader.inputs['Specular IOR Level'].default_value = 0.32
        elif name == 'Fabric':
            shader.inputs['Sheen Weight'].default_value = 0.32
            shader.inputs['Sheen Roughness'].default_value = 0.62
        elif name == 'Hair':
            shader.inputs['Anisotropic'].default_value = 0.55
            shader.inputs['Roughness'].default_value = 0.38
            shader.inputs['Specular IOR Level'].default_value = 0.3
        elif name == 'Leather':
            shader.inputs['Coat Weight'].default_value = 0.16
            shader.inputs['Coat Roughness'].default_value = 0.42
        elif name == 'Metal':
            shader.inputs['Metallic'].default_value = 0.78
        elif name == 'Eyes':
            shader.inputs['Coat Weight'].default_value = 1.0
            shader.inputs['Coat Roughness'].default_value = 0.08


def recolor(obj, name):
    surface = obj['surface']
    if surface not in {'Fabric', 'Hair', 'Leather', 'Metal'}:
        return
    attribute = pigment(obj)
    for item in attribute.data:
        old = item.color[:3]
        luminance = max(0.0, min(1.0, old[0] * 0.24 + old[1] * 0.57 + old[2] * 0.19))
        if surface == 'Fabric':
            base = FABRIC[name]
            shade = 0.68 + luminance * 0.58
            color = tuple(channel * shade for channel in base)
        elif surface == 'Hair' and obj['source_part'] == 'sculpted-head':
            base = HAIR[name]
            shade = 0.82 + luminance * 0.32
            color = tuple(channel * shade for channel in base)
        elif surface == 'Leather':
            shade = 0.72 + luminance * 0.32
            color = (0.025 * shade, 0.031 * shade, 0.043 * shade)
        elif surface == 'Metal':
            shade = 0.78 + luminance * 0.32
            color = (0.15 * shade, 0.19 * shade, 0.23 * shade)
        else:
            continue
        item.color = (*color, 1)


def sculpt_head(obj):
    if not obj.get('head_part'):
        return
    for vertex in obj.data.vertices:
        x, y, z = vertex.co
        if obj['source_part'] in {'open-eyes', 'closed-eyes'} and abs(x) > 0.005 and 1.73 < z < 1.88:
            center = 0.0575 if x > 0 else -0.0575
            vertex.co.x = center + (vertex.co.x - center) * 1.075
            vertex.co.z = 1.805 + (vertex.co.z - 1.805) * 1.055


def refine_hair(obj, name):
    for modifier in list(obj.modifiers):
        apply(obj, modifier)
    remesh = obj.modifiers.new('Continuous sculpted hair', 'REMESH')
    remesh.mode = 'VOXEL'
    remesh.voxel_size = 0.012
    remesh.use_smooth_shade = True
    apply(obj, remesh)
    smooth = obj.modifiers.new('Sculpted hair planes', 'SMOOTH')
    smooth.factor = 1.0
    smooth.iterations = 30
    apply(obj, smooth)
    ensure_uv(obj, smart=True)
    pigment(obj, HAIR[name])
    for face in obj.data.polygons:
        face.use_smooth = True
    sub = obj.modifiers.new('High-poly surface refinement', 'SUBSURF')
    sub.levels = 2
    sub.render_levels = 2


def finish_mesh(obj, root, surface, color, smart_uv=False, bevel=0):
    obj.parent = root
    obj.matrix_parent_inverse = root.matrix_world.inverted()
    obj.data.materials.append(bpy.data.materials[surface])
    obj['source_part'] = 'oni-tailored-detail'
    obj['surface'] = surface
    obj['head_part'] = False
    obj['default_visible'] = True
    obj['oni_generated'] = True
    ensure_uv(obj, smart=smart_uv)
    pigment(obj, color)
    if bevel:
        modifier = obj.modifiers.new('Precision rounded edges', 'BEVEL')
        modifier.width = bevel
        modifier.segments = 3
        modifier.harden_normals = True
        apply(obj, modifier)
    for face in obj.data.polygons:
        face.use_smooth = True
    if bevel:
        normal = obj.modifiers.new('Hard-surface normals', 'WEIGHTED_NORMAL')
        normal.keep_sharp = True
        normal.weight = 40
        apply(obj, normal)
    obj.data.validate()
    return obj


def plate(name, points, root, surface, color, thickness=0.018, bevel=0.005):
    count = len(points)
    vertices = list(points) + [(x, y + thickness, z) for x, y, z in points]
    faces = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    faces.extend((i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish_mesh(obj, root, surface, color, smart_uv=True, bevel=bevel)


def line(name, points, root, color, radius=0.0025, surface='Metal', cyclic=False):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 2
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for point, co in zip(spline.points, points):
        point.co = (*co, 1)
    spline.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    active(obj)
    bpy.ops.object.convert(target='MESH')
    return finish_mesh(bpy.context.object, root, surface, color)


def fastener(name, location, root, color):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.007, location=location)
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, root, 'Metal', color)


def add_tailoring(root, name, index, fabric):
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(fabric, depsgraph)
    def front(x, z, offset=0.022):
        hit, _, _, _ = bvh.ray_cast(Vector((x, -2, z)), Vector((0, 1, 0)))
        return (hit.y if hit is not None else -0.13) - offset
    base = FABRIC[name]
    armour = tuple(channel * 0.65 + 0.055 for channel in base)
    trim = (0.34, 0.27, 0.15) if index % 3 else (0.26, 0.34, 0.39)
    dark = (0.035, 0.045, 0.06)
    for side in (-1, 1):
        outline = [(0.035, 1.18), (0.18, 1.21), (0.218, 1.385), (0.12, 1.445), (0.035, 1.39)]
        points = [(side * x, front(side * x, z), z) for x, z in outline]
        plate(f'Layered chest armour {side}', points, root, 'Metal', armour, bevel=0.006)
        border = [(x, y - 0.006, z) for x, y, z in points]
        line(f'Titanium chest piping {side}', border, root, trim, radius=0.003, cyclic=True)
        for z in (1.25, 1.29, 1.33):
            chevron = [(0.075, z + 0.012), (0.115, z - 0.008), (0.155, z + 0.012)]
            line(f'Chest chevron {side} {z}', [(side * x, front(side * x, zz, 0.031), zz) for x, zz in chevron], root, trim, radius=0.0022)
        for x, z in [outline[1], outline[3]]:
            fastener('Recessed armour fastener', (side * x, front(side * x, z, 0.032), z), root, trim)
        if name not in {'ember', 'nightfall'}:
            for z in (1.235, 1.255):
                points = []
                for step in range(9):
                    x = side * (0.31 + step * 0.022)
                    points.append((x, front(x, z, 0.012), z))
                line('Tailored sleeve seam', points, root, dark, radius=0.0024, surface='Leather')
    for side in (-1, 1):
        collar = [(0.055, 1.475), (0.072, 1.42), (0.105, 1.36)]
        line('Layered collar edge', [(side * x, front(side * x, z, 0.015), z) for x, z in collar], root, trim, radius=0.0032)
    if name not in {'ember', 'nightfall'}:
        side = -1 if index % 2 == 0 else 1
        x = side * 0.37
        hit, _, _, _ = bvh.ray_cast(Vector((x, 0, 3)), Vector((0, 0, -1)))
        top = (hit.z if hit is not None else 1.50) - 0.028
        shoulder = [
            (x - 0.13, -0.13, top), (x + 0.13, -0.13, top),
            (x + 0.15, 0.10, top - 0.025), (x - 0.12, 0.12, top - 0.015),
            (x - 0.10, -0.10, top + 0.045), (x + 0.10, -0.10, top + 0.045),
            (x + 0.11, 0.08, top + 0.028), (x - 0.09, 0.09, top + 0.03),
        ]
        mesh = bpy.data.meshes.new('Fitted asymmetric pauldron')
        mesh.from_pydata(shoulder, [], [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
        mesh.update()
        obj = bpy.data.objects.new('Fitted asymmetric pauldron', mesh)
        bpy.context.collection.objects.link(obj)
        finish_mesh(obj, root, 'Metal', armour, smart_uv=True, bevel=0.008)
        line('Pauldron inset trim', shoulder[4:] + [shoulder[4]], root, trim, radius=0.003)
    z = 1.34
    y = front(0, z, 0.025)
    strip = [(-0.007, y, z - 0.055), (0.007, y, z - 0.055), (0.007, y, z + 0.055), (-0.007, y, z + 0.055)]
    plate('Inset operative light', strip, root, 'SeatLight', (0.2, 0.75, 1.0), thickness=0.008, bevel=0.003)
    for dz in (-0.069, 0.069):
        line('Operative light bezel', [(-0.013, y, z + dz), (0.013, y, z + dz)], root, trim, radius=0.003)


def add_brows(pivot, name, head):
    bpy.context.view_layer.update()
    bvh = BVHTree.FromObject(head, bpy.context.evaluated_depsgraph_get())
    for side in (-1, 1):
        points = []
        for step in range(7):
            t = step / 6
            x = side * (0.022 + t * 0.075)
            z = 1.845 + math.sin(t * math.pi) * 0.012 - t * 0.004
            hit, _, _, _ = bvh.ray_cast(Vector((x, -2, z)), Vector((0, 1, 0)))
            y = (hit.y if hit is not None else -0.12) - 0.004
            points.append((x, y, z))
        brow = line('Sculpted eyebrow', points, pivot, HAIR[name], radius=0.0032, surface='Hair')
        brow['head_part'] = True
        brow['source_part'] = 'oni-brows'


def build(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    name = manifest['name']
    index = manifest['style_index']
    folder = manifest_path.parent
    bpy.ops.wm.open_mainfile(filepath=str(folder / manifest['blend']))
    bpy.context.preferences.filepaths.save_version = 0
    root = bpy.data.objects[f'Character_{name.title()}']
    for obj in list(bpy.data.objects):
        if obj.get('oni_generated'):
            bpy.data.objects.remove(obj, do_unlink=True)
    tune_materials()
    objects = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'source_part' in obj]
    for obj in objects:
        if obj['surface'] == 'Hair' and obj['source_part'] == 'sculpted-head':
            refine_hair(obj, name)
        sculpt_head(obj)
        recolor(obj, name)
    fabric = next(obj for obj in objects if obj['surface'] == 'Fabric' and obj['source_part'].startswith('council-'))
    add_tailoring(root, name, index, fabric)
    head = next(obj for obj in objects if obj['surface'] == 'Skin' and obj['source_part'] == 'sculpted-head')
    add_brows(bpy.data.objects['HeadPivot'], name, head)
    root['art_direction'] = 'High-fidelity anime operative with layered tailoring and PBR surfaces'
    root['asset_revision'] = 'oni-v2'
    objects = [obj for obj in bpy.data.objects if obj.type == 'MESH' and 'source_part' in obj]
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    bpy.ops.object.select_all(action='DESELECT')
    pivot = bpy.data.objects['HeadPivot']
    for obj in [root, pivot, *objects]:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(folder / f'{name}.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_extras=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=True, export_materials='EXPORT',
        export_vertex_color='NAME', export_vertex_color_name='Pigment')
    scene = bpy.context.scene
    scene.cycles.samples = args.samples
    scene['asset_manifest'] = json.dumps({'name': name, 'style_index': index, 'triangles': triangles, 'texture_size': 2048, 'art_direction': 'oni-v2'})
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(folder / f'{name}.blend'))
    if not args.no_render:
        scene.render.filepath = str(folder / 'full-body.png')
        bpy.ops.render.render(write_still=True)
        camera = scene.camera
        target = Vector((0, -0.08, 1.59))
        camera.location = (1.55, -5, 2.22)
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        camera.data.ortho_scale = 1.25
        scene.render.filepath = str(folder / 'portrait.png')
        bpy.ops.render.render(write_still=True)
    manifest.update({
        'triangles': triangles, 'texture_resolution': [2048, 2048], 'packed_textures': True,
        'art_direction': 'oni-v2', 'blend': f'{name}.blend', 'glb': f'{name}.glb',
    })
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'ONI_QUALITY_COMPLETE {name}: {triangles:,} source triangles', flush=True)


paths = sorted(args.source.glob('*/manifest.json'))
assert paths, 'No character sources found'
for path in paths:
    manifest = json.loads(path.read_text())
    if args.only is None or manifest['style_index'] + 1 in args.only:
        build(path)
