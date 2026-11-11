import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { SeatInfo } from '../../shared/api';
import type { CouncilCharacterRig } from './mafia-characters';

export const COUNCIL_ASSETS = [
  'vanguard', 'liaison', 'veteran', 'ember', 'analyst', 'navigator',
  'nightfall', 'sentinel', 'courier', 'envoy', 'silver',
] as const;

/** Adapt Blender's multi-surface eye rig without changing its local transforms. */
export function bindCouncilAsset(root: THREE.Group, seat: SeatInfo, color: THREE.Color): CouncilCharacterRig {
  const head = root.getObjectByName('HeadPivot');
  if (!head) throw new Error('Character asset has no HeadPivot');
  const eyes = new THREE.Group();
  const closedEyes = new THREE.Group();
  const open: THREE.Object3D[] = [];
  const closed: THREE.Object3D[] = [];
  const materials = new Set<THREE.MeshStandardMaterial>();
  let accent: THREE.MeshStandardMaterial | undefined;
  root.traverse((object) => {
    object.userData.seatId = seat.id;
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = object.receiveShadow = true;
    if (object.userData.source_part === 'open-eyes') open.push(object);
    if (object.userData.source_part === 'closed-eyes') {
      object.scale.fromArray(object.userData.open_scale ?? [1, 1, 1]);
      closed.push(object);
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (object.userData.surface === 'SeatLight') {
        accent = material;
        material.vertexColors = false;
        material.color.copy(color);
        material.emissive.copy(color);
      } else materials.add(material);
    }
  });
  if (!open.length || !closed.length || !accent) throw new Error('Character asset has an incomplete eye/light rig');
  head.add(eyes, closedEyes);
  root.updateMatrixWorld(true);
  for (const object of open) eyes.attach(object);
  for (const object of closed) closedEyes.attach(object);
  closedEyes.visible = false;
  root.updateMatrixWorld(true);
  const height = new THREE.Box3().setFromObject(root).max.y;
  root.name = `character-${seat.id}`;
  let hash = 2166136261;
  for (let index = 0; index < seat.id.length; index++) hash = Math.imul(hash ^ seat.id.charCodeAt(index), 16777619);
  return { root, head, eyes, closedEyes, accent, materials: [...materials], height, motionOffset: (hash >>> 0) % 1000 / 100 };
}

/** Scene-owned assets. Shared maps are uploaded once, and survive individual seats. */
export class CouncilAssetLibrary {
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private readonly ownedTextures = new Set<THREE.Texture>();
  private readonly roots = new Set<THREE.Group>();
  private disposed = false;

  constructor(private readonly baseURL: string, private readonly anisotropy = 4) {}

  async load(seat: SeatInfo, style: number, color: THREE.Color): Promise<CouncilCharacterRig | null> {
    if (this.disposed) return null;
    const name = COUNCIL_ASSETS[style];
    if (!name) throw new Error(`Unknown character style: ${style}`);
    const loader = new GLTFLoader();
    loader.register((parser) => ({
      name: 'GAMETABLE_shared_textures',
      loadTexture: (index: number) => {
        const definition = parser.json.textures[index];
        const image = parser.json.images[definition.source];
        return this.texture(new URL(image.uri, this.baseURL).href);
      },
    }));
    const gltf = await loader.loadAsync(new URL(`${name}.gltf`, this.baseURL).href);
    if (this.disposed) {
      disposeModel(gltf.scene);
      return null;
    }
    this.roots.add(gltf.scene);
    return bindCouncilAsset(gltf.scene, seat, color);
  }

  private texture(url: string): Promise<THREE.Texture> {
    let pending = this.textures.get(url);
    if (!pending) {
      pending = new Promise<THREE.Texture>((resolve, reject) => {
        const texture = new THREE.TextureLoader().load(url, (loaded) => {
          if (this.disposed) loaded.dispose();
          resolve(loaded);
        }, undefined, () => reject(new Error(`Could not load character texture: ${url}`)));
        texture.flipY = false;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = this.anisotropy;
        this.ownedTextures.add(texture);
      });
      this.textures.set(url, pending);
    }
    return pending;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const root of this.roots) {
      root.removeFromParent();
      disposeModel(root);
    }
    for (const texture of this.ownedTextures) texture.dispose();
    this.roots.clear();
    this.textures.clear();
    this.ownedTextures.clear();
    // In-flight file/image requests may finish after unmount. Their callbacks
    // release late resources; no global Three.js cache crosses scene lifetimes.
  }
}

function disposeModel(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}
