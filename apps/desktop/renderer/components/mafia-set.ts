import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** Original corporate-security set dressing inspired by the supplied visual direction. */
export function buildCouncilSet(scene: THREE.Scene, cutaway: THREE.Group[]): THREE.Group[] {
  const metal = new THREE.MeshStandardMaterial({ color: 0x202936, roughness: 0.46, metalness: 0.68 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x111925, roughness: 0.72, metalness: 0.35 });
  const glass = new THREE.MeshBasicMaterial({ color: 0x31527b, transparent: true, opacity: 0.055, depthWrite: false });
  const warm = new THREE.MeshBasicMaterial({ color: 0xffc78c, transparent: true, opacity: 0.8, toneMapped: false });

  for (let index = 0; index < 8; index++) {
    const angle = Math.PI / 8 + index * Math.PI / 4;
    const group = new THREE.Group();
    group.position.set(Math.cos(angle) * 7.3, 0, Math.sin(angle) * 7.3);
    group.rotation.y = Math.atan2(-group.position.x, -group.position.z);

    const lower = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.7, 0.28, 3, 0.035), panel);
    lower.position.y = 0.35;
    lower.receiveShadow = true;
    group.add(lower);
    const window = new THREE.Mesh(new THREE.BoxGeometry(5.5, 4.6, 0.035), glass);
    window.position.set(0, 3, 0.03);
    group.add(window);
    for (const side of [-1, 1]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5.4, 0.32), metal);
      frame.position.set(side * 2.85, 2.7, 0);
      group.add(frame);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(5.9, 0.2, 0.35), metal);
    top.position.y = 5.35;
    group.add(top);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(5.45, 0.055, 0.08), warm);
    strip.position.set(0, 0.72, 0.19);
    group.add(strip);

    for (const x of [-1.4, 0, 1.4]) {
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.055, 4.65, 0.1), metal);
      mullion.position.set(x, 3, 0.08);
      group.add(mullion);
    }
    const ceilingStrip = strip.clone();
    ceilingStrip.position.y = 5.2;
    group.add(ceilingStrip);
    if (index === 5) {
      const plaque = new THREE.Mesh(new RoundedBoxGeometry(3.2, 3.6, 0.12, 3, 0.04), metal);
      plaque.position.set(0, 3, 0.14);
      group.add(plaque);
      const material = new THREE.MeshBasicMaterial({ map: councilInsignia(), transparent: true, opacity: 0.38, depthWrite: false });
      const insignia = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.25), material);
      insignia.position.set(0, 3.45, 0.22);
      group.add(insignia);
    }
    scene.add(group);
    cutaway.push(group);
  }

  const planterMaterial = new THREE.MeshStandardMaterial({ color: 0x29333c, roughness: 0.7, metalness: 0.35 });
  const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x294d43, roughness: 0.62, side: THREE.DoubleSide });
  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2;
    const plant = new THREE.Group();
    plant.position.set(Math.cos(angle) * 6.4, 0, Math.sin(angle) * 6.4);
    const planter = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.3, 0.6, 48), planterMaterial);
    planter.position.y = 0.32;
    plant.add(planter);
    for (let leaf = 0; leaf < 22; leaf++) {
      const geometry = new THREE.SphereGeometry(1, 16, 12).scale(0.075, 0.43, 0.012);
      const blade = new THREE.Mesh(geometry, leafMaterial);
      const a = leaf * 2.4;
      const spread = 0.12 + (leaf % 4) * 0.07;
      blade.position.set(Math.cos(a) * spread, 0.86 + (leaf % 5) * 0.12, Math.sin(a) * spread);
      blade.rotation.set(Math.sin(a) * 0.6, a, Math.cos(a) * 0.6);
      plant.add(blade);
    }
    scene.add(plant);
  }

  const ships: THREE.Group[] = [];
  for (let index = 0; index < 6; index++) {
    const ship = createSkyship(index);
    ship.userData.angle = index / 6 * Math.PI * 2;
    ship.userData.radius = 25 + index * 3.5;
    ship.userData.height = 8 + (index % 3) * 4;
    ship.userData.speed = 0.008 + index * 0.0015;
    scene.add(ship);
    ships.push(ship);
  }
  return ships;
}

