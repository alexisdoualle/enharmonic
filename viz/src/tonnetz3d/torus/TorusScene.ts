/**
 * Torus view of the 3D tonnetz: the 7-letter surface on the diatonic torus, plus the animated fold
 * from the lattice. Adapted from the tonnetz app (src/tonnetz/4D-torus/TorusScene.ts): same torus,
 * colours and activation look, trimmed to what the viz uses (no K7 overlay, hover popup, settings bar
 * or persistence). Reads the same TonnetzSceneConfig as TonnetzSceneV2, so the same activations drive
 * both.
 *
 * The surface is the fundamental domain of 14 lattice triangles (domain.ts), lifted out of the squashed
 * lattice in place. While it is still flat it is drawn exactly as the lattice draws it (the lattice's own
 * materials, live colours, node beads and labels, in a second pass with the lattice's lights and colour
 * output), so the handover is invisible; the torus look blends in as the sheet starts to move. Every
 * vertex keeps its lattice position and its torus angles, so one routine places it at any fold stage.
 */
import * as THREE from 'three';
import { FLATTEN_MIN, type TonnetzSceneConfig, type FoldLookSource, type FoldLookTri, type FoldLookEdge } from '../TonnetzSceneV2.js';
import { noteFromFifthsPos } from '../LatticeGeometry.js';
import { PitchClass } from '../core/PitchClass.js';
import { LETTER_NAME_VALUES, LETTER_NAMES, LetterNameUtils, IntervalType, type LetterName } from '../types.js';
import { FIFTHS_ORDER } from '../LatticeGeometry.js';
import {
    R, r_, clamp, mod, latticeToAngles, torusPos, levelFromX, rEffFromLevel, pcFromFifthIndex, nameFromFifthIndex, triadSuffix,
    createGhostHornVertices, defaultLetterAccidentals,
    type LetterAccidentals, type TriadQuality,
} from './TorusGeometry.js';
import { foldPoint, latticeSide, LatticePose, type LatticeView, type CamPose, type FoldCentre } from './fold.js';
import { buildDomain, domainAngles, type Domain, type Piece } from './domain.js';

interface PieceMesh {
    mesh: THREE.Mesh;
    piece: Piece;
    theta: Float32Array;
    phi: Float32Array;
    lat: Float32Array;    // lattice-pose position (group-local, valid while folding)
}

/** A node or label on the sheet: its folded angles, level and lattice-pose position. */
interface Spot {
    theta: number;
    phi: number;
    level: number;
    x: number;
    y: number;
    lat: THREE.Vector3;
}

interface NoteEntry extends Spot { mesh: THREE.Mesh; sprite: THREE.Sprite; pc: number }
interface LabelEntry extends Spot { sprite: THREE.Sprite }

/** The lattice's own drawing of the block, used while the sheet is flat. */
interface Look {
    src: FoldLookSource;
    group: THREE.Group;
    tris: { mesh: THREE.Mesh; color: THREE.BufferAttribute; pd: PieceMesh; h: FoldLookTri | null }[];
    edges: { line: THREE.Line; a: number; b: number; h: FoldLookEdge | null }[];
    nodes: THREE.InstancedMesh | null;
    nodeIdx: number[];    // lattice node instance per domain note (-1: not drawn)
    labels: THREE.Mesh | null;
    labelOf: (ReturnType<FoldLookSource['label']>)[];
    up: THREE.Vector3;    // lattice +z in the group's local space
}

interface Fold {
    dir: 1 | -1;
    start: number;
    dur: number;
    pose: LatticePose;
    latticeCam: CamPose;                  // group-local
    rot0: { x: number; y: number };       // group rotation when an unfold starts, turned back to rot1
    rot1: { x: number; y: number };
    offset0: number;                      // vortex offset when an unfold starts, unwound to a whole turn
    offset1: number;
    onProgress: (u: number) => void;
    onDone: () => void;
}

/** Fold stage: m = lattice -> flat sheet, b1 = roll, b2 = bend, k = lattice look -> torus look. */
interface Stage { m: number; b1: number; b2: number; k: number }
const FULL: Stage = { m: 1, b1: 1, b2: 1, k: 1 };

const smooth = (t: number): number => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** View settings persist per browser (a convenience; the page works without storage). */
function setting<T extends number | boolean>(key: string, fallback: T): T {
    try {
        const v = localStorage.getItem(`viz.torus.${key}`);
        if (v === null) return fallback;
        return (typeof fallback === 'boolean' ? v === '1' : Number(v)) as T;
    } catch { return fallback; }
}
function save(key: string, v: number | boolean): void {
    try { localStorage.setItem(`viz.torus.${key}`, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)); } catch { /* storage unavailable */ }
}

/** Fold timeline over u in 0..1:
 *    0    .. 0.13  squash the lattice flat (drawn by the lattice scene, see `latticeSquash`)
 *    0.13 .. 0.25  one fundamental domain: the torus canvas fades in, drawing the 14 triangles exactly as
 *                  the lattice does, so only the rest of the lattice fades out
 *    0.27 .. 0.45  the block re-shears onto the flat sheet; its look turns into the torus's
 *    0.45 .. 0.70  roll into the tube, top row onto bottom row (accidental levels grow off the surface)
 *    0.70 .. 1     bend into the torus; eases in but arrives at full speed, so the ends meet cleanly */
function stageAt(u: number): Stage & { fade: number } {
    const t2 = clamp((u - 0.7) / 0.3, 0, 1);
    return {
        fade: smooth((u - 0.13) / 0.12),
        m: smooth((u - 0.27) / 0.18),
        b1: smooth((u - 0.45) / 0.25),
        b2: t2 * t2 * (2 - t2),
        k: smooth((u - 0.27) / 0.15),
    };
}

/** Lattice z scale at fold time u (1 = full lattice, 0 = squashed flat). */
export const latticeSquash = (u: number): number => 1 - smooth(u / 0.13);

/** Camera moves from the lattice view to the resting torus view from here on: it holds still through the
 *  handover, so the block stays exactly where the lattice drew it. */
const CAM_FROM = 0.27;
const HOME_X = 0.35;
const EDGE_SEGS = 16;

function makeSprite(text: string, opts: { fontSize?: number; color?: string; bg?: string; padding?: number }): THREE.Sprite {
    const fs = opts.fontSize || 44;
    const pad = opts.padding || 10;
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d')!;
    cx.font = `bold ${fs}px serif`;
    const w = cx.measureText(text).width + pad * 2;
    const h = fs * 1.3 + pad * 2;
    cv.width = Math.ceil(w * 2);
    cv.height = Math.ceil(h * 2);
    cx.scale(2, 2);
    cx.fillStyle = opts.bg || 'rgba(12,12,20,0.75)';
    cx.beginPath();
    cx.roundRect(0, 0, w, h, 5);
    cx.fill();
    cx.font = `bold ${fs}px serif`;
    cx.fillStyle = opts.color || '#fff';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false }));
    spr.scale.set(w / 110, h / 110, 1);
    return spr;
}

