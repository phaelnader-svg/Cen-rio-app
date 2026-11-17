/**
 * Motor do jogo (three.js): câmera isométrica ortográfica que gira em passos de 90°, piso e
 * paredes, móveis, peças em produção (com a aparência da etapa), personagens trabalhando,
 * seleção com destaque, iluminação pela hora real, etiquetas sem sobreposição, arraste no modo
 * Construção e marcações do Mestre de Obras.
 * Coordenadas da planta em centímetros (x leste, y sul) ↔ cena em metros (x, z).
 */
import { drawIcon, splitIcon } from './icons';
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
  type AvatarLook,
  type BuildStage,
  FURNITURE_SIZE,
  PALETTE,
  avatar,
  cart,
  decorModel,
  floorText,
  floorTexture,
  furniture,
  label,
  mat,
  noticeBoard,
  pegboard,
  pendantLamp,
  plant,
  rug,
  seatPose,
  stationModel,
  storageModel,
  toolModel,
  trophy,
  vanModel,
  wrappedCargo,
  wallClock,
  wallFabricShelf,
  wallWindow,
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
  | 'player'
  | 'van'
  | 'visitor';

export interface PickTarget {
  kind: PickKind;
  id: string;
  /** Prateleira clicada (nível), quando o alvo é armazenagem. */
  level?: number;
}

/** Retiradas e entregas de hoje (Cenário Gestão), para o furgão e a recepção da oficina. */
export interface LogisticsView {
  trips: {
    id: string;
    kind: 'ENTREGA' | 'RETIRADA';
    customer: string;
    /** AGENDADA (ainda na oficina), NA_RUA (saiu), FEITA ou PROBLEMA. */
    status: 'AGENDADA' | 'NA_RUA' | 'FEITA' | 'PROBLEMA';
  }[];
  /** Cliente que veio buscar a peça na oficina (aparece na entrada por um tempo). */
  visitor: { id: string; name: string } | null;
}

interface YardWall {
  origin: THREE.Vector3;
  out: THREE.Vector3;
  along: THREE.Vector3;
  /** Ponto da rua (faixa do furgão) na posição `t` ao longo da parede. */
  min: number;
  max: number;
}
interface YardSpot {
  wall: string;
  /** Centro do portão, na linha da parede. */
  door: THREE.Vector3;
  out: THREE.Vector3;
  /** Onde o furgão para, de ré para o portão. */
  park: THREE.Vector3;
  t: number;
  entryCm: { x: number; y: number };
}
interface VanStep {
  p: THREE.Vector3;
  /** Último trecho: entra de ré na vaga (frente para a rua). */
  reverse?: boolean;
  /** Reaparece aqui (vindo da rua). */
  teleport?: boolean;
  /** Some ao chegar (saiu para a rua). */
  hide?: boolean;
}

export interface PieceVisual {
  id: string;
  model: FurnitureModel;
  osCode: string;
  /** Cor do tecido (da OS). */
  color: string;
  /** Aparência conforme a etapa (desmontada, estrutura, espuma, capa, embalada). */
  stage: BuildStage;
  /** Centro em cm. */
  x: number;
  y: number;
  rot: number;
  label: string;
  highlight?: boolean;
  /** Situação curta (ícone + texto): Na fila, Em execução, Parada… */
  phase?: string;
  /** Ícone curto da situação (etiqueta compacta). */
  icon?: string;
  /** Cor da situação (anel no chão). */
  tone?: string;
  /** Filtro rápido ativo e a peça não atende: fica esmaecida. */
  dimmed?: boolean;
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
  /** Funções (cargo): uniforme/avental. */
  roles?: string[];
  /** Etapa em execução (anima o trabalho e escolhe a ferramenta). */
  activity?: string | null;
  /** Balão sobre a cabeça ("⏸ falta tecido", "✓ terminei", "⚠ atrasado"). */
  bubble?: { text: string; tone: 'ok' | 'warn' | 'danger' | 'info' } | null;
}

export interface Overlays {
  problems?: ClearanceProblem[];
  highlights?: Rect[];
  path?: GridPoint[] | null;
  /** Retângulos de prévia (contorno tracejado bronze). */
  preview?: Rect[];
  pulse?: { x: number; y: number } | null;
}

export type Quality = 'alta' | 'media' | 'baixa';

export interface EngineCallbacks {
  onPick(
    target: PickTarget | null,
    floorCm: { x: number; y: number } | null,
    ev: PointerEvent,
  ): void;
  onDrag?(target: PickTarget, xCm: number, yCm: number, phase: 'move' | 'end'): void;
  onHover?(target: PickTarget | null): void;
  onArrive?(tag: string): void;
  /** Peça solta em cima de um funcionário (arrastar para atribuir). */
  onAssignDrop?(pieceId: string, userId: string): void;
  /** A qualidade gráfica mudou sozinha (computador lento). */
  onQuality?(q: Quality): void;
  /** Primeira imagem desenhada (fim da tela de carregamento). */
  onReady?(): void;
  /** Passos do boneco (para o som). */
  onStep?(): void;
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
  /** Pode arrastar peça até um funcionário (atribuir etapa). */
  canAssign?: boolean;
  /** Recompensas de missões já conquistadas (decoração extra). */
  rewards?: string[];
}

const CM = 0.01;
const WALL_H = 2.6;
const WALL_LOW = 0.35;

/** Etiqueta com prioridade (as mais importantes ganham quando se sobrepõem). */
interface Tag {
  sprite: THREE.Sprite;
  prio: number;
  owner: string | null;
  /** O dono quer mostrar (ex.: etiqueta curta × completa). */
  want: boolean;
  show: boolean;
  /** Tamanho original (no mundo); de perto a etiqueta encolhe para não tomar a tela. */
  base: THREE.Vector2;
}

interface PieceEntry {
  g: THREE.Group;
  to: THREE.Vector3;
  rot: number;
  ghost?: THREE.Object3D;
  key: string;
  path: THREE.Vector3[];
  cart: THREE.Object3D | null;
  short: THREE.Sprite;
  full: THREE.Sprite;
  highlight: boolean;
  dragging?: boolean;
}

interface PersonEntry {
  g: THREE.Group;
  path: THREE.Vector3[];
  face: number;
  key: string;
  seated: boolean;
  /** 0 em pé … 1 sentado (transição animada). */
  sit: number;
  activity: string | null;
  bubble: THREE.Sprite | null;
  bubbleKey: string;
  phase: number;
}

/** Luz do dia por hora (America/Sao_Paulo). */
const DAY_KEYS: {
  h: number;
  sun: string;
  sunI: number;
  sky: string;
  ground: string;
  hemiI: number;
  bg: string;
  night: number;
}[] = [
  {
    h: 0,
    sun: '#9fb4ff',
    sunI: 0.12,
    sky: '#8ea4cc',
    ground: '#2a3340',
    hemiI: 0.45,
    bg: '#16242c',
    night: 1,
  },
  {
    h: 5.4,
    sun: '#9fb4ff',
    sunI: 0.12,
    sky: '#8ea4cc',
    ground: '#2a3340',
    hemiI: 0.45,
    bg: '#16242c',
    night: 1,
  },
  {
    h: 6.6,
    sun: '#ffc89a',
    sunI: 0.9,
    sky: '#f4dccb',
    ground: '#7d8a86',
    hemiI: 0.85,
    bg: '#e7d3c6',
    night: 0.35,
  },
  {
    h: 8.2,
    sun: '#fff3df',
    sunI: 1.6,
    sky: '#fffaf0',
    ground: '#8aa39d',
    hemiI: 1.25,
    bg: '#cfe1dc',
    night: 0,
  },
  {
    h: 15.8,
    sun: '#fff3df',
    sunI: 1.6,
    sky: '#fffaf0',
    ground: '#8aa39d',
    hemiI: 1.25,
    bg: '#cfe1dc',
    night: 0,
  },
  {
    h: 17.3,
    sun: '#ffcf8f',
    sunI: 1.35,
    sky: '#ffeedd',
    ground: '#8f9a8a',
    hemiI: 1.05,
    bg: '#ecd9c0',
    night: 0.1,
  },
  {
    h: 18.4,
    sun: '#ff9a6a',
    sunI: 0.55,
    sky: '#d9b8c4',
    ground: '#4c5160',
    hemiI: 0.7,
    bg: '#5f5a78',
    night: 0.65,
  },
  {
    h: 19.4,
    sun: '#9fb4ff',
    sunI: 0.12,
    sky: '#8ea4cc',
    ground: '#2a3340',
    hemiI: 0.45,
    bg: '#16242c',
    night: 1,
  },
  {
    h: 24,
    sun: '#9fb4ff',
    sunI: 0.12,
    sky: '#8ea4cc',
    ground: '#2a3340',
    hemiI: 0.45,
    bg: '#16242c',
    night: 1,
  },
];

