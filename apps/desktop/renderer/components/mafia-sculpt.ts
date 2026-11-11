import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type Point = readonly [number, number, number];
export type Profile = readonly [height: number, width: number, depth: number, offset?: number];
export const SURFACE = { cloth: 0, skin: 1, hair: 2, leather: 3, metal: 4, eye: 5 } as const;
type Surface = typeof SURFACE[keyof typeof SURFACE];

/** Smooth, genuinely subdivided garment/skin surface, with optional sculpt displacement. */
export function loft(profile: readonly Profile[], around = 48, rows = 48,
  sculpt?: (point: THREE.Vector3, angle: number, t: number) => void): THREE.BufferGeometry {
  const shape = new THREE.CatmullRomCurve3(profile.map(([y, w, d]) => new THREE.Vector3(w, y, d)), false, 'centripetal');
  const offsets = new THREE.CatmullRomCurve3(profile.map(([y, , , z = 0]) => new THREE.Vector3(z, y, 0)), false, 'centripetal');
  return surface(rows, around, (u, v) => {
    const p = shape.getPoint(u);
    const angle = v * Math.PI * 2;
    const point = new THREE.Vector3(Math.cos(angle) * Math.max(0.001, p.x), p.y,
      Math.sin(angle) * Math.max(0.001, p.z) + offsets.getPoint(u).x);
    sculpt?.(point, angle, u);
    return point;
  }, true);
}

/** Tapered swept anatomy/fabric. A single surface spans the elbow or knee. */
export function sweep(points: readonly Point[], radii: readonly number[], radial = 24, steps = 40,
  flatten = 1, folds = 0): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  const thickness = new THREE.CatmullRomCurve3(radii.map((radius, i) => new THREE.Vector3(radius, i, 0)), false, 'catmullrom', 0.5);
  const frames = curve.computeFrenetFrames(steps, false);
  return surface(steps, radial, (u, v) => {
    // Frenet frames are sampled by arc length. Match their centerline positions;
    // parameter-space positions twist cross-sections on uneven elbow/hair curves.
    const t = curve.getUtoTmapping(u, 0);
    const radius = Math.max(0.0001, thickness.getPoint(t).x);
    const row = Math.round(u * steps);
    const angle = -v * Math.PI * 2;
    const fold = 1 + folds * Math.sin(u * Math.PI * 18 + Math.cos(angle) * 2) * Math.sin(u * Math.PI);
    return curve.getPoint(t)
      .addScaledVector(frames.normals[row]!, Math.cos(angle) * radius * fold)
      .addScaledVector(frames.binormals[row]!, Math.sin(angle) * radius * flatten * fold);
  }, true);
}

function surface(rows: number, columns: number, point: (u: number, v: number) => THREE.Vector3, caps: boolean): THREE.BufferGeometry {
  const positions: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      positions.push(...point(row / rows, col / columns).toArray());
      uv.push(col / columns, row / rows);
    }
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      const b = a + 1;
      indices.push(a, a + columns + 1, b, b, a + columns + 1, b + columns + 1);
    }
  }
  if (caps) for (const row of [0, rows]) {
    const center = new THREE.Vector3();
    for (let col = 0; col < columns; col++) center.add(point(row / rows, col / columns));
    center.divideScalar(columns);
    const index = positions.length / 3;
    positions.push(...center.toArray());
    uv.push(0.5, row / rows);
    for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col;
      indices.push(...(row === 0 ? [index, a, a + 1] : [index, a + 1, a]));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Average duplicated seam normals without welding the UV seam.
  const normals = geometry.getAttribute('normal');
  for (let row = 0; row <= rows; row++) {
    const a = row * (columns + 1);
    const b = a + columns;
    const normal = new THREE.Vector3().fromBufferAttribute(normals, a)
      .add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, normal.x, normal.y, normal.z);
    normals.setXYZ(b, normal.x, normal.y, normal.z);
  }
  return geometry;
}

/** Material-batched indexed geometry: density does not multiply draw calls. */
export class Sculpt {
  private readonly parts = new Map<Surface, THREE.BufferGeometry[]>();

  add(geometry: THREE.BufferGeometry, color: number, surface: Surface = SURFACE.cloth,
    position: Point = [0, 0, 0], rotation: Point = [0, 0, 0]): void {
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
    if (!geometry.getAttribute('uv')) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 2), 2));
    if (!geometry.index) {
      const indexed = mergeVertices(geometry);
      geometry.dispose();
      geometry = indexed;
    }
    const tint = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const bucket = this.parts.get(surface) ?? [];
    bucket.push(geometry);
    this.parts.set(surface, bucket);
  }

  oval(at: Point, scale: Point, color: number, surface: Surface = SURFACE.cloth, rotation: Point = [0, 0, 0]): void {
    this.add(new THREE.SphereGeometry(1, 32, 20).scale(...scale), color, surface, at, rotation);
  }

  box(at: Point, size: Point, color: number, surface: Surface = SURFACE.cloth, rotation: Point = [0, 0, 0]): void {
    this.add(new RoundedBoxGeometry(...size, 4, Math.min(...size) * 0.24), color, surface, at, rotation);
  }

  curve(points: readonly Point[], radius: number, color: number, surface: Surface = SURFACE.cloth, endRadius = radius): void {
    this.add(sweep(points, [radius, endRadius], 10, 24), color, surface);
  }

  finish(): THREE.BufferGeometry {
    const surfaces = [...this.parts.entries()].sort(([a], [b]) => a - b);
    const batches = surfaces.map(([, parts]) => mergeGeometries(parts)!);
    const merged = mergeGeometries(batches, true);
    for (const [, parts] of surfaces) parts.forEach((part) => part.dispose());
    batches.forEach((batch) => batch.dispose());
    this.parts.clear();
    if (!merged) throw new Error('Could not assemble sculpted council mesh');
    merged.groups.forEach((group, index) => { group.materialIndex = surfaces[index]![0]; });
    return merged;
  }
}

export function createCharacterMaterials(): THREE.MeshStandardMaterial[] {
  const fabric = microNormal('fabric');
  const pores = microNormal('skin');
  return [
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, normalMap: fabric, normalScale: new THREE.Vector2(0.16, 0.16) }),
    new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.68, normalMap: pores, normalScale: new THREE.Vector2(0.06, 0.06), sheen: 0.18, sheenColor: new THREE.Color(0xdb9d8e) }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, normalMap: fabric, normalScale: new THREE.Vector2(0.08, 0.08) }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.78 }),
    new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 }),
  ];
}

function microNormal(kind: 'fabric' | 'skin'): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    data[i] = 128 + Math.round((kind === 'fabric' ? Math.sin(x * Math.PI / 2) * 38 : Math.sin(x * 17 + y * 53) * 23));
    data[i + 1] = 128 + Math.round((kind === 'fabric' ? Math.cos(y * Math.PI / 2) * 38 : Math.cos(x * 31 + y * 7) * 23));
    data[i + 2] = 250;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(kind === 'fabric' ? 8 : 3, kind === 'fabric' ? 8 : 3);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
