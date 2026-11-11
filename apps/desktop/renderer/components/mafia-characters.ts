import * as THREE from 'three';
import type { SeatInfo } from '../../shared/api';
import { Sculpt, SURFACE as M, createCharacterMaterials, loft, sweep, type Point } from './mafia-sculpt';

interface CharacterStyle {
  name: string;
  jacket: number;
  trim: number;
  skin: number;
  hair: number;
  width: number;
  face: number;
  stature: number;
  cut: 'armour' | 'uniform' | 'sleeveless' | 'coat';
  hairstyle: 'swept' | 'bob' | 'crop' | 'ponytail' | 'waves' | 'braids';
}

/** Original identities based on the reference's tailored security-crew silhouettes. */
const STYLES: readonly CharacterStyle[] = [
  { name: 'Vanguard', jacket: 0x30394b, trim: 0x9d4445, skin: 0xb88765, hair: 0x171d29, width: 1.13, face: 1.06, stature: 1.03, cut: 'armour', hairstyle: 'swept' },
  { name: 'Liaison', jacket: 0xc2c2cd, trim: 0x796486, skin: 0xd5a487, hair: 0x39253e, width: 0.89, face: 0.93, stature: 0.98, cut: 'uniform', hairstyle: 'bob' },
  { name: 'Veteran', jacket: 0xa8acbb, trim: 0x5a647c, skin: 0xb88e70, hair: 0xa4a6af, width: 1.06, face: 1.02, stature: 1.02, cut: 'coat', hairstyle: 'crop' },
  { name: 'Ember', jacket: 0x282d3c, trim: 0xb04c4a, skin: 0xd4a081, hair: 0x8a302a, width: 0.91, face: 0.94, stature: 0.98, cut: 'sleeveless', hairstyle: 'ponytail' },
  { name: 'Analyst', jacket: 0xc0c6c6, trim: 0x5c7770, skin: 0xb68664, hair: 0x3e4437, width: 0.94, face: 0.98, stature: 1, cut: 'uniform', hairstyle: 'waves' },
  { name: 'Navigator', jacket: 0x3b3b50, trim: 0xaf925e, skin: 0xd9b494, hair: 0x9a784d, width: 1, face: 1, stature: 1.01, cut: 'coat', hairstyle: 'swept' },
  { name: 'Nightfall', jacket: 0x252f43, trim: 0x658ca6, skin: 0xa77254, hair: 0x18253f, width: 0.9, face: 0.94, stature: 0.99, cut: 'sleeveless', hairstyle: 'ponytail' },
  { name: 'Sentinel', jacket: 0x384653, trim: 0x9b7f5c, skin: 0x704b39, hair: 0x1d1e26, width: 1.1, face: 1.05, stature: 1.03, cut: 'armour', hairstyle: 'crop' },
  { name: 'Courier', jacket: 0x6b4f59, trim: 0xc0a6a0, skin: 0xd3a48b, hair: 0x794f60, width: 0.93, face: 0.95, stature: 0.97, cut: 'uniform', hairstyle: 'waves' },
  { name: 'Envoy', jacket: 0xb5bac2, trim: 0x777c9e, skin: 0x7c5844, hair: 0x252433, width: 0.91, face: 0.95, stature: 1.02, cut: 'coat', hairstyle: 'braids' },
  { name: 'Silver', jacket: 0x3c485e, trim: 0xadbcc9, skin: 0xd9b098, hair: 0xb8bac9, width: 0.92, face: 0.94, stature: 0.98, cut: 'uniform', hairstyle: 'bob' },
];

export interface CouncilCharacterRig {
  root: THREE.Group;
  materials: THREE.MeshStandardMaterial[];
  accent: THREE.MeshStandardMaterial;
  height: number;
  head: THREE.Object3D;
  eyes: THREE.Object3D;
  closedEyes: THREE.Object3D;
  motionOffset: number;
}

export interface CouncilCharacter extends CouncilCharacterRig {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
  head: THREE.Group;
  eyes: THREE.Mesh;
  closedEyes: THREE.Mesh;
}

/** Identity survives replays, controller takeover, elimination and array ordering. */
export function characterStylesForSeats(seats: readonly SeatInfo[]): Map<string, number> {
  const assigned = new Map<string, number>();
  const used = new Set<number>();
  for (const seat of [...seats].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    let style = hash(seat.modelId ?? seat.name) % STYLES.length;
    for (let tries = 0; used.has(style) && tries < STYLES.length; tries++) style = (style + 1) % STYLES.length;
    used.add(style);
    assigned.set(seat.id, style);
  }
  return assigned;
}