export function hourInSaoPaulo(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (n('hour') % 24) + n('minute') / 60 + n('second') / 3600;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export class GameEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private target = new THREE.Vector3();
  private viewSize = 14;
  /** Giro da câmera (rad) e alvo do giro (passos de 90°). */
  private yaw = 0;
  private yawTarget = 0;
  private camAnim: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    s0: number;
    s1: number;
    t: number;
    dur: number;
  } | null = null;
  private insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private raf = 0;
  private clock = new THREE.Clock();
  private ray = new THREE.Raycaster();
  private floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private resizeObs: ResizeObserver;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private lamps: THREE.PointLight[] = [];
  private bulbs: THREE.Object3D[] = [];
  private glasses: THREE.Mesh[] = [];
  private clocks: THREE.Object3D[] = [];
  private hourOverride: number | null = null;
  private lastLightAt = -1;
  private night = 0;

  private staticGroup = new THREE.Group();
  /** Paredes externas: sobem atrás e baixam na frente conforme o giro da câmera. */
  private extWalls: { g: THREE.Group; normal: THREE.Vector3; mounted: THREE.Object3D[] }[] = [];
  /** Quadros de Metas posicionados no escritório (barra animada + texto). */
  private boards: { holder: THREE.Group; w: number }[] = [];
  private boardState: { target: number; current: number; text: string; tone: string } | null = null;
  private confetti: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private floaters: { s: THREE.Sprite; life: number; vy: number }[] = [];
  private pieceGroup = new THREE.Group();
  private peopleGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private fxGroup = new THREE.Group();
  private pickables: THREE.Object3D[] = [];
  private objects = new Map<string, THREE.Object3D>();
  private tags: Tag[] = [];
  private lastTagLayout = 0;
  private hudRects: DOMRect[] = [];
  private lastHudScan = 0;
  private hovered: string | null = null;

  // Destaque da seleção (o resto escurece).
  private focusId: string | null = null;
  private focusObj: THREE.Object3D | null = null;
  private dim = 0;
  private dimScene = new THREE.Scene();
  private dimCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private dimMat = new THREE.MeshBasicMaterial({
    color: '#0d1716',
    transparent: true,
    opacity: 0,
    depthTest: false,
  });

  // Qualidade automática.
  private quality: Quality = 'alta';
  private autoQuality = true;
  private frameTimes: number[] = [];
  private readyFired = false;

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
  private pieces = new Map<string, PieceEntry>();
  private people = new Map<string, PersonEntry>();
  private player: { g: THREE.Group; path: THREE.Vector3[]; tag: string | null } | null = null;
  private playerLook: AvatarLook | null = null;
  /** Pátio do lado de fora do portão (furgão e cliente na entrada). */
  private logisticsGroup = new THREE.Group();
  /**
   * Pátio do lado de fora: o portão de recebimento (onde entram as peças das retiradas) e o de
   * expedição (onde saem as entregas), cada um com a sua vaga para o furgão.
   */
  private yard: {
    spots: Record<'RECEB' | 'EXPED', YardSpot>;
    walls: Record<string, YardWall>;
  } | null = null;
  private van: {
    g: THREE.Group;
    tag: THREE.Sprite | null;
    cargo: THREE.Group;
    /** Vaga onde está (ou para onde vai); AWAY = na rua, fora do mapa. */
    at: 'RECEB' | 'EXPED' | 'AWAY';
    wall: string;
    path: VanStep[];
    text: string;
    loading: boolean;
  } | null = null;
  /** Retirada que acabou de voltar: o furgão fica descarregando no recebimento por um tempo. */
  private vanSticky: { text: string; until: number } | null = null;
  private vanTimer: number | null = null;
  private yardSig = '';
  private prevTrips = new Map<string, string>();
  private visitor: THREE.Group | null = null;
  private logistics: LogisticsView | null = null;
  private mestre: THREE.Group | null = null;
  private walkGrid: ReturnType<typeof buildGrid> | null = null;
  private keys = new Set<string>();
  private stepAcc = 0;

  // Ponteiro
  private down: {
    x: number;
    y: number;
    lx: number;
    ly: number;
    target: PickTarget | null;
    button: number;
    moved: boolean;
    start: THREE.Vector3 | null;
    grab: { dx: number; dz: number } | null;
  } | null = null;
  private gesture: {
    d: number;
    a: number;
    size: number;
    yaw: number;
    mid: { x: number; y: number };
  } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private dragging: { target: PickTarget; obj: THREE.Object3D; dx: number; dz: number } | null =
    null;
  private pieceDrag: { id: string; over: string | null; ring: THREE.Mesh } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };

  constructor(
    private container: HTMLElement,
    private cb: EngineCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    const saved = GameEngine.savedQuality();
    if (saved) {
      this.quality = saved;
      this.autoQuality = false;
    }
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.shadowMap.enabled = this.quality !== 'baixa';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.renderer.setClearColor('#cfe1dc');
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.setAttribute('aria-label', 'Mapa da empresa virtual');
    this.renderer.domElement.tabIndex = 0;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    this.camera.layers.enable(0);

    this.hemi = new THREE.HemisphereLight('#fffaf0', '#8aa39d', 1.25);
    this.hemi.layers.enable(1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3df', 1.6);
    this.sun.castShadow = this.quality !== 'baixa';
    this.sun.shadow.mapSize.set(
      this.quality === 'alta' ? 2048 : 1024,
      this.quality === 'alta' ? 2048 : 1024,
    );
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.layers.enable(1);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.dimMat);
    this.dimScene.add(quad);

    this.scene.add(
      this.staticGroup,
      this.pieceGroup,
      this.peopleGroup,
      this.overlayGroup,
      this.fxGroup,
      this.logisticsGroup,
    );
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    this.bindInput();
    this.updateLight(true);
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ───────────────────────────── Qualidade ─────────────────────────────

  static savedQuality(): Quality | null {
    try {
      const v = window.localStorage.getItem('firma-qualidade');
      return v === 'alta' || v === 'media' || v === 'baixa' ? v : null;
    } catch {
      return null;
    }
  }

  private pixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    return this.quality === 'alta'
      ? Math.min(dpr, 2)
      : this.quality === 'media'
        ? Math.min(dpr, 1.25)
        : 1;
  }

  getQuality() {
    return { quality: this.quality, auto: this.autoQuality };
  }

  /** Muda a qualidade gráfica (null = automática). */
  setQuality(q: Quality | null) {
    try {
      if (q) window.localStorage.setItem('firma-qualidade', q);
      else window.localStorage.removeItem('firma-qualidade');
    } catch {
      /* sem armazenamento */
    }
    this.autoQuality = !q;
    this.applyQuality(q ?? 'alta');
  }

  private applyQuality(q: Quality) {
    this.quality = q;
    this.renderer.setPixelRatio(this.pixelRatio());
    const shadows = q !== 'baixa';
    this.renderer.shadowMap.enabled = shadows;
    this.sun.castShadow = shadows;
    const size = q === 'alta' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    for (const l of this.lamps) l.visible = q !== 'baixa';
    this.resize();
    this.cb.onQuality?.(q);
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

  /** Direção da câmera (do alvo para a câmera). Giro 0 = vista sudeste clássica. */
  private camDir(yaw = this.yaw) {
    const a = Math.PI / 4 + yaw;
    return new THREE.Vector3(Math.sin(a) * Math.SQRT2, 1.15, Math.cos(a) * Math.SQRT2).normalize();
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
    this.camera.position.copy(this.target).addScaledVector(this.camDir(), 60);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Espaço ocupado pela interface nas bordas (px), para enquadrar e esconder etiquetas. */
  setInsets(i: { top: number; right: number; bottom: number; left: number }) {
    this.insets = i;
  }

  zoomBy(f: number, at?: { clientX: number; clientY: number }) {
    const before = at ? this.floorAt(at) : null;
    this.camAnim = null;
    this.viewSize = Math.min(60, Math.max(2.5, this.viewSize * f));
    this.updateCamera();
    if (before && at) {
      const after = this.floorAt(at);
      if (after) {
        this.target.add(before.sub(after));
        this.clampTarget();
        this.updateCamera();
      }
    }
  }

  panBy(dxM: number, dzM: number) {
    this.camAnim = null;
    this.target.x += dxM;
    this.target.z += dzM;
    this.clampTarget();
    this.updateCamera();
  }

  /** Gira a câmera 90° (1 = horário, -1 = anti-horário). */
  rotate(dir: 1 | -1) {
    this.yawTarget += (dir * Math.PI) / 2;
  }

  private clampTarget() {
    if (!this.layout) return;
    this.target.x = Math.min(this.layout.widthCm * CM + 3, Math.max(-3, this.target.x));
    this.target.z = Math.min(this.layout.depthCm * CM + 3, Math.max(-3, this.target.z));
    this.target.y = 0;
  }

  private animateTo(target: THREE.Vector3, size: number, dur = 0.55) {
    this.camAnim = {
      from: this.target.clone(),
      to: target.clone(),
      s0: this.viewSize,
      s1: size,
      t: 0,
      dur,
    };
  }

  /** Enquadramento justo de um retângulo no chão (m), descontando a interface. */
  private fitBox(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    height: number,
    yaw = this.yawTarget,
  ) {
    const el = this.container;
    const W = el.clientWidth || 1;
    const H = el.clientHeight || 1;
    const dir = this.camDir(yaw);
    const cam = new THREE.Object3D();
    cam.position.copy(dir);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorld.clone().invert();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const x of [x0, x1])
      for (const z of [z0, z1])
        for (const y of [0, height]) {
          const p = new THREE.Vector3(x, y, z).applyMatrix4(inv);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        }
    const i = this.insets;
    const fx = Math.max(0.3, (W - i.left - i.right) / W);
    const fy = Math.max(0.3, (H - i.top - i.bottom) / H);
    const aspect = W / H;
    const size = Math.max((maxY - minY) / fy, (maxX - minX) / (aspect * fx)) * 1.06;
    // Centro do retângulo visível na tela (descontada a interface), em coordenadas da câmera.
    const ox = ((i.left - i.right) / 2 / H) * size;
    const oy = ((i.bottom - i.top) / 2 / H) * size;
    const center = new THREE.Vector3(
      (minX + maxX) / 2 - ox,
      (minY + maxY) / 2 - oy,
      0,
    ).applyMatrix4(cam.matrixWorld);
    // Projeta o centro no chão ao longo da direção da câmera.
    const t = center.y / dir.y;
    const onFloor = center.clone().addScaledVector(dir, -t);
    return { target: onFloor, size };
  }

  /** Visão geral do ambiente inteiro (animada). */
  overview(animate = true) {
    if (!this.layout) return;
    const w = this.layout.widthCm * CM;
    const d = this.layout.depthCm * CM;
    // Com o pátio (furgão), a visão geral inclui a rua do lado de fora do portão.
    let [x0, z0, x1, z1] = [-0.3, -0.3, w + 0.3, d + 0.3];
    for (const sp of this.yard ? Object.values(this.yard.spots) : []) {
      const far = sp.park.clone().addScaledVector(sp.out, 1.6);
      x0 = Math.min(x0, far.x);
      x1 = Math.max(x1, far.x);
      z0 = Math.min(z0, far.z);
      z1 = Math.max(z1, far.z);
    }
    const { target, size } = this.fitBox(x0, z0, x1, z1, 1.2);
    if (animate) this.animateTo(target, Math.max(4, size));
    else {
      this.camAnim = null;
      this.target.copy(target);
      this.viewSize = Math.max(4, size);
      this.updateCamera();
    }
  }

  /** Posição na tela (px, relativa à janela) de um objeto do mapa — usada pelos testes e pelo tutorial. */
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
    const { target, size } = this.fitBox(
      (r.x - 60) * CM,
      (r.y - 60) * CM,
      (r.x + r.w + 60) * CM,
      (r.y + r.d + 60) * CM,
      1,
    );
    this.animateTo(target, Math.min(60, Math.max(5, size)));
  }

  /** Leva o ponto (cm) para o centro da área livre da tela (descontados os painéis abertos). */
  focus(xCm: number, yCm: number, viewSize?: number) {
    const size = viewSize ?? this.viewSize;
    const H = this.container.clientHeight || 1;
    const dir = this.camDir(this.yawTarget);
    const cam = new THREE.Object3D();
    cam.position.copy(dir);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const p = new THREE.Vector3(xCm * CM, 0, yCm * CM).applyMatrix4(
      cam.matrixWorld.clone().invert(),
    );
    const i = this.insets;
    p.x -= ((i.left - i.right) / 2 / H) * size;
    p.y -= ((i.bottom - i.top) / 2 / H) * size;
    const center = p.applyMatrix4(cam.matrixWorld);
    const onFloor = center.clone().addScaledVector(dir, -(center.y / dir.y));
    this.animateTo(onFloor, size);
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

  private pickAt(
    ev: { clientX: number; clientY: number },
    skip?: THREE.Object3D,
  ): PickTarget | null {
    this.ray.setFromCamera(this.ndc(ev), this.camera);
    const hits = this.ray.intersectObjects(this.pickables, true);
    for (const h of hits) {
      if ((h.object as THREE.Sprite).isSprite) continue;
      if (!h.object.visible) continue;
      let o: THREE.Object3D | null = h.object;
      if (skip && this.isIn(o, skip)) continue;
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
      return t;
    }
    return null;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.target as HTMLElement | null)?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'q') this.rotate(-1);
    if (k === 'e') this.rotate(1);
    const move = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
    if (move.includes(k)) {
      // No modo Construção, D duplica e as setas não andam.
      if (this.opts.mode === 'CONSTRUCAO') return;
      this.keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };
  private onBlur = () => this.keys.clear();

  private bindInput() {
    const el = this.renderer.domElement;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const f = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0015)));
        this.zoomBy(f, e);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      const t = this.pickAt(e);
      const p = this.floorAt(e);
      if (!p) return;
      this.doubleAt(t, p);
    });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.gesture = {
          d: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          a: Math.atan2(b!.y - a!.y, b!.x - a!.x),
          size: this.viewSize,
          yaw: this.yawTarget,
          mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
        };
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
        lx: e.clientX,
        ly: e.clientY,
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
      if (this.gesture && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const ang = Math.atan2(b!.y - a!.y, b!.x - a!.x);
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        this.camAnim = null;
        // Arrastar com dois dedos desloca; pinçar aproxima; girar os dedos gira a câmera.
        const p0 = this.floorAt({ clientX: this.gesture.mid.x, clientY: this.gesture.mid.y });
        const p1 = this.floorAt({ clientX: mid.x, clientY: mid.y });
        if (p0 && p1) this.target.add(p0.sub(p1));
        this.gesture.mid = mid;
        this.viewSize = Math.min(
          60,
          Math.max(2.5, (this.gesture.size * this.gesture.d) / Math.max(1, d)),
        );
        let da = ang - this.gesture.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        if (Math.abs(da) > 0.5) {
          this.yawTarget = this.gesture.yaw - Math.sign(da) * (Math.PI / 2);
          this.gesture.yaw = this.yawTarget;
          this.gesture.a = ang;
        }
        this.clampTarget();
        this.updateCamera();
        return;
      }
      const dn = this.down;
      if (!dn) {
        if (e.pointerType === 'mouse') {
          const t = this.pickAt(e);
          el.style.cursor = t
            ? this.canDrag(t) || (t.kind === 'piece' && this.canAssignDrag())
              ? 'grab'
              : 'pointer'
            : 'default';
          const id =
            t && ['piece', 'employee', 'agent', 'station', 'storage'].includes(t.kind)
              ? t.id
              : null;
          if (id !== this.hovered) {
            this.hovered = id;
            this.lastTagLayout = 0;
          }
          this.cb.onHover?.(t);
        }
        return;
      }
      const dist = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
      if (dist > 6) dn.moved = true;
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
      if (dn.target?.kind === 'piece' && this.canAssignDrag()) {
        this.dragPieceMove(dn.target.id, e);
        el.style.cursor = 'grabbing';
        return;
      }
      // Arrastar o fundo (ou botão direito/do meio) desloca a câmera, exatamente sob o dedo.
      const p0 = this.floorAt({ clientX: dn.lx, clientY: dn.ly });
      const p1 = this.floorAt(e);
      dn.lx = e.clientX;
      dn.ly = e.clientY;
      if (p0 && p1) {
        this.camAnim = null;
        this.target.add(p0.sub(p1));
        this.clampTarget();
        this.updateCamera();
      }
    });
    const up = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.gesture = null;
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
      if (this.pieceDrag) {
        const pd = this.pieceDrag;
        this.endPieceDrag();
        if (pd.over) this.cb.onAssignDrop?.(pd.id, pd.over);
        return;
      }
      if (!dn.moved && dn.button === 0) {
        const p = this.floorAt(e);
        // Toque duplo (celular): mesmo que o duplo clique.
        const now = performance.now();
        if (
          e.pointerType !== 'mouse' &&
          now - this.lastTap.t < 320 &&
          Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 30 &&
          p
        ) {
          this.lastTap.t = 0;
          this.doubleAt(dn.target, p);
          return;
        }
        this.lastTap = { t: now, x: e.clientX, y: e.clientY };
        this.cb.onPick(dn.target, p ? { x: p.x / CM, y: p.z / CM } : null, e);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Duplo clique: aproxima o que foi clicado (ou o ponto do chão). */
  private doubleAt(t: PickTarget | null, p: THREE.Vector3) {
    const o = t
      ? (this.objects.get(t.id) ?? this.pieces.get(t.id)?.g ?? this.people.get(t.id)?.g)
      : null;
    const at = new THREE.Vector3();
    if (o) o.getWorldPosition(at);
    else at.copy(p);
    at.y = 0;
    this.animateTo(at, Math.min(this.viewSize, 5.5));
  }

  private canAssignDrag() {
    return (
      this.opts.mode === 'GESTAO' && Boolean(this.opts.canAssign) && Boolean(this.cb.onAssignDrop)
    );
  }

  private dragPieceMove(id: string, e: PointerEvent) {
    const entry = this.pieces.get(id);
    const p = this.floorAt(e);
    if (!entry || !p) return;
    if (!this.pieceDrag) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.55, 32),
        new THREE.MeshBasicMaterial({
          color: '#1f7a46',
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.fxGroup.add(ring);
      this.pieceDrag = { id, over: null, ring };
      entry.dragging = true;
    }
    entry.g.position.set(p.x, 0.45, p.z);
    const t = this.pickAt(e, entry.g);
    const over = t?.kind === 'employee' ? t.id : null;
    this.pieceDrag.over = over;
    const person = over ? this.people.get(over) : null;
    this.pieceDrag.ring.visible = Boolean(person);
    if (person) this.pieceDrag.ring.position.set(person.g.position.x, 0.03, person.g.position.z);
  }

  private endPieceDrag() {
    const pd = this.pieceDrag;
    if (!pd) return;
    this.fxGroup.remove(pd.ring);
    const entry = this.pieces.get(pd.id);
    if (entry) entry.dragging = false;
    this.pieceDrag = null;
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

  // ───────────────────────────── Etiquetas ─────────────────────────────

  private tag(sprite: THREE.Sprite, prio: number, owner: string | null = null, want = true) {
    const t: Tag = {
      sprite,
      prio,
      owner,
      want,
      show: true,
      base: new THREE.Vector2(sprite.scale.x, sprite.scale.y),
    };
    sprite.userData.tag = t;
    this.tags.push(t);
    this.lastTagLayout = 0;
    return t;
  }

  private alive(o: THREE.Object3D) {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (p === this.scene) return true;
      if (!p.visible && p !== o) return false;
    }
    return false;
  }

  /** Esconde etiquetas que se sobrepõem (ganha a mais importante) ou ficam sob a interface. */
  private layoutTags(now: number) {
    this.tags = this.tags.filter((t) => this.alive(t.sprite));
    if (now - this.lastHudScan > 500) {
      this.lastHudScan = now;
      const root = this.container.parentElement;
      this.hudRects = root
        ? [...root.querySelectorAll<HTMLElement>('[data-hud]')]
            .filter((x) => x.offsetParent !== null)
            .map((x) => x.getBoundingClientRect())
        : [];
    }
    const r = this.renderer.domElement.getBoundingClientRect();
    const pxPerM = r.height / this.viewSize;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = this.hudRects.map((h) => ({
      x0: h.left - r.left,
      y0: h.top - r.top,
      x1: h.right - r.left,
      y1: h.bottom - r.top,
    }));
    const focus = this.focusId;
    const score = (t: Tag) =>
      t.owner && (t.owner === focus || t.owner === this.hovered) ? 1000 + t.prio : t.prio;
    const list = this.tags.filter((t) => t.want).sort((a, b) => score(b) - score(a));
    const k = Math.min(1, Math.max(0.28, this.viewSize / 9));
    for (const t of this.tags) t.sprite.scale.set(t.base.x * k, t.base.y * k, 1);
    const v = new THREE.Vector3();
    for (const t of this.tags) if (!t.want) t.show = false;
    for (const t of list) {
      t.sprite.getWorldPosition(v);
      v.project(this.camera);
      const cx = ((v.x + 1) / 2) * r.width;
      const cy = ((1 - v.y) / 2) * r.height;
      const w = t.sprite.scale.x * pxPerM;
      const h = t.sprite.scale.y * pxPerM;
      const box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
      const off = box.x1 < 0 || box.y1 < 0 || box.x0 > r.width || box.y0 > r.height;
      const hit = placed.some(
        (p) => !(box.x1 < p.x0 || box.x0 > p.x1 || box.y1 < p.y0 || box.y0 > p.y1),
      );
      t.show = !off && !hit;
      if (t.show) placed.push(box);
    }
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
    this.extWalls = [];
    this.lamps = [];
    this.bulbs = [];
    this.glasses = [];
    this.clocks = [];
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
    const office = layout.kind === 'ESCRITORIO';

    // Sol: enquadra a sala inteira (sombras estáveis ao mover a câmera).
    const half = Math.max(W, D) / 2 + 3;
    this.sun.shadow.camera.left = -half;
    this.sun.shadow.camera.right = half;
    this.sun.shadow.camera.top = half;
    this.sun.shadow.camera.bottom = -half;
    this.sun.shadow.camera.far = 120;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.target.position.set(W / 2, 0, D / 2);

    // Base externa e piso com textura (madeira no escritório, cimento queimado na oficina).
    const base = new THREE.Mesh(new THREE.BoxGeometry(W + 1.2, 0.3, D + 1.2), mat('#93b3ab'));
    base.position.set(W / 2, -0.16, D / 2);
    base.receiveShadow = true;
    this.staticGroup.add(base);
    const tex = floorTexture(office ? 'wood' : 'concrete').clone();
    tex.needsUpdate = true;
    const rep = office ? 2 : 4;
    tex.repeat.set(W / rep, D / rep);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ map: tex, roughness: office ? 0.7 : 0.9, color: '#ffffff' }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    floor.receiveShadow = true;
    this.staticGroup.add(floor);
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

    // Áreas: piso tingido de leve, faixa de demarcação e nome pintado no chão.
    for (const a of layout.areas) {
      const r = rectOfArea(a);
      const color = a.color ?? AREA_FUNCTION_COLOR[a.function];
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(r.w * CM, r.d * CM),
        new THREE.MeshStandardMaterial({
          color,
          transparent: true,
          opacity: build ? 0.7 : 0.38,
          roughness: 1,
          depthWrite: false,
        }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set((r.x + r.w / 2) * CM, 0.003, (r.y + r.d / 2) * CM);
      tile.receiveShadow = true;
      this.staticGroup.add(tile);
      // Faixa pintada nas bordas da área (como demarcação de chão de fábrica).
      const stripe = new THREE.Color(color).offsetHSL(0, 0.1, -0.22).getStyle();
      const sm = new THREE.MeshBasicMaterial({
        color: opts.selectedId === a.id ? '#a8743f' : stripe,
        transparent: true,
        opacity: opts.selectedId === a.id ? 1 : 0.7,
        depthWrite: false,
      });
      const t = 0.05;
      for (const [w, d, x, z] of [
        [r.w * CM, t, (r.x + r.w / 2) * CM, r.y * CM + t / 2],
        [r.w * CM, t, (r.x + r.w / 2) * CM, (r.y + r.d) * CM - t / 2],
        [t, r.d * CM, r.x * CM + t / 2, (r.y + r.d / 2) * CM],
        [t, r.d * CM, (r.x + r.w) * CM - t / 2, (r.y + r.d / 2) * CM],
      ] as const) {
        const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), sm);
        s.rotation.x = -Math.PI / 2;
        s.position.set(x, 0.006, z);
        this.staticGroup.add(s);
      }
      const ft = floorText(a.name, '#1d2523', Math.min(r.w * CM * 0.8, 3.2));
      ft.position.set(
        (r.x + 20) * CM + (ft.geometry as THREE.PlaneGeometry).parameters.width / 2,
        0.008,
        (r.y + 30) * CM,
      );
      this.staticGroup.add(ft);
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
    this.boards = [];
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
      if (s.kind === 'QUADRO_METAS') this.boards.push({ holder, w: s.wCm * CM });
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
        this.tag(lb, build ? 6 : 1, s.id);
      }
      // Luminária pendente sobre bancadas e mesas (acende à noite).
      if (!build && !['QUADRO_METAS'].includes(s.kind)) {
        const lamp = pendantLamp();
        lamp.position.set((f.x + f.w / 2) * CM, 0, (f.y + f.d / 2) * CM);
        this.staticGroup.add(lamp);
        const bulb = lamp.getObjectByName('bulb');
        if (bulb) this.bulbs.push(lamp);
      }
    }
    this.addLampLights(layout, build);
    if (this.boardState) this.drawBoards(true);
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
      this.tag(lb, build ? 5 : 1, u.id);
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
    if (!build) this.addAmbience(layout, opts.rewards ?? []);
    // Paredes já na altura certa: sem isso, toda reconstrução as fazia subir e descer de novo.
    this.updateWalls(0, true);

    // Mestre de Obras (só no modo Construção).
    if (this.mestre) this.peopleGroup.remove(this.mestre);
    this.mestre = null;
    if (opts.mode === 'CONSTRUCAO') {
      const g = avatar('#e76f1a', 'MESTRE', 'Mestre de Obras');
      const entry = layout.doc.doors[0]
        ? doorCenter(layout, layout.doc.doors[0])
        : { x: 100, y: layout.depthCm - 100 };
      const p = this.freeNear(entry ?? { x: 100, y: 100 }, 120);
      g.position.set(p.x * CM, 0, p.y * CM);
      g.rotation.y = Math.PI / 4;
      const tag = label('Mestre de Obras', { size: 20, bg: 'rgba(231,111,26,0.95)', icon: '🦺' });
      tag.position.set(0, 1.55, 0);
      g.add(tag);
      this.tag(tag, 9, 'mestre');
      this.peopleGroup.add(g);
      this.register(g, { kind: 'mestre', id: 'mestre' });
      this.mestre = g;
    }

    this.buildDock(layout, build);

    this.walkGrid = buildGrid(layout, { inflateCm: 22, cell: 25 });
    if (!this.player || spaceChanged) this.spawnPlayer();
    if (firstTime) {
      this.overview(false);
      if (spaceChanged) {
        // Entrada no ambiente: começa um pouco mais perto e abre até a visão geral.
        const s = this.viewSize;
        this.viewSize = s * 0.82;
        this.updateCamera();
        this.animateTo(this.target.clone(), s, 0.7);
      }
    }
    this.lastLightAt = -1;
    this.updateLight(true);
    this.applyFocus();
  }

  /** Luzes reais (sem sombra) nas luminárias mais centrais, para a noite. */
  private addLampLights(layout: LayoutContent, build: boolean) {
    if (build || !this.bulbs.length) return;
    const cx = (layout.widthCm * CM) / 2;
    const cz = (layout.depthCm * CM) / 2;
    const chosen = [...this.bulbs]
      .sort(
        (a, b) =>
          a.position.distanceTo(new THREE.Vector3(cx, 0, cz)) -
          b.position.distanceTo(new THREE.Vector3(cx, 0, cz)),
      )
      .slice(0, 5);
    for (const b of chosen) {
      const l = new THREE.PointLight('#ffd9a0', 0, 6, 1.6);
      l.position.set(b.position.x, 1.9, b.position.z);
      l.layers.enable(1);
      l.visible = this.quality !== 'baixa';
      this.staticGroup.add(l);
      this.lamps.push(l);
    }
  }

  /**
   * Ambientação (só visual, não ocupa lugar na planta): janelas, painel de ferramentas, quadro de
   * avisos, relógio, prateleira de tecidos, plantas nos cantos livres e recompensas das missões.
   */
  private addAmbience(layout: LayoutContent, rewards: string[]) {
    const W = layout.widthCm;
    const D = layout.depthCm;
    const office = layout.kind === 'ESCRITORIO';
    const tall = layout.storageUnits.map((u) => footprint(u));
    for (const s of layout.stations) if (s.kind === 'QUADRO_METAS') tall.push(footprint(s));
    const nearWall = (w: string, a: number, b: number) =>
      tall.some((r) => {
        if (w === 'N') return r.y < 60 && r.x < b && r.x + r.w > a;
        if (w === 'S') return r.y + r.d > D - 60 && r.x < b && r.x + r.w > a;
        if (w === 'O') return r.x < 60 && r.y < b && r.y + r.d > a;
        return r.x + r.w > W - 60 && r.y < b && r.y + r.d > a;
      });
    let clockDone = false;
    let boardDone = false;
    let pegDone = office;
    let shelfDone = office;
    for (const wall of this.extWalls) {
      const id = wall.g.userData.wallId as string;
      const len = id === 'N' || id === 'S' ? W : D;
      // Trechos livres: sem porta, sem janela cadastrada e sem armário alto encostado.
      const blocks: [number, number][] = [
        ...layout.doc.doors
          .filter((d) => d.wall === id)
          .map((d) => [d.offsetCm - 30, d.offsetCm + d.widthCm + 30] as [number, number]),
        ...(layout.doc.windows ?? [])
          .filter((x) => x.wall === id)
          .map((x) => [x.offsetCm - 20, x.offsetCm + x.widthCm + 20] as [number, number]),
      ];
      const free = (a: number, b: number) =>
        a >= 40 && b <= len - 40 && !blocks.some(([x, y]) => a < y && b > x) && !nearWall(id, a, b);
      const place = (w: number, obj: THREE.Object3D, from = 0.5) => {
        // Procura um trecho livre perto da posição preferida.
        const steps = Math.ceil(len / 25);
        for (let i = 0; i <= steps; i++) {
          for (const sgn of [1, -1]) {
            const c = len * from + sgn * i * 25;
            const a = c - w / 2;
            const b = c + w / 2;
            if (!free(a, b)) continue;
            blocks.push([a - 20, b + 20]);
            this.mountOnWall(wall, id, c, obj);
            return true;
          }
        }
        return false;
      };
      // Janelas automáticas quando a planta não tem nenhuma.
      if (!(layout.doc.windows ?? []).length) {
        const n = Math.max(1, Math.floor(len / 450));
        for (let i = 0; i < n; i++) {
          const win = wallWindow(1.6, 0.14);
          place(170, win, (i + 0.5) / n);
          const glass = win.getObjectByName('glass') as THREE.Mesh | undefined;
          if (glass) this.glasses.push(glass);
        }
      }
      if (!pegDone && place(110, pegboard(1.0), 0.3)) pegDone = true;
      if (!shelfDone && place(160, wallFabricShelf(1.5), 0.7)) shelfDone = true;
      if (!boardDone && place(100, noticeBoard(0.9), office ? 0.3 : 0.55)) boardDone = true;
      if (!clockDone) {
        const c = wallClock();
        if (place(50, c, 0.85)) {
          clockDone = true;
          this.clocks.push(c);
        }
      }
      // Troféus das missões numa prateleira.
      if (rewards.some((r) => r.startsWith('trofeu'))) {
        const shelf = new THREE.Group();
        shelf.add(
          Object.assign(
            new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.2), mat(PALETTE.woodDark)),
            { position: new THREE.Vector3(0, 1.62, 0.1) },
          ),
        );
        rewards
          .filter((r) => r.startsWith('trofeu'))
          .slice(0, 4)
          .forEach((r, i) => {
            const t = trophy(['#e0a63a', '#c0c7c9', '#b87333', '#e0a63a'][i]!);
            t.position.set(-0.3 + i * 0.2, 1.64, 0.1);
            shelf.add(t);
          });
        if (place(100, shelf, 0.15)) rewards = rewards.filter((r) => !r.startsWith('trofeu'));
      }
    }
    // Plantas nos cantos livres.
    const obstacles = [...layout.stations, ...layout.storageUnits, ...layout.doc.decor].map((o) =>
      footprint(o),
    );
    const doors = layout.doc.doors
      .map((d) => doorCenter(layout, d))
      .filter((c): c is { x: number; y: number } => Boolean(c));
    const corners = [
      [45, 45],
      [W - 45, 45],
      [45, D - 45],
      [W - 45, D - 45],
    ];
    const extraPlants = rewards.includes('plantas') ? 4 : 0;
    let k = 0;
    for (const [x, y] of corners) {
      const r = { x: x! - 40, y: y! - 40, w: 80, d: 80 };
      if (
        obstacles.some(
          (o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.d && r.y + r.d > o.y,
        )
      )
        continue;
      if (doors.some((d) => Math.hypot(d.x - x!, d.y - y!) < 140)) continue;
      if (k >= 2 + extraPlants) break;
      const p = plant(k);
      p.position.set(x! * CM, 0, y! * CM);
      this.staticGroup.add(p);
      k++;
    }
    // Tapete de recompensa no centro livre do escritório/oficina.
    if (rewards.includes('tapete')) {
      const g = this.walkGrid ?? buildGrid(layout, { inflateCm: 0, cell: 25 });
      const c = nearestFree(g, { x: W / 2, y: D / 2 });
      if (c) {
        const r = rug(2.0, 1.4, office ? '#2f6f68' : '#a0574f');
        r.position.set(c.x * CM, 0, c.y * CM);
        this.staticGroup.add(r);
      }
    }
  }

  /** Prende um objeto na parede (em `offsetCm` ao longo dela), virado para dentro da sala. */
  private mountOnWall(
    wall: { g: THREE.Group; mounted: THREE.Object3D[] },
    id: string,
    offsetCm: number,
    obj: THREE.Object3D,
  ) {
    if (!this.layout) return;
    const W = this.layout.widthCm * CM;
    const D = this.layout.depthCm * CM;
    const o = offsetCm * CM;
    const inset = 0.08;
    if (id === 'N') {
      obj.position.set(o, 0, inset);
    } else if (id === 'S') {
      obj.position.set(o, 0, D - inset);
      obj.rotation.y = Math.PI;
    } else if (id === 'O') {
      obj.position.set(inset, 0, o);
      obj.rotation.y = Math.PI / 2;
    } else {
      obj.position.set(W - inset, 0, o);
      obj.rotation.y = -Math.PI / 2;
    }
    // Janela fica no plano da parede (atravessa a espessura).
    if (obj.getObjectByName('glass')) {
      if (id === 'N') obj.position.z = -0.07;
      if (id === 'S') obj.position.z = D + 0.07;
      if (id === 'O') obj.position.x = -0.07;
      if (id === 'L') obj.position.x = W + 0.07;
    }
    obj.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = false;
    });
    this.staticGroup.add(obj);
    wall.mounted.push(obj);
  }

  private isIn(o: THREE.Object3D, g: THREE.Object3D) {
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
    const normals: Record<string, THREE.Vector3> = {
      N: new THREE.Vector3(0, 0, -1),
      S: new THREE.Vector3(0, 0, 1),
      O: new THREE.Vector3(-1, 0, 0),
      L: new THREE.Vector3(1, 0, 0),
    };
    const all = [
      ...ext.map((w) => ({ ...w, ext: true })),
      ...l.doc.walls.map((w) => ({ ...w, ext: false })),
    ];
    for (const w of all) {
      // Externas nascem altas e o motor baixa as que ficam na frente da câmera.
      const H = w.ext ? WALL_H : build ? 1.6 : 1.1;
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
      const color = w.ext ? PALETTE.wall : '#6f9c94';
      for (const [a, b] of segs) {
        const sl = (b - a) * CM;
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
        // Rodapé claro do lado de dentro.
        if (w.ext) {
          const sk = new THREE.Mesh(
            new THREE.BoxGeometry(horizontal ? sl : 0.02, 0.1, horizontal ? 0.02 : sl),
            mat('#e8e0d0'),
          );
          const inward = normals[w.id]!.clone().multiplyScalar(-(T / 2 + 0.01));
          sk.position.copy(m.position).add(inward).setY(0.05);
          group.add(sk);
        }
        const top = new THREE.Mesh(
          new THREE.BoxGeometry(horizontal ? sl : T + 0.02, 0.04, horizontal ? T + 0.02 : sl),
          mat(PALETTE.wallTop),
        );
        top.position.copy(m.position).setY(H + 0.02);
        group.add(top);
      }
      // Janelas cadastradas pelo Mestre de Obras.
      for (const win of l.doc.windows?.filter((x) => x.wall === w.id) ?? []) {
        const mid = (start + win.offsetCm + win.widthCm / 2) * CM;
        const wn = wallWindow(win.widthCm * CM, T);
        if (!horizontal) wn.rotation.y = Math.PI / 2;
        const off = w.ext ? (w.id === 'N' || w.id === 'O' ? -T / 2 : T / 2) : 0;
        if (horizontal) wn.position.set(mid, 0, w.y1 * CM + off);
        else wn.position.set(w.x1 * CM + off, 0, mid);
        if (!w.ext) wn.scale.y = Math.min(1, H / 2.2);
        group.add(wn);
        const glass = wn.getObjectByName('glass') as THREE.Mesh | undefined;
        if (glass) this.glasses.push(glass);
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
          s.position.set(c.x * CM, 1.2, c.y * CM);
          this.staticGroup.add(s);
          this.tag(s, d.toSpaceKey ? 4 : 2, d.id);
        }
      }
      this.staticGroup.add(group);
      if (w.ext) {
        group.userData.wallId = w.id;
        this.extWalls.push({ g: group, normal: normals[w.id]!, mounted: [] });
      } else this.register(group, { kind: 'wall', id: w.id });
    }
  }

  /** Altura das paredes externas conforme o giro: as de trás altas, as da frente baixas. */
  private updateWalls(dt: number, instant = false) {
    const dir = this.camDir();
    dir.y = 0;
    dir.normalize();
    for (const w of this.extWalls) {
      const back = w.normal.dot(dir) < -0.1;
      const want = back ? 1 : WALL_LOW / WALL_H;
      const cur = w.g.scale.y;
      const next = instant ? want : cur + (want - cur) * Math.min(1, dt * 8);
      w.g.scale.y = next;
      const show = next > 0.6;
      for (const m of w.mounted) m.visible = show;
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

  // ───────────────────────────── Pátio: furgão e cliente ─────────────────────────────

  private static readonly LANE = 2.5;
  private static readonly PARK = 2.25;

  private yawOf(d: THREE.Vector3) {
    return Math.atan2(-d.z, d.x);
  }
  private lane(wall: string, t: number) {
    const w = this.yard!.walls[wall]!;
    return w.origin.clone().addScaledVector(w.along, t).addScaledVector(w.out, GameEngine.LANE);
  }
  private tOf(wall: string, p: THREE.Vector3) {
    const w = this.yard!.walls[wall]!;
    return p.clone().sub(w.origin).dot(w.along);
  }

  /**
   * Rua do lado de fora dos portões para a rua (recebimento e expedição) com o furgão. Só na
   * oficina, fora do modo Construção.
   */
  private buildDock(layout: LayoutContent, build: boolean) {
    // A planta é redesenhada a cada seleção: o pátio só refaz se os portões mudaram (senão o
    // furgão voltaria para a vaga no meio do trajeto).
    const sig = JSON.stringify([
      layout.name,
      layout.kind,
      build,
      layout.widthCm,
      layout.depthCm,
      layout.doc.doors,
    ]);
    if (sig === this.yardSig && this.yard) {
      if (this.van) this.register(this.van.g, { kind: 'van', id: 'van' });
      return;
    }
    this.yardSig = sig;
    this.clearGroup(this.logisticsGroup);
    this.yard = null;
    this.van = null;
    this.visitor = null;
    if (build || layout.kind === 'ESCRITORIO') return;
    const ext = layout.doc.doors.filter(
      (d) => ['N', 'S', 'L', 'O'].includes(d.wall) && !d.toSpaceKey,
    );
    const exped =
      ext.find((d) => /expedi|sa[ií]da|entrega/i.test(d.label ?? '')) ??
      ext.find((d) => /port|entrada/i.test(d.label ?? '')) ??
      ext[0];
    const receb =
      ext.find((d) => /receb|chegada|retirada/i.test(d.label ?? '')) ??
      ext.find((d) => d !== exped && /port|entrada/i.test(d.label ?? '')) ??
      exped;
    if (!exped || !receb) return;
    const OUT = {
      N: new THREE.Vector3(0, 0, -1),
      S: new THREE.Vector3(0, 0, 1),
      O: new THREE.Vector3(-1, 0, 0),
      L: new THREE.Vector3(1, 0, 0),
    } as const;
    const walls: Record<string, YardWall> = {};
    const spots = {} as Record<'RECEB' | 'EXPED', YardSpot>;
    for (const [key, door] of [
      ['RECEB', receb],
      ['EXPED', exped],
    ] as const) {
      const cc = doorCenter(layout, door);
      if (!cc) return;
      const out = OUT[door.wall as keyof typeof OUT];
      const c = new THREE.Vector3(cc.x * CM, 0, cc.y * CM);
      if (!walls[door.wall])
        walls[door.wall] = {
          origin: c.clone(),
          out,
          along: new THREE.Vector3(-out.z, 0, out.x),
          min: 0,
          max: 0,
        };
      const w = walls[door.wall]!;
      const t = c.clone().sub(w.origin).dot(w.along);
      w.min = Math.min(w.min, t);
      w.max = Math.max(w.max, t);
      const entry = c.clone().addScaledVector(out, -0.9);
      spots[key] = {
        wall: door.wall,
        door: c,
        out,
        park: c.clone().addScaledVector(out, GameEngine.PARK),
        t,
        entryCm: { x: entry.x / CM, y: entry.z / CM },
      };
    }
    this.yard = { spots, walls };
    // Rua (o piso da base vai só até 0,6 m da parede) com faixa tracejada.
    const depth = 3.6;
    for (const w of Object.values(walls)) {
      w.min -= 6;
      w.max += 6;
      const len = w.max - w.min;
      const mid = w.origin.clone().addScaledVector(w.along, (w.min + w.max) / 2);
      const xAlong = w.along.x !== 0;
      const road = new THREE.Mesh(
        new THREE.BoxGeometry(xAlong ? len : depth, 0.3, xAlong ? depth : len),
        mat('#5f6668', { rough: 0.95 }),
      );
      road.position
        .copy(mid)
        .addScaledVector(w.out, 0.6 + depth / 2)
        .setY(-0.17);
      road.receiveShadow = true;
      this.logisticsGroup.add(road);
      for (let i = w.min + 0.7; i <= w.max - 0.7; i += 1.4) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(xAlong ? 0.7 : 0.08, 0.01, xAlong ? 0.08 : 0.7),
          mat('#e8e2cf'),
        );
        m.position
          .copy(w.origin)
          .addScaledVector(w.along, i)
          .addScaledVector(w.out, 0.6 + depth * 0.78)
          .setY(-0.015);
        this.logisticsGroup.add(m);
      }
    }
    // Faixa de vaga pintada na frente de cada portão.
    for (const sp of Object.values(spots)) {
      const xAlong = sp.out.z !== 0;
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(xAlong ? 0.08 : 3.2, 0.01, xAlong ? 3.2 : 0.08),
          mat('#e8e2cf'),
        );
        m.position
          .copy(sp.park)
          .addScaledVector(new THREE.Vector3(-sp.out.z, 0, sp.out.x), side * 1.05)
          .setY(-0.014);
        this.logisticsGroup.add(m);
      }
    }
    const g = vanModel(PALETTE.bronze);
    this.logisticsGroup.add(g);
    this.register(g, { kind: 'van', id: 'van' });
    const cargo = wrappedCargo();
    cargo.visible = false;
    this.logisticsGroup.add(cargo);
    const start = spots.EXPED;
    g.position.copy(start.park);
    g.rotation.y = this.yawOf(start.out);
    this.van = {
      g,
      tag: null,
      cargo,
      at: 'EXPED',
      wall: start.wall,
      path: [],
      text: '',
      loading: false,
    };
    this.prevTrips.clear();
    this.applyLogistics(true);
  }

  /** Retiradas e entregas de hoje: o furgão sai, volta e para no portão certo. */
  setLogistics(v: LogisticsView | null) {
    const first = !this.logistics;
    this.logistics = v;
    this.applyLogistics(first);
  }

  private applyLogistics(instant: boolean) {
    const v = this.logistics;
    const van = this.van;
    const yard = this.yard;
    if (!van || !yard) return;
    const trips = v?.trips ?? [];
    // Retirada que acabou de voltar: vai descarregar no recebimento.
    for (const t of trips) {
      const before = this.prevTrips.get(t.id);
      if (before === 'NA_RUA' && t.status === 'FEITA' && t.kind === 'RETIRADA')
        this.vanSticky = {
          text: `Descarregando: retirada de ${t.customer}`,
          until: Date.now() + 120_000,
        };
    }
    this.prevTrips = new Map(trips.map((t) => [t.id, t.status]));
    if (this.vanSticky && Date.now() > this.vanSticky.until) this.vanSticky = null;
    const out = trips.filter((t) => t.status === 'NA_RUA');
    const nextDelivery = trips.find((t) => t.kind === 'ENTREGA' && t.status === 'AGENDADA');
    const left = trips.filter((t) => t.status === 'AGENDADA');
    const ent = left.filter((t) => t.kind === 'ENTREGA').length;
    const ret = left.filter((t) => t.kind === 'RETIRADA').length;
    let target: 'RECEB' | 'EXPED' | 'AWAY';
    let text: string;
    let loading = false;
    if (out.length) {
      target = 'AWAY';
      const o = out[0]!;
      text = `Na rua: ${o.kind === 'ENTREGA' ? `entrega para ${o.customer}` : `retirada de ${o.customer}`}${out.length > 1 ? ` e mais ${out.length - 1}` : ''}`;
    } else if (this.vanSticky) {
      target = 'RECEB';
      text = this.vanSticky.text;
      loading = true;
    } else if (nextDelivery) {
      target = 'EXPED';
      text = `Carregando: entrega para ${nextDelivery.customer}${ent > 1 ? ` (+${ent - 1})` : ''}`;
      loading = true;
    } else {
      // Sem entrega para carregar: espera no recebimento se a próxima saída é uma retirada.
      target = ret ? 'RECEB' : 'EXPED';
      const parts = [
        ent ? `${ent} ${ent === 1 ? 'entrega' : 'entregas'}` : '',
        ret ? `${ret} ${ret === 1 ? 'retirada' : 'retiradas'}` : '',
      ].filter(Boolean);
      text = parts.length
        ? `Hoje: ${parts.join(' e ')}`
        : trips.length
          ? 'Roteiro de hoje concluído'
          : 'Sem saídas hoje';
    }
    van.loading = loading;
    if (van.text !== text) {
      van.text = text;
      if (van.tag) {
        van.tag.removeFromParent();
        const m = van.tag.material as THREE.SpriteMaterial;
        m.map?.dispose();
        m.dispose();
      }
      const tag = label(`🚚 ${text}`, {
        size: 18,
        bg: target === 'AWAY' ? 'rgba(168,116,63,0.95)' : 'rgba(29,37,35,0.82)',
      });
      this.logisticsGroup.add(tag);
      this.tag(tag, 6, 'van');
      van.tag = tag;
    }
    this.routeVan(target, instant);
    // Reavalia quando o "descarregando" acaba.
    if (this.vanTimer !== null) window.clearTimeout(this.vanTimer);
    this.vanTimer = this.vanSticky
      ? window.setTimeout(
          () => {
            this.vanTimer = null;
            this.applyLogistics(false);
          },
          Math.max(500, this.vanSticky.until - Date.now() + 50),
        )
      : null;
    // Cliente que veio buscar a peça: espera no portão de expedição (por onde ela sai).
    if (this.visitor) {
      this.peopleGroup.remove(this.visitor);
      this.visitor = null;
    }
    if (v?.visitor && this.layout) {
      const g = avatar('#5b6b7a', 'CLIENTE', v.visitor.id, { name: v.visitor.name });
      const sp = yard.spots.EXPED;
      const p = this.freeNear(sp.entryCm, 80);
      g.position.set(p.x * CM, 0, p.y * CM);
      g.rotation.y = Math.atan2(-sp.out.x, -sp.out.z);
      const t = label(`Cliente: ${v.visitor.name} veio buscar`, {
        size: 18,
        bg: 'rgba(31,122,70,0.95)',
        icon: '🛋️',
      });
      t.position.set(0, 1.55, 0);
      g.add(t);
      this.tag(t, 7, 'visitor');
      this.peopleGroup.add(g);
      this.register(g, { kind: 'visitor', id: 'visitor' });
      this.visitor = g;
    }
  }

  /** Monta o trajeto do furgão até a vaga (ou até sumir na rua). */
  private routeVan(target: 'RECEB' | 'EXPED' | 'AWAY', instant: boolean) {
    const van = this.van!;
    const yard = this.yard!;
    if (van.at === target && (van.path.length || instant || target === 'AWAY')) return;
    if (van.at === target && !van.path.length) {
      // Já parado na vaga certa.
      return;
    }
    const from = van.at;
    van.at = target;
    if (instant) {
      van.path = [];
      if (target === 'AWAY') van.g.visible = false;
      else {
        const sp = yard.spots[target];
        van.g.visible = true;
        van.g.position.copy(sp.park);
        van.g.rotation.y = this.yawOf(sp.out);
        van.wall = sp.wall;
      }
      return;
    }
    const steps: VanStep[] = [];
    const leave = (wall: string) => {
      steps.push({ p: this.lane(wall, this.tOf(wall, van.g.position)) });
      steps.push({ p: this.lane(wall, yard.walls[wall]!.max + 3), hide: true });
    };
    const arrive = (sp: YardSpot) => {
      steps.push({ p: this.lane(sp.wall, yard.walls[sp.wall]!.min - 3), teleport: true });
      steps.push({ p: this.lane(sp.wall, sp.t) });
      steps.push({ p: sp.park.clone(), reverse: true });
    };
    const hidden = from === 'AWAY' && !van.g.visible;
    if (target === 'AWAY') {
      if (!hidden) leave(van.wall);
    } else {
      const sp = yard.spots[target];
      if (hidden) arrive(sp);
      else if (sp.wall === van.wall) {
        steps.push({ p: this.lane(van.wall, this.tOf(van.wall, van.g.position)) });
        steps.push({ p: this.lane(sp.wall, sp.t) });
        steps.push({ p: sp.park.clone(), reverse: true });
      } else {
        leave(van.wall);
        arrive(sp);
      }
    }
    van.path = steps;
  }

  /** Anda o furgão pelo trajeto (rodas giram; entra de ré na vaga). */
  private stepVan(dt: number) {
    const van = this.van;
    if (!van || !this.yard) return;
    const parked = !van.path.length && van.at !== 'AWAY';
    van.cargo.visible = parked && van.loading && van.g.visible;
    if (van.cargo.visible) {
      const sp = this.yard.spots[van.at as 'RECEB' | 'EXPED'];
      // Ao lado da traseira, para aparecer na visão do alto.
      van.cargo.position
        .copy(sp.door)
        .addScaledVector(sp.out, 0.7)
        .addScaledVector(new THREE.Vector3(sp.out.z, 0, -sp.out.x), 1.55);
      van.cargo.rotation.y = this.yawOf(sp.out);
    }
    if (van.tag) {
      const at = van.g.visible ? van.g.position : this.yard.spots.EXPED.park;
      van.tag.position.set(at.x, 2.45, at.z);
    }
    const step = van.path[0];
    if (!step) return;
    if (step.teleport) {
      van.g.position.copy(step.p);
      van.g.visible = true;
      const next = van.path[1];
      if (next) van.g.rotation.y = this.yawOf(next.p.clone().sub(step.p));
      const wall = Object.entries(this.yard.walls).find(
        ([, w]) => Math.abs(step.p.clone().sub(w.origin).dot(w.out) - GameEngine.LANE) < 0.01,
      );
      if (wall) van.wall = wall[0];
      van.path.shift();
      return;
    }
    const d = step.p.clone().sub(van.g.position);
    d.y = 0;
    const dist = d.length();
    const speed = step.reverse ? 1.6 : 3.4;
    const move = Math.min(dist, speed * dt);
    if (dist > 1e-4) {
      // De ré na vaga: a frente fica para a rua.
      const yaw = step.reverse ? this.yawOf(d.clone().negate()) : this.yawOf(d);
      const diff = Math.atan2(Math.sin(yaw - van.g.rotation.y), Math.cos(yaw - van.g.rotation.y));
      van.g.rotation.y += diff * Math.min(1, dt * 5);
      van.g.position.addScaledVector(d.normalize(), move);
      van.g.traverse((o) => {
        if (o.name === 'wheel') o.rotation.z += (step.reverse ? 1 : -1) * dt * 8;
      });
    }
    if (dist - move < 0.03) {
      van.g.position.copy(step.p);
      if (step.hide) van.g.visible = false;
      van.path.shift();
    }
  }

  /** Aparência escolhida pela pessoa para o "Você"; troca o boneco no mesmo lugar. */
  setPlayerLook(look: AvatarLook | null) {
    const same = JSON.stringify(look) === JSON.stringify(this.playerLook);
    this.playerLook = look;
    if (same || !this.player) return;
    const at = this.playerCm() ?? undefined;
    const rot = this.player.g.rotation.y;
    this.spawnPlayer(at);
    if (this.player) (this.player as { g: THREE.Group }).g.rotation.y = rot;
  }

  private spawnPlayer(at?: { x: number; y: number }) {
    if (!this.layout) return;
    if (this.player) this.peopleGroup.remove(this.player.g);
    const g = avatar(PALETTE.bronze, 'JOGADOR', 'voce', { look: this.playerLook });
    const tag = label('Você', { size: 20, bg: 'rgba(168,116,63,0.95)' });
    tag.position.set(0, 1.5, 0);
    g.add(tag);
    this.tag(tag, 8, 'player');
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

  // ───────────────────────────── Seleção em destaque ─────────────────────────────

  /** Destaca um objeto (peça, pessoa, estação…): o resto da cena escurece. */
  setFocus(id: string | null) {
    if (this.focusId === id) return;
    this.focusId = id;
    this.lastTagLayout = 0;
    this.applyFocus();
  }

  private applyFocus() {
    if (this.focusObj) this.focusObj.traverse((o) => o.layers.disable(1));
    const id = this.focusId;
    const o = id
      ? (this.pieces.get(id)?.g ?? this.people.get(id)?.g ?? this.objects.get(id) ?? null)
      : null;
    this.focusObj = o;
    if (o) o.traverse((x) => x.layers.enable(1));
  }

  // ───────────────────────────── Operação (dinâmico) ─────────────────────────────

  setPieces(list: PieceVisual[]) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const key = `${p.model}|${p.stage}|${p.color}|${p.label}|${p.highlight ? 1 : 0}|${p.confirmed?.text ?? ''}|${p.phase ?? ''}|${p.dimmed ? 1 : 0}|${p.tone ?? ''}`;
      let e = this.pieces.get(p.id);
      const to = new THREE.Vector3(p.x * CM, 0, p.y * CM);
      if (!e || e.key !== key) {
        const old = e;
        const g = new THREE.Group();
        const body = furniture(p.model, p.color, p.stage);
        g.add(body);
        const tone = p.tone ?? '#1f7a46';
        const [sw, sd] = FURNITURE_SIZE[p.model];
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(Math.max(sw, sd) * 0.55, Math.max(sw, sd) * 0.6, 40),
          new THREE.MeshBasicMaterial({
            color: tone,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        ring.name = 'ring';
        g.add(ring);
        // Etiqueta curta (sempre) e completa (ao passar o mouse, selecionar ou aproximar).
        const short = label(`${p.icon ?? ''} ${p.osCode}`.trim(), {
          size: 18,
          bg: p.highlight ? 'rgba(168,116,63,0.97)' : 'rgba(255,255,255,0.92)',
          fg: p.highlight ? '#fff' : '#1d2523',
          border: tone,
        });
        const full = label(`${p.osCode}${p.phase ? ` · ${p.phase}` : ''} · ${p.label}`, {
          size: 20,
          bg: p.highlight ? 'rgba(168,116,63,0.97)' : 'rgba(255,255,255,0.96)',
          fg: p.highlight ? '#fff' : '#1d2523',
          border: tone,
        });
        const ty = p.model === 'CABECEIRA' ? 1.6 : 1.25;
        short.position.set(0, ty, 0);
        full.position.set(0, ty, 0);
        g.add(short, full);
        this.tag(short, p.highlight ? 50 : 5, p.id);
        this.tag(full, p.highlight ? 60 : 7, p.id, false);
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
        g.rotation.y = old ? old.g.rotation.y : p.rot;
        if (p.dimmed)
          g.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.Material | undefined;
            if (m && 'opacity' in m) {
              const c = m.clone();
              c.transparent = true;
              c.opacity = Math.min(c.opacity, 0.22);
              (o as THREE.Mesh).material = c;
            }
          });
        if (old) {
          this.pieceGroup.remove(old.g);
          if (old.ghost) this.pieceGroup.remove(old.ghost);
        }
        this.pieceGroup.add(g);
        this.pickables = this.pickables.filter((x) => x !== old?.g);
        this.register(g, { kind: 'piece', id: p.id });
        e = {
          g,
          to,
          rot: p.rot,
          key,
          path: old?.path ?? [],
          cart: null,
          short,
          full,
          highlight: Boolean(p.highlight),
        };
        if (old?.cart) {
          e.cart = old.cart;
          g.add(old.cart);
        }
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
          this.tag(t, 3, p.id);
          ghost.position.set(p.confirmed.x * CM, 0, p.confirmed.y * CM);
          this.pieceGroup.add(ghost);
          e.ghost = ghost;
        }
        if (this.focusId === p.id) this.applyFocus();
      }
      // Mudou de lugar de verdade: vai de carrinho pelo corredor.
      if (e.to.distanceTo(to) > 0.4 && e.g.position.distanceTo(to) > 0.4) {
        e.path = this.routeBetween(e.g.position, to);
        if (!e.cart) {
          const [w, d] = FURNITURE_SIZE[p.model];
          e.cart = cart(w, d);
          e.g.add(e.cart);
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

  private routeBetween(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.walkGrid) return [b.clone()];
    const s = nearestFree(this.walkGrid, { x: a.x / CM, y: a.z / CM });
    const t = nearestFree(this.walkGrid, { x: b.x / CM, y: b.z / CM });
    const path = s && t ? findPath(this.walkGrid, s, t) : null;
    return path
      ? [...path.map((q) => new THREE.Vector3(q.x * CM, 0, q.y * CM)), b.clone()]
      : [b.clone()];
  }

  setPeople(list: PersonVisual[]) {
    const seen = new Set<string>();
    for (const p of list) {
      seen.add(p.id);
      const key = `${p.kind}|${p.name}|${p.color}|${p.status ?? ''}|${p.dim ? 1 : 0}|${p.activity ?? ''}|${(p.roles ?? []).join(',')}`;
      let e = this.people.get(p.id);
      const to = new THREE.Vector3(p.x * CM, 0, p.y * CM);
      if (!e || e.key !== key) {
        const old = e;
        const g = avatar(p.color, p.kind === 'agent' ? 'AGENTE' : 'PESSOA', p.id, {
          name: p.name,
          roles: p.roles,
        });
        const tool = g.getObjectByName('toolR');
        if (tool && p.activity) tool.add(toolModel(p.activity));
        const tag = label(p.status ? `${p.name} · ${p.status}` : p.name, {
          size: 18,
          bg: p.kind === 'agent' ? 'rgba(91,33,182,0.92)' : 'rgba(29,37,35,0.85)',
          icon: p.kind === 'agent' ? '🤖' : undefined,
        });
        tag.position.set(0, 1.5, 0);
        g.add(tag);
        this.tag(tag, p.kind === 'agent' ? 6 : 4, p.id);
        if (p.dim)
          g.traverse((o) =>
            (o as THREE.Mesh).isMesh
              ? (((o as THREE.Mesh).material as THREE.Material) = mat('#9aa3a1', { opacity: 0.6 }))
              : null,
          );
        g.position.copy(old ? old.g.position : to);
        if (old) {
          this.peopleGroup.remove(old.g);
        }
        this.peopleGroup.add(g);
        this.pickables = this.pickables.filter((x) => x !== old?.g);
        this.register(g, { kind: p.kind === 'agent' ? 'agent' : 'employee', id: p.id });
        const startSeated = Boolean(p.seated) && (!old || old.sit > 0.5);
        if (old) g.rotation.y = old.g.rotation.y;
        else if (startSeated) g.rotation.y = p.face;
        e = {
          g,
          path: [],
          face: p.face,
          key,
          seated: Boolean(p.seated),
          sit: startSeated ? 1 : 0,
          activity: p.activity ?? null,
          bubble: null,
          bubbleKey: '',
          phase: (p.id.charCodeAt(0) % 10) / 3,
        };
        if (old) e.path = old.path;
        this.people.set(p.id, e);
        if (this.focusId === p.id) this.applyFocus();
      }
      // Balão sobre a cabeça.
      const bk = p.bubble ? `${p.bubble.tone}|${p.bubble.text}` : '';
      if (bk !== e.bubbleKey) {
        if (e.bubble) e.g.remove(e.bubble);
        e.bubble = null;
        e.bubbleKey = bk;
        if (p.bubble) {
          const b = bubble(p.bubble.text, p.bubble.tone);
          b.position.set(0, 1.85, 0);
          e.g.add(b);
          e.bubble = b;
          this.tag(b, 20, p.id);
        }
      }
      e.face = p.face;
      e.seated = Boolean(p.seated);
      const last = e.path[e.path.length - 1] ?? e.g.position;
      if (last.distanceTo(to) > 0.05) e.path = this.routeBetween(e.g.position, to);
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

  // ───────────────────────────── Luz pela hora ─────────────────────────────

  /** Força uma hora (0–24) para ver a iluminação; null volta à hora real. */
  setHour(h: number | null) {
    this.hourOverride = h;
    this.lastLightAt = -1;
    this.updateLight(true);
  }

  currentHour() {
    return this.hourOverride ?? hourInSaoPaulo();
  }

  private updateLight(force = false) {
    const now = performance.now();
    if (!force && now - this.lastLightAt < 20_000) return;
    this.lastLightAt = now;
    const h = this.currentHour();
    let i = 0;
    while (i < DAY_KEYS.length - 2 && DAY_KEYS[i + 1]!.h <= h) i++;
    const a = DAY_KEYS[i]!;
    const b = DAY_KEYS[i + 1]!;
    const f = Math.min(1, Math.max(0, (h - a.h) / Math.max(0.001, b.h - a.h)));
    const lerpC = (x: string, y: string) => new THREE.Color(x).lerp(new THREE.Color(y), f);
    const night = a.night + (b.night - a.night) * f;
    this.night = night;
    this.sun.color.copy(lerpC(a.sun, b.sun));
    this.sun.intensity = a.sunI + (b.sunI - a.sunI) * f;
    this.hemi.color.copy(lerpC(a.sky, b.sky));
    this.hemi.groundColor.copy(lerpC(a.ground, b.ground));
    this.hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * f;
    this.renderer.setClearColor(lerpC(a.bg, b.bg));
    // Sol nasce a leste (+x), passa ao norte (−z) e se põe a oeste; à noite, luar alto.
    const W = (this.layout?.widthCm ?? 1000) * CM;
    const D = (this.layout?.depthCm ?? 800) * CM;
    const day = Math.min(1, Math.max(0, (h - 6) / 12.5));
    const theta = day * Math.PI;
    const elev = night > 0.9 ? 0.9 : 0.35 + Math.sin(theta) * 0.75;
    const dir =
      night > 0.9
        ? new THREE.Vector3(-0.4, 1, 0.3)
        : new THREE.Vector3(Math.cos(theta), elev, -0.55 - Math.sin(theta) * 0.3);
    dir.normalize();
    this.sun.position.set(W / 2, 0, D / 2).addScaledVector(dir, 30);
    // Luminárias, vidros e relógios.
    for (const l of this.lamps) l.intensity = 7 * night;
    for (const lamp of this.bulbs) {
      const bulb = lamp.getObjectByName('bulb') as THREE.Mesh | undefined;
      if (bulb) (bulb.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + 2.6 * night;
      const cone = lamp.getObjectByName('beamcone') as THREE.Mesh | undefined;
      if (cone) {
        (cone.material as THREE.MeshBasicMaterial).opacity = 0.09 * night;
        cone.visible = night > 0.05;
      }
    }
    const glassDay = new THREE.Color(h > 16.8 && h < 19 ? '#ffd7a8' : '#cfeaff');
    for (const g of this.glasses) {
      const m = g.material as THREE.MeshStandardMaterial;
      m.emissive.copy(glassDay.clone().lerp(new THREE.Color('#1c2a44'), night));
      m.emissiveIntensity = 0.55 - 0.35 * night;
      m.color.copy(new THREE.Color('#bfe3f2').lerp(new THREE.Color('#2a3a55'), night));
    }
  }

  /** Noite (0 dia … 1 noite), para a interface acompanhar. */
  nightLevel() {
    return this.night;
  }

  // ───────────────────────────── Comemorações ─────────────────────────────

  private confettiAt(p: THREE.Vector3, n = 70, y = 2.2) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.06, 0.1),
        new THREE.MeshBasicMaterial({
          color: ['#a8743f', '#1f7a46', '#2c5ea8', '#e0a63a', '#b42323'][i % 5],
          side: THREE.DoubleSide,
        }),
      );
      m.position.set(p.x + (Math.random() - 0.5) * 0.6, y, p.z + (Math.random() - 0.5) * 0.4);
      this.fxGroup.add(m);
      this.confetti.push({
        m,
        v: new THREE.Vector3(
          (Math.random() - 0.5) * 2.2,
          2 + Math.random() * 2.5,
          (Math.random() - 0.5) * 2.2,
        ),
        life: 2.6,
      });
    }
  }

  /** Comemoração breve (confete) sobre os quadros. */
  celebrate() {
    for (const b of this.boards) {
      const p = new THREE.Vector3();
      b.holder.getWorldPosition(p);
      this.confettiAt(p);
    }
  }

  /** Comemora sobre uma peça ou pessoa (confete e um texto que sobe). */
  celebrateAt(id: string, text: string) {
    const o = this.pieces.get(id)?.g ?? this.people.get(id)?.g ?? this.objects.get(id);
    if (!o) return;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    this.confettiAt(p, 50, 1.6);
    const s = label(text, { size: 24, bg: 'rgba(31,122,70,0.95)' });
    s.position.set(p.x, 1.6, p.z);
    s.renderOrder = 20;
    this.fxGroup.add(s);
    this.floaters.push({ s, life: 2.4, vy: 0.45 });
  }

  boardHolders() {
    return this.boards.map((b) => b.holder);
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
    if (!next) return false;
    const dir = next.clone().sub(obj.position);
    dir.y = 0;
    const dist = dir.length();
    if (dist < 0.03) {
      path.shift();
      return true;
    }
    const step = Math.min(dist, speed * dt);
    obj.position.addScaledVector(dir.normalize(), step);
    const want = Math.atan2(dir.x, dir.z);
    const turn = Math.atan2(Math.sin(want - obj.rotation.y), Math.cos(want - obj.rotation.y));
    obj.rotation.y += turn * Math.min(1, dt * 12);
    const swing = Math.sin(t * 10) * 0.5;
    if (legL && legR) {
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
    }
    if (armL && armR) {
      armL.rotation.x = -swing * 0.8;
      armR.rotation.x = swing * 0.8;
      armL.rotation.z = armR.rotation.z = 0;
    }
    return true;
  }

  /** Pose de trabalho conforme a etapa (corte, costura, grampo, desmontagem, embalagem). */
  private workPose(e: PersonEntry, t: number) {
    const g = e.g;
    const armL = g.getObjectByName('armL');
    const armR = g.getObjectByName('armR');
    const head = g.getObjectByName('head');
    const torso = g.getObjectByName('torso');
    const legL = g.getObjectByName('legL');
    const legR = g.getObjectByName('legR');
    if (legL && legR) legL.rotation.x = legR.rotation.x = 0;
    const a = e.activity;
    const tt = t + e.phase;
    if (!armL || !armR) return;
    armL.rotation.z = armR.rotation.z = 0;
    if (!a) {
      // Parado: respira e olha em volta de vez em quando.
      armL.rotation.x = armR.rotation.x = Math.sin(tt * 1.3) * 0.04;
      if (head)
        head.rotation.y = Math.sin(tt * 0.4) * 0.35 * (Math.sin(tt * 0.13) > 0.6 ? 1 : 0.15);
      if (torso) torso.rotation.x = 0;
      return;
    }
    if (head) {
      head.rotation.x = 0.3;
      head.rotation.y = Math.sin(tt * 0.7) * 0.12;
    }
    if (torso) torso.rotation.x = 0.08;
    switch (a) {
      case 'CORTE':
      case 'CORTE_TECIDO':
      case 'CORTE_ESPUMA': {
        // Mão esquerda segura o tecido; a direita corta deslizando.
        armL.rotation.x = -1.05;
        armR.rotation.x = -1.2 + Math.sin(tt * 1.5) * 0.15;
        armR.rotation.z = Math.sin(tt * 1.5) * 0.25;
        const tool = g.getObjectByName('toolR');
        if (tool) tool.rotation.y = Math.sin(tt * 14) * 0.2;
        break;
      }
      case 'COSTURA': {
        // As duas mãos guiam o tecido na máquina, com tremidinha do motor.
        const v = Math.sin(tt * 40) * 0.02;
        armL.rotation.x = -1.25 + v;
        armR.rotation.x = -1.25 - v;
        armL.rotation.z = 0.18;
        armR.rotation.z = -0.18;
        break;
      }
      case 'REVESTIMENTO':
      case 'MONTAGEM':
      case 'ACABAMENTO':
      case 'CORRECAO': {
        // Estica com a esquerda e grampeia com a direita (batidas ritmadas).
        armL.rotation.x = -0.95 + Math.sin(tt * 1.2) * 0.1;
        const k = (tt * 2.4) % 1;
        armR.rotation.x = -1.35 + (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * 0.45;
        break;
      }
      case 'DESMONTAGEM':
      case 'PREPARACAO':
      case 'PREPARACAO_MDF': {
        // Puxa grampos e capa velha: tranco para trás.
        const k = (tt * 1.1) % 1;
        const pull = k < 0.7 ? k / 0.7 : 1 - (k - 0.7) / 0.3;
        armL.rotation.x = armR.rotation.x = -1.1 + pull * 0.55;
        if (torso) torso.rotation.x = 0.12 - pull * 0.1;
        break;
      }
      case 'EMBALAGEM': {
        armL.rotation.x = -1.0 + Math.sin(tt * 3) * 0.3;
        armR.rotation.x = -1.0 - Math.sin(tt * 3) * 0.3;
        armL.rotation.z = Math.cos(tt * 3) * 0.3;
        armR.rotation.z = -Math.cos(tt * 3) * 0.3;
        break;
      }
      default:
        armL.rotation.x = -0.8 + Math.sin(tt * 2) * 0.1;
        armR.rotation.x = -0.8 - Math.sin(tt * 2) * 0.1;
    }
  }

  /**
   * Quadro de Metas: fração da meta (0..1), texto e cor. A barra anima até o novo valor
   * (avança ou recua). `from` reinicia a animação (ex.: abertura → fechamento da semana).
   */
  setGoalBoard(s: { fraction: number; text: string; tone?: string; from?: number }) {
    const target = Math.max(0, Math.min(1, s.fraction));
    const current =
      s.from !== undefined
        ? Math.max(0, Math.min(1, s.from))
        : (this.boardState?.current ?? target);
    const changedText = this.boardState?.text !== s.text || this.boardState?.tone !== s.tone;
    this.boardState = { target, current, text: s.text, tone: s.tone ?? '#1f7a46' };
    this.drawBoards(changedText);
  }

  private drawBoards(relabel: boolean) {
    const s = this.boardState;
    if (!s) return;
    for (const b of this.boards) {
      const trackW = b.w - 0.3;
      let bar = b.holder.getObjectByName('goalbar') as THREE.Mesh | undefined;
      if (!bar) {
        bar = new THREE.Mesh(
          new THREE.BoxGeometry(1, 0.1, 0.03),
          new THREE.MeshStandardMaterial({
            color: s.tone,
            emissive: s.tone,
            emissiveIntensity: 0.25,
          }),
        );
        bar.name = 'goalbar';
        b.holder.add(bar);
      }
      (bar.material as THREE.MeshStandardMaterial).color.set(s.tone);
      (bar.material as THREE.MeshStandardMaterial).emissive.set(s.tone);
      const f = Math.max(0.001, s.current);
      bar.scale.x = trackW * f;
      bar.position.set(-trackW / 2 + (trackW * f) / 2, 1.11, 0.075);
      if (relabel) {
        const old = b.holder.getObjectByName('goaltext');
        if (old) b.holder.remove(old);
        const lb = label(s.text, {
          size: 18,
          bg: 'rgba(255,250,242,0.96)',
          fg: '#1d2523',
          border: s.tone,
        });
        lb.name = 'goaltext';
        lb.position.set(0, 2.25, 0);
        b.holder.add(lb);
        this.tag(lb, 8, null);
      }
    }
  }

  /** Movimento do boneco pelo teclado (WASD/setas), relativo à câmera, desviando dos móveis. */
  private keyMove(dt: number) {
    if (!this.player || !this.keys.size || this.opts.mode !== 'GESTAO') return false;
    const k = this.keys;
    let fx = 0;
    let fz = 0;
    if (k.has('w') || k.has('arrowup')) fz -= 1;
    if (k.has('s') || k.has('arrowdown')) fz += 1;
    if (k.has('a') || k.has('arrowleft')) fx -= 1;
    if (k.has('d') || k.has('arrowright')) fx += 1;
    if (!fx && !fz) return false;
    // Eixos da tela no chão.
    const fwd = this.camDir().multiplyScalar(-1);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3().addScaledVector(right, fx).addScaledVector(fwd, -fz);
    move.normalize().multiplyScalar(2.4 * dt);
    const g = this.player.g;
    this.player.path = [];
    this.player.tag = null;
    const free = (x: number, z: number) => {
      const grid = this.walkGrid;
      if (!grid) return true;
      const cx = Math.floor(x / CM / grid.cell);
      const cy = Math.floor(z / CM / grid.cell);
      if (cx < 0 || cy < 0 || cx >= grid.cols || cy >= grid.rows) return false;
      return !grid.blocked[cy * grid.cols + cx];
    };
    const nx = g.position.x + move.x;
    const nz = g.position.z + move.z;
    // Desliza na parede/móvel em vez de travar.
    if (free(nx, nz)) g.position.set(nx, 0, nz);
    else if (free(nx, g.position.z)) g.position.x = nx;
    else if (free(g.position.x, nz)) g.position.z = nz;
    g.rotation.y = Math.atan2(move.x, move.z);
    // A câmera acompanha.
    this.target.lerp(new THREE.Vector3(g.position.x, 0, g.position.z), Math.min(1, dt * 3));
    this.updateCamera();
    return true;
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dtRaw = this.clock.getDelta();
    const dt = Math.min(0.05, dtRaw);
    const t = this.clock.elapsedTime;
    const now = performance.now();

    // Qualidade automática: mede os primeiros segundos e baixa se o computador for lento.
    if (this.autoQuality && this.layout && this.frameTimes.length < 240) {
      this.frameTimes.push(dtRaw);
      if (this.frameTimes.length === 240) {
        const avg = this.frameTimes.slice(60).reduce((a, b) => a + b, 0) / 180;
        if (avg > 1 / 28 && this.quality !== 'baixa') {
          this.applyQuality(this.quality === 'alta' ? 'media' : 'baixa');
          this.frameTimes = [];
        }
      }
    }

    // Câmera: giro e animações de enquadramento.
    if (Math.abs(this.yawTarget - this.yaw) > 0.0005) {
      this.yaw += (this.yawTarget - this.yaw) * Math.min(1, dt * 7);
      this.updateCamera();
    }
    if (this.camAnim) {
      const c = this.camAnim;
      c.t = Math.min(1, c.t + dt / c.dur);
      const k = ease(c.t);
      this.target.lerpVectors(c.from, c.to, k);
      this.viewSize = c.s0 + (c.s1 - c.s0) * k;
      this.updateCamera();
      if (c.t >= 1) this.camAnim = null;
    }
    this.updateWalls(dt);
    this.updateLight();

    // Destaque da seleção: escurece o resto aos poucos.
    const wantDim = this.focusObj && this.opts.mode === 'GESTAO' ? 1 : 0;
    this.dim += (wantDim - this.dim) * Math.min(1, dt * 6);
    this.dimMat.opacity = 0.42 * this.dim;

    if (this.boardState && Math.abs(this.boardState.target - this.boardState.current) > 0.0005) {
      const d = this.boardState.target - this.boardState.current;
      this.boardState.current += Math.sign(d) * Math.min(Math.abs(d), dt * 0.35);
      this.drawBoards(false);
    }
    if (this.confetti.length) {
      for (const c of this.confetti) {
        c.v.y -= 4.5 * dt;
        c.m.position.addScaledVector(c.v, dt);
        c.m.rotation.x += dt * 6;
        c.m.rotation.y += dt * 4;
        c.life -= dt;
      }
      for (const c of this.confetti.filter((x) => x.life <= 0)) {
        this.fxGroup.remove(c.m);
        c.m.geometry.dispose();
      }
      this.confetti = this.confetti.filter((x) => x.life > 0);
    }
    for (const f of this.floaters) {
      f.life -= dt;
      f.s.position.y += f.vy * dt;
      (f.s.material as THREE.SpriteMaterial).opacity = Math.min(1, f.life / 0.6);
      if (f.life <= 0) this.fxGroup.remove(f.s);
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);

    for (const e of this.pieces.values()) {
      if (e.dragging) continue;
      if (e.path.length) {
        // Vai de carrinho pelo corredor até a nova estação.
        const next = e.path[0]!;
        const d = next.clone().sub(e.g.position);
        d.y = 0;
        const dist = d.length();
        if (dist < 0.05) e.path.shift();
        else {
          e.g.position.addScaledVector(d.normalize(), Math.min(dist, 1.3 * dt));
          const want = Math.atan2(d.x, d.z) + Math.PI / 2;
          const turn = Math.atan2(Math.sin(want - e.g.rotation.y), Math.cos(want - e.g.rotation.y));
          e.g.rotation.y += turn * Math.min(1, dt * 4);
        }
        e.g.position.y = 0.12 + Math.abs(Math.sin(t * 9)) * 0.02;
        if (e.cart) e.cart.position.y = -0.12;
      } else {
        const d = e.to.clone().sub(e.g.position);
        d.y = 0;
        const dist = d.length();
        if (dist > 0.01) {
          const step = Math.min(dist, Math.max(1.2, dist * 2) * dt);
          e.g.position.addScaledVector(d.normalize(), step);
        }
        e.g.position.y = Math.max(0, e.g.position.y - dt * 0.6);
        if (e.cart && e.g.position.y <= 0.001) {
          e.g.remove(e.cart);
          e.cart = null;
        }
        const turn = Math.atan2(Math.sin(e.rot - e.g.rotation.y), Math.cos(e.rot - e.g.rotation.y));
        e.g.rotation.y += turn * Math.min(1, dt * 5);
      }
      const beam = e.g.getObjectByName('beam');
      if (beam)
        (beam as THREE.Mesh).scale.x = (beam as THREE.Mesh).scale.z = 1 + Math.sin(t * 4) * 0.3;
      // Etiqueta completa ao passar o mouse, selecionar, destacar ou aproximar.
      const id = (e.g.userData.pick as PickTarget | undefined)?.id;
      const expand =
        e.highlight || id === this.hovered || id === this.focusId || this.viewSize < 6.5;
      const st = e.short.userData.tag as Tag | undefined;
      const ft = e.full.userData.tag as Tag | undefined;
      if (st && ft && st.want === expand) {
        st.want = !expand;
        ft.want = expand;
        this.lastTagLayout = 0;
      }
    }
    for (const e of this.people.values()) {
      // Levanta da cadeira antes de sair andando.
      if (e.path.length && e.sit > 0) {
        e.sit = Math.max(0, e.sit - dt * 2.4);
        e.g.position.y = seatPose(e.g, e.sit, t) * e.sit;
        continue;
      }
      const moving = this.walkStep(e.g, e.path, 1.6, dt, t);
      if (!moving) {
        const turn = Math.atan2(
          Math.sin(e.face - e.g.rotation.y),
          Math.cos(e.face - e.g.rotation.y),
        );
        e.g.rotation.y += turn * Math.min(1, dt * 6);
        // Senta só depois de virar para a mesa; levanta se deixou de estar sentado.
        if (e.seated && Math.abs(turn) < 0.35) e.sit = Math.min(1, e.sit + dt * 2);
        else if (!e.seated) e.sit = Math.max(0, e.sit - dt * 2.4);
        if (e.sit > 0) e.g.position.y = seatPose(e.g, e.sit, t) * e.sit;
        else {
          e.g.position.y = 0;
          this.workPose(e, t);
        }
      } else e.g.position.y = 0;
      if (e.bubble) e.bubble.position.y = 1.85 + Math.sin(t * 2.2 + e.phase) * 0.04;
    }
    if (this.player) {
      const keyed = this.keyMove(dt);
      const was = this.player.path.length > 0;
      const walking = this.walkStep(this.player.g, this.player.path, 2.2, dt, t);
      if (keyed) {
        const legL = this.player.g.getObjectByName('legL');
        const legR = this.player.g.getObjectByName('legR');
        const swing = Math.sin(t * 11) * 0.55;
        if (legL && legR) {
          legL.rotation.x = swing;
          legR.rotation.x = -swing;
        }
      } else if (!walking) {
        for (const n of ['legL', 'legR', 'armL', 'armR']) {
          const o = this.player.g.getObjectByName(n);
          if (o) o.rotation.x *= 0.8;
        }
      }
      if (keyed || walking) {
        this.stepAcc += dt;
        if (this.stepAcc > 0.32) {
          this.stepAcc = 0;
          this.cb.onStep?.();
        }
      }
      if (was && this.player.path.length === 0 && this.player.tag) {
        const tag = this.player.tag;
        this.player.tag = null;
        this.cb.onArrive?.(tag);
      }
    }
    const pulse = this.overlayGroup.getObjectByName('pulse');
    if (pulse) pulse.scale.setScalar(1 + ((t * 1.5) % 1) * 0.8);
    if (this.mestre) this.mestre.position.y = Math.abs(Math.sin(t * 2)) * 0.03;
    this.stepVan(dt);
    if (this.pieceDrag?.ring.visible)
      this.pieceDrag.ring.scale.setScalar(1 + Math.sin(t * 8) * 0.06);
    // Relógio de parede na hora real.
    if (this.clocks.length) {
      const h = this.currentHour();
      for (const c of this.clocks) {
        const hh = c.getObjectByName('hourHand');
        const mm = c.getObjectByName('minHand');
        if (hh) hh.rotation.z = -((h % 12) / 12) * Math.PI * 2;
        if (mm) mm.rotation.z = -((h % 1) * Math.PI * 2);
      }
    }

    // Etiquetas: reorganiza algumas vezes por segundo e faz o fade.
    if (now - this.lastTagLayout > 160) {
      this.lastTagLayout = now;
      this.layoutTags(now);
    }
    for (const tg of this.tags) {
      const m = tg.sprite.material as THREE.SpriteMaterial;
      const want = tg.show ? 1 : 0;
      m.opacity += (want - m.opacity) * Math.min(1, dt * 10);
      tg.sprite.visible = m.opacity > 0.02;
    }

    this.render();
    if (!this.readyFired && this.layout) {
      this.readyFired = true;
      this.cb.onReady?.();
    }
  };

  private render() {
    const r = this.renderer;
    r.clear();
    this.camera.layers.set(0);
    r.render(this.scene, this.camera);
    if (this.dim > 0.01 && this.focusObj) {
      r.render(this.dimScene, this.dimCam);
      r.clearDepth();
      this.camera.layers.set(1);
      const auto = r.shadowMap.autoUpdate;
      r.shadowMap.autoUpdate = false;
      const bg = this.scene.background;
      r.render(this.scene, this.camera);
      r.shadowMap.autoUpdate = auto;
      this.scene.background = bg;
      this.camera.layers.set(0);
    }
  }

  /** Ponto da frente de uma estação (cm), onde a pessoa fica de pé. */
  static workSpot(
    s: { xCm: number; yCm: number; wCm: number; dCm: number; rotation: number },
    depth = 45,
  ) {
    const fr = frontRect(s as never, depth);
    return { x: fr.x + fr.w / 2, y: fr.y + fr.d / 2, face: Math.PI - (s.rotation * Math.PI) / 180 };
  }
}

