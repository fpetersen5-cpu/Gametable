import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SeatInfo } from '../../shared/api';
import { characterStylesForSeats, createCouncilCharacter, poseCouncilCharacter } from './mafia-characters';
import { loft, sweep } from './mafia-sculpt';

const seats: SeatInfo[] = Array.from({ length: 11 }, (_, index) => ({
  id: `s${index + 1}`, name: 'Same model', modelId: 'local/repeated', kind: 'llm', alive: true,
}));

describe('council character meshes', () => {
  it('gives a full table distinct silhouettes, including duplicate models, independently of seat ordering and elimination', () => {
    const original = characterStylesForSeats(seats);
    expect(new Set(original.values()).size).toBe(11);
    const replay = characterStylesForSeats([...seats].reverse().map((seat) => ({ ...seat, alive: false })));
    expect([...replay]).toEqual([...original]);
    // Takeover changes the controller, not the visible identity.
    expect([...characterStylesForSeats(seats.map((seat) => ({ ...seat, kind: 'human' as const })))]).toEqual([...original]);
  });

  it('builds independently owned, finite, pickable meshes within the scene geometry budget', () => {
    const styles = characterStylesForSeats(seats);
    const characters = seats.map((seat) => createCouncilCharacter(seat, styles.get(seat.id)!, new THREE.Color(0x7dbbdb)));
    try {
      expect(new Set(characters.map((character) => character.mesh.geometry)).size).toBe(11);
      expect(new Set(characters.map((character) => character.mesh.material)).size).toBe(11);
      expect(new Set(characters.flatMap((character) => character.materials)).size).toBe(66);
      expect(new Set(characters.map((character) => character.materials[0]!.normalMap)).size).toBe(11);
      expect(new Set(characters.map((character) => character.accent)).size).toBe(11);
      const shapes = new Set<string>();
      let triangles = 0;
      let bytes = 0;
      for (const [index, character] of characters.entries()) {
        const { geometry } = character.mesh;
        const positions = geometry.getAttribute('position');
        for (const attribute of ['position', 'normal', 'color']) {
          expect(Array.from(geometry.getAttribute(attribute).array).every(Number.isFinite)).toBe(true);
          expect(geometry.getAttribute(attribute).count).toBe(positions.count);
        }
        let drawCalls = 0;
        character.root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          triangles += object.geometry.index!.count / 3;
          bytes += object.geometry.index!.array.byteLength;
          for (const name of Object.keys(object.geometry.attributes)) bytes += object.geometry.getAttribute(name).array.byteLength;
          if (object.visible) drawCalls += Array.isArray(object.material) ? object.geometry.groups.length : 1;
          for (const attribute of ['position', 'normal', 'uv']) {
            expect(Array.from(object.geometry.getAttribute(attribute).array as Float32Array).every(Number.isFinite)).toBe(true);
          }
        });
        const box = new THREE.Box3().setFromObject(character.root);
        expect(box.min.y).toBeGreaterThanOrEqual(-0.001);
        expect(box.max.y).toBeGreaterThan(2);
        expect(box.max.y).toBeLessThan(2.6);
        expect(Math.max(Math.abs(box.min.x), box.max.x)).toBeLessThan(0.85);
        expect(box.min.z).toBeGreaterThan(-0.4);
        expect(box.max.z).toBeLessThan(0.85);
        // Geometry differs, not just material colours or object UUIDs.
        shapes.add(JSON.stringify(Array.from(positions.array)));
        const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.8, 3), new THREE.Vector3(0, 0, -1));
        character.root.updateMatrixWorld(true);
        expect(ray.intersectObject(character.root, true)[0]?.object.userData.seatId).toBe(seats[index]!.id);
        // Dense surfaces are batched by PBR material, not one draw per finger/hair lock.
        expect(drawCalls).toBeLessThanOrEqual(14);
      }
      expect(shapes.size).toBe(11);
      expect(triangles).toBeGreaterThan(1_000_000);
      expect(triangles).toBeLessThan(2_000_000);
      expect(bytes).toBeLessThan(60 * 1024 * 1024);
    } finally {
      for (const character of characters) character.root.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => { material.normalMap?.dispose(); material.dispose(); });
        }
      });
    }
  });

  it('orients both lofted and swept surfaces outward for lighting and front-face picking', () => {
    const geometries = [loft([[0, 0.2, 0.2], [1, 0.2, 0.2]], 24, 24), sweep([[0, 0, 0], [0, 1, 0]], [0.2, 0.2], 24, 24)];
    for (const geometry of geometries) {
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      for (let col = 0; col < 24; col++) {
        const index = 12 * 25 + col;
        const outward = new THREE.Vector3(positions.getX(index), 0, positions.getZ(index)).normalize();
        expect(new THREE.Vector3().fromBufferAttribute(normals, index).dot(outward)).toBeGreaterThan(0.99);
      }
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      const hit = new THREE.Raycaster(new THREE.Vector3(0, 0.5, 1), new THREE.Vector3(0, 0, -1)).intersectObject(mesh)[0];
      expect(hit?.point.z).toBeCloseTo(0.2, 3);
      geometry.dispose();
      mesh.material.dispose();
    }
  });

  it('closes eyes at night, wakes at dawn and keeps reduced-motion poses static', () => {
    const character = createCouncilCharacter(seats[0]!, 0, new THREE.Color('cyan'));
    const pose = { asleep: true, eliminated: false, speaking: false, lookYaw: 0.3, elapsed: 1, delta: 0.016, still: true };
    poseCouncilCharacter(character, pose);
    expect(character.eyes.visible).toBe(false);
    expect(character.closedEyes.visible).toBe(true);
    expect(character.head.rotation.x).toBe(0.28);
    expect(character.head.rotation.y).toBe(0);
    character.root.updateMatrix();
    const sleeping = character.root.matrix.clone();
    poseCouncilCharacter(character, { ...pose, elapsed: 200 });
    character.root.updateMatrix();
    expect(character.root.matrix.equals(sleeping)).toBe(true);
    expect(character.root.position.y).toBe(0);
    poseCouncilCharacter(character, { ...pose, asleep: false });
    expect(character.eyes.visible).toBe(true);
    expect(character.closedEyes.visible).toBe(false);
    expect(character.head.rotation.x).toBe(0);
    expect(character.head.rotation.y).toBe(0.3);
    poseCouncilCharacter(character, { ...pose, asleep: false, eliminated: true });
    expect(character.eyes.visible).toBe(false);
    expect(character.head.rotation.x).toBe(0.42);
    expect(character.materials.every((material) => material.color.r === 0.42)).toBe(true);
    character.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    character.materials.forEach((material) => { material.normalMap?.dispose(); material.dispose(); });
    character.accent.dispose();
  });

  it('keeps curved cross-sections perpendicular to the centerline through uneven bends', () => {
    const geometry = sweep([[0, 0, 0], [0, 0.1, 0], [0.8, 0.4, 0], [1, 2, 0]], [0.02, 0.02], 24, 64);
    const positions = geometry.getAttribute('position');
    const centers = Array.from({ length: 65 }, (_, row) => {
      const center = new THREE.Vector3();
      for (let col = 0; col < 24; col++) center.add(new THREE.Vector3().fromBufferAttribute(positions, row * 25 + col));
      return center.divideScalar(24);
    });
    for (let row = 4; row < 61; row++) {
      const tangent = centers[row + 1]!.clone().sub(centers[row - 1]!).normalize();
      for (let col = 0; col < 24; col++) {
        const radial = new THREE.Vector3().fromBufferAttribute(positions, row * 25 + col).sub(centers[row]!).normalize();
        expect(Math.abs(radial.dot(tangent))).toBeLessThan(0.08);
      }
    }
    geometry.dispose();
  });
});