export function animateCouncilShips(ships: THREE.Group[], elapsed: number): void {
  for (const ship of ships) {
    const angle = ship.userData.angle + elapsed * ship.userData.speed;
    const radius = ship.userData.radius;
    ship.position.set(Math.cos(angle) * radius, ship.userData.height + Math.sin(elapsed * 0.3 + angle) * 0.3, Math.sin(angle) * radius);
    ship.rotation.y = -angle;
  }
}

export function createHolographicCity(materials: THREE.MeshBasicMaterial[]): THREE.Group {
  const city = new THREE.Group();
  const random = mulberry32(928);
  const count = 26;
  const material = new THREE.MeshBasicMaterial({
    color: 0x4f83d8,
    wireframe: true,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    toneMapped: false,
  });
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, count);
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < count; index++) {
    const gridX = index % 7 - 3;
    const gridZ = Math.floor(index / 7) - 1.5;
    const height = 0.16 + random() * 0.68;
    const position = new THREE.Vector3(gridX * 0.45 + (random() - 0.5) * 0.1, 0.72 + height / 2, gridZ * 0.45 + (random() - 0.5) * 0.1);
    const scale = new THREE.Vector3(0.2 + random() * 0.16, height, 0.2 + random() * 0.16);
    matrix.compose(position, new THREE.Quaternion(), scale);
    blocks.setMatrixAt(index, matrix);
  }
  blocks.instanceMatrix.needsUpdate = true;
  city.add(blocks);
  materials.push(material);

  for (let index = 0; index < 4; index++) {
    const angle = index / 4 * Math.PI * 2 + Math.PI / 4;
    const panelMaterial = new THREE.MeshBasicMaterial({
      map: displayTexture(index),
      color: 0x8fa8ff,
      transparent: true,
      opacity: 0.48,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.52), panelMaterial);
    panel.position.set(Math.cos(angle) * 2.2, 1.02, Math.sin(angle) * 2.2);
    panel.rotation.set(-0.32, Math.atan2(panel.position.x, panel.position.z), 0);
    city.add(panel);
    materials.push(panelMaterial);
  }
  return city;
}

function createSkyship(index: number): THREE.Group {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x202b3a, roughness: 0.48, metalness: 0.7 });
  const light = new THREE.MeshBasicMaterial({ color: index % 2 ? 0xff596d : 0x7fb5ff, toneMapped: false });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.48), hull);
  group.add(body);
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.09, 1.25), hull);
    wing.position.set(side * 0.65, -0.04, 0);
    wing.rotation.y = side * 0.22;
    group.add(wing);
    const engine = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 4), light);
    engine.position.set(side * 0.7, 0, -0.62);
    group.add(engine);
  }
  return group;
}

function councilInsignia(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  context.strokeStyle = '#a9b9d2';
  context.lineWidth = 12;
  context.beginPath();
  context.moveTo(58, 48);
  context.lineTo(138, 128);
  context.lineTo(58, 208);
  context.moveTo(112, 48);
  context.lineTo(192, 128);
  context.lineTo(112, 208);
  context.stroke();
  context.fillStyle = '#a9b9d2';
  context.font = '600 31px system-ui';
  context.fillText('COUNCIL', 224, 112);
  context.font = '500 19px system-ui';
  context.fillText('NIGHTWATCH DIVISION', 224, 150);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function displayTexture(index: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 280;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'rgba(5, 20, 36, 0.72)';
  context.fillRect(0, 0, 512, 280);
  context.strokeStyle = '#b9d8ff';
  context.lineWidth = 4;
  context.strokeRect(7, 7, 498, 266);
  context.globalAlpha = 0.65;
  for (let row = 0; row < 7; row++) {
    context.fillStyle = row === index + 1 ? '#e0f2ff' : '#6f9dcc';
    context.fillRect(32, 40 + row * 29, 230 + ((row * 67 + index * 41) % 170), 7);
  }
  context.strokeStyle = '#8fc5ff';
  context.lineWidth = 3;
  context.beginPath();
  for (let x = 0; x < 7; x++) {
    const y = 215 - Math.sin(x * 1.4 + index) * 25;
    if (x === 0) context.moveTo(315 + x * 23, y);
    else context.lineTo(315 + x * 23, y);
  }
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