export function createCouncilCharacter(seat: SeatInfo, styleIndex: number, color: THREE.Color): CouncilCharacter {
  const s = STYLES[styleIndex % STYLES.length]!;
  const body = new Sculpt();
  const head = new Sculpt();
  const eyes = new Sculpt();
  const closed = new Sculpt();
  buildSeatedBody(body, s, styleIndex);
  sculptFace(head, eyes, closed, s);
  sculptHair(head, s);
  if (styleIndex === 4 || styleIndex === 9) addGlasses(head, s);
  const materials = createCharacterMaterials();
  // Head proportions vary; wrists remain on the same tabletop and feet on the floor.
  const geometry = body.finish();
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = `council-${seat.id}-${s.name.toLowerCase()}`;
  mesh.castShadow = mesh.receiveShadow = true;
  const pivot = 1.505;
  const headMesh = new THREE.Mesh(head.finish(), materials);
  headMesh.name = 'sculpted-head';
  headMesh.geometry.scale(1, s.stature, 1);
  headMesh.geometry.translate(0, pivot - 1.565 * s.stature, 0);
  headMesh.geometry.computeBoundingBox();
  const height = headMesh.geometry.boundingBox!.max.y;
  headMesh.geometry.translate(0, -pivot, 0);
  headMesh.castShadow = headMesh.receiveShadow = true;
  const makeEyes = (sculpt: Sculpt, name: string) => {
    const geometry = sculpt.finish();
    geometry.scale(1, s.stature, 1);
    geometry.translate(0, -1.565 * s.stature, 0);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = name;
    return mesh;
  };
  const openEyes = makeEyes(eyes, 'open-eyes');
  const lids = makeEyes(closed, 'closed-eyes');
  lids.visible = false;
  const headPivot = new THREE.Group();
  headPivot.name = 'head-pivot';
  headPivot.position.y = pivot;
  headPivot.add(headMesh, openEyes, lids);
  const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.65, roughness: 0.35, metalness: 0.45 });
  const light = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.055, 8, 16), accent);
  light.name = 'seat-pin';
  light.position.set(-0.23 * s.width, 1.32, 0.15);
  light.rotation.z = Math.PI / 2;
  const root = new THREE.Group();
  root.name = `character-${seat.id}`;
  root.add(mesh, light, headPivot);
  root.traverse((object) => { object.userData.seatId = seat.id; });
  return { root, mesh, materials, accent, height, head: headPivot, eyes: openEyes, closedEyes: lids, motionOffset: hash(seat.id) % 1000 / 100 };
}

