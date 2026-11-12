import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { COUNCIL_ASSETS, CouncilAssetLibrary } from './mafia-character-assets';
import { poseCouncilCharacter } from './mafia-characters';

const directory = new URL('../../../../assets/mafia/runtime/mafia-characters/', import.meta.url);
const base = 'https://gametable.test/mafia-characters/';
const libraries: CouncilAssetLibrary[] = [];

function library() {
  const result = new CouncilAssetLibrary(base);
  libraries.push(result);
  return result;
}

beforeEach(() => {
  vi.stubGlobal('ProgressEvent', class { constructor(readonly type: string) {} });
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    const relative = request.url.slice(base.length);
    return new Response(readFileSync(new URL(relative, directory)));
  }));
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  });
});

afterEach(() => {
  libraries.splice(0).forEach((entry) => entry.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shipped Blender council assets', () => {
  it('loads every high-fidelity identity with PBR surfaces and working night/eye poses', async () => {
    const assets = library();
    const identities = new Set<string>();
    const skinMaps = new Set<THREE.Texture>();
    for (const [style, name] of COUNCIL_ASSETS.entries()) {
      const character = (await assets.load({ id: `p${style}`, name, kind: 'human' }, style, new THREE.Color('red')))!;
      const staticCharacter = character.static === true;
      let triangles = 0;
      character.root.traverse((object) => {
        if (object.userData.identity) identities.add(object.userData.identity);
        if (!(object instanceof THREE.Mesh)) return;
        if (!staticCharacter) {
          expect(object.geometry.getAttribute('color')).toBeDefined();
        }
        expect(object.geometry.getAttribute('uv')).toBeDefined();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (!staticCharacter && materials.some((mat) => mat instanceof THREE.MeshStandardMaterial && mat.normalMap)) {
          expect(object.geometry.getAttribute('tangent')).toBeDefined();
        }
        triangles += object.geometry.index!.count / 3;
        expect(object.userData.seatId).toBe(`p${style}`);
      });
      expect(triangles).toBeGreaterThan(200000);
      expect(triangles).toBeLessThan(550000);

      if (staticCharacter) {
        expect(character.materials.length).toBeGreaterThan(0);
        const material = character.materials[0]!;
        expect(material.map).toBeTruthy();
        expect(material.normalMap).toBeTruthy();
        expect(material.roughnessMap).toBeTruthy();
        skinMaps.add(material.map!);
        expect(character.height).toBeCloseTo(1.9, 2);
        expect(character.head.position.y).toBeCloseTo(1.634, 2);
        expect(character.eyes.children.length).toBe(0);
        expect(character.closedEyes.children.length).toBe(0);
        poseCouncilCharacter(character, { asleep: false, eliminated: true, speaking: false, lookYaw: 1, elapsed: 1, delta: 0, still: true });
        expect(character.materials.every((mat) => mat.color.r === 0.42)).toBe(true);
        continue;
      }

      expect(character.materials.every((mat) => mat.vertexColors)).toBe(true);
      const skin = character.materials.find((mat) => mat.name === 'Skin')!;
      expect(skin.map).toBeTruthy();
      expect(skin.normalMap).toBeTruthy();
      expect(skin.roughnessMap).toBeTruthy();
      skinMaps.add(skin.map!);
      const fabric = character.materials.find((mat) => mat.name === 'Fabric') as THREE.MeshPhysicalMaterial;
      expect(fabric.sheenColor.r).toBeCloseTo(0.32);
      expect(character.height).toBeGreaterThan(1.8);
      expect(character.height).toBeLessThan(2.3);
      expect(character.head.position.y).toBeCloseTo(1.505, 3);
      expect(character.eyes.children.length).toBe(3);
      const lids = character.closedEyes.children[0]!;
      expect(lids.scale.length()).toBeCloseTo(Math.sqrt(3));
      const bounds = new THREE.Box3().setFromObject(character.eyes);
      expect(bounds.min.y).toBeGreaterThan(1.7);
      expect(bounds.max.y).toBeLessThan(2);
      poseCouncilCharacter(character, { asleep: true, eliminated: false, speaking: false, lookYaw: 1, elapsed: 1, delta: 0, still: true });
      expect(character.closedEyes.visible).toBe(true);
      expect(character.eyes.visible).toBe(false);
      expect(character.head.rotation.x).toBe(0.28);
      expect(character.head.rotation.y).toBe(0);
      poseCouncilCharacter(character, { asleep: false, eliminated: true, speaking: false, lookYaw: 1, elapsed: 1, delta: 0, still: true });
      expect(character.head.rotation.x).toBe(0.42);
      expect(character.materials.every((mat) => mat.color.r === 0.42)).toBe(true);
      poseCouncilCharacter(character, { asleep: false, eliminated: false, speaking: true, lookYaw: 1, elapsed: 1, delta: 0, still: true });
      expect(character.eyes.visible).toBe(true);
      expect(character.head.rotation.x).toBe(0);
      expect(character.head.rotation.y).toBe(0.35);
    }
    expect(identities).toEqual(new Set(COUNCIL_ASSETS));
    expect(skinMaps.size).toBe(11);
  });

  it('keeps seat lights and pose materials independent, and disposes once', async () => {
    const assets = library();
    const a = (await assets.load({ id: 'a', name: 'A', kind: 'human' }, 3, new THREE.Color('red')))!;
    const b = (await assets.load({ id: 'b', name: 'B', kind: 'human' }, 4, new THREE.Color('blue')))!;
    const fabricA = a.materials.find((mat) => mat.name === 'Fabric')!;
    const fabricB = b.materials.find((mat) => mat.name === 'Fabric')!;
    expect(fabricA).not.toBe(fabricB);
    expect(a.accent.color.getHex()).toBe(0xff0000);
    expect(b.accent.color.getHex()).toBe(0x0000ff);
    const disposed = vi.fn();
    fabricA.addEventListener('dispose', disposed);
    assets.dispose();
    assets.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(await assets.load({ id: 'c', name: 'C', kind: 'human' }, 2, new THREE.Color())).toBeNull();
  });

  it('discards a model that finishes loading after the scene was disposed', async () => {
    const assets = library();
    const pending = assets.load({ id: 'late', name: 'Late', kind: 'human' }, 0, new THREE.Color());
    assets.dispose();
    expect(await pending).toBeNull();
  });
});
