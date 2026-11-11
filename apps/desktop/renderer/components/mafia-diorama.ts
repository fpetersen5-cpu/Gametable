import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Phase, SeatInfo } from '../../shared/api';
import { seatColor } from '../game-data';
import { characterStylesForSeats, poseCouncilCharacter, type CouncilCharacterRig } from './mafia-characters';
import { CouncilAssetLibrary } from './mafia-character-assets';
import { mafiaPhaseIsNight, mafiaSceneState } from './mafia-scene-state';
import { animateCouncilShips, buildCouncilSet, createHolographicCity } from './mafia-set';

export type MafiaCameraMode = 'cinematic' | 'tactical';

export interface MafiaDioramaFrame {
  seats: SeatInfo[];
  phase: Phase;
  mode: MafiaCameraMode;
  focusSeatId: string | null;
  selectedSeatId: string | null;
  snapCamera: boolean;
  speakingSeatId: string | null;
}

interface SeatVisual {
  root: THREE.Group;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
  position: THREE.Vector3;
  character: CouncilCharacterRig | null;
}

export interface CouncilLoadingState { loaded: number; total: number; error?: string }

/** Blender-backed real-time diorama. It only receives the current seat projection. */
export class MafiaDiorama {
  readonly ready: Promise<void>;
  private readonly assets: CouncilAssetLibrary;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly visuals = new Map<string, SeatVisual>();
  private readonly pickable: THREE.Object3D[] = [];
  private readonly pillars: THREE.Group[] = [];
  private readonly ships: THREE.Group[];
  private readonly environment: THREE.WebGLRenderTarget;
  private tableReflection!: Reflector;
  private readonly tableRadius: number;
  private readonly holo = new THREE.Group();
  private readonly holoMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly activeLight = new THREE.PointLight(0xd7e4ff, 3, 5, 2);
  private readonly skyLight = new THREE.HemisphereLight(0x9fb5e5, 0x17130e, 1.8);
  private readonly keyLight = new THREE.DirectionalLight(0xf1d7b5, 3.2);
  private readonly warmLight = new THREE.PointLight(0xf0a65c, 28, 19, 2);
  private readonly rimLight = new THREE.PointLight(0x637fd5, 24, 20, 2);
  private readonly starMaterial = new THREE.PointsMaterial({ color: 0xaabbd8, size: 0.1, transparent: true, opacity: 0.65 });
  private readonly moonMaterial = new THREE.MeshBasicMaterial({ color: 0xb8c9e6, transparent: true });
  private readonly nightEmblem = new THREE.Group();
  private readonly nightMaterial = new THREE.MeshBasicMaterial({ color: 0x6f96e8, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  private readonly daySky = new THREE.Color(0x172638);
  private readonly nightSky = new THREE.Color(0x030713);
  private readonly dayFog = new THREE.Color(0x243344);
  private readonly nightFog = new THREE.Color(0x07101a);
  private readonly dayKey = new THREE.Color(0xf1d7b5);
  private readonly nightKey = new THREE.Color(0x8da4ee);
  private readonly dayHolo = new THREE.Color(0x89b9e5);
  private readonly nightHolo = new THREE.Color(0x5b8de8);
  private nightBlend: number;
  private activeIds: string[] = [];
  private readonly clock = new THREE.Timer();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly startCamera = new THREE.Vector3();
  private readonly startTarget = new THREE.Vector3();
  private readonly endCamera = new THREE.Vector3();
  private readonly endTarget = new THREE.Vector3();
  private frame: MafiaDioramaFrame;
  private animation = 0;
  private transition = 1;
  private cameraCommand = '';
  private pointerDown: { x: number; y: number; id: number } | null = null;
  private visible = true;
  private disposed = false;
  private contextLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    frame: MafiaDioramaFrame,
    private readonly onSeatSelect: (seatId: string) => void,
    private readonly onLoading: (state: CouncilLoadingState) => void = () => {},
  ) {
    this.frame = frame;
    this.tableRadius = Math.max(1.85, frame.seats.length * 0.235);
    this.nightBlend = mafiaPhaseIsNight(frame.phase) ? 1 : 0;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.assets = new CouncilAssetLibrary(new URL('mafia-characters/', document.baseURI).href,
      Math.min(4, this.renderer.capabilities.getMaxAnisotropy()));
    const studio = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(studio, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.45;
    studio.dispose();
    pmrem.dispose();

    this.scene.background = new THREE.Color(0x05080e);
    this.scene.fog = new THREE.FogExp2(0x07101a, 0.025);
    this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 180);
    this.camera.layers.enable(1); // Seat markers stay out of the tabletop reflection camera.
    this.raycaster.layers.enable(1);
    this.camera.position.set(9, 7, 11);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.25;
    this.controls.maxDistance = 18;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.target.set(0, 0.9, 0);
    this.controls.addEventListener('start', this.cancelTransition);

    try {
      this.buildLighting();
      this.buildEnvironment();
      this.ships = buildCouncilSet(this.scene, this.pillars);
      animateCouncilShips(this.ships, 0);
      this.buildTable();
      this.buildSeats(frame.seats);
      this.scene.add(this.holo, this.activeLight, this.nightEmblem);

      this.resizeObserver = new ResizeObserver(this.resize);
      if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
      this.intersectionObserver = new IntersectionObserver((entries) => {
        this.visible = entries[0]?.isIntersecting ?? true;
      });
      this.intersectionObserver.observe(canvas);
      this.resize();
      canvas.addEventListener('pointerdown', this.onPointerDown);
      canvas.addEventListener('pointerup', this.onPointerUp);
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      this.update(frame);
      this.clock.connect(document);
      this.clock.reset();
      this.animate();
      this.ready = this.loadCharacters(frame.seats);
    } catch (error) {
      this.assets.dispose();
      this.renderer.dispose();
      throw error;
    }
  }

  update(frame: MafiaDioramaFrame): void {
    this.frame = frame;
    this.activeIds = mafiaSceneState(frame.phase, frame.seats).activeIds;
    const command = `${frame.mode}:${frame.focusSeatId ?? 'table'}:${mafiaPhaseIsNight(frame.phase)}`;
    if (command !== this.cameraCommand) {
      this.cameraCommand = command;
      this.setCameraDestination();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.assets.dispose();
    cancelAnimationFrame(this.animation);
    this.clock.dispose();
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.controls.removeEventListener('start', this.cancelTransition);
    this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          materials.add(material);
        }
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    this.tableReflection.getRenderTarget().dispose();
    this.environment.dispose();
    this.keyLight.shadow.dispose();
    // A roster change reuses this canvas. Clear pixel-unpack flags before the
    // next renderer creates its array textures on the same WebGL context.
    this.renderer.resetState();
    this.renderer.dispose();
  }

  private readonly cancelTransition = (): void => {
    this.transition = 1;
  };

  private readonly resize = (): void => {
    const parent = this.canvas.parentElement;
    if (!parent || this.disposed) return;
    const width = Math.max(1, parent.clientWidth);
    const height = Math.max(1, parent.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    this.pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || !event.isPrimary || event.button !== 0 || event.pointerId !== down.id) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickable, false)[0];
    const seatId = hit?.object.userData.seatId;
    if (typeof seatId === 'string') this.onSeatSelect(seatId);
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    cancelAnimationFrame(this.animation);
    this.onLoading({
      loaded: 0,
      total: this.frame.seats.length,
      error: 'The 3D graphics context was lost. Retry to reopen the chamber.',
    });
  };