/** Balão de fala (sprite) com rabinho, sobre a cabeça do funcionário. */
function bubble(text: string, tone: 'ok' | 'warn' | 'danger' | 'info') {
  const colors = {
    ok: ['#e7f6ec', '#1f7a46'],
    warn: ['#fff3dc', '#a15c07'],
    danger: ['#fde8e8', '#b42323'],
    info: ['#e8f0fb', '#2c5ea8'],
  }[tone];
  const size = 22;
  const { icon, text: body } = splitIcon(text);
  const iw = icon ? size * 1.05 : 0;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
  const tw = Math.ceil(ctx.measureText(body).width);
  c.width = tw + size * 1.2 + iw;
  c.height = Math.ceil(size * 2.2);
  const bh = size * 1.6;
  ctx.fillStyle = colors[0]!;
  ctx.strokeStyle = colors[1]!;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, c.width - 4, bh - 4, 12);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(c.width / 2 - 9, bh - 3);
  ctx.lineTo(c.width / 2, c.height - 2);
  ctx.lineTo(c.width / 2 + 9, bh - 3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(c.width / 2 - 7, bh - 6, 14, 5);
  if (icon) drawIcon(ctx, icon, size * 0.6, (bh - size * 0.85) / 2, size * 0.85, colors[1]!);
  ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = colors[1]!;
  ctx.textBaseline = 'middle';
  ctx.fillText(body, size * 0.6 + iw, bh / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
  );
  const scale = 0.0125 * (size / 28);
  s.scale.set(c.width * scale, c.height * scale, 1);
  s.renderOrder = 12;
  return s;
}
