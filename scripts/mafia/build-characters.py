"""Blender 5.2: refine original council blockouts and produce editable, textured assets.

Run using the commands in assets/mafia/README.md. No external models or textures.
"""
import argparse
import gzip
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree


parser = argparse.ArgumentParser()
parser.add_argument('--source', default='/tmp/opencode/mafia-blender-source')
parser.add_argument('--output', required=True)
parser.add_argument('--only', type=int, nargs='+', help='One or more one-based character indices')
parser.add_argument('--samples', type=int, default=32)
parser.add_argument('--render-only', action='store_true', help='Refresh studio renders from saved projects')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
OUT = Path(args.output).resolve()
SIZE = 2048
SURFACES = ['Fabric', 'Skin', 'Hair', 'Leather', 'Metal', 'Eyes', 'SeatLight']


def save_image(path, rgb, color=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    image = bpy.data.images.new(path.stem, width=SIZE, height=SIZE, alpha=True)
    image.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    pixels = np.ones((SIZE, SIZE, 4), dtype=np.float32)
    pixels[:, :, :3] = rgb if rgb.ndim == 3 else rgb[:, :, None]
    image.pixels.foreach_set(pixels.ravel())
    image.filepath_raw = str(path)
    image.file_format = 'PNG'
    image.save()
    bpy.data.images.remove(image)


def texture_set(folder, kind, seed):
    """UV-tileable 2K base colour, roughness and tangent-space OpenGL normals."""
    paths = {key: folder / f'{kind}_{key}.png' for key in ['BaseColor', 'Roughness', 'Normal']}
    if all(p.exists() for p in paths.values()):
        return paths
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE
    noise = rng.random((SIZE, SIZE), dtype=np.float32)
    # Integer spatial frequencies keep opposite UV boundaries continuous.
    coarse = (np.sin(x * math.tau * 7) * np.cos(y * math.tau * 11) + np.cos((x + y) * math.tau * 13)) / 2
    if kind == 'Fabric':
        warp = np.sin(x * math.tau * 256)
        weft = np.sin(y * math.tau * 256)
        twill = np.sin((x - y) * math.tau * 64)
        height = (warp + weft) * 0.16 + twill * 0.08 + noise * 0.015
        base = 0.88 + height * 0.11 + coarse * 0.025
        rough = 0.76 + height * 0.1
        strength = 2.2
    elif kind == 'Skin':
        pore = np.sin(x * math.tau * 311 + np.sin(y * math.tau * 37)) * np.cos(y * math.tau * 283)
        height = pore * 0.13 + noise * 0.09
        base = 0.94 + coarse * 0.018 + noise * 0.018
        # Very sparse pigmentation, with different distributions for every identity.
        freckles = noise > 0.9993
        base[freckles] *= 0.82
        rough = 0.57 + coarse * 0.04 + noise * 0.05
        strength = 0.8
    elif kind == 'Hair':
        strand = np.sin(x * math.tau * 340 + np.sin(y * math.tau * 3) * 0.4)
        height = strand * 0.14 + np.sin(x * math.tau * 97) * 0.08
        base = 0.84 + strand * 0.09 + coarse * 0.035
        rough = 0.39 + strand * 0.08
        strength = 1.5
    elif kind == 'Leather':
        grain = np.sin(x * math.tau * 117 + np.sin(y * math.tau * 71)) * np.cos(y * math.tau * 103)
        height = grain * 0.12 + noise * 0.07
        base = 0.86 + grain * 0.035 + coarse * 0.03
        rough = 0.48 + grain * 0.07
        strength = 1.8
    else:
        brushed = np.sin(x * math.tau * 701) * 0.018 + noise * 0.01
        height = brushed
        base = 0.94 + coarse * 0.025
        rough = 0.27 + brushed * 2
        strength = 1.2
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength
    normal = np.stack([-dx, -dy, np.ones_like(dx)], axis=2)
    normal /= np.linalg.norm(normal, axis=2)[:, :, None]
    save_image(paths['BaseColor'], np.clip(base, 0, 1))
    save_image(paths['Roughness'], np.clip(rough, 0, 1), False)
    save_image(paths['Normal'], normal * 0.5 + 0.5, False)
    return paths


def image_node(nodes, path, location, non_color=False):
    image = bpy.data.images.load(str(path), check_existing=True)
    image.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    node = nodes.new('ShaderNodeTexImage')
    node.image = image
    node.label = path.stem
    node.location = location
    return node


def material(name, paths=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes.get('Principled BSDF')
    shader.location = (450, 100)
    pigment = nodes.new('ShaderNodeVertexColor')
    pigment.layer_name = 'Pigment'
    pigment.location = (-600, 300)
    if paths:
        base = image_node(nodes, paths['BaseColor'], (-600, 50))
        multiply = nodes.new('ShaderNodeMixRGB')
        multiply.blend_type = 'MULTIPLY'
        multiply.inputs[0].default_value = 1
        multiply.location = (0, 250)
        links.new(pigment.outputs['Color'], multiply.inputs[1])
        links.new(base.outputs['Color'], multiply.inputs[2])
        links.new(multiply.outputs['Color'], shader.inputs['Base Color'])
        rough = image_node(nodes, paths['Roughness'], (-600, -230), True)
        links.new(rough.outputs['Color'], shader.inputs['Roughness'])
        normal = image_node(nodes, paths['Normal'], (-600, -510), True)
        normal_map = nodes.new('ShaderNodeNormalMap')
        normal_map.location = (0, -250)
        normal_map.inputs['Strength'].default_value = {'Fabric': 0.45, 'Skin': 0.5, 'Hair': 0.4, 'Leather': 0.65, 'Metal': 0.5}[name]
        links.new(normal.outputs['Color'], normal_map.inputs['Color'])
        links.new(normal_map.outputs['Normal'], shader.inputs['Normal'])
        # Exporters understand direct image/vertex-colour multiplication through
        # COLOR_0 and the base-colour texture; see export_materials below.
    else:
        links.new(pigment.outputs['Color'], shader.inputs['Base Color'])
    if name == 'Skin':
        shader.inputs['Subsurface Weight'].default_value = 0.075
        shader.inputs['Subsurface Radius'].default_value = (1, 0.42, 0.2)
        shader.inputs['Subsurface Scale'].default_value = 0.035
        shader.inputs['Specular IOR Level'].default_value = 0.3
    elif name == 'Fabric':
        shader.inputs['Sheen Weight'].default_value = 0.22
        shader.inputs['Sheen Roughness'].default_value = 0.7
    elif name == 'Hair':
        shader.inputs['Anisotropic'].default_value = 0.35
        shader.inputs['Specular IOR Level'].default_value = 0.22
    elif name == 'Metal':
        shader.inputs['Metallic'].default_value = 0.82
    elif name == 'Eyes':
        shader.inputs['Roughness'].default_value = 0.18
        shader.inputs['Coat Weight'].default_value = 0.8
    elif name == 'SeatLight':
        links.new(pigment.outputs['Color'], shader.inputs['Emission Color'])
        shader.inputs['Emission Strength'].default_value = 1.3
    return mat


def mesh_from_source(part, group, mats):
    source_positions = np.asarray(part['positions'], dtype=np.float32).reshape(-1, 3)
    source_uv = np.asarray(part['uv'], dtype=np.float32).reshape(-1, 2)
    source_colors = np.asarray(part['colors'], dtype=np.float32).reshape(-1, 3) if part['colors'] else np.tile([0.28, 0.58, 0.8], (len(source_positions), 1))
    indices = np.asarray(part['indices'][group['start']:group['start'] + group['count']], dtype=np.int32).reshape(-1, 3)
    used, inverse = np.unique(indices, return_inverse=True)
    positions = source_positions[used][:, [0, 2, 1]].copy()
    positions[:, 1] *= -1  # Three.js Y-up -> Blender Z-up; preserves handedness.
    slot = group['materialIndex']
    mesh = bpy.data.meshes.new(f"{part['name']}_{SURFACES[slot]}")
    mesh.from_pydata(positions.tolist(), [], inverse.reshape(-1, 3).tolist())
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mats[slot])
    uv = mesh.uv_layers.new(name='SurfaceUV')
    uv.data.foreach_set('uv', source_uv[indices.ravel()].ravel())
    pigment = mesh.color_attributes.new(name='Pigment', type='FLOAT_COLOR', domain='POINT')
    rgba = np.ones((len(used), 4), dtype=np.float32)
    rgba[:, :3] = source_colors[used]
    pigment.data.foreach_set('color', rgba.ravel())
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj['surface'] = SURFACES[slot]
    obj['source_part'] = part['name']
    obj['head_part'] = part['head']
    obj['default_visible'] = not part['hidden']
    return obj


def active(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def weld_and_quad(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.000001)
    bmesh.ops.join_triangles(bm, faces=list(bm.faces), angle_face_threshold=0.7,
                            angle_shape_threshold=0.7, cmp_uvs=True, cmp_vcols=False)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def unify_skin(obj, head, name):
    """Voxel-weld ears, lips and fingers to their underlying skin, then relax."""
    active(obj)
    original = obj.data
    coords = np.empty(len(original.vertices) * 3, dtype=np.float32)
    original.vertices.foreach_get('co', coords)
    coords = coords.reshape(-1, 3)
    colors = np.empty(len(original.vertices) * 4, dtype=np.float32)
    original.color_attributes['Pigment'].data.foreach_get('color', colors)
    colors = colors.reshape(-1, 4)
    tree = KDTree(len(coords))
    for i, co in enumerate(coords):
        tree.insert(co, i)
    tree.balance()
    modifier = obj.modifiers.new('Unified anatomical skin', 'REMESH')
    modifier.mode = 'VOXEL'
    modifier.voxel_size = 0.0032 if head else 0.0038
    modifier.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    relax = obj.modifiers.new('Skin surface relaxation', 'SMOOTH')
    relax.factor = 0.65
    relax.iterations = 3
    bpy.ops.object.modifier_apply(modifier=relax.name)
    mesh = obj.data
    for layer in list(mesh.color_attributes):
        mesh.color_attributes.remove(layer)
    pigment = mesh.color_attributes.new(name='Pigment', type='FLOAT_COLOR', domain='POINT')
    rgba = np.ones((len(mesh.vertices), 4), dtype=np.float32)
    for i, vertex in enumerate(mesh.vertices):
        _, source, _ = tree.find(vertex.co)
        color = colors[source].copy()
        if head:
            x, y, z = vertex.co
            front = max(0, min(1, (-y - 0.025) / 0.1))
            blush = math.exp(-((abs(x) - 0.09) / 0.045) ** 2 - ((z - 1.75) / 0.05) ** 2) * front
            color[:3] *= [1 + blush * 0.035, 1 - blush * 0.08, 1 - blush * 0.065]
            # Fine crow's-feet sculpting for the older identities, independent of roles.
            if name in {'veteran', 'sentinel'} and abs(x) > 0.09 and y < -0.075 and 1.76 < z < 1.86:
                crease = math.sin((z + abs(x) * 0.3) * 420) ** 10
                vertex.co.y += crease * 0.0008 * front
            if name in {'veteran', 'sentinel'} and 1.59 < z < 1.695:
                # Pigmented stubble lies on the skin instead of detached hair spikes.
                edge = max(0, 1 - abs(x) / 0.13)
                mouth_clearance = 1 - math.exp(-(x / 0.052) ** 2 - ((z - 1.66) / 0.017) ** 2)
                grain = (math.sin(x * 1253 + z * 1781) * math.sin(z * 2137)) ** 8
                amount = front * edge * mouth_clearance * (0.10 + grain * 0.23)
                beard = np.array([0.35, 0.37, 0.4]) if name == 'veteran' else np.array([0.025, 0.026, 0.035])
                color[:3] = color[:3] * (1 - amount) + beard * amount
            # Individual jaw/chin silhouettes, sculpted below the eye rig.
            jaw_width = {'vanguard': 0.18, 'liaison': -0.07, 'veteran': 0.12,
                         'ember': -0.03, 'analyst': -0.02, 'navigator': 0.08,
                         'nightfall': -0.06, 'sentinel': 0.2, 'courier': -0.09,
                         'envoy': 0.02, 'silver': -0.08}[name]
            jaw = math.exp(-((z - 1.635) / 0.07) ** 2)
            vertex.co.x *= 1 + jaw_width * jaw
            chin = math.exp(-(x / 0.06) ** 2 - ((z - 1.605) / 0.035) ** 2) * front
            vertex.co.y -= chin * (0.008 + jaw_width * 0.03)
        rgba[i] = color
    pigment.data.foreach_set('color', rgba.ravel())
    # Remeshing changes topology; regenerate a unique, non-overlapping skin UV set.
    active(obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.1, island_margin=0.012)
    bpy.ops.object.mode_set(mode='OBJECT')
    for polygon in mesh.polygons:
        polygon.use_smooth = True


def refine(obj, name):
    slot = obj['surface']
    is_head = obj['source_part'] == 'sculpted-head'
    is_body = obj['source_part'].startswith('council-')
    if slot == 'Skin' and is_body and name in {'ember', 'nightfall'}:
        width = 0.91 if name == 'ember' else 0.9
        # Sculpt a continuous rounded deltoid over the blockout's tapered cap.
        # The neck, wrists and seated tabletop alignment are outside this region.
        for vertex in obj.data.vertices:
            x, y, z = vertex.co
            if abs(x) < 0.19 or z < 1.385 or abs(y) > 0.16:
                continue
            radial = ((abs(x) - 0.33 * width) / 0.145) ** 2 + (y / 0.135) ** 2
            target = 1.405 + 0.125 * math.sqrt(max(0, 1 - radial))
            blend = max(0, min(1, (z - 1.385) / 0.065))
            blend = blend * blend * (3 - 2 * blend)
            vertex.co.z = z * (1 - blend) + target * blend
    if slot == 'Hair' and is_head and name in {'veteran', 'sentinel'}:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        beard = [v for v in bm.verts if v.co.z < 1.70]
        bmesh.ops.delete(bm, geom=beard, context='VERTS')
        bm.to_mesh(obj.data)
        bm.free()
    if slot == 'Skin' and (is_head or is_body):
        unify_skin(obj, is_head, name)
    else:
        weld_and_quad(obj)
    if slot not in {'Eyes', 'SeatLight'}:
        sub = obj.modifiers.new('High-poly surface refinement', 'SUBSURF')
        sub.subdivision_type = 'CATMULL_CLARK'
        sub.levels = 1
        sub.render_levels = 1
        sub.uv_smooth = 'PRESERVE_BOUNDARIES'
    obj['uv_policy'] = 'unique smart-unwrapped skin' if slot == 'Skin' and (is_head or is_body) else 'intentional tiled surface UVs'


def studio():
    stage = bpy.data.collections.new('STUDIO - excluded from GLB')
    bpy.context.scene.collection.children.link(stage)
    def move(obj):
        for collection in list(obj.users_collection):
            collection.objects.unlink(obj)
        stage.objects.link(obj)
    bpy.ops.mesh.primitive_plane_add(size=200)
    plane = bpy.context.object
    plane.name = 'Studio floor'
    move(plane)
    mat = bpy.data.materials.new('Studio charcoal')
    mat.use_nodes = True
    mat.diffuse_color = (0.035, 0.045, 0.065, 1)
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = mat.diffuse_color
    mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.78
    plane.data.materials.append(mat)
    # Chair supports the council's intentionally seated pose in the presentation.
    for location, scale in [((0, 0, 0.54), (0.35, 0.30, 0.055)), ((0, 0.26, 1.01), (0.34, 0.055, 0.43))]:
        bpy.ops.mesh.primitive_cube_add(size=2, location=location)
        chair = bpy.context.object
        chair.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        chair.data.materials.append(mat)
        bevel = chair.modifiers.new('Upholstery edges', 'BEVEL')
        bevel.width, bevel.segments = 0.045, 5
        move(chair)
    for location, power, size, color in [((-3, -4, 5), 500, 4, (1, 0.85, 0.74)), ((3, -2, 3), 300, 3, (0.65, 0.8, 1)), ((0, 3, 4), 650, 2.5, (0.68, 0.8, 1))]:
        data = bpy.data.lights.new('Studio softbox', 'AREA')
        data.energy, data.shape, data.size, data.color = power, 'DISK', size, color
        obj = bpy.data.objects.new(data.name, data)
        stage.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector((0, 0, 1.2)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data = bpy.data.cameras.new('Portrait camera')
    camera = bpy.data.objects.new('Portrait camera', camera_data)
    stage.objects.link(camera)
    camera_data.type = 'ORTHO'
    bpy.context.scene.camera = camera
    return camera


def point_camera(camera, portrait):
    target = Vector((0, -0.08, 1.58 if portrait else 1.05))
    camera.location = (1.8, -5, 2.25 if portrait else 2.6)
    camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.ortho_scale = 1.35 if portrait else 2.48


def export_materials(mats):
    """Use glTF's standard texture * COLOR_0 expression, preserving Blender's look."""
    restored = []
    for mat in mats:
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        shader = nodes.get('Principled BSDF')
        base = next((n for n in nodes if n.type == 'TEX_IMAGE' and n.image.name.endswith('BaseColor.png')), None)
        if base:
            old = shader.inputs['Base Color'].links[0].from_socket
            restored.append((mat, old))
            links.new(base.outputs['Color'], shader.inputs['Base Color'])
    return restored


def build(path):
    source = json.loads(gzip.decompress(path.read_bytes()))
    name, index = source['name'], source['index']
    destination = OUT / f'{index + 1:02d}-{name}'
    destination.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 8
    scene.render.resolution_x, scene.render.resolution_y = 800, 1000
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('Studio world')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.14, 0.18, 0.25, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.3
    scene.world = world
    sets = {kind: texture_set(OUT / 'textures', kind, 817 + i) for i, kind in enumerate(['Fabric', 'Hair', 'Leather', 'Metal'])}
    sets['Skin'] = texture_set(destination / 'textures', 'Skin', 1201 + index * 91)
    mats = [material(kind, sets.get(kind)) for kind in SURFACES]
    root = bpy.data.objects.new(f'Character_{name.title()}', None)
    bpy.context.collection.objects.link(root)
    root['identity'] = name
    root['style_index'] = index
    root['license'] = 'MIT - original GameTable geometry and generated textures'
    pivot = bpy.data.objects.new('HeadPivot', None)
    bpy.context.collection.objects.link(pivot)
    pivot.parent = root
    pivot.location.z = source['headPivot']
    bpy.context.view_layer.update()
    objects = []
    for part in source['meshes']:
        for group in part['groups']:
            obj = mesh_from_source(part, group, mats)
            refine(obj, name)
            obj.parent = pivot if part['head'] else root
            obj.matrix_parent_inverse = obj.parent.matrix_world.inverted()
            if part['hidden']:
                obj.hide_render = True
                obj.scale = (0, 0, 0)
                obj['open_scale'] = [1, 1, 1]
            objects.append(obj)
    root['rig_notes'] = 'HeadPivot rotates the head. Open-eyes and closed-eyes parts are separately named. Closed lids have scale zero at rest; restore open_scale to close eyes and hide open-eye meshes.'
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    # Export only the character; all source modifiers remain editable in the blend.
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [root, pivot, *objects]:
        obj.select_set(True)
    restored = export_materials(mats)
    bpy.ops.export_scene.gltf(filepath=str(destination / f'{name}.glb'), export_format='GLB', use_selection=True,
                              export_apply=True, export_extras=True, export_yup=True,
                              export_texcoords=True, export_normals=True, export_materials='EXPORT',
                              export_vertex_color='NAME', export_vertex_color_name='Pigment')
    for mat, socket in restored:
        mat.node_tree.links.new(socket, mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    camera = studio()
    point_camera(camera, False)
    # Portable source projects: every referenced image is packed into each .blend.
    bpy.ops.file.pack_all()
    for image in bpy.data.images:
        if image.filepath:
            image.filepath = bpy.path.relpath(image.filepath, start=str(destination))
    scene['asset_manifest'] = json.dumps({'name': name, 'style_index': index, 'triangles': triangles, 'texture_size': SIZE})
    active(objects[0])
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_perspective = 'CAMERA'
    bpy.ops.wm.save_as_mainfile(filepath=str(destination / f'{name}.blend'))
    scene.render.filepath = str(destination / 'full-body.png')
    bpy.ops.render.render(write_still=True)
    point_camera(camera, True)
    scene.render.filepath = str(destination / 'portrait.png')
    bpy.ops.render.render(write_still=True)
    result = {'name': name, 'style_index': index, 'triangles': triangles, 'texture_resolution': [SIZE, SIZE],
              'blend': f'{name}.blend', 'glb': f'{name}.glb', 'pose': 'seated council', 'packed_textures': True}
    (destination / 'manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print('CHARACTER_COMPLETE ' + json.dumps(result), flush=True)


def render_existing(path):
    manifest = json.loads(path.read_text())
    destination = path.parent
    bpy.ops.wm.open_mainfile(filepath=str(destination / manifest['blend']))
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.cycles.samples = args.samples
    mat = bpy.data.materials['Studio charcoal']
    mat.use_nodes = True
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.035, 0.045, 0.065, 1)
    mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.78
    point_camera(scene.camera, False)
    bpy.ops.wm.save_as_mainfile(filepath=str(destination / manifest['blend']))
    scene.render.filepath = str(destination / 'full-body.png')
    bpy.ops.render.render(write_still=True)
    point_camera(scene.camera, True)
    scene.render.filepath = str(destination / 'portrait.png')
    bpy.ops.render.render(write_still=True)
    print('RENDER_COMPLETE ' + manifest['name'], flush=True)


OUT.mkdir(parents=True, exist_ok=True)
paths = sorted(OUT.glob('*/manifest.json') if args.render_only else Path(args.source).glob('*.json.gz'))
assert paths, 'No character sources found'
for path in paths:
    index = int((path.parent.name if args.render_only else path.name)[:2])
    if args.only is None or index in args.only:
        render_existing(path) if args.render_only else build(path)