  private setCameraDestination(): void {
    this.startCamera.copy(this.camera.position);
    this.startTarget.copy(this.controls.target);
    const focus = this.frame.focusSeatId ? this.visuals.get(this.frame.focusSeatId) : undefined;
    if (this.frame.mode === 'tactical') {
      this.endCamera.set(0, this.tableRadius * 3.3, this.tableRadius * 1.8);
      this.endTarget.set(0, 0.8, 0);
    } else if (focus) {
      this.endTarget.copy(focus.position).add(new THREE.Vector3(0, 1.58, 0));
      const tangent = new THREE.Vector3(-focus.position.z, 0, focus.position.x).normalize();
      this.endCamera.copy(focus.position).multiplyScalar(0.18).add(tangent.multiplyScalar(0.75));
      this.endCamera.y = 2.05;
    } else {
      this.endCamera.set(this.tableRadius * 1.95, this.tableRadius * 1.05, this.tableRadius * 2.3);
      this.endTarget.set(0, 1.25, 0);
    }
    this.transition = this.reducedMotion || this.frame.snapCamera ? 1 : 0;
    if (this.transition === 1) {
      this.camera.position.copy(this.endCamera);
      this.controls.target.copy(this.endTarget);
    }
  }

  private animate = (): void => {
    if (this.disposed || this.contextLost) return;
    this.animation = requestAnimationFrame(this.animate);
    this.clock.update();
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.getElapsed();
    const night = mafiaPhaseIsNight(this.frame.phase);
    const still = this.reducedMotion;
    this.nightBlend = THREE.MathUtils.lerp(this.nightBlend, night ? 1 : 0,
      still || this.frame.snapCamera ? 1 : 1 - Math.exp(-delta * 1.5));

    if (this.transition < 1) {
      this.transition = Math.min(1, this.transition + delta / 1.05);
      const eased = this.transition * this.transition * (3 - 2 * this.transition);
      this.camera.position.lerpVectors(this.startCamera, this.endCamera, eased);
      this.controls.target.lerpVectors(this.startTarget, this.endTarget, eased);
    }

    if (!still) {
      this.holo.rotation.y += delta * (night ? 0.025 : 0.06);
      animateCouncilShips(this.ships, elapsed);
    }

    this.activeLight.visible = false;
    const focusId = this.frame.focusSeatId ?? this.frame.speakingSeatId ?? this.activeIds[0];
    const speaker = focusId ? this.visuals.get(focusId) : undefined;
    for (const [seatId, visual] of this.visuals) {
      const seat = this.frame.seats.find((entry) => entry.id === seatId);
      const active = this.activeIds.includes(seatId);
      const selected = this.frame.selectedSeatId === seatId;
      const focused = this.frame.focusSeatId === seatId;
      const dead = seat?.alive === false;
      const asleep = night && !active;
      const targetAngle = speaker && speaker !== visual
        ? Math.atan2(speaker.position.x - visual.position.x, speaker.position.z - visual.position.z) - visual.root.rotation.y : 0;
      if (visual.character) poseCouncilCharacter(visual.character, {
        asleep, eliminated: dead, speaking: this.frame.speakingSeatId === seatId,
        lookYaw: Math.atan2(Math.sin(targetAngle), Math.cos(targetAngle)), elapsed, delta, still,
      });
      visual.ring.visible = !dead && (active || selected);
      visual.ring.material.opacity = active && !still ? 0.68 + Math.sin(elapsed * 3) * 0.2 : 0.5;
      visual.ring.scale.setScalar(selected && !active ? 1.15 : 1);
      visual.label.visible = this.frame.mode === 'tactical' || !this.frame.focusSeatId || focused || active || selected;
      visual.label.material.opacity = dead ? 0.3 : asleep && !selected ? 0.72 : 0.92;
      if (visual.character) visual.character.accent.emissiveIntensity = dead || asleep ? 0 : active ? 1.8 : 0.85;
      if (seatId === focusId && (!night || active)) {
        this.activeLight.position.copy(visual.position).multiplyScalar(0.85);
        this.activeLight.position.y = visual.position.y + 2.6;
        this.activeLight.color.set(0xd7e4ff);
        this.activeLight.visible = !dead;
      }
    }

    this.controls.update();
    this.updateAtmosphere();
    // Cut away the near wall so orbiting never hides a character behind a column.
    const distance = Math.hypot(this.camera.position.x, this.camera.position.z) || 1;
    for (const pillar of this.pillars) {
      pillar.visible = (pillar.position.x * this.camera.position.x + pillar.position.z * this.camera.position.z) / distance < 5.2;
    }
    if (this.visible && !document.hidden) this.renderer.render(this.scene, this.camera);
  };

