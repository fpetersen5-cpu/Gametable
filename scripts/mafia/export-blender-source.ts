/** Export the existing original blockouts, including UVs, pigment and head/eye separation. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { createCouncilCharacter } from '../../apps/desktop/renderer/components/mafia-characters';

const out = resolve(process.argv[2] ?? '/tmp/opencode/mafia-blender-source');
mkdirSync(out, { recursive: true });
for (let index = 0; index < 11; index++) {
  const character = createCouncilCharacter({ id: `asset-${index}`, name: `Character ${index}`, kind: 'human' }, index, new THREE.Color(0x8dc8e7));
  const name = character.mesh.name.split('-').at(-1)!;
  character.root.updateMatrixWorld(true);
  const meshes: object[] = [];
  character.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    meshes.push({
      name: object.name,
      head: object.parent === character.head,
      hidden: !object.visible,
      positions: Array.from(geometry.getAttribute('position').array),
      uv: Array.from(geometry.getAttribute('uv').array),
      colors: geometry.getAttribute('color') ? Array.from(geometry.getAttribute('color').array) : null,
      indices: Array.from(geometry.index!.array),
      groups: Array.isArray(object.material) ? geometry.groups : [{ start: 0, count: geometry.index!.count, materialIndex: 6 }],
    });
    geometry.dispose();
  });
  writeFileSync(resolve(out, `${String(index + 1).padStart(2, '0')}-${name}.json.gz`), gzipSync(JSON.stringify({ index, name, headPivot: character.head.position.y, meshes })));
  console.log(`Exported ${index + 1}: ${name}`);
}
