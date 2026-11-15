/**
 * Motor do jogo (three.js): câmera isométrica ortográfica, piso e paredes, móveis, peças em
 * produção, personagens, seleção, arraste no modo Construção e marcações do Mestre de Obras.
 * Coordenadas da planta em centímetros (x leste, y sul) ↔ cena em metros (x, z).
 */
import * as THREE from 'three';
import {
  type ClearanceProblem,
  type FurnitureModel,
  type GridPoint,
  type LayoutContent,
  type Rect,
  AREA_FUNCTION_COLOR,
  STORAGE_KINDS,
  buildGrid,
  catalogOf,
  doorCenter,
  exteriorWalls,
  findPath,
  footprint,
  frontRect,
  nearestFree,
  rectOfArea,
} from '@cenario/shared';
import {
  FURNITURE_SIZE,
  PALETTE,
  avatar,
  decorModel,
  fabricColor,
  floorText,
  furniture,
  label,
  mat,
  stationModel,
  storageModel,
} from './models';

export type PickKind =
  | 'piece'
  | 'employee'
  | 'agent'
  | 'station'
  | 'storage'
  | 'decor'
  | 'area'
  | 'door'
  | 'wall'
  | 'handle'
  | 'mestre'
  | 'player';

export interface PickTarget {
  kind: PickKind;
  id: string;
  /** Prateleira clicada (nível), quando o alvo é armazenagem. */
  level?: number;
}

export interface PieceVisual {
  id: string;
  model: FurnitureModel;
  osCode: string;
  tone: 'FALTA' | 'DISPONIVEL' | 'A_CONFERIR';
  /** Centro em cm. */
  x: number;
  y: number;
  rot: number;
  label: string;
  highlight?: boolean;
  /** Posição física confirmada (fantasma), quando diferente da representada. */
  confirmed?: { x: number; y: number; text: string } | null;
}

export interface PersonVisual {
  id: string;
  kind: 'employee' | 'agent';
  name: string;
  color: string;
  x: number;
  y: number;
  /** Direção em que olha (rad). */
  face: number;
  seated?: boolean;
  status?: string;
  dim?: boolean;
}

export interface Overlays {
  problems?: ClearanceProblem[];
  highlights?: Rect[];
  path?: GridPoint[] | null;
  /** Retângulos de prévia (contorno tracejado bronze). */
  preview?: Rect[];
  pulse?: { x: number; y: number } | null;
}

export interface EngineCallbacks {
  onPick(
    target: PickTarget | null,
    floorCm: { x: number; y: number } | null,
    ev: PointerEvent,
  ): void;
  onDrag?(target: PickTarget, xCm: number, yCm: number, phase: 'move' | 'end'): void;
  onHover?(target: PickTarget | null): void;
  onArrive?(tag: string): void;
}

export interface SceneOptions {
  mode: 'GESTAO' | 'CONSTRUCAO';
  preview: boolean;
  selectedId: string | null;
  slotTones: Record<string, string>;
  /** Objetos editáveis podem ser arrastados (permissão jogo.construir). */
  editable: boolean;
  snapCm: number;
  agentDesks: Record<string, { name: string; color: string; status: string }>;
}

const CM = 0.01;
const ISO_DIR = new THREE.Vector3(1, 1.15, 1).normalize();