  private buildLighting(): void {
    this.scene.add(this.skyLight);
    const moon = this.keyLight;
    moon.position.set(-9, 16, 8);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -7;
    moon.shadow.camera.right = 7;
    moon.shadow.camera.top = 7;
    moon.shadow.camera.bottom = -7;
    moon.shadow.normalBias = 0.012;
    moon.shadow.bias = -0.00015;
    moon.shadow.radius = 3;
    this.scene.add(moon);

    const warm = this.warmLight;
    warm.position.set(3, 4, -3);
    this.scene.add(warm);
    const rim = this.rimLight;
    rim.position.set(-4, 4, 3);
    this.scene.add(rim);
  }

  private updateAtmosphere(): void {
    const blend = this.nightBlend;
    (this.scene.background as THREE.Color).lerpColors(this.daySky, this.nightSky, blend);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.lerpColors(this.dayFog, this.nightFog, blend);
    fog.density = THREE.MathUtils.lerp(0.018, 0.026, blend);
    this.skyLight.intensity = THREE.MathUtils.lerp(1.1, 0.7, blend);
    this.keyLight.color.lerpColors(this.dayKey, this.nightKey, blend);
    this.keyLight.intensity = THREE.MathUtils.lerp(2.4, 1.8, blend);
    this.warmLight.intensity = THREE.MathUtils.lerp(28, 8, blend);
    this.rimLight.intensity = THREE.MathUtils.lerp(24, 22, blend);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.45, 0.22, blend);
    this.starMaterial.opacity = THREE.MathUtils.lerp(0.06, 0.8, blend);
    this.moonMaterial.opacity = THREE.MathUtils.lerp(0.12, 1, blend);
    this.nightMaterial.opacity = blend * 0.58;
    this.nightEmblem.quaternion.copy(this.camera.quaternion);
    for (const material of this.holoMaterials) material.color.lerpColors(this.dayHolo, this.nightHolo, blend);
    for (const material of this.holoMaterials) {
      if (typeof material.userData.dayOpacity === 'number') material.opacity = material.userData.dayOpacity * (1 - blend * 0.85);
    }
  }

  private buildEnvironment(): void {
    const concrete = new THREE.MeshStandardMaterial({ color: 0x313a47, roughness: 0.32, metalness: 0.35 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x354454, roughness: 0.72, metalness: 0.25 });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(8, 8.1, 0.3, 128), concrete);
    platform.position.y = -0.15;
    platform.receiveShadow = true;
    this.scene.add(platform);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(75, 48), new THREE.MeshStandardMaterial({ color: 0x0d141e, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -7.5;
    ground.receiveShadow = true;
    this.scene.add(ground);

    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const pillar = new THREE.Group();
      const column = new THREE.Mesh(new THREE.BoxGeometry(0.65, 5.5, 0.65), edge);
      column.position.y = 2.3;
      column.castShadow = true;
      pillar.add(column);
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.68, 1.7, 0.04),
        new THREE.MeshBasicMaterial({ color: index % 2 ? 0x6e83bd : 0xc18a52, transparent: true, opacity: 0.5 }),
      );
      strip.position.set(0, 2.5, 0.35);
      pillar.add(strip);
      pillar.position.set(Math.cos(angle) * 7.3, 0, Math.sin(angle) * 7.3);
      pillar.rotation.y = -angle + Math.PI / 2;
      this.scene.add(pillar);
      this.pillars.push(pillar);
    }

    const random = mulberry32(410);
    const windows = cityWindows();
    const towerMaterial = new THREE.MeshStandardMaterial({ color: 0x263447, roughness: 0.44, metalness: 0.45, map: windows, emissiveMap: windows, emissive: 0x6d8ec5, emissiveIntensity: 0.75 });
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x172231, roughness: 0.6, metalness: 0.5 });
    for (let index = 0; index < 34; index++) {
      const angle = random() * Math.PI * 2;
      const radius = 19 + random() * 37;
      const height = 5 + random() * 24;
      const tower = new THREE.Mesh(new THREE.BoxGeometry(2 + random() * 3, height, 2 + random() * 3), [towerMaterial, towerMaterial, roofMaterial, roofMaterial, towerMaterial, towerMaterial]);
      tower.position.set(Math.cos(angle) * radius, height / 2 - 7, Math.sin(angle) * radius);
      tower.rotation.y = random() * Math.PI;
      this.scene.add(tower);
    }

    const starPositions = new Float32Array(600 * 3);
    for (let index = 0; index < 600; index++) {
      const radius = 45 + random() * 70;
      const angle = random() * Math.PI * 2;
      starPositions[index * 3] = Math.cos(angle) * radius;
      starPositions[index * 3 + 1] = 10 + random() * 55;
      starPositions[index * 3 + 2] = Math.sin(angle) * radius;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.scene.add(new THREE.Points(starGeometry, this.starMaterial));

    const moon = new THREE.Mesh(new THREE.SphereGeometry(2.8, 20, 14), this.moonMaterial);
    moon.position.set(-26, 27, -43);
    this.scene.add(moon);
  }

  private buildTable(): void {
    const crescent = new THREE.Shape();
    const angle = Math.acos(0.26 / 0.57);
    const tip = Math.sin(angle) * 0.57;
    crescent.moveTo(0.26, tip);
    crescent.absarc(0, 0, 0.57, angle, Math.PI * 2 - angle, false);
    crescent.quadraticCurveTo(-0.28, 0, 0.26, tip);
    const moon = new THREE.Mesh(new THREE.ShapeGeometry(crescent, 32), this.nightMaterial);
    this.nightEmblem.position.y = 1.75;
    this.nightEmblem.add(moon);
    for (const [x, y, radius] of [[0.55, 0.33, 0.04], [0.38, -0.1, 0.025], [0.68, -0.3, 0.03]]) {
      const star = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), this.nightMaterial);
      star.position.set(x!, y!, 0);
      this.nightEmblem.add(star);
    }
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(this.tableRadius, this.tableRadius + 0.035, 0.1, 128),
      new THREE.MeshPhysicalMaterial({ color: 0x28313e, roughness: 0.2, metalness: 0.75, clearcoat: 1 }),
    );
    table.position.y = 1.11;
    table.castShadow = true;
    table.receiveShadow = true;
    this.scene.add(table);

    this.tableReflection = new Reflector(new THREE.CircleGeometry(this.tableRadius - 0.045, 128), {
      color: 0x485363, textureWidth: 1024, textureHeight: 1024, clipBias: 0.003,
      shader: {
        uniforms: { color: { value: new THREE.Color() }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() } },
        vertexShader: `
          uniform mat4 textureMatrix;
          varying vec4 vUv;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vUv = textureMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          uniform vec3 color;
          uniform sampler2D tDiffuse;
          varying vec4 vUv;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            vec2 uv = vUv.xy / vUv.w;
            vec3 reflection = texture2D(tDiffuse, uv).rgb * 0.4;
            reflection += texture2D(tDiffuse, uv + vec2(0.0015, 0.0)).rgb * 0.15;
            reflection += texture2D(tDiffuse, uv - vec2(0.0015, 0.0)).rgb * 0.15;
            reflection += texture2D(tDiffuse, uv + vec2(0.0, 0.0015)).rgb * 0.15;
            reflection += texture2D(tDiffuse, uv - vec2(0.0, 0.0015)).rgb * 0.15;
            gl_FragColor = vec4(mix(color, reflection, 0.38), 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      },
    });
    this.tableReflection.rotation.x = -Math.PI / 2;
    this.tableReflection.getReflectionCamera(this.camera).layers.set(0);
    this.tableReflection.position.y = 1.162;
    this.scene.add(this.tableReflection);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1.05, 64), table.material);
    pedestal.position.y = 0.525;
    pedestal.castShadow = true;
    this.scene.add(pedestal);

    for (const radius of [this.tableRadius - 0.07, this.tableRadius + 0.025]) {
      const material = new THREE.MeshBasicMaterial({ color: 0x7188cb, transparent: true, opacity: 0.32 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009, 12, 128), material);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.166;
      this.scene.add(ring);
      this.holoMaterials.push(material);
    }

    const city = createHolographicCity(this.holoMaterials);
    city.traverse((object) => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial) object.material.userData.dayOpacity = object.material.opacity;
    });
    city.scale.setScalar(0.55);
    city.position.y = 0.78;
    this.holo.add(city);
    this.nightEmblem.scale.setScalar(0.5);
  }

  private buildSeats(seats: SeatInfo[]): void {
    const radius = this.tableRadius + 0.52;
    seats.forEach((seat, index) => {
      const angle = (index / seats.length) * Math.PI * 2 + Math.PI / 2;
      const position = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      const root = new THREE.Group();
      root.position.copy(position);
      root.rotation.y = Math.atan2(-position.x, -position.z);

      root.add(createCouncilChair());

      const ringMaterial = new THREE.MeshBasicMaterial({ color: seatThreeColor(seat.id), transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.012, 12, 64), ringMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.035;
      ring.visible = false;
      root.add(ring);

      const label = createSeatMarker(index + 1, seatColor(seat.id));
      label.layers.set(1);
      label.position.set(0, 2.2, 0);
      root.add(label);

      // One cheap picking proxy per seat; the character meshes are far too
      // detailed to raycast on every click.
      const pick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 2.4, 8),
        new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        }),
      );
      pick.position.y = 1.2;
      pick.userData.seatId = seat.id;
      root.add(pick);
      this.pickable.push(pick);
      this.scene.add(root);
      this.visuals.set(seat.id, { root, ring, label, position, character: null });
    });
  }

  private async loadCharacters(seats: SeatInfo[]): Promise<void> {
    const styles = characterStylesForSeats(seats);
    let loaded = 0;
    this.onLoading({ loaded, total: seats.length });
    try {
      // Limit decode/upload peaks and keep interaction available while loading.
      for (const seat of seats) {
        if (this.disposed) return;
        const character = await this.assets.load(seat, styles.get(seat.id)!, seatThreeColor(seat.id));
        if (this.disposed || !character) return;
        const visual = this.visuals.get(seat.id)!;
        visual.character = character;
        const current = this.frame.seats.find((entry) => entry.id === seat.id);
        // Apply the latest private projection before the model becomes visible.
        poseCouncilCharacter(character, {
          asleep: mafiaPhaseIsNight(this.frame.phase) && !this.activeIds.includes(seat.id),
          eliminated: current?.alive === false, speaking: false, lookYaw: 0,
          elapsed: 0, delta: 0, still: true,
        });
        visual.root.add(character.root);
        visual.label.position.y = character.height + 0.17;
        this.onLoading({ loaded: ++loaded, total: seats.length });
      }
    } catch (failure) {
      if (!this.disposed) this.onLoading({ loaded, total: seats.length,
        error: failure instanceof Error ? failure.message : 'Could not load council characters.' });
    }
  }
}

function createCouncilChair(): THREE.Group {
  const chair = new THREE.Group();
  chair.name = 'council-chair';
  const leather = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x586476, roughness: 0.28, metalness: 0.85 });
  const cushion = new THREE.Mesh(new RoundedBoxGeometry(0.68, 0.12, 0.61, 5, 0.05), leather);
  cushion.position.set(0, 0.55, 0.02);
  const back = new THREE.Mesh(new RoundedBoxGeometry(0.64, 0.79, 0.12, 5, 0.055), leather);
  back.position.set(0, 0.98, -0.25);
  back.rotation.x = -0.09;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 0.48, 24), metal);
  stem.position.y = 0.26;
  chair.add(cushion, back, stem);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.055, 0.43, 3, 0.02), leather);
    arm.position.set(side * 0.365, 0.91, 0.04);
    const support = new THREE.Mesh(new RoundedBoxGeometry(0.035, 0.38, 0.035, 2, 0.01), metal);
    support.position.set(side * 0.365, 0.72, -0.08);
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.045, 0.065, 3, 0.02), metal);
    foot.position.y = 0.035;
    foot.rotation.y = side * Math.PI / 4;
    chair.add(arm, support, foot);
  }
  chair.traverse((object) => {
    if (object instanceof THREE.Mesh) object.castShadow = object.receiveShadow = true;
  });
  return chair;
}

function cityWindows(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#0b1524';
  context.fillRect(0, 0, 128, 512);
  const random = mulberry32(529);
  for (let row = 0; row < 48; row++) for (let col = 0; col < 10; col++) {
    context.fillStyle = random() > 0.35 ? (random() > 0.75 ? '#cfaa7a' : '#729dc5') : '#18263b';
    context.fillRect(3 + col * 13, 3 + row * 11, 5, 4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createSeatMarker(seatNumber: number, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 144;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create seat labels');
  context.fillStyle = 'rgba(6, 10, 15, 0.84)';
  context.beginPath();
  context.moveTo(18, 8);
  context.lineTo(110, 8);
  context.lineTo(110, 105);
  context.lineTo(64, 134);
  context.lineTo(18, 105);
  context.closePath();
  context.fill();
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.stroke();
  context.fillStyle = color;
  context.font = '500 64px system-ui';
  context.textAlign = 'center';
  context.fillStyle = '#e9eff9';
  context.fillText(String(seatNumber), 64, 87);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.22, 0.25, 1);
  return sprite;
}

function seatThreeColor(seatId: string): THREE.Color {
  const match = /^hsl\((\d+)/.exec(seatColor(seatId));
  const hue = match ? Number(match[1]) / 360 : 0.6;
  return new THREE.Color().setHSL(hue, 0.78, 0.42);
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