function clearGroup(group: THREE.Group): void {
    while (group.children.length) {
        const obj = group.children.pop() as THREE.Mesh;
        group.remove(obj);
        obj.geometry?.dispose();
        const mat = obj.material as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
        mat?.map?.dispose();
        mat?.dispose();
    }
}

const isPerfectTriad = (type: TriadQuality | null): boolean => type === 'major' || type === 'minor';

/** PitchClass[] of a triad from its root fifths index and quality (for the shared triad colours). */
function triadPitchClasses(rootX: number, quality: TriadQuality, acc: LetterAccidentals): PitchClass[] {
    const third = quality === 'minor' || quality === 'diminished' ? -3 : 4;
    return [rootX, rootX + third, rootX + 1].map(x => {
        const wrapped = mod(x, 7);
        return new PitchClass(noteFromFifthsPos(wrapped).letter, levelFromX(wrapped, 0, acc));
    });
}

function hexToRGB(hex: string): { r: number; g: number; b: number } {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

function saturateRGB(c: { r: number; g: number; b: number }, f: number): { r: number; g: number; b: number } {
    const g = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const s = (v: number): number => Math.min(1, Math.max(0, g + (v - g) * f));
    return { r: s(c.r), g: s(c.g), b: s(c.b) };
}

export class TorusScene {
    private readonly renderer: THREE.WebGLRenderer;
    private readonly scene = new THREE.Scene();
    private readonly lookScene = new THREE.Scene();
    private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
    // The lattice panel's background (#1a1a2e), given in linear terms since this renderer outputs linear.
    private readonly clearColor = new THREE.Color().setRGB(0x1a / 255, 0x1a / 255, 0x2e / 255, THREE.LinearSRGBColorSpace);

    private readonly grp = new THREE.Group();
    private readonly triGrp = new THREE.Group();
    private readonly noteGrp = new THREE.Group();
    private readonly labelGrp = new THREE.Group();
    private readonly k7Grp = new THREE.Group();
    private k7Data: { mesh: THREE.Mesh; coords: { tl: number; pl: number; tr: number; pr: number }[]; pcs: [number, number] }[] = [];

    private readonly ghostMat = new THREE.MeshBasicMaterial({ color: 0x181828, transparent: true, opacity: 0.06, side: THREE.FrontSide, depthWrite: false });
    private ghostMesh: THREE.Mesh | null = null;
    private readonly sGeo = new THREE.SphereGeometry(0.1, 16, 16);

    private domain!: Domain;
    private centre: FoldCentre = { thetaC: 0, phiC: Math.PI / 2 };
    private side = Math.PI / 2;   // the tube side the flat sheet lies on (from the lattice's handedness)
    private pieceData: PieceMesh[] = [];
    private noteData: NoteEntry[] = [];
    private labelData: LabelEntry[] = [];
    private look: Look | null = null;

    private letterAccidentals: LetterAccidentals = defaultLetterAccidentals();

    // View: group rotation (drag + auto-rotate), camera distance (wheel).
    private rot = { x: HOME_X, y: 0 };
    private rVel = { x: 0, y: 0 };
    private isDrag = false;
    private prev = { x: 0, y: 0 };
    private tgtZ = 14;
    private curZ = 14;

    // Display settings (the tonnetz app's defaults).
    private rotSpeed: number = setting('rotate', 0.15);
    private vortexSpeed: number = setting('vortex', 0.2);
    private taper: number = setting('taper', 0.25);
    private shaftWidth: number = setting('shaft', 1);
    private showChords: boolean = setting('chords', true);
    private showNotes: boolean = setting('notes', true);
    private showK7: boolean = setting('k7', true);
    private readonly faceOpacity = 1;
    private wireframeEnabled: boolean = setting('mesh', true);
    private wireframeAll: boolean = setting('meshAll', false);

    private spiralOffset = 0;
    private lastOffset = -1;
    private needsGeomUpdate = true;
    private styleK = 1;   // torus look (1) vs lattice look (0)

    private fold: Fold | null = null;
    private visible = false;
    private raf: number | null = null;
    private readonly resizeObserver: ResizeObserver;

    // Face opacity: idle (no notes), activated, held. Mostly opaque, so the far wall of the tube
    // does not show through.
    private static readonly TRI_OPACITY_IDLE = 0.55;
    private static readonly TRI_OPACITY_BASE = 0.9;
    private static readonly TRI_OPACITY_HELD = 1;

    constructor(private readonly container: HTMLElement, private readonly config: TonnetzSceneConfig) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(this.clearColor);
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.renderer.autoClear = false;
        container.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0x606070, 1.6));
        const key = new THREE.DirectionalLight(0xfff8e8, 2.7);
        key.position.set(4, 6, 5);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0xc8d8ff, 0.8);
        fill.position.set(-4, -2, -4);
        this.scene.add(fill);

        this.grp.add(this.triGrp, this.noteGrp, this.labelGrp, this.k7Grp);
        this.scene.add(this.grp);

        this.setupInteraction();
        this.createControls();
        this.syncFromConfig();
        this.rebuildModelGeometry();
        this.rot = { x: HOME_X, y: this.homeY() };
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();
    }

    // ── Public API ───────────────────────────────────────────────────

    /** The surface changed: rebuild the faces (spellings, qualities, levels). */
    rebuild(): void {
        this.syncFromConfig();
        this.rebuildModelGeometry();
    }

    updateActivations(): void {
        if (!this.visible) return;
        this.updateTriangleActivations();
        this.updateNoteActivations();
        this.updateK7Activations();
    }

    resize(): void {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) { this.resize(); this.startAnimate(); } else this.stopAnimate();
    }

    get folding(): boolean { return this.fold !== null; }

    /** Lattice -> torus. Starts on the block exactly as the lattice draws it. `onProgress(u)` runs every
     *  frame (the panel squashes the lattice from it). */
    foldIn(view: LatticeView, look: FoldLookSource, durationMs: number, onProgress: (u: number) => void, onDone: () => void = () => {}): void {
        this.spiralOffset = 0;
        this.rot = { x: HOME_X, y: this.homeY() };
        this.startFold(view, look, 1, durationMs, onProgress, onDone);
    }

    /** Torus -> lattice, the same path backwards. The torus first turns back to its home angle and
     *  the vortex unwinds to a whole turn. */
    foldOut(view: LatticeView, look: FoldLookSource, durationMs: number, onProgress: (u: number) => void, onDone: () => void = () => {}): void {
        this.startFold(view, look, -1, durationMs, onProgress, onDone);
    }

    dispose(): void {
        this.stopAnimate();
        this.resizeObserver.disconnect();
        for (const g of [this.triGrp, this.noteGrp, this.labelGrp, this.k7Grp]) clearGroup(g);
        this.disposeLook();
        if (this.ghostMesh) { this.grp.remove(this.ghostMesh); this.ghostMesh.geometry.dispose(); }
        this.sGeo.dispose();
        this.ghostMat.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    /** Home turn about the hole axis: the block's middle faces away from the camera, where the lattice
     *  camera looks at it, so the camera hardly moves during the fold. */
    private homeY(): number {
        return this.centre.thetaC + Math.PI / 2;
    }

    // ── Config -> torus state ────────────────────────────────────────

    private syncFromConfig(): void {
        const thirds = this.config.getThirds();
        if (!thirds || thirds.length === 0) return;
        const acc = defaultLetterAccidentals();
        for (const pc of thirds) acc[pc.letterName as LetterName] = pc.accidental;
        this.letterAccidentals = acc;
    }

    // ── Geometry ─────────────────────────────────────────────────────

    private rebuildModelGeometry(): void {
        for (const g of [this.triGrp, this.noteGrp, this.labelGrp]) clearGroup(g);
        this.pieceData = [];
        this.noteData = [];
        this.labelData = [];
        const acc = this.letterAccidentals;
        const d = this.domain = buildDomain(acc, this.side);
        this.centre = { thetaC: d.thetaC, phiC: d.phiC };

        // Faces: one mesh per lattice triangle of the block. Chord labels on one copy of each chord.
        const labelled = new Map<string, Piece>();
        for (const piece of d.pieces) {
            const face = piece.face;
            const color = face.quality
                ? this.config.getTriadColor(face.quality, triadPitchClasses(face.rootX, face.quality, acc))
                : '#8a8a98';
            const c = saturateRGB(hexToRGB(color), 1.5);
            const nv = piece.xy.length / 2;
            const theta = new Float32Array(nv), phi = new Float32Array(nv);
            for (let i = 0; i < nv; i++) {
                const a = domainAngles(d, piece.xy[2 * i]!, piece.xy[2 * i + 1]!);
                theta[i] = a.theta; phi[i] = a.phi;
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(nv * 3), 3));
            geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(nv * 3), 3));
            geo.setIndex(piece.index);
            const mat = new THREE.MeshPhongMaterial({
                color: new THREE.Color(c.r, c.g, c.b), transparent: true, opacity: this.faceOpacity,
                // Outer side only: the faces wind so their front is the outer surface (also the side the
                // flat sheet shows the camera); drawing the inner walls lit them with flipped normals.
                side: THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
                shininess: 18, specular: new THREE.Color(0x222222),
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.userData = { type: face.quality, colorRGB: c, pcs: face.pcs };
            this.triGrp.add(mesh);
            this.pieceData.push({ mesh, piece, theta, phi, lat: new Float32Array(nv * 3) });
            if (face.quality && (!labelled.has(face.key) || piece.top)) labelled.set(face.key, piece);
        }

        for (const piece of labelled.values()) {
            const f = piece.face;
            const name = `${nameFromFifthIndex(f.rootX, 0, acc)}${triadSuffix(f.quality!)}`;
            const color = this.config.getTriadColor(f.quality!, triadPitchClasses(f.rootX, f.quality!, acc));
            const sprite = makeSprite(name, { fontSize: 22, color, bg: 'rgba(10,10,18,0.6)', padding: 7 });
            this.labelGrp.add(sprite);
            const level = piece.level.reduce((s, l) => s + l, 0) / piece.level.length;
            this.labelData.push({ sprite, ...this.spot(piece.cx, piece.cy, level) });
        }

        // Notes: the block's 13 lattice nodes (top and bottom rows repeat; they meet when rolled).
        for (const n of d.notes) {
            const level = levelFromX(n.letter, 0, acc);
            const emissive = level < 0 ? 0x3070aa : 0xccaa66;
            const txt = level > 0 ? '#e8c060' : (level < 0 ? '#5090cc' : '#f0ece4');
            const mesh = new THREE.Mesh(this.sGeo, new THREE.MeshPhongMaterial({ color: 0xffffff, emissive, emissiveIntensity: 0.3, shininess: 80, transparent: true }));
            const sprite = makeSprite(nameFromFifthIndex(n.letter, 0, acc), { fontSize: 34, color: txt, padding: 10 });
            this.noteGrp.add(mesh, sprite);
            this.noteData.push({ mesh, sprite, pc: pcFromFifthIndex(n.letter, 0, acc), ...this.spot(n.x, n.y, level) });
        }

        this.rebuildGhost();
        this.rebuildK7();
        if (this.fold) {
            this.placeLattice(this.fold.pose);
            if (this.look) this.buildLook(this.look.src, this.fold.pose);
        }
        this.needsGeomUpdate = true;
    }

    private spot(x: number, y: number, level: number): Spot {
        const a = domainAngles(this.domain, x, y);
        return { theta: a.theta, phi: a.phi, level, x, y, lat: new THREE.Vector3() };
    }

    private rebuildGhost(): void {
        if (this.ghostMesh) { this.grp.remove(this.ghostMesh); this.ghostMesh.geometry.dispose(); }
        const { positions, indices } = createGhostHornVertices(0, 6, 0, this.letterAccidentals, this.taper, this.shaftWidth);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        this.ghostMesh = new THREE.Mesh(geo, this.ghostMat);
        this.grp.add(this.ghostMesh);
    }

    /** Lattice-pose positions of every vertex, node and label. */
    private placeLattice(pose: LatticePose): void {
        const q = new THREE.Vector3();
        for (const pd of this.pieceData) {
            const xy = pd.piece.xy;
            for (let i = 0; i < xy.length / 2; i++) pose.local(xy[2 * i]!, xy[2 * i + 1]!, q).toArray(pd.lat, 3 * i);
        }
        for (const s of [...this.noteData, ...this.labelData]) pose.local(s.x, s.y, s.lat);
    }

    // ── The lattice's look ───────────────────────────────────────────

    /** Build the block as the lattice draws it: its triangle material and live colours (sharing the
     *  torus meshes' positions), its wires, its node beads and its labels. Rendered in its own pass with
     *  the lattice's lights and sRGB output (see draw). */
    private buildLook(src: FoldLookSource, pose: LatticePose): void {
        this.disposeLook();
        const group = new THREE.Group();
        group.matrixAutoUpdate = false;
        this.lookScene.add(group);
        const ambient = new THREE.AmbientLight(src.ambient.color, src.ambient.intensity);
        const dir = new THREE.DirectionalLight(src.directional.color, src.directional.intensity);
        dir.position.copy(src.directional.position).applyQuaternion(pose.rot);
        group.add(ambient, dir, dir.target);
        const up = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.rot);

        const d = this.domain;
        const world = (x: number, y: number): THREE.Vector3 | null => {
            const { col, row } = pose.cell(x, y);
            const i = src.node(col, row);
            return i < 0 ? null : src.nodeWorld(i, new THREE.Vector3());
        };

        const tris = this.pieceData.map(pd => {
            const geo = new THREE.BufferGeometry();
            const pos = pd.mesh.geometry.getAttribute('position');
            geo.setAttribute('position', pos);
            geo.setIndex(pd.piece.index);
            const color = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3);
            geo.setAttribute('color', color);
            const c = pd.piece.corners.map(([x, y]) => world(x, y));
            const h = c.every(Boolean) ? src.triangle(c[0]!, c[1]!, c[2]!) : null;
            const map = (h?.mesh.material as THREE.MeshBasicMaterial | undefined)?.map ?? null;
            if (h && map) {
                const uv = new Float32Array(pos.count * 2), cu = [0, 1, 2].map(k => src.triUv(h, k));
                const b = pd.piece.bary;
                for (let i = 0; i < pos.count; i++) for (let j = 0; j < 2; j++) {
                    uv[2 * i + j] = b[3 * i]! * cu[0]![j]! + b[3 * i + 1]! * cu[1]![j]! + b[3 * i + 2]! * cu[2]![j]!;
                }
                geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
            }
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false,
                blending: THREE.AdditiveBlending, map,
            }));
            mesh.frustumCulled = false;
            group.add(mesh);
            return { mesh, color, pd, h };
        });

        const edges = d.edges.map(([a, b]) => {
            const na = d.notes[a]!, nb = d.notes[b]!;
            const wa = world(na.x, na.y), wb = world(nb.x, nb.y);
            const h = wa && wb ? src.edge(wa, wb) : null;
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((EDGE_SEGS + 1) * 3), 3));
            geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array((EDGE_SEGS + 1) * 3), 3));
            const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1 }));
            line.frustumCulled = false;
            line.visible = !!h;
            group.add(line);
            return { line, a, b, h };
        });

        // The squashed lattice keeps a sliver of each layer's height (z x FLATTEN_MIN): lift the block's
        // lattice pose by the same, so every vertex, bead and label lands on the lattice's own pixels.
        const lift = (x: number, y: number): number => (world(x, y)?.z ?? 0) * FLATTEN_MIN * pose.scale;
        for (const pd of this.pieceData) {
            const [z0, z1, z2] = pd.piece.corners.map(([x, y]) => lift(x, y)) as [number, number, number];
            const b = pd.piece.bary;
            for (let i = 0; i < b.length / 3; i++) {
                const h = b[3 * i]! * z0 + b[3 * i + 1]! * z1 + b[3 * i + 2]! * z2;
                for (let a = 0; a < 3; a++) pd.lat[3 * i + a] = pd.lat[3 * i + a]! + up.getComponent(a) * h;
            }
        }
        for (const n of this.noteData) n.lat.addScaledVector(up, lift(n.x, n.y));

        // Node beads: the lattice's own glow material (copied, so fading it here leaves the lattice alone).
        const nodeIdx = d.notes.map(n => { const { col, row } = pose.cell(n.x, n.y); return src.node(col, row); });
        let nodes: THREE.InstancedMesh | null = null;
        const srcMat = src.nodeMaterial();
        if (srcMat) {
            const mat = srcMat.clone();
            mat.onBeforeCompile = srcMat.onBeforeCompile;
            mat.customProgramCacheKey = srcMat.customProgramCacheKey;
            const geo = src.sphereGeo.clone();
            for (const name of [...Object.keys(geo.attributes)]) if (name.startsWith('instance')) geo.deleteAttribute(name);
            geo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(new Float32Array(d.notes.length).fill(1), 1));
            geo.setAttribute('instanceGlow', new THREE.InstancedBufferAttribute(new Float32Array(d.notes.length), 1));
            nodes = new THREE.InstancedMesh(geo, mat, d.notes.length);
            nodes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(d.notes.length * 3), 3);
            nodes.frustumCulled = false;
            group.add(nodes);
        }

        // Labels: the lattice's atlas quads and shader; view-space offsets scaled with the pose.
        const labelOf = nodeIdx.map(i => (i < 0 ? null : src.label(i)));
        let labels: THREE.Mesh | null = null;
        const first = labelOf.find(Boolean);
        if (first) {
            const n = labelOf.length;
            const geo = new THREE.BufferGeometry();
            const uvs = new Float32Array(n * 8), offs = new Float32Array(n * 8), idx: number[] = [];
            labelOf.forEach((l, q) => {
                if (!l) return;
                for (let v = 0; v < 8; v++) { uvs[q * 8 + v] = l.uvs[v]!; offs[q * 8 + v] = l.offsets[v]! * pose.scale; }
                idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
            });
            geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 12), 3));
            geo.setAttribute('labelOffset', new THREE.Float32BufferAttribute(offs, 2));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geo.setAttribute('labelOpacity', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 1));
            geo.setIndex(idx);
            const mat = first.material.clone();
            mat.uniforms.map = { value: first.material.uniforms.map!.value };
            labels = new THREE.Mesh(geo, mat);
            labels.frustumCulled = false;
            group.add(labels);
        }

        this.look = { src, group, tris, edges, nodes, nodeIdx, labels, labelOf, up };
    }

    /** Drop the lattice look. Its triangle meshes share their position attribute with the torus meshes,
     *  and its label texture belongs to the lattice, so only our own geometry and materials go. */
    private disposeLook(): void {
        if (!this.look) return;
        const shared = new Set(this.look.tris.map(t => t.mesh));
        for (const o of this.look.group.children) {
            const m = o as THREE.Mesh;
            if ((m.isMesh || (o as THREE.Line).isLine) && m.geometry) {
                // Detach the torus mesh's position buffer first: disposing a geometry frees its attributes'
                // GPU buffers, which would leave the torus faces drawing from a deleted buffer.
                if (shared.has(m)) m.geometry.deleteAttribute('position');
                m.geometry.dispose();
                (m.material as THREE.Material).dispose();
            }
        }
        this.lookScene.remove(this.look.group);
        this.look = null;
    }

    /** Update the lattice look for this frame: live colours, sizes and glow from the lattice, faded by
     *  (1 - k), at the current fold positions. */
    private placeLook(st: Stage): void {
        const L = this.look;
        if (!L) return;
        const fade = 1 - st.k;
        L.group.visible = fade > 0.001;
        if (!L.group.visible) return;
        L.group.matrix.copy(this.grp.matrixWorld);
        L.group.matrixWorldNeedsUpdate = true;
        const src = L.src;
        const c = new THREE.Color(), cs = [new THREE.Color(), new THREE.Color(), new THREE.Color()];

        for (const t of L.tris) {
            t.mesh.visible = !!t.h;
            if (!t.h) continue;
            for (let k = 0; k < 3; k++) src.readTri(t.h, k, cs[k]!);
            const b = t.pd.piece.bary, arr = t.color.array as Float32Array;
            for (let i = 0; i < t.color.count; i++) {
                const w0 = b[3 * i]! * fade, w1 = b[3 * i + 1]! * fade, w2 = b[3 * i + 2]! * fade;
                arr[3 * i] = w0 * cs[0]!.r + w1 * cs[1]!.r + w2 * cs[2]!.r;
                arr[3 * i + 1] = w0 * cs[0]!.g + w1 * cs[1]!.g + w2 * cs[2]!.g;
                arr[3 * i + 2] = w0 * cs[0]!.b + w1 * cs[1]!.b + w2 * cs[2]!.b;
            }
            t.color.needsUpdate = true;
        }

        for (const e of L.edges) {
            if (!e.h) continue;
            src.readEdge(e.h, 0, cs[0]!);
            src.readEdge(e.h, 1, cs[1]!);
            const pos = e.line.geometry.getAttribute('position') as THREE.BufferAttribute;
            const col = e.line.geometry.getAttribute('color') as THREE.BufferAttribute;
            const na = this.noteData[e.a]!, nb = this.noteData[e.b]!;
            for (let s = 0; s <= EDGE_SEGS; s++) {
                const f = s / EDGE_SEGS;
                this.placePoint(
                    na.theta + (nb.theta - na.theta) * f, na.phi + (nb.phi - na.phi) * f,
                    na.level + (nb.level - na.level) * f, this._q.lerpVectors(na.lat, nb.lat, f), st,
                );
                pos.setXYZ(s, this._p.x, this._p.y, this._p.z);
                c.copy(cs[0]!).lerp(cs[1]!, f);
                col.setXYZ(s, c.r, c.g, c.b);
            }
            pos.needsUpdate = true;
            col.needsUpdate = true;
            (e.line.material as THREE.LineBasicMaterial).opacity = fade;
        }

        const squash = src.squash();
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), L.up);
        if (L.nodes) {
            const nodes = L.nodes;
            const glow = nodes.geometry.getAttribute('instanceGlow') as THREE.InstancedBufferAttribute;
            L.nodeIdx.forEach((i, j) => {
                const note = this.noteData[j]!;
                if (i < 0) { nodes.setMatrixAt(j, m4.makeScale(0, 0, 0)); return; }
                const { scale, glow: g } = src.readNode(i, c);
                nodes.setColorAt(j, c);
                glow.setX(j, g);
                this.placePoint(note.theta, note.phi, note.level, note.lat, st);
                const sz = scale * this.lookScale;
                m4.compose(this._p, q, this._v.set(sz, sz, sz * squash));
                nodes.setMatrixAt(j, m4);
            });
            nodes.instanceMatrix.needsUpdate = true;
            if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
            glow.needsUpdate = true;
            (nodes.material as THREE.Material).opacity = fade;
        }

        if (L.labels) {
            const pos = L.labels.geometry.getAttribute('position') as THREE.BufferAttribute;
            const op = L.labels.geometry.getAttribute('labelOpacity') as THREE.BufferAttribute;
            L.labelOf.forEach((l, j) => {
                const note = this.noteData[j]!;
                this.placePoint(note.theta, note.phi, note.level, note.lat, st);
                this._p.addScaledVector(L.up, (l?.lift ?? 0) * squash * this.lookScale);
                for (let v = 0; v < 4; v++) {
                    pos.setXYZ(j * 4 + v, this._p.x, this._p.y, this._p.z);
                    op.setX(j * 4 + v, (l?.opacity ?? 0) * fade);
                }
            });
            pos.needsUpdate = true;
            op.needsUpdate = true;
        }
    }

    // ── Placement (any fold stage) ───────────────────────────────────

    private readonly _p = new THREE.Vector3();
    private readonly _n = new THREE.Vector3();
    private readonly _l = new THREE.Vector3();
    private readonly _q = new THREE.Vector3();
    private readonly _v = new THREE.Vector3();
    private lookScale = 1;   // the lattice pose's scale (lattice units -> torus units)

    /** One point at stage `st`, into _p (position) and _n (normal). */
    private placePoint(theta: number, phi: number, level: number, lat: THREE.Vector3 | null, st: Stage, dPhi = 0): void {
        const r = r_ * this.shaftWidth;
        // Accidental levels lift off the surface as the sheet rolls (the squashed lattice is flat).
        const rt = r + (rEffFromLevel(level, this.taper) * this.shaftWidth - r) * st.b1;
        foldPoint(theta, phi + dPhi, r, rt, st.b1, st.b2, this.centre, this._p, this._n);
        if (lat && st.m < 1) this._p.lerpVectors(lat, this._p, st.m);
    }

    /** Place everything at fold stage `st`, vortex offset `offset`. While folding, labels lean toward
     *  `camLocal` (the sheet is seen from both sides); at rest they sit on the outward normal. */
    private placeAll(offset: number, st: Stage, camLocal: THREE.Vector3 | null): void {
        const dPhi = (2 * Math.PI / 7) * offset;
        const { _p: P3, _n: N, _l: L } = this;
        this.styleK = st.k;

        for (const pd of this.pieceData) {
            const pos = pd.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const nrm = pd.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
            const lv = pd.piece.level;
            for (let i = 0; i < pd.theta.length; i++) {
                this.placePoint(pd.theta[i]!, pd.phi[i]!, lv[i]!, L.fromArray(pd.lat, 3 * i), st, dPhi);
                pos.setXYZ(i, P3.x, P3.y, P3.z);
                nrm.setXYZ(i, N.x, N.y, N.z);
            }
            pos.needsUpdate = true;
            nrm.needsUpdate = true;
            pd.mesh.geometry.computeBoundingSphere();
        }

        const lift = (sprite: THREE.Sprite, d: number): void => {
            if (camLocal) sprite.position.copy(P3).addScaledVector(L.subVectors(camLocal, P3).normalize(), d);
            else sprite.position.copy(P3).addScaledVector(N, d);
        };
        for (const note of this.noteData) {
            this.placePoint(note.theta, note.phi, note.level, note.lat, st, dPhi);
            note.mesh.position.copy(P3);
            lift(note.sprite, 0.28);
            (note.mesh.material as THREE.MeshPhongMaterial).opacity = st.k;
            note.sprite.material.opacity = st.k;
            note.mesh.visible = st.k > 0.001;
            note.sprite.visible = note.mesh.visible && this.showNotes;
        }
        for (const l of this.labelData) {
            this.placePoint(l.theta, l.phi, l.level, l.lat, st, dPhi);
            lift(l.sprite, 0.12);
            l.sprite.material.opacity = st.k;
            l.sprite.visible = st.k > 0.001 && this.showChords;
        }
        // K7 bands only on the resting torus (they span the closed surface).
        const resting = st.b2 >= 1 && st.b1 >= 1;
        this.k7Grp.visible = this.showK7 && resting;
        if (this.k7Grp.visible) this.placeK7(dPhi);
        this.updateTriangleActivations();
        this.placeLook(st);
    }

    // ── K7 overlay (every pair of the 7 notes, as bands on the torus) ─

    /** K7 band colour by interval class (letter distance + quality): P5/P4 grey, A5/d4 green, d5/A4
     *  purple, m2/M7 pink, the rest light grey. As in the tonnetz app. */
    private static k7EdgeColor(letterDist: number, quality: IntervalType): number {
        const stepClass = Math.min(letterDist, 7 - letterDist);
        if (stepClass === 3) {
            if (quality === IntervalType.AUGMENTED || quality === IntervalType.DOUBLE_AUGMENTED) return 0x2ecc71;
            if (quality === IntervalType.DIMINISHED || quality === IntervalType.DOUBLE_DIMINISHED) return 0xe855cc;
        }
        if (stepClass === 1) {
            const minorSide = letterDist > 3 ? quality === IntervalType.MAJOR : quality === IntervalType.MINOR;
            if (minorSide) return 0xd4a0b0;
        }
        return 0xcccccc;
    }

    private static k7IntervalQuality(l1: LetterName, a1: number, l2: LetterName, a2: number): IntervalType {
        const letterDist = LetterNameUtils.steps(l1, l2);
        const natural = LETTER_NAME_VALUES[LETTER_NAMES[letterDist]!];
        const semis = (((LETTER_NAME_VALUES[l2] + a2) - (LETTER_NAME_VALUES[l1] + a1)) % 12 + 12) % 12;
        let diff = semis - natural;
        if (diff > 6) diff -= 12;
        if (diff < -6) diff += 12;
        if (letterDist === 0 || letterDist === 3 || letterDist === 4) {
            if (diff === 0) return IntervalType.PERFECT;
            if (diff === 1) return IntervalType.AUGMENTED;
            if (diff === -1) return IntervalType.DIMINISHED;
            return diff > 0 ? IntervalType.DOUBLE_AUGMENTED : IntervalType.DOUBLE_DIMINISHED;
        }
        if (diff === 0) return IntervalType.MAJOR;
        if (diff === -1) return IntervalType.MINOR;
        if (diff === 1) return IntervalType.AUGMENTED;
        if (diff === -2) return IntervalType.DIMINISHED;
        return diff > 0 ? IntervalType.DOUBLE_AUGMENTED : IntervalType.DOUBLE_DIMINISHED;
    }

    /** One band per pair of notes, along the shortest path on the flat torus, at the notes' own phase
     *  (the same phi shift as the surface, so the bands meet the note beads). */
    private rebuildK7(): void {
        clearGroup(this.k7Grp);
        this.k7Data = [];
        const SEGS = 60, HW = 0.06, TAU = 2 * Math.PI;
        const shift = this.domain.phiShift;
        const v = [0, 1, 2, 3, 4, 5, 6].map(k => { const a = latticeToAngles(k, 0); return [a.theta / TAU, (a.phi + shift) / TAU]; });
        const acc = this.letterAccidentals;
        for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
            let du = v[j]![0]! - v[i]![0]!, dv = v[j]![1]! - v[i]![1]!;
            du -= Math.round(du); dv -= Math.round(dv);
            const l1 = FIFTHS_ORDER[i]!, l2 = FIFTHS_ORDER[j]!, a1 = acc[l1] || 0, a2 = acc[l2] || 0;
            const [q1, qa1, q2, qa2] = j - i === 6 ? [l2, a2, l1, a1] as const : [l1, a1, l2, a2] as const;
            const color = TorusScene.k7EdgeColor(LetterNameUtils.steps(q1, q2), TorusScene.k7IntervalQuality(q1, qa1, q2, qa2));
            const coords: { tl: number; pl: number; tr: number; pr: number }[] = [];
            const tubeR = r_ * this.shaftWidth + 0.06;
            for (let k = 0; k <= SEGS; k++) {
                const t = k / SEGS, th = (v[i]![0]! + du * t) * TAU, ph = (v[i]![1]! + dv * t) * TAU;
                // Perpendicular to the path, compensated for the torus metric so the band keeps its width.
                const gt = R + tubeR * Math.cos(ph), gp = tubeR;
                const tx = gt * du * TAU, ty = gp * dv * TAU, tl = Math.hypot(tx, ty) || 1;
                const oT = -ty / tl * HW / gt, oP = tx / tl * HW / gp;
                coords.push({ tl: th + oT, pl: ph + oP, tr: th - oT, pr: ph - oP });
            }
            const idx: number[] = [];
            for (let k = 0; k < SEGS; k++) idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((SEGS + 1) * 6), 3));
            geo.setIndex(idx);
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }));
            mesh.frustumCulled = false;
            this.k7Grp.add(mesh);
            this.k7Data.push({ mesh, coords, pcs: [pcFromFifthIndex(i, 0, acc), pcFromFifthIndex(j, 0, acc)] });
        }
    }

    private placeK7(dPhi: number): void {
        const rr = r_ * this.shaftWidth + 0.06;
        for (const { mesh, coords } of this.k7Data) {
            const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            coords.forEach((c, k) => {
                const [lx, ly, lz] = torusPos(c.tl, c.pl + dPhi, rr);
                const [rx, ry, rz] = torusPos(c.tr, c.pr + dPhi, rr);
                pos.setXYZ(2 * k, lx, ly, lz);
                pos.setXYZ(2 * k + 1, rx, ry, rz);
            });
            pos.needsUpdate = true;
        }
    }

    /** A band lights when both its notes are held. */
    private updateK7Activations(): void {
        if (!this.k7Grp.visible) return;
        const held = this.config.getHeldPCs();
        for (const { mesh, pcs } of this.k7Data) {
            (mesh.material as THREE.MeshBasicMaterial).opacity = held.has(pcs[0]) && held.has(pcs[1]) ? 0.9 : 0.15;
        }
    }

    // ── Controls (the tonnetz app's torus settings) ──────────────────

    private createControls(): void {
        const bar = document.createElement('div');
        bar.className = 'torus-controls waiting';   // shown once a fold has closed the torus
        for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) bar.addEventListener(ev, e => e.stopPropagation());
        const toggles = document.createElement('div'), sliders = document.createElement('div');
        toggles.className = sliders.className = 'torus-controls-row';
        bar.append(toggles, sliders);
        const toggle = (label: string, on: boolean, set: (v: boolean) => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.classList.toggle('active', on);
            b.addEventListener('click', () => set(b.classList.toggle('active')));
            toggles.appendChild(b);
            return b;
        };
        const slider = (label: string, min: number, max: number, value: number, set: (v: number) => void): HTMLInputElement => {
            const wrap = document.createElement('label');
            wrap.textContent = label;
            const range = document.createElement('input');
            Object.assign(range, { type: 'range', min: String(min), max: String(max), step: '0.01', value: String(value) });
            range.addEventListener('input', () => set(Number(range.value)));
            wrap.appendChild(range);
            sliders.appendChild(wrap);
            return range;
        };
        const redraw = (): void => { this.needsGeomUpdate = true; };
        toggle('K7', this.showK7, v => { this.showK7 = v; save('k7', v); redraw(); });
        toggle('Chords', this.showChords, v => { this.showChords = v; save('chords', v); redraw(); });
        toggle('Notes', this.showNotes, v => { this.showNotes = v; save('notes', v); redraw(); });
        const all = toggle('All', this.wireframeAll, v => { this.wireframeAll = v; save('meshAll', v); this.updateTriangleActivations(); });
        const mesh = toggle('Mesh', this.wireframeEnabled, v => {
            this.wireframeEnabled = v; save('mesh', v); all.hidden = !v; this.updateTriangleActivations();
        });
        toggles.insertBefore(mesh, all);   // Mesh, then its "All" option
        all.hidden = !this.wireframeEnabled;
        slider('Rotate', 0, 1, this.rotSpeed, v => { this.rotSpeed = v; save('rotate', v); });
        slider('Vortex', 0, 1, this.vortexSpeed, v => { this.vortexSpeed = v; save('vortex', v); });
        this.twistInput = slider('Twist', 0, 7, this.spiralOffset, v => { if (!this.fold) { this.spiralOffset = v; redraw(); } });
        slider('Taper', 0, 0.5, this.taper, v => { this.taper = v; save('taper', v); this.rebuildGhost(); redraw(); });
        slider('Shaft', 0.1, 1.8, this.shaftWidth, v => this.setShaftWidth(v));
        this.container.appendChild(bar);
        this.controls = bar;
    }

    private twistInput: HTMLInputElement | null = null;
    private controls: HTMLElement | null = null;

    private setShaftWidth(w: number): void {
        this.shaftWidth = w;
        save('shaft', w);
        this.rebuildGhost();
        this.rebuildK7();
        this.needsGeomUpdate = true;
    }

    // ── Fold animation ───────────────────────────────────────────────

    private startFold(view: LatticeView, src: FoldLookSource, dir: 1 | -1, dur: number, onProgress: (u: number) => void, onDone: () => void): void {
        const side = latticeSide(view);
        if (side !== this.side) { this.side = side; this.rebuildModelGeometry(); }
        const d = this.domain;
        const pose = new LatticePose(view, r_ * this.shaftWidth, this.centre, d.centre,
            domainAngles(d, d.centre[0], d.centre[1]), p => this.coverage(src, p));
        this.lookScale = pose.scale;
        const off = mod(this.spiralOffset, 7);
        const rot0 = { ...this.rot };
        const home = this.homeY();
        const rot1 = { x: HOME_X, y: home + 2 * Math.PI * Math.round((rot0.y - home) / (2 * Math.PI)) };
        this.fold = {
            dir, start: performance.now(), dur, pose, latticeCam: pose.camera(), rot0, rot1,
            offset0: off, offset1: off < 3.5 ? 0 : 7, onProgress, onDone,
        };
        this.rVel = { x: 0, y: 0 };
        this.isDrag = false;
        this.controls?.classList.add('waiting');
        this.placeLattice(pose);
        this.buildLook(src, pose);
        if (dir > 0) this.renderer.domElement.style.opacity = '0';   // no flash before the first frame
        this.setVisible(true);
    }

    /** Share of the block (0..1) that the lattice draws at a candidate placement: its 13 nodes, then
     *  (once all are there) its 14 triangles. The lattice draws only some accidental layers, so in a far
     *  key part of its grid is empty; the block goes where it is whole. */
    private coverage(src: FoldLookSource, pose: LatticePose): number {
        const d = this.domain;
        const nodeAt = (x: number, y: number): number => { const { col, row } = pose.cell(x, y); return src.node(col, row); };
        const nodes = d.notes.filter(n => nodeAt(n.x, n.y) >= 0).length;
        const total = d.notes.length + d.pieces.length;
        if (nodes < d.notes.length) return nodes / total;
        const v = new THREE.Vector3();
        const tris = d.pieces.filter(p => {
            const w = p.corners.map(([x, y]) => src.nodeWorld(nodeAt(x, y), v.clone()));
            return src.triangle(w[0]!, w[1]!, w[2]!) !== null;
        }).length;
        return (nodes + tris) / total;
    }

    /** The resting torus camera, expressed in the group's local space. */
    private restingCameraLocal(): CamPose {
        const inv = this.grp.quaternion.clone().invert();
        const yOff = -1.6;
        return {
            pos: new THREE.Vector3(0, this.curZ * 0.3 + yOff, this.curZ).applyQuaternion(inv),
            target: new THREE.Vector3(0, yOff, 0).applyQuaternion(inv),
            up: new THREE.Vector3(0, 1, 0).applyQuaternion(inv),
            fov: 45,
        };
    }

    /** Camera between two group-local poses: target and distance lerp, orientation slerps. */
    private blendCamera(a: CamPose, b: CamPose, k: number): THREE.Vector3 {
        const look = (c: CamPose): THREE.Quaternion => {
            const m = new THREE.Matrix4().lookAt(c.pos, c.target, c.up);
            return new THREE.Quaternion().setFromRotationMatrix(m);
        };
        const q = look(a).slerp(look(b), k);
        const target = a.target.clone().lerp(b.target, k);
        const dist = THREE.MathUtils.lerp(a.pos.distanceTo(a.target), b.pos.distanceTo(b.target), k);
        const local = target.clone().add(new THREE.Vector3(0, 0, dist).applyQuaternion(q));
        this.camera.position.copy(local).applyMatrix4(this.grp.matrixWorld);
        this.camera.quaternion.copy(this.grp.quaternion).multiply(q);
        this.camera.fov = THREE.MathUtils.lerp(a.fov, b.fov, k);
        this.camera.updateProjectionMatrix();
        return local;
    }

    private stepFold(f: Fold, now: number): void {
        const t = clamp((now - f.start) / f.dur, 0, 1);
        const u = f.dir > 0 ? t : 1 - t;
        if (f.dir < 0) {
            const k = smooth(t / 0.25);
            this.spiralOffset = THREE.MathUtils.lerp(f.offset0, f.offset1, k);
            this.rot = { x: THREE.MathUtils.lerp(f.rot0.x, f.rot1.x, k), y: THREE.MathUtils.lerp(f.rot0.y, f.rot1.y, k) };
        }
        this.grp.rotation.set(this.rot.x, this.rot.y, 0);
        this.grp.updateMatrixWorld(true);
        f.onProgress(u);
        const st = stageAt(u);
        this.renderer.domElement.style.opacity = String(st.fade);
        if (this.ghostMesh) this.ghostMesh.visible = u >= 1;
        // The resting camera is tracked live, so the torus can turn home while the camera holds still.
        const camLocal = this.blendCamera(f.latticeCam, this.restingCameraLocal(), smooth((u - CAM_FROM) / (1 - CAM_FROM)));
        this.placeAll(this.spiralOffset, st, u >= 1 ? null : camLocal);
        if (t < 1) return;
        this.fold = null;
        this.spiralOffset = mod(this.spiralOffset, 7);
        this.needsGeomUpdate = true;
        this.camera.fov = 45;
        this.camera.updateProjectionMatrix();
        if (f.dir > 0) this.controls?.classList.remove('waiting');
        f.onDone();
    }

    // ── Activations ──────────────────────────────────────────────────

    private updateTriangleActivations(): void {
        const getRes = this.config.getResonanceActivation;
        for (const { mesh } of this.pieceData) {
            const pcs = mesh.userData.pcs as number[];
            const act = Math.min(...pcs.map(pc => this.config.getNoteActivation(pc)));
            const res = getRes ? Math.min(...pcs.map(pc => getRes(pc))) : 0;
            const mat = mesh.material as THREE.MeshPhongMaterial;
            const c = mesh.userData.colorRGB as { r: number; g: number; b: number };
            const active = TorusScene.TRI_OPACITY_BASE + (TorusScene.TRI_OPACITY_HELD - TorusScene.TRI_OPACITY_BASE) * res;
            mat.opacity = (TorusScene.TRI_OPACITY_IDLE + act * (active - TorusScene.TRI_OPACITY_IDLE)) * this.styleK;
            mat.visible = this.styleK > 0.001;
            mat.wireframe = this.wireframeEnabled && (this.wireframeAll || !isPerfectTriad(mesh.userData.type as TriadQuality | null));
            mat.color.setRGB(c.r, c.g, c.b);
            const em = res * 0.15;
            mat.emissive.setRGB(c.r * em, c.g * em, c.b * em);
        }
    }

    private updateNoteActivations(): void {
        const held = this.config.getHeldPCs();
        for (const note of this.noteData) {
            const act = this.config.getNoteActivation(note.pc);
            const mat = note.mesh.material as THREE.MeshPhongMaterial;
            if (held.has(note.pc)) { note.mesh.scale.setScalar(2); mat.emissiveIntensity = 0.8; }
            else if (act > 0.01) { note.mesh.scale.setScalar(1 + 0.5 * act); mat.emissiveIntensity = 0.3 + 0.4 * act; }
            else { note.mesh.scale.setScalar(1); mat.emissiveIntensity = 0.3; }
        }
    }

    // ── Interaction (drag to turn, wheel to zoom; ignored mid-fold) ──

    private setupInteraction(): void {
        const cvs = this.renderer.domElement;
        const drag = (x: number, y: number): void => {
            this.rVel = { x: (y - this.prev.y) * 0.004, y: (x - this.prev.x) * 0.004 };
            this.rot.x = clamp(this.rot.x + this.rVel.x, -1.5, 1.5);
            this.rot.y += this.rVel.y;
            this.prev = { x, y };
        };
        cvs.addEventListener('mousedown', e => { if (this.fold) return; this.isDrag = true; this.prev = { x: e.clientX, y: e.clientY }; this.rVel = { x: 0, y: 0 }; });
        cvs.addEventListener('mousemove', e => { if (this.isDrag && !this.fold) drag(e.clientX, e.clientY); });
        cvs.addEventListener('mouseup', () => { this.isDrag = false; });
        cvs.addEventListener('mouseleave', () => { this.isDrag = false; });
        cvs.addEventListener('wheel', e => {
            e.preventDefault();
            if (this.fold) return;
            this.tgtZ = clamp(this.tgtZ + e.deltaY * 0.005, 3.5, 24);
        }, { passive: false });
        cvs.addEventListener('touchstart', e => {
            if (this.fold || e.touches.length !== 1) return;
            this.isDrag = true; this.prev = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY }; this.rVel = { x: 0, y: 0 };
        });
        cvs.addEventListener('touchmove', e => {
            if (!this.isDrag || this.fold || e.touches.length !== 1) return;
            drag(e.touches[0]!.clientX, e.touches[0]!.clientY);
            e.preventDefault();
        }, { passive: false });
        cvs.addEventListener('touchend', () => { this.isDrag = false; });
    }

    // ── Frame loop ───────────────────────────────────────────────────

    private startAnimate(): void {
        if (this.raf !== null) return;
        const loop = (): void => {
            if (!this.visible) { this.raf = null; return; }
            this.raf = requestAnimationFrame(loop);
            this.animateFrame();
        };
        this.raf = requestAnimationFrame(loop);
    }

    private stopAnimate(): void {
        if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; }
    }

    /** Two passes: the torus (linear output, as in the tonnetz app), then the lattice look (sRGB output,
     *  as the lattice renders it). */
    private draw(): void {
        // The sRGB pass leaves an sRGB-converted clear colour behind; set it again under linear output.
        this.renderer.setClearColor(this.clearColor);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        if (this.look?.group.visible) {
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
            this.renderer.render(this.lookScene, this.camera);
            this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        }
    }

    private animateFrame(): void {
        if (this.fold) {
            this.stepFold(this.fold, performance.now());
            this.draw();
            return;
        }
        this.rot.y += this.rotSpeed * 0.007;
        this.spiralOffset = (this.spiralOffset + this.vortexSpeed * 0.01) % 7;
        if (this.twistInput && this.vortexSpeed > 0) this.twistInput.value = String(this.spiralOffset);
        if (!this.isDrag) {
            this.rVel.x *= 0.94;
            this.rVel.y *= 0.94;
            this.rot.x = clamp(this.rot.x + this.rVel.x, -1.5, 1.5);
            this.rot.y += this.rVel.y;
        }
        this.grp.rotation.set(this.rot.x, this.rot.y, 0);
        this.grp.updateMatrixWorld(true);

        this.curZ += (this.tgtZ - this.curZ) * 0.08;
        const yOff = -1.6;
        this.camera.position.set(0, this.curZ * 0.3 + yOff, this.curZ);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(0, yOff, 0);

        if (this.spiralOffset !== this.lastOffset || this.needsGeomUpdate) {
            this.placeAll(this.spiralOffset, FULL, null);
            this.lastOffset = this.spiralOffset;
            this.needsGeomUpdate = false;
        }
        this.renderer.domElement.style.opacity = '1';
        if (this.ghostMesh) this.ghostMesh.visible = true;
        this.draw();
    }
}