export class GameEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3();
  private viewSize = 14;
  private raf = 0;
  private clock = new THREE.Clock();
  private ray = new THREE.Raycaster();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private resizeObs: ResizeObserver;

  private staticGroup = new THREE.Group();
  private pieceGroup = new THREE.Group();
  private peopleGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private pickables: THREE.Object3D[] = [];
  private objects = new Map<string, THREE.Object3D>();

  private layout: LayoutContent | null = null;
  private opts: SceneOptions = {
    mode: 'GESTAO',
    preview: false,
    selectedId: null,
    slotTones: {},
    editable: false,
    snapCm: 10,
    agentDesks: {},
  };
  private pieces = new Map<
    string,
    { g: THREE.Group; to: THREE.Vector3; rot: number; ghost?: THREE.Object3D; key: string }
  >();
  private people = new Map<
    string,
    { g: THREE.Group; path: THREE.Vector3[]; face: number; key: string; seated: boolean }
  >();
  private player: { g: THREE.Group; path: THREE.Vector3[]; tag: string | null } | null = null;
  private mestre: THREE.Group | null = null;
  private walkGrid: ReturnType<typeof buildGrid> | null = null;

  // Ponteiro
  private down: {
    x: number;
    y: number;
    target: PickTarget | null;
    button: number;
    moved: boolean;
    start: THREE.Vector3 | null;
    grab: { dx: number; dz: number } | null;
  } | null = null;
  private pinch: { d: number; size: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private dragging: { target: PickTarget; obj: THREE.Object3D; dx: number; dz: number } | null =
    null;

  constructor(
    private container: HTMLElement,
    private cb: EngineCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor('#cfe1dc');
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.setAttribute('aria-label', 'Mapa da empresa virtual');
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);

    const hemi = new THREE.HemisphereLight('#fffaf0', '#8aa39d', 1.25);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff3df', 1.6);
    sun.position.set(-12, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -25;
    sun.shadow.camera.right = 25;
    sun.shadow.camera.top = 25;
    sun.shadow.camera.bottom = -25;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.scene.add(sun.target);
    (this as unknown as { sun: THREE.DirectionalLight }).sun = sun;

    this.scene.add(this.staticGroup, this.pieceGroup, this.peopleGroup, this.overlayGroup);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.bindInput();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ───────────────────────────── Câmera ─────────────────────────────

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.updateCamera();
  }

  private updateCamera() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    const s = this.viewSize;
    this.camera.left = (-s * aspect) / 2;
    this.camera.right = (s * aspect) / 2;
    this.camera.top = s / 2;
    this.camera.bottom = -s / 2;
    this.camera.position.copy(this.target).addScaledVector(ISO_DIR, 60);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    const sun = (this as unknown as { sun: THREE.DirectionalLight }).sun;
    sun.position.set(this.target.x - 12, 22, this.target.z + 8);
    sun.target.position.copy(this.target);
  }

  zoomBy(f: number) {
    this.viewSize = Math.min(60, Math.max(3, this.viewSize * f));
    this.updateCamera();
  }

  panBy(dxM: number, dzM: number) {
    this.target.x += dxM;
    this.target.z += dzM;
    this.clampTarget();
    this.updateCamera();
  }

  private clampTarget() {
    if (!this.layout) return;
    this.target.x = Math.min(this.layout.widthCm * CM + 3, Math.max(-3, this.target.x));
    this.target.z = Math.min(this.layout.depthCm * CM + 3, Math.max(-3, this.target.z));
  }

  /** Visão geral do ambiente inteiro. */
  overview() {
    if (!this.layout) return;
    const w = this.layout.widthCm * CM;
    const d = this.layout.depthCm * CM;
    this.target.set(w / 2, 0, d / 2);
    const el = this.container;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    const diag = (w + d) * 0.72;
    this.viewSize = Math.max(6, Math.max(diag / aspect, (w + d) * 0.42) * 1.08);
    this.updateCamera();
  }

  /** Posição na tela (px, relativa à janela) de um objeto do mapa — usada pelos testes. */
  screenOf(id: string, heightM = 0.6) {
    const o = this.objects.get(id) ?? this.pieces.get(id)?.g ?? this.people.get(id)?.g;
    if (!o) return null;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    p.y += heightM;
    p.project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  viewCenterCm() {
    return { x: this.target.x / CM, y: this.target.z / CM };
  }

  /** Enquadra um retângulo (cm) com folga, para mostrar uma sugestão inteira. */
  fitRect(r: { x: number; y: number; w: number; d: number }) {
    const el = this.container;
    const aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
    this.target.set((r.x + r.w / 2) * CM, 0, (r.y + r.d / 2) * CM);
    const span = (r.w + r.d) * CM;
    this.viewSize = Math.min(60, Math.max(6, Math.max((span * 0.75) / aspect, span * 0.45) * 1.4));
    this.updateCamera();
  }

  focus(xCm: number, yCm: number, viewSize?: number) {
    this.target.set(xCm * CM, 0, yCm * CM);
    if (viewSize) this.viewSize = viewSize;
    this.updateCamera();
  }

  // ───────────────────────────── Entrada ─────────────────────────────

  private ndc(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    );
  }

  private floorAt(ev: { clientX: number; clientY: number }) {
    this.ray.setFromCamera(this.ndc(ev), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.floorPlane, p) ? p : null;
  }

  private pickAt(ev: { clientX: number; clientY: number }): PickTarget | null {
    this.ray.setFromCamera(this.ndc(ev), this.camera);
    const hits = this.ray.intersectObjects(this.pickables, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.pick) o = o.parent;
      if (!o) continue;
      const t = { ...(o.userData.pick as PickTarget) };
      if (t.kind === 'storage') {
        const local = o.worldToLocal(h.point.clone());
        const unit = this.layout?.storageUnits.find((u) => u.id === t.id);
        if (unit) {
          const levels = unit.slots.length || 1;
          const H =
            unit.kind === 'GAVETEIRO'
              ? 1.0
              : unit.kind === 'ESTRADO_ESPUMA'
                ? 1.4
                : unit.kind === 'PRATELEIRA'
                  ? 1.6
                  : 2.0;
          t.level = Math.min(levels, Math.max(1, Math.floor((local.y / H) * levels) + 1));
        }
      }
      // No modo Gestão as áreas só contam se nada estiver por cima.
      return t;
    }
    return null;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), size: this.viewSize };
        this.down = null;
        return;
      }
      const target = e.button === 0 ? this.pickAt(e) : null;
      const start = this.floorAt(e);
      let grab: { dx: number; dz: number } | null = null;
      if (target && this.canDrag(target) && start) {
        const obj = this.objects.get(target.id);
        if (obj) grab = { dx: start.x - obj.position.x, dz: start.z - obj.position.z };
      }
      this.down = {
        x: e.clientX,
        y: e.clientY,
        target,
        button: e.button,
        moved: false,
        start,
        grab,
      };
    });
    el.addEventListener('pointermove', (e) => {
      if (this.touches.has(e.pointerId))
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.viewSize = Math.min(
          60,
          Math.max(3, (this.pinch.size * this.pinch.d) / Math.max(1, d)),
        );
        this.updateCamera();
        return;
      }
      const dn = this.down;
      if (!dn) {
        if (e.pointerType === 'mouse') {
          const t = this.pickAt(e);
          el.style.cursor = t ? (this.canDrag(t) ? 'grab' : 'pointer') : 'default';
          this.cb.onHover?.(t);
        }
        return;
      }
      const dist = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
      if (dist > 4) dn.moved = true;
      if (!dn.moved) return;
      if (dn.target && dn.grab && this.canDrag(dn.target)) {
        const p = this.floorAt(e);
        if (!p) return;
        const obj = this.objects.get(dn.target.id);
        if (!obj) return;
        if (!this.dragging)
          this.dragging = { target: dn.target, obj, dx: dn.grab.dx, dz: dn.grab.dz };
        const nx = p.x - this.dragging.dx;
        const nz = p.z - this.dragging.dz;
        const { x, y } = this.snapOrigin(dn.target, nx, nz);
        this.cb.onDrag?.(dn.target, x, y, 'move');
        el.style.cursor = 'grabbing';
        return;
      }
      // Arrastar o fundo (ou botão direito/do meio) desloca a câmera.
      const r = el.getBoundingClientRect();
      const mPerPx = this.viewSize / r.height;
      const dx = e.movementX * mPerPx;
      const dy = e.movementY * mPerPx;
      // Tela → plano isométrico (direita = +x−z, baixo = +x+z, em proporção).
      this.panBy(-(dx * 0.7071 + dy * 0.7071 * 1.22), -(-dx * 0.7071 + dy * 0.7071 * 1.22));
    });
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      const dn = this.down;
      this.down = null;
      if (!dn) return;
      if (this.dragging) {
        const p = this.floorAt(e);
        if (p) {
          const { x, y } = this.snapOrigin(
            this.dragging.target,
            p.x - this.dragging.dx,
            p.z - this.dragging.dz,
          );
          this.cb.onDrag?.(this.dragging.target, x, y, 'end');
        }
        this.dragging = null;
        el.style.cursor = 'grab';
        return;
      }
      if (!dn.moved && dn.button === 0) {
        const p = this.floorAt(e);
        this.cb.onPick(dn.target, p ? { x: p.x / CM, y: p.z / CM } : null, e);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private canDrag(t: PickTarget) {
    if (this.opts.mode !== 'CONSTRUCAO' || this.opts.preview || !this.opts.editable) return false;
    return ['station', 'storage', 'decor', 'area', 'wall', 'handle'].includes(t.kind);
  }

  /** Converte a posição arrastada (centro do objeto, m) para a origem em cm, com encaixe. */
  private snapOrigin(t: PickTarget, cx: number, cz: number) {
    const snap = this.opts.snapCm || 1;
    const sn = (v: number) => Math.round(v / snap) * snap;
    if (t.kind === 'handle' || t.kind === 'wall') return { x: sn(cx / CM), y: sn(cz / CM) };
    const l = this.layout;
    let w = 0;
    let d = 0;
    if (l) {
      const s =
        l.stations.find((x) => x.id === t.id) ??
        l.storageUnits.find((x) => x.id === t.id) ??
        l.doc.decor.find((x) => x.id === t.id);
      if (s) {
        const f = footprint(s);
        w = f.w;
        d = f.d;
      }
      const a = l.areas.find((x) => x.id === t.id);
      if (a) {
        w = a.wCm;
        d = a.dCm;
      }
    }
    return { x: sn(cx / CM - w / 2), y: sn(cz / CM - d / 2) };
  }

  // ───────────────────────────── Construção da cena ─────────────────────────────

  private register(o: THREE.Object3D, pick: PickTarget) {
    o.userData.pick = pick;
    this.pickables.push(o);
    this.objects.set(pick.id, o);
  }

  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const sm = (o as THREE.Sprite).material as THREE.SpriteMaterial | undefined;
        if ((o as THREE.Sprite).isSprite && sm?.map) {
          sm.map.dispose();
          sm.dispose();
        }
      });
    }
  }

  setLayout(layout: LayoutContent, opts: SceneOptions) {
    const firstTime =
      !this.layout ||
      this.layout.name !== layout.name ||
      this.layout.widthCm !== layout.widthCm ||
      this.layout.depthCm !== layout.depthCm;
    const spaceChanged = !this.layout || this.layout.name !== layout.name;
    this.layout = layout;
    this.opts = opts;
    this.clearGroup(this.staticGroup);
    this.pickables = this.pickables.filter(
      (p) =>
        p.parent &&
        !this.isIn(p, this.staticGroup) &&
        (this.isIn(p, this.pieceGroup) || this.isIn(p, this.peopleGroup)),
    );
    for (const [id, o] of this.objects)
      if (!this.isIn(o, this.pieceGroup) && !this.isIn(o, this.peopleGroup))
        this.objects.delete(id);
    const build = opts.mode === 'CONSTRUCAO' && !opts.preview;
    const W = layout.widthCm * CM;
    const D = layout.depthCm * CM;

    // Piso (madeira clara) e base externa.
    const base = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.3, D + 1.2), mat('#93b3ab'));
    base.position.set(W / 2, -0.16, D / 2);
    base.receiveShadow = true;
    this.staticGroup.add(base);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      mat(PALETTE.floor, { rough: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    floor.receiveShadow = true;
    this.staticGroup.add(floor);
    // Tábuas: linhas a cada 20 cm no sentido leste-oeste.
    const planks = new THREE.Group();
    for (let z = 0.2; z < D; z += 0.2) {
      const ln = new THREE.Mesh(
        new THREE.PlaneGeometry(W, 0.008),
        new THREE.MeshBasicMaterial({ color: PALETTE.floorLine }),
      );
      ln.rotation.x = -Math.PI / 2;
      ln.position.set(W / 2, 0.001, z);
      planks.add(ln);
    }
    this.staticGroup.add(planks);
    // Grade com medidas (modo Construção).
    if (build) {
      const g = layout.gridCm * CM;
      const lines: number[] = [];
      for (let x = 0; x <= W + 1e-6; x += g) lines.push(x, 0.004, 0, x, 0.004, D);
      for (let z = 0; z <= D + 1e-6; z += g) lines.push(0, 0.004, z, W, 0.004, z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      this.staticGroup.add(
        new THREE.LineSegments(
          geo,
          new THREE.LineBasicMaterial({ color: '#7d6a4a', transparent: true, opacity: 0.35 }),
        ),
      );
      const meter: number[] = [];
      for (let x = 0; x <= W + 1e-6; x += 1) meter.push(x, 0.005, 0, x, 0.005, D);
      for (let z = 0; z <= D + 1e-6; z += 1) meter.push(0, 0.005, z, W, 0.005, z);
      const mgeo = new THREE.BufferGeometry();
      mgeo.setAttribute('position', new THREE.Float32BufferAttribute(meter, 3));
      this.staticGroup.add(
        new THREE.LineSegments(
          mgeo,
          new THREE.LineBasicMaterial({ color: '#5a4a2e', transparent: true, opacity: 0.55 }),
        ),
      );
      // Réguas nas bordas.
      for (let x = 0; x <= W + 1e-6; x += Math.max(1, Math.round(W / 8))) {
        const s = label(`${x.toFixed(0)} m`, {
          size: 20,
          bg: 'rgba(255,255,255,0.85)',
          fg: '#1d2523',
        });
        s.position.set(x, 0.05, -0.35);
        this.staticGroup.add(s);
      }
      for (let z = 0; z <= D + 1e-6; z += Math.max(1, Math.round(D / 6))) {
        const s = label(`${z.toFixed(0)} m`, {
          size: 20,
          bg: 'rgba(255,255,255,0.85)',
          fg: '#1d2523',
        });
        s.position.set(-0.45, 0.05, z);
        this.staticGroup.add(s);
      }
      const dims = label(
        `${W.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} × ${D.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m · ${Math.round(W * D)} m²${layout.illustrative ? ' · medidas ilustrativas' : ''}`,
        { size: 24, bg: layout.illustrative ? 'rgba(161,92,7,0.9)' : 'rgba(29,74,69,0.9)' },
      );
      dims.position.set(W / 2, 0.05, D + 0.7);
      this.staticGroup.add(dims);
      // Alças da sala (largura leste, profundidade sul).
      for (const [id, x, z] of [
        ['room:e', W, D / 2],
        ['room:s', W / 2, D],
      ] as const) {
        const h = new THREE.Mesh(
          new THREE.BoxGeometry(0.35, 0.35, 0.35),
          mat('#a8743f', { emissive: '#a8743f' }),
        );
        h.position.set(x, 0.2, z);
        this.staticGroup.add(h);
        this.register(h, { kind: 'handle', id });
      }
    }

    // Áreas (piso colorido + nome).
    for (const a of layout.areas) {
      const r = rectOfArea(a);
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w * CM, r.d * CM),
        new THREE.MeshStandardMaterial({
          color: a.color ?? AREA_FUNCTION_COLOR[a.function],
          transparent: true,
          opacity: build ? 0.75 : 0.55,
          roughness: 1,
        }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set((r.x + r.w / 2) * CM, 0.003, (r.y + r.d / 2) * CM);
      tile.receiveShadow = true;
      this.staticGroup.add(tile);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w * CM, 0.001, r.d * CM)),
        new THREE.LineBasicMaterial({
          color: opts.selectedId === a.id ? '#a8743f' : '#5a4a2e',
          transparent: true,
          opacity: opts.selectedId === a.id ? 1 : 0.4,
        }),
      );
      border.position.copy(tile.position).setY(0.006);
      this.staticGroup.add(border);
      const t = floorText(a.name, '#1d2523', Math.min(r.w * CM * 0.8, 3.2));
      t.position.set(
        (r.x + 20) * CM + (t.geometry as THREE.PlaneGeometry).parameters.width / 2,
        0.008,
        (r.y + 30) * CM,
      );
      this.staticGroup.add(t);
      if (build) {
        tile.userData.pick = { kind: 'area', id: a.id };
        this.pickables.push(tile);
        this.objects.set(a.id, tile);
        const dl = label(
          `${(r.w / 100).toLocaleString('pt-BR')} × ${(r.d / 100).toLocaleString('pt-BR')} m`,
          { size: 18, bg: 'rgba(255,255,255,0.8)', fg: '#4a5552' },
        );
        dl.position.set((r.x + r.w / 2) * CM, 0.05, (r.y + r.d - 25) * CM);
        this.staticGroup.add(dl);
        if (opts.selectedId === a.id)
          for (const [c, x, z] of [
            ['nw', r.x, r.y],
            ['ne', r.x + r.w, r.y],
            ['sw', r.x, r.y + r.d],
            ['se', r.x + r.w, r.y + r.d],
          ] as const) {
            const h = new THREE.Mesh(
              new THREE.BoxGeometry(0.28, 0.12, 0.28),
              mat('#1d4a45', { emissive: '#2f6f68' }),
            );
            h.position.set(x * CM, 0.06, z * CM);
            this.staticGroup.add(h);
            this.register(h, { kind: 'handle', id: `${a.id}:${c}` });
          }
      } else {
        tile.userData.pick = { kind: 'area', id: a.id };
        this.pickables.push(tile);
      }
    }

    this.buildWalls(layout, build);

    // Estações.
    for (const s of layout.stations) {
      const f = footprint(s);
      const holder = new THREE.Group();
      holder.position.set((f.x + f.w / 2) * CM, 0, (f.y + f.d / 2) * CM);
      const m = stationModel(s.kind, s.wCm * CM, s.dCm * CM);
      m.position.set((-s.wCm / 2) * CM, 0, (-s.dCm / 2) * CM);
      holder.add(m);
      holder.rotation.y = (-s.rotation * Math.PI) / 180;
      const wrap = new THREE.Group();
      wrap.add(holder);
      this.staticGroup.add(wrap);
      this.register(holder, { kind: 'station', id: s.id });
      if (opts.selectedId === s.id) this.selectionBox(f);
      const agent = opts.agentDesks[s.id];
      const showName = build || s.assigneeUserIds.length === 0 || catalogOf(s.kind).desk;
      if (showName && !agent) {
        const lb = label(s.name, {
          size: 18,
          bg: build ? 'rgba(29,74,69,0.85)' : 'rgba(255,255,255,0.85)',
          fg: build ? '#fff' : '#1d2523',
        });
        lb.position.set((f.x + f.w / 2) * CM, 1.35, (f.y + f.d / 2) * CM);
        this.staticGroup.add(lb);
      }
    }
    // Armazenagem.
    for (const u of layout.storageUnits) {
      const f = footprint(u);
      const holder = new THREE.Group();
      holder.position.set((f.x + f.w / 2) * CM, 0, (f.y + f.d / 2) * CM);
      const levels = u.slots.length || (STORAGE_KINDS[u.kind]?.levels ?? 1);
      const tones = [...u.slots]
        .sort((a, b) => a.level - b.level)
        .map((sl) => opts.slotTones[sl.id] ?? null);
      const m = storageModel(u.kind, u.wCm * CM, u.dCm * CM, levels, tones);
      m.position.set((-u.wCm / 2) * CM, 0, (-u.dCm / 2) * CM);
      holder.add(m);
      holder.rotation.y = (-u.rotation * Math.PI) / 180;
      this.staticGroup.add(holder);
      this.register(holder, { kind: 'storage', id: u.id });
      if (opts.selectedId === u.id) this.selectionBox(f);
      const lb = label(u.label, { size: 18, bg: 'rgba(168,116,63,0.92)' });
      lb.position.set(
        (f.x + f.w / 2) * CM,
        u.kind === 'ESTRADO_ESPUMA' ? 1.7 : 2.25,
        (f.y + f.d / 2) * CM,
      );
      this.staticGroup.add(lb);
    }
    // Decoração.
    for (const dcor of layout.doc.decor) {
      const f = footprint(dcor);
      const holder = new THREE.Group();
      holder.position.set((f.x + f.w / 2) * CM, 0, (f.y + f.d / 2) * CM);
      const m = decorModel(dcor.kind, dcor.wCm * CM, dcor.dCm * CM);
      m.position.set((-dcor.wCm / 2) * CM, 0, (-dcor.dCm / 2) * CM);
      holder.add(m);
      holder.rotation.y = (-dcor.rotation * Math.PI) / 180;
      this.staticGroup.add(holder);
      this.register(holder, { kind: 'decor', id: dcor.id });
      if (opts.selectedId === dcor.id) this.selectionBox(f);
    }

    // Mestre de Obras (só no modo Construção).
    if (this.mestre) this.peopleGroup.remove(this.mestre);
    this.mestre = null;
    if (opts.mode === 'CONSTRUCAO') {
      const g = avatar('#e76f1a', 'MESTRE', 1);
      const entry = layout.doc.doors[0]
        ? doorCenter(layout, layout.doc.doors[0])
        : { x: 100, y: layout.depthCm - 100 };
      const p = this.freeNear(entry ?? { x: 100, y: 100 }, 120);
      g.position.set(p.x * CM, 0, p.y * CM);
      g.rotation.y = Math.PI / 4;
      const tag = label('Mestre de Obras', { size: 20, bg: 'rgba(231,111,26,0.95)', icon: '🦺' });
      tag.position.set(0, 1.55, 0);
      g.add(tag);
      this.peopleGroup.add(g);
      this.register(g, { kind: 'mestre', id: 'mestre' });
      this.mestre = g;
    }

    this.walkGrid = buildGrid(layout, { inflateCm: 22, cell: 25 });
    if (!this.player || spaceChanged) this.spawnPlayer();
    if (firstTime) this.overview();
  }

  private isIn(o: THREE.Object3D, g: THREE.Group) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === g) return true;
    return false;
  }

  private selectionBox(f: Rect) {
    const geo = new THREE.EdgesGeometry(
      new THREE.BoxGeometry(f.w * CM + 0.06, 1.2, f.d * CM + 0.06),
    );
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#a8743f' }));
    l.position.set((f.x + f.w / 2) * CM, 0.6, (f.y + f.d / 2) * CM);
    this.staticGroup.add(l);
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(f.w * CM + 0.2, f.d * CM + 0.2),
      new THREE.MeshBasicMaterial({
        color: '#a8743f',
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set((f.x + f.w / 2) * CM, 0.01, (f.y + f.d / 2) * CM);
    this.staticGroup.add(ring);
  }

  private buildWalls(l: LayoutContent, build: boolean) {
    const ext = exteriorWalls(l.widthCm, l.depthCm);
    const all = [
      ...ext.map((w) => ({ ...w, ext: true })),
      ...l.doc.walls.map((w) => ({ ...w, ext: false })),
    ];
    for (const w of all) {
      const tall = w.ext ? w.id === 'N' || w.id === 'O' : true;
      const H = w.ext ? (tall ? 2.6 : 0.35) : build ? 1.6 : 1.1;
      const T = 0.14;
      const horizontal = w.y1 === w.y2;
      const len = horizontal ? Math.abs(w.x2 - w.x1) : Math.abs(w.y2 - w.y1);
      const start = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const doors = l.doc.doors
        .filter((d) => d.wall === w.id)
        .sort((a, b) => a.offsetCm - b.offsetCm);
      const segs: [number, number][] = [];
      let cur = 0;
      for (const d of doors) {
        if (d.offsetCm > cur) segs.push([cur, d.offsetCm]);
        cur = Math.max(cur, d.offsetCm + d.widthCm);
      }
      if (cur < len) segs.push([cur, len]);
      const group = new THREE.Group();
      for (const [a, b] of segs) {
        const sl = (b - a) * CM;
        const color = w.ext ? (tall ? PALETTE.wall : PALETTE.wallLow) : '#6f9c94';
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(horizontal ? sl : T, H, horizontal ? T : sl),
          mat(color),
        );
        const mid = (start + (a + b) / 2) * CM;
        const off = w.ext ? (w.id === 'N' || w.id === 'O' ? -T / 2 : T / 2) : 0;
        if (horizontal) m.position.set(mid, H / 2, w.y1 * CM + off);
        else m.position.set(w.x1 * CM + off, H / 2, mid);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
        const top = new THREE.Mesh(
          new THREE.BoxGeometry(horizontal ? sl : T + 0.02, 0.04, horizontal ? T + 0.02 : sl),
          mat(PALETTE.wallTop),
        );
        top.position.copy(m.position).setY(H + 0.02);
        group.add(top);
      }
      // Janelas: vidro claro na parede (referência do Mestre de Obras).
      for (const win of l.doc.windows?.filter((x) => x.wall === w.id) ?? []) {
        const mid = (start + win.offsetCm + win.widthCm / 2) * CM;
        const glassH = Math.min(1.1, H - 0.6);
        if (glassH <= 0.1) continue;
        const glass = new THREE.Mesh(
          new THREE.BoxGeometry(
            horizontal ? win.widthCm * CM : T + 0.04,
            glassH,
            horizontal ? T + 0.04 : win.widthCm * CM,
          ),
          new THREE.MeshStandardMaterial({
            color: '#bfe3f2',
            transparent: true,
            opacity: 0.75,
            emissive: '#9fd3f0',
            emissiveIntensity: 0.25,
          }),
        );
        const off = w.ext ? (w.id === 'N' || w.id === 'O' ? -T / 2 : T / 2) : 0;
        if (horizontal) glass.position.set(mid, 0.9 + glassH / 2, w.y1 * CM + off);
        else glass.position.set(w.x1 * CM + off, 0.9 + glassH / 2, mid);
        group.add(glass);
      }
      // Portas: soleira e placa do destino.
      for (const d of doors) {
        const c = doorCenter(l, d);
        if (!c) continue;
        const mat2 = new THREE.Mesh(
          new THREE.PlaneGeometry(
            horizontal ? d.widthCm * CM : 0.6,
            horizontal ? 0.6 : d.widthCm * CM,
          ),
          new THREE.MeshStandardMaterial({
            color: d.toSpaceKey ? '#a8743f' : '#7a8481',
            transparent: true,
            opacity: 0.75,
          }),
        );
        mat2.rotation.x = -Math.PI / 2;
        mat2.position.set(c.x * CM, 0.012, c.y * CM);
        this.staticGroup.add(mat2);
        this.register(mat2, { kind: 'door', id: d.id });
        if (d.label || d.toSpaceKey) {
          const s = label(d.toSpaceKey ? `→ ${d.label ?? d.toSpaceKey}` : (d.label ?? 'Porta'), {
            size: 18,
            bg: d.toSpaceKey ? 'rgba(168,116,63,0.95)' : 'rgba(29,37,35,0.75)',
            icon: d.toSpaceKey ? '🚪' : undefined,
          });
          s.position.set(c.x * CM, tall && w.ext ? 2.3 : 1.0, c.y * CM);
          this.staticGroup.add(s);
        }
      }
      this.staticGroup.add(group);
      if (!w.ext) this.register(group, { kind: 'wall', id: w.id });
    }
  }

  private freeNear(p: { x: number; y: number }, inwardCm = 80) {
    if (!this.layout) return p;
    const q = {
      x: Math.min(this.layout.widthCm - inwardCm, Math.max(inwardCm, p.x)),
      y: Math.min(this.layout.depthCm - inwardCm, Math.max(inwardCm, p.y)),
    };
    const g = this.walkGrid ?? buildGrid(this.layout, { inflateCm: 22, cell: 25 });
    return nearestFree(g, q) ?? q;
  }

  private spawnPlayer(at?: { x: number; y: number }) {
    if (!this.layout) return;
    if (this.player) this.peopleGroup.remove(this.player.g);
    const g = avatar(PALETTE.bronze, 'JOGADOR', 0);
    const tag = label('Você', { size: 20, bg: 'rgba(168,116,63,0.95)' });
    tag.position.set(0, 1.5, 0);
    g.add(tag);
    const d0 = this.layout.doc.doors[0];
    const entry = at ??
      (d0 ? doorCenter(this.layout, d0) : null) ?? {
        x: this.layout.widthCm / 2,
        y: this.layout.depthCm - 100,
      };
    const p = this.freeNear(entry, 90);
    g.position.set(p.x * CM, 0, p.y * CM);
    this.peopleGroup.add(g);
    this.player = { g, path: [], tag: null };
    this.register(g, { kind: 'player', id: 'player' });
  }

  placePlayerAtDoorTo(spaceKey: string) {
    if (!this.layout) return;
    const d = this.layout.doc.doors.find((x) => x.toSpaceKey === spaceKey);
    const c = d ? doorCenter(this.layout, d) : null;
    this.spawnPlayer(c ?? undefined);
  }

  /** Anda até o ponto (cm) desviando dos móveis. `tag` volta em onArrive. */
  walkTo(xCm: number, yCm: number, tag: string | null = null) {
    if (!this.player || !this.layout) return false;
    const g = this.walkGrid ?? buildGrid(this.layout, { inflateCm: 22, cell: 25 });
    const from = { x: this.player.g.position.x / CM, y: this.player.g.position.z / CM };
    const s = nearestFree(g, from);
    const t = nearestFree(g, { x: xCm, y: yCm });
    if (!s || !t) return false;
    const path = findPath(g, s, t);
    if (!path) return false;
    this.player.path = path.map((p) => new THREE.Vector3(p.x * CM, 0, p.y * CM));
    this.player.tag = tag;
    return true;
  }

  playerCm() {
    return this.player
      ? { x: this.player.g.position.x / CM, y: this.player.g.position.z / CM }
      : null;
  }

  /** Move a representação de um objeto durante o arraste (antes de virar estado). */
  previewMove(id: string, xCm: number, yCm: number) {
    const o = this.objects.get(id);
    if (!o || !this.layout) return;
    const s =
      this.layout.stations.find((x) => x.id === id) ??
      this.layout.storageUnits.find((x) => x.id === id) ??
      this.layout.doc.decor.find((x) => x.id === id);
    if (s) {
      const f = footprint({ ...s, xCm, yCm });
      o.position.set((f.x + f.w / 2) * CM, 0, (f.y + f.d / 2) * CM);
    }
  }

  // ───────────────────────────── Operação (dinâmico) ─────────────────────────────

  setPieces(list: PieceVisual[]) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const key = `${p.model}|${p.tone}|${p.label}|${p.highlight ? 1 : 0}|${p.confirmed?.text ?? ''}`;
      let e = this.pieces.get(p.id);
      const to = new THREE.Vector3(p.x * CM, 0, p.y * CM);
      if (!e || e.key !== key) {
        const old = e;
        const g = new THREE.Group();
        const body = furniture(p.model, fabricColor(p.osCode));
        g.add(body);
        // Anel e ícone do semáforo de materiais (cor + ícone + texto).
        const tone =
          p.tone === 'FALTA' ? '#b42323' : p.tone === 'DISPONIVEL' ? '#1f7a46' : '#a15c07';
        const [sw, sd] = FURNITURE_SIZE[p.model];
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(sw, sd) * 0.55, Math.max(sw, sd) * 0.62, 32),
          new THREE.MeshBasicMaterial({
            color: tone,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        g.add(ring);
        const icon = p.tone === 'FALTA' ? '⛔' : p.tone === 'DISPONIVEL' ? '✅' : '❔';
        const tag = label(
          `${p.osCode} · ${p.tone === 'FALTA' ? 'falta material' : p.tone === 'DISPONIVEL' ? 'material ok' : 'a conferir'}`,
          {
            size: 20,
            bg: p.highlight ? 'rgba(168,116,63,0.97)' : 'rgba(255,255,255,0.94)',
            fg: p.highlight ? '#fff' : '#1d2523',
            icon,
            border: tone,
          },
        );
        tag.position.set(0, p.model === 'CABECEIRA' ? 1.6 : 1.25, 0);
        g.add(tag);
        if (p.highlight) {
          const beam = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.06, 4, 8),
            new THREE.MeshBasicMaterial({ color: '#a8743f', transparent: true, opacity: 0.6 }),
          );
          beam.position.y = 2.4;
          beam.name = 'beam';
          g.add(beam);
        }
        g.position.copy(old ? old.g.position : to);
        g.rotation.y = p.rot;
        if (old) {
          this.pieceGroup.remove(old.g);
          if (old.ghost) this.pieceGroup.remove(old.ghost);
        }
        this.pieceGroup.add(g);
        this.pickables = this.pickables.filter((x) => x !== old?.g);
        this.register(g, { kind: 'piece', id: p.id });
        e = { g, to, rot: p.rot, key };
        this.pieces.set(p.id, e);
        if (p.confirmed) {
          const ghost = new THREE.Group();
          const pin = new THREE.Mesh(
            new THREE.ConeGeometry(0.15, 0.4, 8),
            mat('#2c5ea8', { emissive: '#2c5ea8' }),
          );
          pin.rotation.x = Math.PI;
          pin.position.y = 0.5;
          ghost.add(pin);
          const t = label(`📍 ${p.osCode}: ${p.confirmed.text}`, {
            size: 16,
            bg: 'rgba(44,94,168,0.92)',
          });
          t.position.y = 1.0;
          ghost.add(t);
          ghost.position.set(p.confirmed.x * CM, 0, p.confirmed.y * CM);
          this.pieceGroup.add(ghost);
          e.ghost = ghost;
        }
      }
      e.to = to;
      e.rot = p.rot;
      if (e.ghost && p.confirmed) e.ghost.position.set(p.confirmed.x * CM, 0, p.confirmed.y * CM);
    }
    for (const [id, e] of this.pieces)
      if (!seen.has(id)) {
        this.pieceGroup.remove(e.g);
        if (e.ghost) this.pieceGroup.remove(e.ghost);
        this.pieces.delete(id);
        this.objects.delete(id);
        this.pickables = this.pickables.filter((x) => x !== e.g);
      }
  }

  setPeople(list: PersonVisual[]) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const key = `${p.kind}|${p.name}|${p.color}|${p.status ?? ''}|${p.dim ? 1 : 0}`;
      let e = this.people.get(p.id);
      const to = new THREE.Vector3(p.x * CM, 0, p.y * CM);
      if (!e || e.key !== key) {
        const old = e;
        const g = avatar(p.color, p.kind === 'agent' ? 'AGENTE' : 'PESSOA', p.name.length);
        const tag = label(p.status ? `${p.name} · ${p.status}` : p.name, {
          size: 18,
          bg: p.kind === 'agent' ? 'rgba(91,33,182,0.92)' : 'rgba(29,37,35,0.85)',
          icon: p.kind === 'agent' ? '🤖' : undefined,
        });
        tag.position.set(0, 1.5, 0);
        g.add(tag);
        if (p.dim)
          g.traverse((o) =>
            (o as THREE.Mesh).isMesh
              ? (((o as THREE.Mesh).material as THREE.Material) = mat('#9aa3a1', { opacity: 0.6 }))
              : null,
          );
        g.position.copy(old ? old.g.position : to);
        if (old) this.peopleGroup.remove(old.g);
        this.peopleGroup.add(g);
        this.pickables = this.pickables.filter((x) => x !== old?.g);
        this.register(g, { kind: p.kind === 'agent' ? 'agent' : 'employee', id: p.id });
        e = { g, path: [], face: p.face, key, seated: Boolean(p.seated) };
        this.people.set(p.id, e);
      }
      e.face = p.face;
      e.seated = Boolean(p.seated);
      const last = e.path[e.path.length - 1] ?? e.g.position;
      if (last.distanceTo(to) > 0.05) {
        // Caminha até a nova estação pelo corredor.
        if (this.walkGrid) {
          const s = nearestFree(this.walkGrid, { x: e.g.position.x / CM, y: e.g.position.z / CM });
          const t = nearestFree(this.walkGrid, { x: p.x, y: p.y });
          const path = s && t ? findPath(this.walkGrid, s, t) : null;
          e.path = path ? [...path.map((q) => new THREE.Vector3(q.x * CM, 0, q.y * CM)), to] : [to];
        } else e.path = [to];
      }
    }
    for (const [id, e] of this.people)
      if (!seen.has(id)) {
        this.peopleGroup.remove(e.g);
        this.people.delete(id);
        this.objects.delete(id);
        this.pickables = this.pickables.filter((x) => x !== e.g);
      }
  }

  setOverlays(o: Overlays) {
    this.clearGroup(this.overlayGroup);
    for (const p of o.problems ?? []) {
      const color = p.severity === 'erro' ? '#b42323' : '#d08a16';
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(0.05, p.rect.w * CM), Math.max(0.05, p.rect.d * CM)),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set((p.rect.x + p.rect.w / 2) * CM, 0.02, (p.rect.y + p.rect.d / 2) * CM);
      this.overlayGroup.add(m);
      if (p.gapCm > 0) {
        const t = label(`${p.gapCm} cm (precisa ${p.requiredCm})`, { size: 16, bg: color });
        t.position.set((p.rect.x + p.rect.w / 2) * CM, 0.4, (p.rect.y + p.rect.d / 2) * CM);
        this.overlayGroup.add(t);
      }
    }
    for (const r of o.highlights ?? []) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w * CM, r.d * CM),
        new THREE.MeshBasicMaterial({
          color: '#a8743f',
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.set((r.x + r.w / 2) * CM, 0.015, (r.y + r.d / 2) * CM);
      this.overlayGroup.add(m);
      const e = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w * CM, 0.02, r.d * CM)),
        new THREE.LineDashedMaterial({ color: '#8d5f31', dashSize: 0.15, gapSize: 0.1 }),
      );
      e.computeLineDistances();
      e.position.copy(m.position);
      this.overlayGroup.add(e);
    }
    for (const r of o.preview ?? []) {
      const e = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w * CM, 0.9, r.d * CM)),
        new THREE.LineBasicMaterial({ color: '#a8743f' }),
      );
      e.position.set((r.x + r.w / 2) * CM, 0.45, (r.y + r.d / 2) * CM);
      this.overlayGroup.add(e);
    }
    if (o.path && o.path.length > 1) {
      const pts = o.path.map((p) => new THREE.Vector3(p.x * CM, 0.03, p.y * CM));
      const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), 0.05, 6),
        new THREE.MeshBasicMaterial({ color: '#1f7a46', transparent: true, opacity: 0.8 }),
      );
      this.overlayGroup.add(tube);
      const band = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(8, pts.length * 6), 0.5, 6),
        new THREE.MeshBasicMaterial({
          color: '#1f7a46',
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
        }),
      );
      band.scale.y = 0.02;
      this.overlayGroup.add(band);
    }
    if (o.pulse) {
      const r = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.45, 32),
        new THREE.MeshBasicMaterial({
          color: '#a8743f',
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        }),
      );
      r.rotation.x = -Math.PI / 2;
      r.position.set(o.pulse.x * CM, 0.03, o.pulse.y * CM);
      r.name = 'pulse';
      this.overlayGroup.add(r);
    }
  }

  // ───────────────────────────── Laço de animação ─────────────────────────────

  private walkStep(
    obj: THREE.Object3D,
    path: THREE.Vector3[],
    speed: number,
    dt: number,
    t: number,
  ) {
    const next = path[0];
    const legL = obj.getObjectByName('legL');
    const legR = obj.getObjectByName('legR');
    const armL = obj.getObjectByName('armL');
    const armR = obj.getObjectByName('armR');
    if (!next) {
      if (legL && legR) legL.rotation.x = legR.rotation.x = 0;
      if (armL && armR) armL.rotation.x = armR.rotation.x = 0;
      return false;
    }
    const dir = next.clone().sub(obj.position);
    dir.y = 0;
    const dist = dir.length();
    if (dist < 0.03) {
      path.shift();
      return true;
    }
    const step = Math.min(dist, speed * dt);
    obj.position.addScaledVector(dir.normalize(), step);
    obj.rotation.y = Math.atan2(dir.x, dir.z);
    const swing = Math.sin(t * 10) * 0.5;
    if (legL && legR) {
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
    }
    if (armL && armR) {
      armL.rotation.x = -swing * 0.8;
      armR.rotation.x = swing * 0.8;
    }
    return true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    for (const e of this.pieces.values()) {
      const d = e.to.clone().sub(e.g.position);
      const dist = d.length();
      if (dist > 0.01) {
        // Desliza até a nova estação, com um "pulinho" de carregamento.
        const step = Math.min(dist, Math.max(1.2, dist * 2) * dt);
        e.g.position.addScaledVector(d.normalize(), step);
        e.g.position.y = Math.min(0.25, dist * 0.15);
      } else e.g.position.y = 0;
      e.g.rotation.y += (e.rot - e.g.rotation.y) * Math.min(1, dt * 5);
      const beam = e.g.getObjectByName('beam');
      if (beam)
        (beam as THREE.Mesh).scale.x = (beam as THREE.Mesh).scale.z = 1 + Math.sin(t * 4) * 0.3;
    }
    for (const e of this.people.values()) {
      const moving = this.walkStep(e.g, e.path, 1.6, dt, t);
      if (!moving) {
        e.g.rotation.y += (e.face - e.g.rotation.y) * Math.min(1, dt * 6);
        e.g.position.y = e.seated ? -0.18 : 0;
      }
    }
    if (this.player) {
      const was = this.player.path.length > 0;
      this.walkStep(this.player.g, this.player.path, 2.2, dt, t);
      if (was && this.player.path.length === 0 && this.player.tag) {
        const tag = this.player.tag;
        this.player.tag = null;
        this.cb.onArrive?.(tag);
      }
    }
    const pulse = this.overlayGroup.getObjectByName('pulse');
    if (pulse) pulse.scale.setScalar(1 + ((t * 1.5) % 1) * 0.8);
    if (this.mestre) this.mestre.position.y = Math.abs(Math.sin(t * 2)) * 0.03;
    this.renderer.render(this.scene, this.camera);
  };

  /** Ponto da frente de uma estação (cm), onde a pessoa fica de pé. */
  static workSpot(
    s: { xCm: number; yCm: number; wCm: number; dCm: number; rotation: number },
    depth = 45,
  ) {
    const fr = frontRect(s as never, depth);
    return { x: fr.x + fr.w / 2, y: fr.y + fr.d / 2, face: Math.PI - (s.rotation * Math.PI) / 180 };
  }
}