function buildSeatedBody(body: Sculpt, s: CharacterStyle, index: number): void {
  const w = s.width;
  const leather = 0x151c27;
  const steel = 0x8a94a4;
  for (const side of [-1, 1]) {
    const x = side * 0.17 * w;
    body.add(sweep([[x, 0.72, -0.05], [x * 1.06, 0.65, 0.2], [x * 1.12, 0.57, 0.45], [x * 1.13, 0.3, 0.47], [x * 1.12, 0.12, 0.45]],
      [0.145, 0.145, 0.118, 0.09, 0.078], 32, 56, 0.92, 0.035), 0x242b38);
    body.box([x * 1.12, 0.075, 0.53], [0.19, 0.14, 0.33], leather, M.leather);
    body.box([x * 1.12, 0.017, 0.53], [0.2, 0.035, 0.35], 0x111722, M.leather);
    body.curve([[x - 0.05, 0.14, 0.47], [x, 0.145, 0.56], [x + 0.05, 0.14, 0.47]], 0.004, 0x596273, M.leather);
    body.curve([[x + side * 0.13, 0.71, 0], [x + side * 0.13, 0.62, 0.3], [x + side * 0.11, 0.49, 0.45]], 0.0035, 0x4c5362);
  }
  body.add(loft([[0.65, 0.23 * w, 0.19], [0.76, 0.28 * w, 0.21], [0.9, 0.24 * w, 0.16],
    [1.07, 0.25 * w, 0.16], [1.25, 0.31 * w, 0.19], [1.41, 0.33 * w, 0.16], [1.49, 0.23 * w, 0.115], [1.52, 0.11, 0.085]],
  64, 56, (p, a, t) => { p.z += Math.sin(a) * Math.sin(t * 30 + Math.cos(a) * 3) * 0.004 * Math.sin(t * Math.PI); }), s.jacket);
  body.add(loft([[1.47, 0.085, 0.075], [1.58, 0.08, 0.07], [1.7, 0.09, 0.08]], 40, 24), s.skin, M.skin);
  body.add(loft([[1.15, 0.07, 0.012, 0.174], [1.3, 0.09, 0.016, 0.182],
    [1.43, 0.11, 0.015, 0.137], [1.5, 0.06, 0.008, 0.07]], 32, 24), 0x222a3b);
  for (const side of [-1, 1]) {
    body.add(sweep([[side * 0.045, 1.21, 0.188], [side * 0.12, 1.39, 0.185], [side * 0.095, 1.55, 0.055]],
      [0.028, 0.048, 0.045], 20, 28, 0.3), s.cut === 'armour' ? leather : s.jacket);
    body.curve([[side * 0.07, 1.25, 0.202], [side * 0.147, 1.42, 0.18], [side * 0.11, 1.54, 0.06]], 0.003, s.trim);
    const front = (x: number) => 0.19 * Math.sqrt(Math.max(0, 1 - (x / (0.31 * w)) ** 2)) + 0.01;
    const pocket = new THREE.PlaneGeometry(0.105 * w, 0.115, 12, 12);
    const vertices = pocket.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      const x = vertices.getX(i) + side * 0.23 * w;
      vertices.setXYZ(i, x, vertices.getY(i) + 1.24, front(x));
    }
    pocket.computeVertexNormals();
    body.add(pocket, s.jacket);
    body.curve([0.18, 0.23, 0.28].map((x) => [side * x * w, 1.29, front(side * x * w) + 0.003] as Point), 0.002, s.trim);
  }
  body.add(loft([[0.82, 0.265 * w, 0.186], [0.875, 0.255 * w, 0.174]], 48, 8), leather, M.leather);
  body.box([0.025, 0.85, 0.19], [0.085, 0.055, 0.025], steel, M.metal);
  body.box([0.025, 0.85, 0.205], [0.05, 0.032, 0.008], leather, M.leather);
  body.curve([[0.055, 0.91, 0.172], [0.055, 1.1, 0.177], [0.045, 1.27, 0.19]], 0.004, steel, M.metal);
  for (let button = 0; button < 3; button++) body.oval([-0.055, 1.15 - button * 0.1, 0.177], [0.012, 0.012, 0.006], steel, M.metal);
  for (const side of [-1, 1]) {
    const elbow: Point = [side * (index % 3 === 0 ? 0.46 : 0.4) * w, 1.1, 0.27];
    const wrist: Point = [side * (index % 3 === 1 ? 0.14 : 0.27) * w, 1.205, 0.61];
    const bare = s.cut === 'sleeveless';
    // The rounded deltoid and arm are one surface, avoiding intersecting shoulder caps.
    body.add(sweep([[side * 0.31 * w, 1.53, 0], [side * 0.32 * w, 1.49, 0], [side * 0.34 * w, 1.405, 0],
      [side * 0.39 * w, 1.28, 0.12], elbow, [side * 0.34 * w, 1.13, 0.46], wrist],
    [0.003, 0.09, 0.125, 0.108, 0.09, 0.082, 0.055], 32, 64, 0.94, bare ? 0 : 0.045), bare ? s.skin : s.jacket, bare ? M.skin : M.cloth);
    if (s.cut === 'armour' || (side === -1 && !bare)) {
      body.box([side * 0.337 * w, 1.455, 0.005], [0.21, 0.07, 0.26], leather, M.leather, [0, 0, side * -0.28]);
      body.curve([[side * 0.25 * w, 1.47, 0.11], [side * 0.36 * w, 1.5, 0.13], [side * 0.45 * w, 1.42, 0.12]], 0.008, s.trim, M.leather);
    }
    body.add(sweep([[wrist[0], wrist[1] - 0.006, wrist[2] - 0.05], wrist], [0.059, 0.057], 24, 10), leather, M.leather);
    sculptHand(body, [wrist[0], 1.205, 0.665], s.skin, side);
  }
  if (s.cut === 'armour' || s.cut === 'sleeveless') {
    body.add(sweep([[-0.24 * w, 1.45, 0.15], [-0.1, 1.25, 0.21], [0.13, 0.94, 0.19]], [0.028, 0.028, 0.028], 16, 32, 0.18), leather, M.leather);
    body.box([0.02, 1.1, 0.233], [0.065, 0.06, 0.012], steel, M.metal, [0, 0, 0.6]);
  }
  if (s.cut === 'coat') for (const side of [-1, 1]) {
    body.add(sweep([[side * 0.23, 0.89, 0.05], [side * 0.25, 0.7, 0.26], [side * 0.26, 0.59, 0.43]], [0.065, 0.08, 0.025], 24, 32, 0.3, 0.08), s.jacket);
  }
  if (index % 2 === 0) {
    body.box([-0.29 * w, 0.85, 0.16], [0.11, 0.15, 0.065], leather, M.leather, [0, 0, -0.12]);
    body.box([-0.29 * w, 0.89, 0.2], [0.08, 0.022, 0.012], steel, M.metal);
  }
}

function sculptHand(body: Sculpt, at: Point, skin: number, side: number): void {
  const [x, y, z] = at;
  body.oval([x, y, z], [0.061, 0.032, 0.085], skin, M.skin, [-0.08, side * 0.12, 0]);
  const nails = new THREE.Color(skin).lerp(new THREE.Color(0xe4c4b4), 0.35).getHex();
  for (let finger = 0; finger < 4; finger++) {
    const dx = (finger - 1.5) * 0.027;
    const length = [0.077, 0.096, 0.09, 0.069][finger]!;
    body.add(sweep([[x + dx, y, z + 0.035], [x + dx * 1.07, y - 0.008, z + 0.08], [x + dx * 1.1, y - 0.025, z + 0.045 + length]],
      [0.016, 0.014, 0.01], 16, 20, 0.8), skin, M.skin);
    body.oval([x + dx * 1.1, y - 0.013, z + 0.035 + length], [0.008, 0.002, 0.012], nails, M.skin);
  }
  body.add(sweep([[x - side * 0.047, y, z - 0.015], [x - side * 0.085, y - 0.012, z + 0.018], [x - side * 0.085, y - 0.03, z + 0.06]],
    [0.021, 0.017, 0.012], 16, 20), skin, M.skin);
}

function sculptFace(head: Sculpt, eyes: Sculpt, closed: Sculpt, s: CharacterStyle): void {
  const w = s.face;
  const gaussian = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) => Math.exp(-(((x - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);
  head.add(loft([[1.645, 0.045 * w, 0.055, 0.01], [1.68, 0.09 * w, 0.095, 0.005],
    [1.75, 0.137 * w, 0.13], [1.84, 0.162 * w, 0.148], [1.94, 0.155 * w, 0.145, -0.008],
    [2.03, 0.138 * w, 0.126, -0.017], [2.085, 0.085 * w, 0.08, -0.025], [2.105, 0.003, 0.003, -0.025]],
  96, 96, (p, angle) => {
    const front = Math.max(0, Math.sin(angle)) ** 8;
    let d = 0.035 * gaussian(p.x, p.y, 0, 1.85, 0.024, 0.085);
    d += 0.061 * gaussian(p.x, p.y, 0, 1.79, 0.027, 0.029);
    d += 0.012 * gaussian(p.x, p.y, 0, 1.718, 0.057, 0.019);
    for (const side of [-1, 1]) {
      d -= 0.018 * gaussian(p.x, p.y, side * 0.073 * w, 1.883, 0.043, 0.026);
      d += 0.014 * gaussian(p.x, p.y, side * 0.092 * w, 1.8, 0.038, 0.042);
      d += 0.012 * gaussian(p.x, p.y, side * 0.028, 1.774, 0.014, 0.016);
      d += 0.01 * gaussian(p.x, p.y, side * 0.07 * w, 1.923, 0.047, 0.018);
    }
    p.z += d * front;
  }), s.skin, M.skin);
  const crease = new THREE.Color(s.skin).multiplyScalar(0.48).getHex();
  const lip = new THREE.Color(s.skin).lerp(new THREE.Color(0x915c58), 0.45).getHex();
  for (const side of [-1, 1]) {
    head.oval([side * 0.164 * w, 1.835, -0.012], [0.026, 0.054, 0.03], s.skin, M.skin, [0, side * 0.18, side * -0.1]);
    head.oval([side * 0.179 * w, 1.837, 0.003], [0.008, 0.03, 0.014], lip, M.skin);
    const x = side * 0.073 * w;
    eyes.oval([x, 1.883, 0.126], [0.034, 0.011, 0.019], 0xbcb9b2, M.eye);
    eyes.oval([x, 1.882, 0.143], [0.009, 0.01, 0.003], 0x47594f, M.eye);
    eyes.oval([x, 1.882, 0.146], [0.0045, 0.006, 0.0015], 0x101821, M.eye);
    eyes.oval([x - 0.003, 1.886, 0.148], [0.0015, 0.0015, 0.001], 0xffffff, M.eye);
    const top: Point[] = [[x - 0.035, 1.882, 0.13], [x - 0.016, 1.894, 0.143], [x + 0.016, 1.893, 0.143], [x + 0.035, 1.885, 0.13]];
    eyes.curve(top, 0.0035, s.skin, M.skin);
    eyes.curve([[x - 0.035, 1.882, 0.13], [x, 1.874, 0.143], [x + 0.035, 1.885, 0.13]], 0.0025, lip, M.skin);
    eyes.curve(top.map(([x, y, z]) => [x, y - 0.002, z + 0.001] as Point), 0.0012, s.hair, M.hair);
    closed.oval([x, 1.882, 0.129], [0.035, 0.014, 0.015], s.skin, M.skin);
    closed.curve([[x - 0.032, 1.882, 0.135], [x, 1.879, 0.145], [x + 0.032, 1.885, 0.135]], 0.0015, crease, M.skin);
    head.add(sweep([[x - 0.043, 1.921, 0.137], [x, 1.935, 0.151], [x + 0.04, 1.927, 0.134]], [0.004, 0.007, 0.002], 12, 28, 0.4), s.hair, M.hair);
    head.oval([side * 0.019, 1.769, 0.172], [0.008, 0.003, 0.005], crease, M.skin);
  }
  head.oval([0, 1.714, 0.122], [0.036, 0.007, 0.012], lip, M.skin);
  head.curve([[-0.036, 1.718, 0.12], [-0.016, 1.721, 0.13], [0, 1.718, 0.133], [0.016, 1.721, 0.13], [0.036, 1.718, 0.12]], 0.0015, lip, M.skin);
  head.curve([[-0.035, 1.717, 0.122], [0, 1.717, 0.135], [0.035, 1.717, 0.122]], 0.001, crease, M.skin);
  if (s.name === 'Veteran' || s.name === 'Sentinel') for (let i = 0; i < 32; i++) {
    const x = (i / 31 - 0.5) * 0.17;
    const y = 1.665 + Math.abs(x) * 0.36;
    const z = 0.104 - Math.abs(x) * 0.23;
    head.curve([[x, y + 0.035, z], [x * 0.95, y + 0.012, z + 0.008], [x * 0.9, y, z]], 0.002, s.hair, M.hair, 0.0005);
  }
}

function sculptHair(head: Sculpt, s: CharacterStyle): void {
  const w = s.face;
  const dark = new THREE.Color(s.hair);
  head.add(loft([[1.94, 0.153 * w, 0.141, -0.024], [2, 0.159 * w, 0.144, -0.025], [2.07, 0.126 * w, 0.118, -0.027], [2.12, 0.002, 0.002, -0.03]], 64, 40,
    (p, a, t) => { p.y += Math.max(0, Math.sin(a)) * 0.055 * (1 - t) ** 3; }), s.hair, M.hair);
  const count = s.hairstyle === 'crop' ? 28 : 38;
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const front = Math.max(0, sa);
    const color = dark.clone().multiplyScalar(0.78 + (i % 5) * 0.09).getHex();
    const start: Point = [ca * 0.055, 2.1 + Math.sin(i * 1.3) * 0.012, -0.025 + sa * 0.045];
    let end: Point;
    let middle: Point;
    if (s.hairstyle === 'bob' || s.hairstyle === 'braids') {
      middle = [ca * 0.171 * w, 2.035, sa * 0.15 - 0.02];
      end = [ca * 0.175 * w, front > 0.5 ? 1.96 - (i % 3) * 0.018 : 1.72, sa * 0.14 - 0.03];
    } else if (s.hairstyle === 'swept' || s.hairstyle === 'waves') {
      middle = [ca * 0.13 * w + 0.035, 2.11 + front * 0.015, sa * 0.115 - 0.02];
      end = [ca * 0.17 * w + (front > 0.5 ? 0.025 : 0), front > 0.4 ? 1.95 - (i % 4) * 0.015 : 1.94, sa * 0.15 - 0.015];
    } else {
      middle = [ca * 0.125 * w, 2.07, sa * 0.11 - 0.025];
      end = [ca * 0.157 * w, 1.985, sa * 0.145 - 0.025];
    }
    head.add(sweep([start, middle, end], [0.018, s.hairstyle === 'crop' ? 0.022 : 0.028, 0.001], 12, 28, 0.28), color, M.hair);
    if (i % 2 === 0) head.curve([start, [middle[0], middle[1] + 0.008, middle[2] + 0.003], end], 0.0013, dark.clone().multiplyScalar(1.28).getHex(), M.hair, 0.0003);
  }
  if (s.hairstyle === 'ponytail') {
    head.oval([0, 2.055, -0.19], [0.07, 0.065, 0.07], s.hair, M.hair);
    for (let i = 0; i < 14; i++) {
      const x = (i / 13 - 0.5) * 0.1;
      head.add(sweep([[x * 0.5, 2.07, -0.2], [x, 1.93, -0.28], [x * 0.8, 1.65, -0.27], [x * 0.3 - 0.03, 1.42, -0.21]],
        [0.017, 0.025, 0.021, 0.002], 12, 40, 0.55), dark.clone().multiplyScalar(0.8 + i * 0.025).getHex(), M.hair);
    }
  }
  if (s.hairstyle !== 'crop') for (let i = 0; i < 7; i++) {
    const shift = i * 0.012;
    const endY = s.hairstyle === 'bob' ? 1.88 : 1.91;
    head.add(sweep([[0.065 + shift * 0.3, 2.105, 0.02], [0.015 - shift * 0.6, 2.045, 0.133], [-0.05 - shift, endY + i * 0.008, 0.125 - i * 0.007]],
      [0.012, 0.025, 0.001], 12, 28, 0.25), dark.clone().multiplyScalar(0.86 + i * 0.035).getHex(), M.hair);
  }
  if (s.hairstyle === 'braids') for (const side of [-1, 1]) for (let braid = 0; braid < 3; braid++) {
    const points: Point[] = Array.from({ length: 14 }, (_, i) => [side * 0.16 + Math.sin(i * 1.4 + braid * 2.1) * 0.012, 1.9 - i * 0.035, -0.03 + Math.cos(i * 1.4 + braid * 2.1) * 0.012]);
    head.add(sweep(points, [0.011, 0.008], 10, 52), s.hair, M.hair);
  }
}

function addGlasses(head: Sculpt, s: CharacterStyle): void {
  for (const side of [-1, 1]) {
    const x = side * 0.073 * s.face;
    head.curve([[x - 0.045, 1.867, 0.172], [x - 0.045, 1.905, 0.172], [x + 0.045, 1.905, 0.172], [x + 0.045, 1.867, 0.172], [x - 0.045, 1.867, 0.172]], 0.0025, 0x465365, M.metal);
    head.curve([[side * 0.118, 1.9, 0.172], [side * 0.157, 1.9, 0.08], [side * 0.165, 1.87, -0.02]], 0.0025, 0x465365, M.metal);
  }
  head.curve([[-0.027, 1.89, 0.177], [0, 1.897, 0.19], [0.027, 1.89, 0.177]], 0.002, 0x465365, M.metal);
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}

export function poseCouncilCharacter(character: CouncilCharacterRig, pose: {
  asleep: boolean; eliminated: boolean; speaking: boolean; lookYaw: number;
  elapsed: number; delta: number; still: boolean;
}): void {
  const time = pose.elapsed + character.motionOffset;
  const closed = pose.asleep || pose.eliminated || (!pose.still && time % 4.7 < 0.13);
  character.eyes.visible = !closed;
  character.closedEyes.visible = closed;
  const blend = pose.still ? 1 : 1 - Math.exp(-pose.delta * 7);
  const nod = pose.still ? 0 : Math.sin(time * (pose.speaking ? 5 : 0.8)) * (pose.speaking ? 0.035 : 0.01);
  const tilt = pose.eliminated ? 0.42 : pose.asleep ? 0.28 : nod;
  character.head.rotation.x = THREE.MathUtils.lerp(character.head.rotation.x, tilt, blend);
  character.head.rotation.y = THREE.MathUtils.lerp(character.head.rotation.y,
    pose.asleep || pose.eliminated ? 0 : THREE.MathUtils.clamp(pose.lookYaw, -0.35, 0.35), blend);
  character.root.position.y = pose.still || pose.eliminated ? 0 : Math.sin(time * (pose.asleep ? 0.65 : 1.2)) * 0.004;
  character.root.rotation.z = THREE.MathUtils.lerp(character.root.rotation.z,
    pose.eliminated ? -0.1 : pose.still || pose.asleep ? 0 : Math.sin(time * 0.7) * 0.006, blend);
  for (const material of character.materials) material.color.setScalar(pose.eliminated ? 0.42 : pose.asleep ? 0.9 : 1);
}
