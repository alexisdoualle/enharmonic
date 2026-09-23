import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PitchClass } from './core/PitchClass';
import { TRI_OPACITY_BASE, TRI_OPACITY_HELD } from './constants';
import type { LetterName, NoteDisplayMode } from './types';
import { AccidentalUtils, NoteDisplayUtils } from './types';
import {
    computeLatticeNodes,
    computeLatticeTriangles,
    computeScalePathV2,
    classifyEdgeInterval,
    extendedFifthsPos,
    // computeStartFifths not used: grid anchor is fixed to C major naturals
    X_SPACING, Y_SPACING, Z_SPACING, ROW_SHIFT,
    LatticeNode,
} from './LatticeGeometry';
import { computeArrowLit, hasNonPerfectFifth, LETTER_INDICES, LIT_THRESHOLD } from './arrowLogic';

// ── Config interface (simplified: no getNoteAt, getTriadType, getTriadActivation) ──

export interface TonnetzSceneConfig {
    getThirds: () => PitchClass[];          // current scale (7 notes) for highlighting
    getTriadColor: (type: string, notes?: PitchClass[]) => string; // color mapping
    getActivePCs: () => Set<number>;         // active MIDI pitch classes
    getHeldPCs: () => Set<number>;           // held MIDI pitch classes
    getNoteActivation: (pc: number) => number; // activation level per pitch class
    freeMode: () => boolean;
    cols: () => number;                      // grid columns (fifths-chain width)
    rows: () => number;                      // grid rows (m3 depth)
    getOffset?: () => number;                // note offset (0-6), shifts grid along fifths chain
    getNoteOnTimestamps?: () => Map<number, number>;  // for arrow resolution temporal logic
    getFifthsForward?: () => boolean;        // false = reverse x-axis (fourths direction)
    getYInverted?: () => boolean;             // true = invert y-axis (thirds rows)
    getZInverted?: () => boolean;             // true = invert z-axis (accidental layers)
    getResonanceActivePCs?: () => Set<number>;  // PCs above resonance threshold + held
    getResonanceActivation?: (pc: number) => number; // resonance level per PC
    getSpellingPenalty?: (midiPC: number, letterName: string, accidental: number) => number | undefined;
    getBestSpellingPenalty?: (midiPC: number) => number | undefined;
    getResolvedMidi?: () => ((letterIdx: number) => number | null) | null;
    getHeldNoteColor?: (pc: number) => string | null; // chord-role color for held notes (hex)
    /**
     * When the accumulator detects sus2/sus4/cadential 6-4, returns the altered
     * spelling (letter + accidental) per held PC that the 3D scene should bias
     * triangle activation toward (e.g. PC 5 → { letter: 'E', accidental: 1 }
     * for Csus4). Empty/null map = no bias.
     */
    getPreferredSpelling?: () => ReadonlyMap<number, { letter: LetterName; accidental: number }> | null;
    /**
     * When the diatonic anchor toggle is on, returns the 7 anchor pitch classes
     * (natural major or natural minor of the current root) that triangles are
     * classified against: anchor (full opacity) vs alteration (faded overlay).
     */
    getDiatonicAnchor?: () => PitchClass[];
}

// ── Helpers ────────────────────────────────────────────────────────

function normPC(pc: number): number { return ((pc % 12) + 12) % 12; }

// Canonical display order for interval toggles
const INTERVAL_ORDER = ['P5', 'M3', 'm3', 'd5', 'A5', 'A6', 'A3'];

const EXOTIC_TRIAD_TYPES = new Set(['aug3', 'dim3']);



// Enharmonic triangles: quality multiplier (0 = invisible, 1 = same as exact match)


// Triangle opacity tuning (fill uses shared TRI_OPACITY_BASE / TRI_OPACITY_HELD from tonnetz.ts)
const TRI_FILL_SCALE = 0.2;          // 3D fill dimming factor (fraction of 2D opacity)
const TRI_WIRE_BASE = 0.25;        // wireframe baseline when inactive
const TRI_WIRE_ACTIVE = 0.02;      // wireframe boost when activated (not held)
const TRI_WIRE_HELD = 0.45;        // wireframe boost when all 3 notes held
const ALTERATION_OPACITY_FACTOR = 0.4; // diatonic anchor overlay dim factor

// Visual smoothing time constants (seconds): reduces flicker during fast MIDI playback.
// Deliberately heavier than the 2D grid so the 3D scene shows "average" state during fast passages
// rather than tracking every individual note pulse (trades reactivity for smoothness).
const SMOOTH_ATTACK_TAU = 0.060;       // 60ms rise: absorbs rapid repeated notes
const SMOOTH_RELEASE_TAU = 0.150;      // 150ms fall: smooths out rapid on/off flicker
const SMOOTH_HELD_ATTACK_TAU = 0.030;  // 30ms held rise: quick but not instant
const SMOOTH_HELD_RELEASE_TAU = 0.100; // 100ms held fade: prevents white↔blue flicker
const Z_ANIM_TAU = 0.15;               // 150ms accidental-slide time constant (smoother motion)
const Z_ANIM_MIN_STEP = 1 / 60;        // update z buffers at most once per display frame
const Z_ANIM_HEAVY_GEOMETRY_EVERY = 2; // while audio is active: triangle/wire z every N z-steps

// Scale path colors
const PATH_COLOR_P5 = 0x8888ff;
const PATH_COLOR_D5 = 0xff6644;
const PATH_COLOR_A5 = 0x66ff88;

// Resolution arrow constants
const ARROW_COLOR_DIM = 0x5a5a66;
const ARROW_COLOR_LIT = 0xffffff;
const ARROW_DIM_OPACITY = 0.15;
const ARROW_HEAD_LENGTH = 0.15;
const ARROW_HEAD_WIDTH = 0.08;
const ARROW_SHAFT_RADIUS = 0.015;
const NODE_RADIUS = 0.11; // matches sphereGeo radius, used to shorten arrows
const ARROW_TARGET_COLOR = 0xffd700; // gold highlight for resolution target nodes
const ARROW_ENHARMONIC_TARGET_COLOR = 0xcc7744; // copper highlight for enharmonic arrow targets
const EXTRA_NODE_OPACITY_ALL_NOTES = 0.3; // non-scale nodes when "All Notes" is enabled
const EXTRA_NODE_OPACITY_FOCUSED = 0.55;  // non-scale nodes in focused mode
const EXTRA_NODE_GRAY = 0x7a7a88;          // base gray for enharmonic/extra notes
const EXTRA_NODE_GRAY_DIM = 0x666674;      // dim gray for inactive extra notes

// Label billboard shaders: single draw call for all node labels
const LABEL_VERTEX_SHADER = /* glsl */`
attribute vec2 labelOffset;
attribute float labelOpacity;
varying vec2 vUv;
varying float vOpacity;
void main() {
    vUv = uv;
    vOpacity = labelOpacity;
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    viewPos.xy += labelOffset;
    gl_Position = projectionMatrix * viewPos;
}
`;

const LABEL_FRAGMENT_SHADER = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
varying float vOpacity;
void main() {
    vec4 texColor = texture2D(map, vUv);
    if (texColor.a < 0.01) discard;
    gl_FragColor = vec4(texColor.rgb, texColor.a * vOpacity);
}
`;

// ── Label texture atlas ───────────────────────────────────────────

interface AtlasEntry { u: number; v: number; w: number; h: number; }
type TriMeshGroup = 'flat' | 'tiltedPerfect' | 'tiltedNonPerfect';

class LabelAtlas {
    readonly texture: THREE.CanvasTexture;
    private entries = new Map<string, AtlasEntry>();
    private atlasW = 512;
    private atlasH = 512;

    constructor(private displayMode: NoteDisplayMode = 'letter') {
        const canvas = document.createElement('canvas');
        canvas.width = this.atlasW;
        canvas.height = this.atlasH;
        const ctx = canvas.getContext('2d')!;

        ctx.font = 'bold 20px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffffff';

        // Generate all possible labels
        const labels = this.generateLabels();
        const cellW = 64;
        const cellH = 32;
        const cols = Math.floor(this.atlasW / cellW);

        labels.forEach((label, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const cx = col * cellW + cellW / 2;
            const cy = row * cellH + cellH / 2;

            ctx.fillText(label, cx, cy);

            this.entries.set(label, {
                u: col * cellW / this.atlasW,
                v: 1 - (row + 1) * cellH / this.atlasH,
                w: cellW / this.atlasW,
                h: cellH / this.atlasH,
            });
        });

        this.texture = new THREE.CanvasTexture(canvas);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
    }

    private generateLabels(): string[] {
        const letters: LetterName[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
        const labels: string[] = [];
        // Generate labels for accidentals from -maxAcc to +maxAcc
        const maxAcc = 6;
        for (let acc = -maxAcc; acc <= maxAcc; acc++) {
            for (const letter of letters) {
                labels.push(NoteDisplayUtils.toDisplayName(letter, this.displayMode, true, acc));
            }
        }
        return labels;
    }

    getEntry(label: string): AtlasEntry | undefined {
        return this.entries.get(label);
    }

    dispose(): void {
        this.texture.dispose();
    }
}

// ── TonnetzSceneV2 ────────────────────────────────────────────────

export class TonnetzSceneV2 {
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private controls: OrbitControls;
    private container: HTMLElement;
    private config: TonnetzSceneConfig;
    private visible = false;

    // Object groups
    private nodeGroup = new THREE.Group();
    private triangleGroup = new THREE.Group();
    private pathGroup = new THREE.Group();
    private labelGroup = new THREE.Group();
    private arrowGroup = new THREE.Group();
    private axisGroup = new THREE.Group();

    // Resolution arrows (semitone tendencies at d5 boundaries)
    private arrowData: {
        fromPC: number;
        toPC: number;
        toLetterIdx: number;
        arrow: THREE.Group;
        shaftMat: THREE.MeshBasicMaterial;
        coneMat: THREE.MeshBasicMaterial;
        targetGridKey: string; // "gridRow:layer:gridCol" for gold highlight lookup
        isEnharmonic: boolean;
    }[] = [];

    // InstancedMesh for nodes
    private nodeInstanced: THREE.InstancedMesh | null = null;
    private nodeOpacityAttr: THREE.InstancedBufferAttribute | null = null;
    // Per-instance glow (0..1): held nodes self-illuminate past scene lighting + get a fresnel rim
    private nodeGlowAttr: THREE.InstancedBufferAttribute | null = null;
    private nodeData: { pc: PitchClass; layer: number; isScaleNote: boolean; isEnharmonicNote: boolean; x: number; y: number; z: number; midiPC: number; nodeKey: string }[] = [];
    private nodeIndexMap = new Map<string, number>(); // "gridRow:layer:gridCol" → instanced mesh index
    private sphereGeo: THREE.SphereGeometry;
    // Cached node material: created once, reused across rebuilds to skip shader setup.
    private _nodeMaterial: THREE.MeshStandardMaterial | null = null;

    // Merged triangle buffers
    private triMesh: THREE.Mesh | null = null;
    private triMeshTiltedPerfect: THREE.Mesh | null = null;
    private triMeshTiltedNonPerfect: THREE.Mesh | null = null;
    private intervalWires = new Map<string, THREE.LineSegments>();
    private layerZeroWires: THREE.LineSegments | null = null;
    private triData: {
        pcs: [number, number, number];
        spellings: [string, string, string];
        letters: [LetterName, LetterName, LetterName];
        accidentals: [number, number, number];
        triadType: string;
        color: string;        // per-triangle color (may vary within same triadType)
        edgeIntervals: Set<string>;
        edgeMapping: { interval: string; wireIdx: number }[];
        hasSecond: boolean;  // true if any edge is M2 or m2: not a valid triad
        isMisspelled: boolean; // A5 edge in a major/minor/dim triad (enharmonic misspelling)
        meshIdx: number; // index into the mesh group geometry
        meshGroup: TriMeshGroup;
        shade: number;   // normal-based shading factor (0..1) for 3D depth
        tilted: boolean; // true if triangle crosses accidental layers (meshGroup !== flat)
    }[] = [];
    // Sparse triangle update: PC → triangle indices containing that PC (built during buildTriangles)
    private _pcToTriangles: Map<number, number[]> = new Map();
    // Track which triangles were non-zero last frame (need updating to fade out)
    private _activeTriIndices: Set<number> = new Set();

    // Label atlas
    private labelAtlas: LabelAtlas;
    private displayMode: NoteDisplayMode = 'letter';

    // Reusable scratch objects for per-frame update methods (avoid GC pressure)
    private readonly _scratchColor = new THREE.Color();
    private readonly _scratchMatrix = new THREE.Matrix4();
    private readonly _scratchActivationMap = new Map<string, number>();
    private readonly _scratchHeldLetterAcc = new Set<string>();
    private readonly _scratchActiveSet = new Set<string>();
    private readonly _scratchActivationByPC = new Map<number, number>();
    private readonly _scratchExactSpellings = new Set<string>();
    private readonly _scratchResolvedAccByLetter = new Map<LetterName, number>();
    private readonly _scratchAnchorPCByLetter = new Map<LetterName, number>();
    private readonly _scratchAnchorAccByLetter = new Map<LetterName, number>();
    private readonly _scratchAnchorPCSet = new Set<number>();
    private readonly _scratchLetterActivation = new Map<LetterName, number>();
    private _anchorScratchRef: PitchClass[] | null = null; // last anchor array; rebuild scratches only when this changes
    private readonly _scratchTriColorCache = new Map<string, THREE.Color>();
    private readonly _scratchWireColorAttrs = new Map<string, THREE.BufferAttribute>();
    private readonly _scratchTriUpdateSet = new Set<number>();
    private readonly _scratchNewActive = new Set<number>();
    private readonly _scratchGoldColor = new THREE.Color(ARROW_TARGET_COLOR);
    private readonly _scratchCopperColor = new THREE.Color(ARROW_ENHARMONIC_TARGET_COLOR);

    // Visual smoothing state (per pitch class, 0-11)
    private _smoothedByPC = new Float32Array(12);
    private _smoothedHeldByPC = new Float32Array(12);
    private _prevSmoothedByPC = new Float32Array(12);   // previous frame (dirty tracking)
    private _prevSmoothedHeldByPC = new Float32Array(12);
    // Last spectrum colour applied per PC. A held/active node's colour is key- and
    // spelling-driven, so it can change with NO activation change (e.g. the key settles
    // from a transient tonic to the real one). Without tracking this, the node freezes
    // on the colour it had when its PC last changed activation; the piano has no such
    // gate, so the two disagree (a held D shows the settled cyan on the keys but a
    // stale degree colour on the node). Comparing this each frame re-dirties the PC.
    private _lastHeldColorByPC: (string | null)[] = new Array(12).fill(null);
    private _lastSmoothTime = 0;
    // Pre-computed resonance per-PC (avoids per-triangle callback overhead)
    private _resonanceByPC = new Float32Array(12);
    private _prevResonanceByPC = new Float32Array(12);  // previous frame (dirty tracking)
    // PCs whose smoothed values changed this frame (for sparse node/triangle updates)
    private _dirtyPCs = new Set<number>();
    // Pre-allocated colors for smooth held blending
    private readonly _activeBlue = new THREE.Color(0x90caf9);
    private readonly _hdrWhite = new THREE.Color(2, 2, 2);
    private readonly _enhSilver = new THREE.Color(0xc0c0c0);
    private readonly _scratchHeldColor = new THREE.Color();

    // Per-letter z-offset animation (chromatic slide)
    private _letterZOffset = new Map<string, number>();    // LetterName → current animated offset
    private _prevScaleAcc = new Map<string, number>();     // LetterName → accidental at last rebuild
    private _letterToNodeIdx = new Map<string, number[]>(); // LetterName → instance indices
    private _letterToTriVerts = new Map<string, {idx: number; z: number; meshGroup: TriMeshGroup}[]>(); // LetterName → tri position attr entries
    private _letterToWireVerts = new Map<string, Map<string, {idx: number; z: number}[]>>(); // LetterName → interval → wire entries
    private _lastZAnimTime = 0; // seconds, timestamp of last z animation tick
    private _zAnimAccumDt = 0;  // seconds, accumulated dt for throttled z-buffer writes
    private _zAnimStep = 0;     // counts z animation ticks for heavy-geometry throttling

    // Camera tracking
    private lastCols = -1;
    private lastRows = -1;

    // Cached grid params
    private currentStartFifths = 0;
    private currentNodes: LatticeNode[] = [];
    private gridMaxX = 0;  // max x extent, used for mirroring

    // Dynamic layer range (layer 0 always present)
    private layerMin = -1;  // ≤ 0
    private layerMax = 1;   // ≥ 0

    private get layers(): number[] {
        return Array.from({ length: this.layerMax - this.layerMin + 1 }, (_, i) => this.layerMin + i);
    }

    // Display toggles
    private showGhostNodes = false;
    private showLayerZeroOnly = false;
    private activateEnharmonics = false;
    private showIntervals: Record<string, boolean> = { P5: false, M3: false, m3: false, d5: false, A5: false, A6: false, A3: false }; // per-interval visibility
    private showEnharmonicTriads: Record<string, boolean> = {
        major: true, minor: true, diminished: true, augmented: true,
        flat5: true, aug6: true, aug3: false, dim3: false,
    };
    private showTiltedPerfect = true;
    private suspensionTilt = false; // when true, boost tilted triangles whose vertex spellings match getPreferredSpelling()
    private diatonicAnchor = false; // when true, anchor triangles use letter-based activation; alteration overlays appear faded
    private chromaticSlide = true;  // when true, animate vertex z-positions on accidental changes; off = snap to new layer instantly
    private meshAll = false;         // false = only mesh tilted triangles, flat ones stay filled
    private meshTiltedNonPerfect = false; // false = dim/aug/etc. tilted triangles stay filled
    private show3LayerTriads = true;
    private showAxes = true;
    private showTrianglePattern = false;
    private DEBUG_SHOW_COORDS = true; // hardcoded: show (x, y, z) below each node
    private patternTexture: THREE.CanvasTexture;
    private maxAccidentals = 1;
    private maxEnharmonicPenaltyGap = 99;
    private maxEnharmonicDistance = 1;
    private zSpacing = Z_SPACING;
    private scaleAccByLetter = new Map<LetterName, number>(); // letter → accidental for current scale
    private enhArrowTargetPCs = new Set<number>(); // MIDI PCs that enharmonic arrows point to
    private _renderPending = false; // coalesce multiple render requests into one rAF
    private _updateCycle = 0;      // stagger expensive updates across frames

    constructor(container: HTMLElement, config: TonnetzSceneConfig) {
        this.container = container;
        this.config = config;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x1a1a2e);
        container.appendChild(this.renderer.domElement);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.add(this.nodeGroup);
        this.scene.add(this.triangleGroup);
        this.scene.add(this.pathGroup);
        this.scene.add(this.labelGroup);
        this.scene.add(this.arrowGroup);
        this.scene.add(this.axisGroup);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
        this.camera.up.set(0, 0, 1);
        this.camera.position.set(-3, -5, 9);

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(5, 10, 7);
        this.scene.add(dir);

        // Controls (no damping; on-demand rendering)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;
        this.controls.addEventListener('change', () => this.render());

        // Shared geometry (reduced segments; these are small nodes, 12×8 is plenty)
        this.sphereGeo = new THREE.SphereGeometry(0.11, 12, 8);

        // Label atlas
        this.labelAtlas = new LabelAtlas();

        // Hatched pattern texture for triangle fills
        this.patternTexture = this.createPatternTexture();

        this.resize();

        // Auto-resize when container dimensions change
        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(this.container);
    }

    private _resizeObserver: ResizeObserver;

    // ── Public API ─────────────────────────────────────────────────

    rebuild(): void {
        if (!this.visible) return;

        // Snapshot accidentals before rebuild for z-offset animation
        const prevAcc = new Map(this._prevScaleAcc);

        this.clearGroups();

        const thirds = this.config.getThirds();

        // Update accidental snapshot for next rebuild
        this._prevScaleAcc.clear();
        for (const pc of thirds) {
            this._prevScaleAcc.set(pc.letterName, pc.accidental);
        }
        const numCols = Math.floor(this.config.cols() / 2);
        const numRows = this.config.rows();

        const fifthsForward = this.config.getFifthsForward?.() ?? true;
        const middleRow = Math.floor(numRows / 2);

        // Fixed grid anchor: D (fifths position 3, median of the 7 naturals)
        // at grid center. Grid never shifts when individual scale notes change.
        // Offset shifts the grid along the fifths chain to match the 2D view.
        const offset = this.config.getOffset?.() ?? 0;
        this.currentStartFifths = 3 + offset - Math.floor(numCols / 2) - middleRow * ROW_SHIFT;

        // Compute all nodes from the self-contained grid
        this.currentNodes = computeLatticeNodes(thirds, numCols, numRows, this.currentStartFifths, this.layers, this.zSpacing);

        // Mirror x-axis when fifths direction is reversed (fourths mode)
        this.gridMaxX = 0;
        for (const n of this.currentNodes) if (n.x > this.gridMaxX) this.gridMaxX = n.x;
        if (!fifthsForward) {
            for (const n of this.currentNodes) n.x = this.gridMaxX - n.x;
        }

        // Flip y-axis so row 0 is at the far side and higher rows are in the foreground
        // When yInverted, skip the flip (mirror the thirds axis)
        const yInverted = this.config.getYInverted?.() ?? false;
        if (!yInverted) {
            let gridMaxY = 0;
            for (const n of this.currentNodes) if (n.y > gridMaxY) gridMaxY = n.y;
            for (const n of this.currentNodes) n.y = gridMaxY - n.y;
        }

        // Mirror z-axis when inverted (flips accidental layer depth)
        if (this.config.getZInverted?.()) {
            let gridMinZ = Infinity, gridMaxZ = -Infinity;
            for (const n of this.currentNodes) {
                if (n.z < gridMinZ) gridMinZ = n.z;
                if (n.z > gridMaxZ) gridMaxZ = n.z;
            }
            for (const n of this.currentNodes) n.z = gridMinZ + gridMaxZ - n.z;
        }

        // Filter out nodes with too many accidentals (relative to their layer,
        // so each layer retains the same range of pitch classes)
        this.currentNodes = this.currentNodes.filter(n => Math.abs(n.pc.accidental - n.layer) <= this.maxAccidentals);

        // Filter out enharmonic nodes whose spelling penalty exceeds the threshold
        this.currentNodes = this.currentNodes.filter(n =>
            n.isScaleNote || this.isWithinPenaltyThreshold(n.pc)
        );

        // Build letter→accidental map for the current scale (used by enharmonic distance checks)
        this.scaleAccByLetter.clear();
        for (const pc of thirds) {
            this.scaleAccByLetter.set(pc.letterName, pc.accidental);
        }

        this.enhArrowTargetPCs = this.computeEnharmonicTargetPCs();
        this.buildNodes();
        this.buildTriangles();
        this.buildScalePath();
        this.pathGroup.visible = false;
        this.buildArrows();
        this.buildAxes();

        // Compute z-offsets for letters whose accidental changed (chromatic slide animation)
        if (this.chromaticSlide) {
            for (const [letter, newAcc] of this._prevScaleAcc) {
                const oldAcc = prevAcc.get(letter);
                if (oldAcc !== undefined && oldAcc !== newAcc) {
                    this._letterZOffset.set(letter, (oldAcc - newAcc) * this.zSpacing);
                }
            }
            // Apply initial offsets immediately so the slide starts from the previous layer.
            if (this._letterZOffset.size > 0) {
                this.applyZOffsets();
            }
        }

        if (numCols !== this.lastCols || numRows !== this.lastRows) {
            this.lastCols = numCols;
            this.lastRows = numRows;
            this.centerCamera();
        }

        this.render();
    }

    /**
     * Fast path for spelling-only changes (same MIDI pitch classes, different
     * accidental spellings). Reuses triangle and wireframe geometry: only
     * rebuilds nodes, labels, scale path, and arrows. Triangle colors update
     * on the next updateActivations() via the existing per-frame logic.
     *
     * Grid node positions are fixed by (col, row, layer) and don't depend on
     * the scale, so triangle topology and letter→vertex maps stay valid. The
     * caller must ensure this is only called when the grid params (cols,
     * rows, startFifths, layers, inversions) haven't changed.
     */
    updateSpellings(): void {
        if (!this.visible) return;
        // Safety: if no prior rebuild has populated triangle geometry,
        // we have no geometry to reuse: fall back to full rebuild.
        if (!this.triMesh && !this.triMeshTiltedPerfect && !this.triMeshTiltedNonPerfect) {
            this.rebuild();
            return;
        }

        // Snapshot accidentals before update for z-offset animation
        const prevAcc = new Map(this._prevScaleAcc);

        // Reset any in-flight z-animation so triangle/wireframe positions
        // snap back to their base z before we apply new offsets.
        if (this._letterZOffset.size > 0) {
            for (const letter of this._letterZOffset.keys()) {
                this._letterZOffset.set(letter, 0);
            }
            this.applyZOffsets();
            this._letterZOffset.clear();
        }
        this._lastZAnimTime = 0;
        this._zAnimAccumDt = 0;
        this._zAnimStep = 0;
        this._lastSmoothTime = 0;

        const thirds = this.config.getThirds();

        this._prevScaleAcc.clear();
        for (const pc of thirds) {
            this._prevScaleAcc.set(pc.letterName, pc.accidental);
        }

        const numCols = Math.floor(this.config.cols() / 2);
        const numRows = this.config.rows();
        const fifthsForward = this.config.getFifthsForward?.() ?? true;
        const middleRow = Math.floor(numRows / 2);
        const offset = this.config.getOffset?.() ?? 0;
        this.currentStartFifths = 3 + offset - Math.floor(numCols / 2) - middleRow * ROW_SHIFT;

        this.currentNodes = computeLatticeNodes(
            thirds, numCols, numRows, this.currentStartFifths, this.layers, this.zSpacing,
        );

        this.gridMaxX = 0;
        for (const n of this.currentNodes) if (n.x > this.gridMaxX) this.gridMaxX = n.x;
        if (!fifthsForward) {
            for (const n of this.currentNodes) n.x = this.gridMaxX - n.x;
        }
        const yInverted = this.config.getYInverted?.() ?? false;
        if (!yInverted) {
            let gridMaxY = 0;
            for (const n of this.currentNodes) if (n.y > gridMaxY) gridMaxY = n.y;
            for (const n of this.currentNodes) n.y = gridMaxY - n.y;
        }
        if (this.config.getZInverted?.()) {
            let gridMinZ = Infinity, gridMaxZ = -Infinity;
            for (const n of this.currentNodes) {
                if (n.z < gridMinZ) gridMinZ = n.z;
                if (n.z > gridMaxZ) gridMaxZ = n.z;
            }
            for (const n of this.currentNodes) n.z = gridMinZ + gridMaxZ - n.z;
        }
        this.currentNodes = this.currentNodes.filter(n => Math.abs(n.pc.accidental - n.layer) <= this.maxAccidentals);
        this.currentNodes = this.currentNodes.filter(n =>
            n.isScaleNote || this.isWithinPenaltyThreshold(n.pc)
        );

        this.scaleAccByLetter.clear();
        for (const pc of thirds) {
            this.scaleAccByLetter.set(pc.letterName, pc.accidental);
        }
        this.enhArrowTargetPCs = this.computeEnharmonicTargetPCs();

        // Rebuild only the groups that depend on the current scale's spelling.
        // Triangles and wireframes stay intact; their geometry is grid-bound
        // and updateTriangleActivations() will re-derive isExactMatch next frame.
        this.clearNodeGroup();
        this.clearLabelGroup();
        this.clearPathGroup();
        this.clearArrowGroup();

        this.buildNodes();
        this.buildScalePath();
        this.pathGroup.visible = false;
        this.buildArrows();

        if (this.chromaticSlide) {
            for (const [letter, newAcc] of this._prevScaleAcc) {
                const oldAcc = prevAcc.get(letter);
                if (oldAcc !== undefined && oldAcc !== newAcc) {
                    this._letterZOffset.set(letter, (oldAcc - newAcc) * this.zSpacing);
                }
            }
            if (this._letterZOffset.size > 0) {
                this.applyZOffsets();
            }
        }

        this.render();
    }

    updateActivations(): void {
        if (!this.visible) return;
        const dirty = this.computeSmoothedActivations();
        const zDirty = this.animateZOffsets();
        if (!dirty && !zDirty) return; // nothing changed: skip GPU updates and render
        if (!dirty && zDirty) {
            // Accidental slide in progress with steady activation. The nodes must follow the
            // sliding layer just like the triangles do: otherwise a held altered note (F♯) stays
            // lit at its pre-alteration node (F, one layer below) until the next PC change unfreezes
            // it on release. updateNodeActivations repositions the sliding-letter nodes (cheaply
            // gated, see the slide check there); colour/triad/arrow work stays skipped since only
            // the letter's geometry is moving.
            this.updateNodeActivations();
            this.renderDeferred();
            return;
        }
        this._updateCycle++;
        // Nodes update every cycle (cheap, most visually noticeable)
        this.updateNodeActivations();
        // Triangles + arrows update every other cycle (most expensive, visually slower-changing)
        if (this._updateCycle % 2 === 0) {
            this.updateTriangleActivations();
            this.updateArrowActivations();
        }
        this.renderDeferred();
    }

    /** Exponentially smooth activation and held values per PC to reduce visual flicker.
     *  Returns true if any smoothed value changed meaningfully (dirty tracking). */
    private computeSmoothedActivations(): boolean {
        const now = performance.now() * 0.001; // seconds
        const dt = this._lastSmoothTime > 0
            ? Math.min(now - this._lastSmoothTime, 0.1)
            : 0;
        this._lastSmoothTime = now;

        const { getNoteActivation, getHeldPCs } = this.config;
        const heldPCs = getHeldPCs();

        // Snapshot previous values for dirty detection
        this._prevSmoothedByPC.set(this._smoothedByPC);
        this._prevSmoothedHeldByPC.set(this._smoothedHeldByPC);
        this._prevResonanceByPC.set(this._resonanceByPC);

        // Pre-compute resonance per-PC (avoids per-triangle callback overhead)
        const getResAct = this.config.getResonanceActivation;
        for (let pc = 0; pc < 12; pc++) {
            this._resonanceByPC[pc] = getResAct ? getResAct(pc) : 0;
        }

        for (let pc = 0; pc < 12; pc++) {
            const targetAct = getNoteActivation(pc);
            const targetHeld = heldPCs.has(pc) ? 1 : 0;

            if (dt === 0) {
                // First frame after rebuild: snap to current values
                this._smoothedByPC[pc] = targetAct;
                this._smoothedHeldByPC[pc] = targetHeld;
                continue;
            }

            // Smooth activation (fast attack, slower release)
            const curAct = this._smoothedByPC[pc];
            const tauAct = targetAct > curAct ? SMOOTH_ATTACK_TAU : SMOOTH_RELEASE_TAU;
            const alphaAct = 1 - Math.exp(-dt / tauAct);
            let newAct = curAct + (targetAct - curAct) * alphaAct;
            if (newAct < 0.001) newAct = 0;
            this._smoothedByPC[pc] = newAct;

            // Smooth held state (near-instant on, smooth fade-off)
            const curHeld = this._smoothedHeldByPC[pc];
            const tauHeld = targetHeld > curHeld ? SMOOTH_HELD_ATTACK_TAU : SMOOTH_HELD_RELEASE_TAU;
            const alphaHeld = 1 - Math.exp(-dt / tauHeld);
            let newHeld = curHeld + (targetHeld - curHeld) * alphaHeld;
            if (newHeld < 0.001) newHeld = 0;
            this._smoothedHeldByPC[pc] = newHeld;
        }

        // Check which PCs changed meaningfully (higher threshold = fewer GPU updates)
        const DIRTY_THRESHOLD = 0.008;
        this._dirtyPCs.clear();
        for (let pc = 0; pc < 12; pc++) {
            if (Math.abs(this._smoothedByPC[pc] - this._prevSmoothedByPC[pc]) > DIRTY_THRESHOLD
                || Math.abs(this._smoothedHeldByPC[pc] - this._prevSmoothedHeldByPC[pc]) > DIRTY_THRESHOLD
                || Math.abs(this._resonanceByPC[pc] - this._prevResonanceByPC[pc]) > DIRTY_THRESHOLD) {
                this._dirtyPCs.add(pc);
            }
        }

        // Re-dirty a PC whose spectrum colour changed even if its activation didn't:
        // otherwise a held node freezes on a transient key's degree colour (see
        // _lastHeldColorByPC). Only tracked for lit PCs (held/active/resonating) so a
        // key change doesn't churn the dozen inactive nodes.
        const getHeldColor = this.config.getHeldNoteColor;
        if (getHeldColor) {
            for (let pc = 0; pc < 12; pc++) {
                const lit = this._smoothedByPC[pc] > 0.01 || this._smoothedHeldByPC[pc] > 0.01
                    || this._resonanceByPC[pc] > 0.01;
                const col = lit ? (getHeldColor(pc) ?? null) : null;
                if (col !== this._lastHeldColorByPC[pc]) {
                    this._lastHeldColorByPC[pc] = col;
                    if (lit) this._dirtyPCs.add(pc);
                }
            }
        }

        return this._dirtyPCs.size > 0;
    }

    /** Zero all smoothing/activation state and force a full GPU repaint. */
    clearSmoothing(): void {
        this._smoothedByPC.fill(0);
        this._smoothedHeldByPC.fill(0);
        this._prevSmoothedByPC.fill(0);
        this._prevSmoothedHeldByPC.fill(0);
        this._resonanceByPC.fill(0);
        this._prevResonanceByPC.fill(0);
        this._lastSmoothTime = 0;
        this._activeTriIndices.clear();
        // Directly zero all triangle fill colors on the GPU buffer
        for (const mesh of [this.triMesh, this.triMeshTiltedPerfect, this.triMeshTiltedNonPerfect]) {
            if (!mesh) continue;
            const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
            (attr.array as Float32Array).fill(0);
            attr.needsUpdate = true;
        }
        // Nodes: force full dirty pass on next updateActivations
        this._dirtyPCs.clear();
        for (let pc = 0; pc < 12; pc++) this._dirtyPCs.add(pc);
        this._updateCycle = 1; // next increment → even → triangles+arrows run
        this.render();
    }

    /** Animate per-letter z-offsets toward 0. Returns true if any offset is active. */
    private animateZOffsets(): boolean {
        if (this._letterZOffset.size === 0) {
            this._lastZAnimTime = 0;
            this._zAnimAccumDt = 0;
            this._zAnimStep = 0;
            return false;
        }
        const now = performance.now() * 0.001;
        if (this._lastZAnimTime <= 0) {
            this._lastZAnimTime = now;
            return false;
        }
        const dt = Math.min(now - this._lastZAnimTime, 0.1);
        this._lastZAnimTime = now;
        this._zAnimAccumDt += dt;
        if (this._zAnimAccumDt < Z_ANIM_MIN_STEP) {
            return false;
        }
        const stepDt = this._zAnimAccumDt;
        this._zAnimAccumDt = 0;
        const alpha = 1 - Math.exp(-stepDt / Z_ANIM_TAU);
        // Adaptive smoothing/perf:
        // - when audio is active, throttle heavy geometry writes to protect audio thread
        // - when quiet, update every tick for smoother full-mesh motion
        const audioBusy = this._smoothedByPC.some(v => v > 0.01) || this._smoothedHeldByPC.some(v => v > 0.01);
        const heavyEvery = audioBusy ? Z_ANIM_HEAVY_GEOMETRY_EVERY : 1;
        const updateHeavyGeometry = (this._zAnimStep++ % heavyEvery) === 0;
        let hasNonZeroOffset = false;

        for (const [letter, offset] of this._letterZOffset) {
            const newOffset = offset * (1 - alpha);
            if (Math.abs(newOffset) < 0.0005) {
                this._letterZOffset.set(letter, 0);
            } else {
                this._letterZOffset.set(letter, newOffset);
                hasNonZeroOffset = true;
            }
        }

        // Throttle triangle/wire buffer writes when audio is busy.
        // On the final frame we force a full pass to snap all geometry exactly to baseline.
        this.applyZOffsets(updateHeavyGeometry || !hasNonZeroOffset);
        if (!hasNonZeroOffset) {
            this._letterZOffset.clear();
            this._lastZAnimTime = 0;
            this._zAnimAccumDt = 0;
            this._zAnimStep = 0;
        }
        return true;
    }

    /** Apply current z-offsets to triangle and wireframe vertex positions.
     *  Nodes stay fixed at their grid positions; only triangle vertices and
     *  wire endpoints animate between the old and new accidental layers. */
    private applyZOffsets(updateHeavyGeometry = true): void {
        if (!updateHeavyGeometry) return;

        // Triangle fill: update position buffer z-component
        if (this.triMesh || this.triMeshTiltedPerfect || this.triMeshTiltedNonPerfect) {
            const flatPosAttr = this.triMesh?.geometry.getAttribute('position') as THREE.BufferAttribute | null;
            const tiltedPerfectPosAttr = this.triMeshTiltedPerfect?.geometry.getAttribute('position') as THREE.BufferAttribute | null;
            const tiltedNonPerfectPosAttr = this.triMeshTiltedNonPerfect?.geometry.getAttribute('position') as THREE.BufferAttribute | null;
            const flatPosArray = flatPosAttr?.array as Float32Array | undefined;
            const tiltedPerfectPosArray = tiltedPerfectPosAttr?.array as Float32Array | undefined;
            const tiltedNonPerfectPosArray = tiltedNonPerfectPosAttr?.array as Float32Array | undefined;
            for (const [letter, offset] of this._letterZOffset) {
                const verts = this._letterToTriVerts.get(letter);
                if (!verts) continue;
                for (const { idx, z, meshGroup } of verts) {
                    const posArray = meshGroup === 'flat'
                        ? flatPosArray
                        : (meshGroup === 'tiltedPerfect' ? tiltedPerfectPosArray : tiltedNonPerfectPosArray);
                    if (!posArray) continue;
                    posArray[idx * 3 + 2] = z + offset;
                }
            }
            if (flatPosAttr) flatPosAttr.needsUpdate = true;
            if (tiltedPerfectPosAttr) tiltedPerfectPosAttr.needsUpdate = true;
            if (tiltedNonPerfectPosAttr) tiltedNonPerfectPosAttr.needsUpdate = true;
        }

        // Wireframe edges: update position buffer z-component per interval
        for (const [letter, offset] of this._letterZOffset) {
            const byInterval = this._letterToWireVerts.get(letter);
            if (!byInterval) continue;
            for (const [interval, verts] of byInterval) {
                const wire = this.intervalWires.get(interval);
                if (!wire) continue;
                const posAttr = wire.geometry.getAttribute('position') as THREE.BufferAttribute;
                const posArray = posAttr.array as Float32Array;
                for (const { idx, z } of verts) {
                    posArray[idx * 3 + 2] = z + offset;
                }
                posAttr.needsUpdate = true;
            }
        }
    }

    resize(): void {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.render();
    }

    dispose(): void {
        this._resizeObserver.disconnect();
        this.clearGroups();
        if (this._nodeMaterial) {
            this._nodeMaterial.dispose();
            this._nodeMaterial = null;
        }
        this.sphereGeo.dispose();
        this.labelAtlas.dispose();
        this.patternTexture.dispose();
        this.controls.dispose();
        this.renderer.dispose();
        if (this.renderer.domElement.parentElement) {
            this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
        }
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) {
            this.resize();
            this.rebuild();
        }
    }

    /** Dolly the camera to `factor`× its current distance from the orbit target (>1 zooms out). Call once
     *  after construction to set the initial framing; OrbitControls then keeps the new distance. */
    setCameraDistance(factor: number): void {
        const t = this.controls.target;
        this.camera.position.sub(t).multiplyScalar(factor).add(t);
        this.controls.update();
        this.render();
    }

    setNoteDisplayMode(mode: NoteDisplayMode): void {
        if (mode === this.displayMode) return;
        this.displayMode = mode;
        // Rebuild label atlas with new display names
        this.labelAtlas.dispose();
        this.labelAtlas = new LabelAtlas(mode);
        if (this.visible) this.rebuild();
    }

    setShowInterval(interval: string, show: boolean): void {
        this.showIntervals[interval] = show;
        const wire = this.intervalWires.get(interval);
        if (wire) wire.visible = show;
        this.pathGroup.visible = false;
        this.render();
    }

    setShowArrows(show: boolean): void {
        this.arrowGroup.visible = show;
        this.render();
    }

    setShowGhostNodes(show: boolean): void {
        this.showGhostNodes = show;
        this.rebuild();
    }

    setShowLayerZeroOnly(show: boolean): void {
        this.showLayerZeroOnly = show;
        if (this.layerZeroWires) this.layerZeroWires.visible = show;
        this.rebuild();
    }

    setShowCoords(show: boolean): void {
        this.DEBUG_SHOW_COORDS = show;
        this.rebuild();
    }

    setActivateEnharmonics(activate: boolean): void {
        this.activateEnharmonics = activate;
        // When inactive nodes are hidden, toggling enharmonics changes which nodes
        // are visible (enharmonic equivalents must be added/removed from the mesh)
        if (!this.showGhostNodes) {
            this.rebuild();
        } else {
            this.updateActivations();
        }
    }

    setShowEnharmonicTriad(type: string, show: boolean): void {
        this.showEnharmonicTriads[type] = show;
        this.rebuild();
    }

    setShowTiltedPerfect(show: boolean): void {
        this.showTiltedPerfect = show;
        this.rebuild();
    }

    setSuspensionTilt(on: boolean): void {
        const prev = this.suspensionTilt;
        this.suspensionTilt = on;
        // Rebuild needed when toggling on: the 6/4 tilted triangle (C-E♯-G𝄪)
        // classifies as 'major' (rotation puts E♯ as root with [4,7] intervals)
        // and is culled by buildTriangles when showTiltedPerfect is off. Bypass
        // that cull while suspensionTilt is on so the triangle reaches triData.
        if (prev !== on) {
            this.rebuild();
        } else {
            this.render();
        }
    }

    setDiatonicAnchor(on: boolean): void {
        this.diatonicAnchor = on;
        // No rebuild needed: classification happens per frame in updateTriangleActivations
        // from triData.spellings/letters which are already populated.
        this.updateActivations();
    }

    setChromaticSlide(on: boolean): void {
        this.chromaticSlide = on;
        // When turning off mid-animation, snap any in-flight offsets to their
        // final position so vertices don't get stuck off-layer.
        if (!on && this._letterZOffset.size > 0) {
            for (const letter of this._letterZOffset.keys()) {
                this._letterZOffset.set(letter, 0);
            }
            this.applyZOffsets();
            this._letterZOffset.clear();
            this.render();
        }
    }

    setMeshAll(on: boolean): void {
        this.meshAll = on;
        // Toggle pattern texture on flat mesh when hatched is active
        if (this.triMesh && this.showTrianglePattern) {
            (this.triMesh.material as THREE.MeshBasicMaterial).map = on ? this.patternTexture : null;
            (this.triMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        this.render();
    }

    setMeshTiltedNonPerfect(on: boolean): void {
        this.meshTiltedNonPerfect = on;
        if (this.triMeshTiltedNonPerfect) {
            (this.triMeshTiltedNonPerfect.material as THREE.MeshBasicMaterial).map =
                (this.showTrianglePattern && on) ? this.patternTexture : null;
            (this.triMeshTiltedNonPerfect.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        this.render();
    }

    setShow3LayerTriads(show: boolean): void {
        this.show3LayerTriads = show;
        this.rebuild();
    }

    setLayerMin(n: number): void {
        this.layerMin = Math.min(n, 0);
        this.rebuild();
    }

    setLayerMax(n: number): void {
        this.layerMax = Math.max(n, 0);
        this.rebuild();
    }

    setMaxAccidentals(max: number): void {
        this.maxAccidentals = Math.max(0, Math.min(6, max));
        this.rebuild();
    }

    setMaxEnharmonicDistance(max: number): void {
        this.maxEnharmonicDistance = Math.max(0, Math.min(6, max));
        this.rebuild();
    }

    setMaxEnharmonicPenalty(max: number): void {
        this.maxEnharmonicPenaltyGap = Math.max(0, Math.min(99, max));
        this.rebuild();
    }

    setZSpacing(spacing: number): void {
        this.zSpacing = Math.max(0.1, spacing);
        this.rebuild();
    }

    /** Letter-based activation for the diatonic anchor: a played PC contributes
     *  to letter L when it matches L's anchor PC, or is ±1 from L's anchor AND
     *  not occupied by another anchor letter. Prevents adjacent-semitone anchors
     *  (B/C, E/F) from cross-activating each other's slots. */
    private letterActivationFor(anchorPC: number, anchorPCSet: Set<number>): number {
        const direct = this._smoothedByPC[anchorPC];
        const upPC = (anchorPC + 1) % 12;
        const dnPC = (anchorPC + 11) % 12;
        const up = anchorPCSet.has(upPC) ? 0 : this._smoothedByPC[upPC];
        const dn = anchorPCSet.has(dnPC) ? 0 : this._smoothedByPC[dnPC];
        return Math.max(direct, up, dn);
    }

    private isWithinEnharmonicDistance(pc: PitchClass): boolean {
        const scaleAcc = this.scaleAccByLetter.get(pc.letterName as LetterName);
        if (scaleAcc === undefined) return false;
        return Math.abs(pc.accidental - scaleAcc) <= this.maxEnharmonicDistance;
    }

    private isWithinPenaltyThreshold(pc: PitchClass): boolean {
        const getPenalty = this.config.getSpellingPenalty;
        if (!getPenalty) return true;
        const midiPC = normPC(pc.midiValue);
        const penalty = getPenalty(midiPC, pc.letterName, pc.accidental);
        if (penalty === undefined) return true;  // no data = pass
        const getBestPenalty = this.config.getBestSpellingPenalty;
        if (!getBestPenalty) return true;
        const bestPenalty = getBestPenalty(midiPC);
        if (bestPenalty === undefined) return true;
        return (penalty - bestPenalty) <= this.maxEnharmonicPenaltyGap;
    }

    /** Check distance from scale for a "letter:accidental" string (used in triangle code). */
    private spellingWithinEnharmonicDistance(spelling: string): boolean {
        const [letter, accStr] = spelling.split(':');
        const scaleAcc = this.scaleAccByLetter.get(letter as LetterName);
        if (scaleAcc === undefined) return false;
        return Math.abs(Number(accStr) - scaleAcc) <= this.maxEnharmonicDistance;
    }

    setTrianglePattern(show: boolean): void {
        this.showTrianglePattern = show;
        // Flat mesh: only gets pattern when hatched AND "All" are both on
        if (this.triMesh) {
            (this.triMesh.material as THREE.MeshBasicMaterial).map = (show && this.meshAll) ? this.patternTexture : null;
            (this.triMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        // Tilted perfect mesh: always gets pattern when hatched is on
        if (this.triMeshTiltedPerfect) {
            (this.triMeshTiltedPerfect.material as THREE.MeshBasicMaterial).map = show ? this.patternTexture : null;
            (this.triMeshTiltedPerfect.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        // Tilted non-perfect mesh: optional pattern via dedicated toggle
        if (this.triMeshTiltedNonPerfect) {
            (this.triMeshTiltedNonPerfect.material as THREE.MeshBasicMaterial).map =
                (show && this.meshTiltedNonPerfect) ? this.patternTexture : null;
            (this.triMeshTiltedNonPerfect.material as THREE.MeshBasicMaterial).needsUpdate = true;
        }
        this.render();
    }

    private createPatternTexture(): THREE.CanvasTexture {
        const s = 10; // hex circumradius
        const sqrt3 = Math.sqrt(3);
        const hPeriod = sqrt3 * s;
        const vPeriod = 3 * s;
        const nH = 6, nV = 4;
        const width = Math.round(nH * hPeriod);
        const height = nV * vPeriod;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        // Black background = transparent gaps under additive blending
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        // White hex edges = visible chickenwire
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;

        for (let ry = -2; ry <= height / (1.5 * s) + 2; ry++) {
            const cy = ry * 1.5 * s;
            const xOff = (((ry % 2) + 2) % 2) ? hPeriod / 2 : 0;
            for (let cx = -hPeriod + xOff; cx < width + hPeriod; cx += hPeriod) {
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = Math.PI / 6 + i * Math.PI / 3;
                    const vx = cx + s * Math.cos(angle);
                    const vy = cy + s * Math.sin(angle);
                    if (i === 0) ctx.moveTo(vx, vy);
                    else ctx.lineTo(vx, vy);
                }
                ctx.closePath();
                ctx.stroke();
            }
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        return texture;
    }

    /** Apply multiple settings at once without triggering per-setting rebuilds.
     *  Caller should follow with setVisible() or rebuild(). */
    applyInitialSettings(s: {
        showCoords?: boolean;
        showGhostNodes?: boolean;
        showLayerZeroOnly?: boolean;
        activateEnharmonics?: boolean;
        showEnharmonicTriads?: Record<string, boolean>;
        showTiltedPerfect?: boolean;
        suspensionTilt?: boolean;
        diatonicAnchor?: boolean;
        chromaticSlide?: boolean;
        show3LayerTriads?: boolean;
        layerMin?: number;
        layerMax?: number;
        maxAccidentals?: number;
        maxEnharmonicPenalty?: number;
        maxEnharmonicDistance?: number;
        zSpacing?: number;
        showTrianglePattern?: boolean;
        meshAll?: boolean;
        meshTiltedNonPerfect?: boolean;
        showArrows?: boolean;
        showIntervals?: Record<string, boolean>;
    }): void {
        if (s.showCoords !== undefined) this.DEBUG_SHOW_COORDS = s.showCoords;
        if (s.showGhostNodes !== undefined) this.showGhostNodes = s.showGhostNodes;
        if (s.showLayerZeroOnly !== undefined) this.showLayerZeroOnly = s.showLayerZeroOnly;
        if (s.activateEnharmonics !== undefined) this.activateEnharmonics = s.activateEnharmonics;
        if (s.showEnharmonicTriads) {
            for (const [type, show] of Object.entries(s.showEnharmonicTriads)) {
                this.showEnharmonicTriads[type] = show;
            }
        }
        if (s.showTiltedPerfect !== undefined) this.showTiltedPerfect = s.showTiltedPerfect;
        if (s.suspensionTilt !== undefined) this.suspensionTilt = s.suspensionTilt;
        if (s.diatonicAnchor !== undefined) this.diatonicAnchor = s.diatonicAnchor;
        if (s.chromaticSlide !== undefined) this.chromaticSlide = s.chromaticSlide;
        if (s.show3LayerTriads !== undefined) this.show3LayerTriads = s.show3LayerTriads;
        if (s.layerMin !== undefined) this.layerMin = Math.min(s.layerMin, 0);
        if (s.layerMax !== undefined) this.layerMax = Math.max(s.layerMax, 0);
        if (s.maxAccidentals !== undefined) this.maxAccidentals = Math.max(0, Math.min(6, s.maxAccidentals));
        if (s.maxEnharmonicPenalty !== undefined) this.maxEnharmonicPenaltyGap = Math.max(0, Math.min(99, s.maxEnharmonicPenalty));
        if (s.maxEnharmonicDistance !== undefined) this.maxEnharmonicDistance = Math.max(0, Math.min(6, s.maxEnharmonicDistance));
        if (s.zSpacing !== undefined) this.zSpacing = Math.max(0.1, s.zSpacing);
        if (s.showTrianglePattern !== undefined) this.showTrianglePattern = s.showTrianglePattern;
        if (s.meshAll !== undefined) this.meshAll = s.meshAll;
        if (s.meshTiltedNonPerfect !== undefined) this.meshTiltedNonPerfect = s.meshTiltedNonPerfect;
        if (s.showArrows !== undefined) this.arrowGroup.visible = s.showArrows;
        if (s.showIntervals) {
            for (const [iv, show] of Object.entries(s.showIntervals)) {
                this.showIntervals[iv] = show;
            }
        }
    }

    getLayerMin(): number { return this.layerMin; }
    getLayerMax(): number { return this.layerMax; }

    // ── Internal rendering ─────────────────────────────────────────

    private render(): void {
        if (!this.visible) return;
        this.renderer.render(this.scene, this.camera);
    }

    /** Schedule a render for the next animation frame (coalesces multiple calls). */
    private renderDeferred(): void {
        if (this._renderPending || !this.visible) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            this.render();
        });
    }

    private clearGroups(): void {
        // Reset visual smoothing so first frame after rebuild snaps to current values
        this._lastSmoothTime = 0;
        this._letterZOffset.clear();
        this._lastZAnimTime = 0;
        this._zAnimAccumDt = 0;
        this._zAnimStep = 0;

        this.clearNodeGroup();
        this.clearTriangleGroup();
        this.clearPathGroup();
        this.clearLabelGroup();
        this.clearArrowGroup();
        this.clearAxisGroup();
    }

    /** Dispose the node InstancedMesh + its label atlas entries. Keeps the cached material. */
    private clearNodeGroup(): void {
        if (this.nodeInstanced) {
            this.nodeInstanced.geometry?.dispose();
            // NOTE: do NOT dispose the material: it's cached across rebuilds in _nodeMaterial.
            this.nodeInstanced = null;
        }
        this.nodeData = [];
        this.nodeGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
            }
        });
        this.nodeGroup.clear();
    }

    private clearTriangleGroup(): void {
        if (this.triMesh) {
            this.triMesh.geometry?.dispose();
            (this.triMesh.material as THREE.Material).dispose();
            this.triMesh = null;
        }
        if (this.triMeshTiltedPerfect) {
            this.triMeshTiltedPerfect.geometry?.dispose();
            (this.triMeshTiltedPerfect.material as THREE.Material).dispose();
            this.triMeshTiltedPerfect = null;
        }
        if (this.triMeshTiltedNonPerfect) {
            this.triMeshTiltedNonPerfect.geometry?.dispose();
            (this.triMeshTiltedNonPerfect.material as THREE.Material).dispose();
            this.triMeshTiltedNonPerfect = null;
        }
        for (const wire of this.intervalWires.values()) {
            wire.geometry?.dispose();
            (wire.material as THREE.Material).dispose();
        }
        this.intervalWires.clear();
        if (this.layerZeroWires) {
            this.layerZeroWires.geometry?.dispose();
            (this.layerZeroWires.material as THREE.Material).dispose();
            this.layerZeroWires = null;
        }
        this.triData = [];
        this.triangleGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else if (child.material) {
                    (child.material as THREE.Material).dispose();
                }
            }
        });
        this.triangleGroup.clear();
    }

    private clearPathGroup(): void {
        this.pathGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else if (child.material) {
                    (child.material as THREE.Material).dispose();
                }
            }
        });
        this.pathGroup.clear();
    }

    private clearLabelGroup(): void {
        this.labelGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else if (child.material) {
                    (child.material as THREE.Material).dispose();
                }
            }
            if (child instanceof THREE.Sprite) {
                (child.material as THREE.SpriteMaterial).map?.dispose();
                child.material.dispose();
            }
        });
        this.labelGroup.clear();
    }

    private clearArrowGroup(): void {
        for (const ad of this.arrowData) {
            ad.shaftMat.dispose();
            ad.coneMat.dispose();
            ad.arrow.traverse(child => {
                if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                    child.geometry?.dispose();
                }
            });
        }
        this.arrowData = [];
        this.arrowGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else if (child.material) {
                    (child.material as THREE.Material).dispose();
                }
            }
        });
        this.arrowGroup.clear();
    }

    private clearAxisGroup(): void {
        this.axisGroup.traverse(child => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else if (child.material) {
                    (child.material as THREE.Material).dispose();
                }
            }
        });
        this.axisGroup.clear();
    }

    // ── Nodes (InstancedMesh) ──────────────────────────────────────

    private buildNodes(): void {
        const { getThirds, getActivePCs, getResonanceActivePCs } = this.config;
        const thirds = getThirds();
        const nodes = this.currentNodes;
        const activePCs = getActivePCs();
        const resonancePCs = getResonanceActivePCs ? getResonanceActivePCs() : new Set<number>();

        // Build held set by letter+accidental (for "held" white highlight)
        const heldPCs = this.config.getHeldPCs();
        const heldLetterAcc = new Set<string>();
        for (const pc of thirds) {
            const key = `${pc.letterName}:${pc.accidental}`;
            if (heldPCs.has(normPC(pc.midiValue))) {
                heldLetterAcc.add(key);
            }
        }

        // Filter nodes: always show scale notes.
        // With ghost nodes off, only show enharmonic/arrow-target nodes when that PC is currently active.
        // With showLayerZeroOnly, all layer-0 nodes are additionally forced visible.
        const visibleNodes = this.showGhostNodes
            ? nodes
            : nodes.filter(n => {
                if (n.isScaleNote) return true;
                if (this.showLayerZeroOnly && n.layer === 0) return true;
                const midiPC = normPC(n.pc.midiValue);
                const hasLiveActivity = activePCs.has(midiPC) || resonancePCs.has(midiPC) || heldPCs.has(midiPC);
                if (!hasLiveActivity) return false;
                return (n.isEnharmonicNote && this.activateEnharmonics && this.isWithinEnharmonicDistance(n.pc))
                    || (this.activateEnharmonics && this.enhArrowTargetPCs.has(midiPC));
            });
        const count = visibleNodes.length;
        if (!this._nodeMaterial) {
            const material = new THREE.MeshStandardMaterial({
                transparent: true,
                depthWrite: true,
            });
            material.onBeforeCompile = (shader) => {
                shader.vertexShader = shader.vertexShader
                    .replace(
                        '#include <common>',
                        '#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;\nattribute float instanceGlow;\nvarying float vInstanceGlow;',
                    )
                    .replace(
                        '#include <begin_vertex>',
                        '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;\nvInstanceGlow = instanceGlow;',
                    );
                shader.fragmentShader = shader.fragmentShader
                    .replace(
                        '#include <common>',
                        '#include <common>\nvarying float vInstanceOpacity;\nvarying float vInstanceGlow;',
                    )
                    // three r170 renamed <output_fragment> → <opaque_fragment>; target the real chunk.
                    .replace(
                        '#include <opaque_fragment>',
                        [
                            '#ifdef OPAQUE',
                            'diffuseColor.a = 1.0;',
                            '#endif',
                            '#ifdef USE_TRANSMISSION',
                            'diffuseColor.a *= material.transmissionAlpha;',
                            '#endif',
                            // Held nodes glow: self-illuminate past scene lighting and brighten at
                            // the silhouette edge (fresnel rim) so a pressed key reads as lit, not shaded.
                            'float nodeRim = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 2.0);',
                            // Core stays at ×1.0 so the sphere face shows the node\'s EXACT colour
                            // (linear→sRGB round-trips to the same hex the piano keys / spectrum use);
                            // the rim adds an edge highlight only, for the glowing-bead read. A >1.0
                            // core would clip saturated hues toward white and break the colour match.
                            'vec3 glowColor = diffuseColor.rgb * (1.0 + 1.1 * nodeRim);',
                            'vec3 nodeFinal = mix(outgoingLight, glowColor, clamp(vInstanceGlow, 0.0, 1.0));',
                            // NOTE: alpha intentionally ignores vInstanceOpacity to preserve the
                            // current (all-opaque) look; the old opacity replace targeted a chunk
                            // name that no longer exists in three r170, so it was already a no-op.
                            'gl_FragColor = vec4( nodeFinal, diffuseColor.a );',
                        ].join('\n'),
                    );
            };
            material.customProgramCacheKey = () => 'node-instanced-glow-v2';
            this._nodeMaterial = material;
        }

        const instanced = new THREE.InstancedMesh(this.sphereGeo, this._nodeMaterial, count);
        instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        instanced.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(count * 3), 3
        );
        instanced.instanceColor.setUsage(THREE.DynamicDrawUsage);
        const instanceOpacity = new Float32Array(count);
        this.nodeOpacityAttr = new THREE.InstancedBufferAttribute(instanceOpacity, 1);
        this.nodeOpacityAttr.setUsage(THREE.DynamicDrawUsage);
        instanced.geometry.setAttribute('instanceOpacity', this.nodeOpacityAttr);

        const instanceGlow = new Float32Array(count);
        this.nodeGlowAttr = new THREE.InstancedBufferAttribute(instanceGlow, 1);
        this.nodeGlowAttr.setUsage(THREE.DynamicDrawUsage);
        instanced.geometry.setAttribute('instanceGlow', this.nodeGlowAttr);

        const matrix = new THREE.Matrix4();
        const color = new THREE.Color();
        this.nodeData = [];
        this.nodeIndexMap.clear();
        const labelEntries: { x: number; y: number; z: number; entry: AtlasEntry; opacity: number }[] = [];

        for (let i = 0; i < count; i++) {
            const node = visibleNodes[i];
            const nodeKey = `${node.pc.letterName}:${node.pc.accidental}`;
            const isEnharmonic = node.isEnharmonicNote && this.isWithinEnharmonicDistance(node.pc);
            const isHeld = heldLetterAcc.has(nodeKey);

            // Scale: larger for active/held nodes, intermediate for enharmonic
            const isLayerZeroForced = this.showLayerZeroOnly && node.layer === 0 && !node.isScaleNote;
            const scale = isHeld ? 1.0
                : node.isScaleNote ? 1.0
                : isLayerZeroForced ? 0.9
                : isEnharmonic ? 0.8
                : 0.6;
            matrix.makeScale(scale, scale, scale);
            matrix.setPosition(node.x, node.y, node.z);
            instanced.setMatrixAt(i, matrix);

            // Color
            if (isHeld) {
                color.setRGB(2, 2, 2);   // HDR white: glows past lighting cap
            } else if (node.isScaleNote) {
                color.set(0x90caf9);         // light blue
            } else if (isEnharmonic) {
                color.set(EXTRA_NODE_GRAY);  // gray enharmonic
            } else {
                color.set(EXTRA_NODE_GRAY_DIM); // gray ghost
            }
            instanced.setColorAt(i, color);
            const nodeOpacity = node.isScaleNote
                ? 1
                : isLayerZeroForced ? 0.7
                : (this.showGhostNodes ? EXTRA_NODE_OPACITY_ALL_NOTES : EXTRA_NODE_OPACITY_FOCUSED);
            instanceOpacity[i] = nodeOpacity;
            instanceGlow[i] = isHeld ? 1 : 0;

            this.nodeData.push({
                pc: node.pc,
                layer: node.layer,
                isScaleNote: node.isScaleNote,
                isEnharmonicNote: node.isEnharmonicNote,
                x: node.x, y: node.y, z: node.z,
                midiPC: normPC(node.pc.midiValue),
                nodeKey: `${node.pc.letterName}:${node.pc.accidental}`,
            });
            this.nodeIndexMap.set(`${node.gridRow}:${node.layer}:${node.gridCol}`, i);

            // Collect label data for batched rendering (single draw call)
            const isArrowTarget = this.activateEnharmonics && this.enhArrowTargetPCs.has(normPC(node.pc.midiValue));
            if (node.isScaleNote || node.isEnharmonicNote || isArrowTarget || isLayerZeroForced || (this.showGhostNodes && scale > 0.5)) {
                const label = NoteDisplayUtils.toDisplayName(node.pc.letterName, this.displayMode, true, node.pc.accidental);
                const opacity = node.isScaleNote
                    ? 0.9
                    : isLayerZeroForced ? 0.7
                    : this.showGhostNodes
                        ? ((node.isEnharmonicNote || isArrowTarget) ? 0.28 : 0.16)
                        : ((node.isEnharmonicNote || isArrowTarget) ? 0.45 : 0.25);
                const atlasEntry = this.labelAtlas.getEntry(label);
                if (atlasEntry) {
                    labelEntries.push({ x: node.x, y: node.y, z: node.z + 0.35, entry: atlasEntry, opacity });
                } else {
                    const sprite = this.createLabel(label, opacity);
                    sprite.position.set(node.x, node.y, node.z + 0.35);
                    this.labelGroup.add(sprite);
                }
            }

            // Debug: show C-centered (x, y, z) coordinates below each node.
            // x = fifth axis, y = major-third axis, z = accidental layer, all relative to C = (0,0,0).
            // By construction n = x + 4y + 7z is the line-of-fifths position (C = 0, G = 1, A = 3, E = 4 …).
            // The code's fifthsPos has F = 0, so the true line-of-fifths is fifthsPos − 1 (+7 per layer).
            if (this.DEBUG_SHOW_COORDS && (node.isScaleNote || node.isEnharmonicNote || this.showGhostNodes)) {
                const centerRow = Math.floor(this.config.rows() / 2);
                const n = node.fifthsPos - 1 + 7 * node.layer;
                const dy = node.gridRow - centerRow;
                const dz = node.layer;
                const dx = n - 4 * dy - 7 * dz;
                const coordText = `${dx},${dy},${dz} n=${n}`;
                const sprite = this.createCoordLabel(coordText);
                sprite.position.set(node.x, node.y, node.z - 0.3);
                this.labelGroup.add(sprite);
            }
        }

        instanced.instanceMatrix.needsUpdate = true;
        if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
        if (this.nodeOpacityAttr) this.nodeOpacityAttr.needsUpdate = true;
        if (this.nodeGlowAttr) this.nodeGlowAttr.needsUpdate = true;
        this.nodeInstanced = instanced;
        this.nodeGroup.add(instanced);

        // Build letter → instance index mapping for z-offset animation
        this._letterToNodeIdx.clear();
        for (let i = 0; i < this.nodeData.length; i++) {
            const letter = this.nodeData[i].pc.letterName;
            let arr = this._letterToNodeIdx.get(letter);
            if (!arr) { arr = []; this._letterToNodeIdx.set(letter, arr); }
            arr.push(i);
        }

        // Build batched label mesh (single draw call for all node labels)
        this.buildLabelMesh(labelEntries);
    }

    /** Batch all node labels into a single draw call using merged quad geometry with billboard shader. */
    private buildLabelMesh(entries: { x: number; y: number; z: number; entry: AtlasEntry; opacity: number }[]): void {
        if (entries.length === 0) return;
        const count = entries.length;
        const vCount = count * 4;

        const positions = new Float32Array(vCount * 3);
        const offsets = new Float32Array(vCount * 2);
        const uvs = new Float32Array(vCount * 2);
        const opacities = new Float32Array(vCount);
        const indices = new Uint16Array(count * 6);

        const hw = 0.3, hh = 0.15; // half-extents matching previous sprite scale (0.6 × 0.3)
        const quadOff: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
        const quadUv: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

        for (let i = 0; i < count; i++) {
            const e = entries[i];
            const vBase = i * 4;
            for (let v = 0; v < 4; v++) {
                const vi = vBase + v;
                positions[vi * 3]     = e.x;
                positions[vi * 3 + 1] = e.y;
                positions[vi * 3 + 2] = e.z;
                offsets[vi * 2]     = quadOff[v][0];
                offsets[vi * 2 + 1] = quadOff[v][1];
                uvs[vi * 2]     = e.entry.u + quadUv[v][0] * e.entry.w;
                uvs[vi * 2 + 1] = e.entry.v + quadUv[v][1] * e.entry.h;
                opacities[vi] = e.opacity;
            }
            const iBase = i * 6;
            indices[iBase]     = vBase;
            indices[iBase + 1] = vBase + 1;
            indices[iBase + 2] = vBase + 2;
            indices[iBase + 3] = vBase;
            indices[iBase + 4] = vBase + 2;
            indices[iBase + 5] = vBase + 3;
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('labelOffset', new THREE.BufferAttribute(offsets, 2));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geo.setAttribute('labelOpacity', new THREE.BufferAttribute(opacities, 1));
        geo.setIndex(new THREE.BufferAttribute(indices, 1));

        const mat = new THREE.ShaderMaterial({
            uniforms: { map: { value: this.labelAtlas.texture } },
            vertexShader: LABEL_VERTEX_SHADER,
            fragmentShader: LABEL_FRAGMENT_SHADER,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        this.labelGroup.add(mesh);
    }

    private updateNodeActivations(): void {
        if (!this.nodeInstanced) return;
        const { freeMode, getNoteActivation, getHeldPCs, getThirds } = this.config;
        const heldPCs = getHeldPCs();
        const isFree = freeMode();
        const thirds = getThirds();

        // Reuse scratch collections (clear instead of allocating new)
        const activationMap = this._scratchActivationMap; activationMap.clear();
        const heldLetterAcc = this._scratchHeldLetterAcc; heldLetterAcc.clear();
        const activeSet = this._scratchActiveSet; activeSet.clear();
        for (const pc of thirds) {
            const key = `${pc.letterName}:${pc.accidental}`;
            activeSet.add(key);
            const act = getNoteActivation(normPC(pc.midiValue));
            if (act > 0) activationMap.set(key, act);
            if (heldPCs.has(normPC(pc.midiValue))) {
                heldLetterAcc.add(key);
            }
        }

        // Build PC-based activation map for enharmonic nodes
        const activationByPC = this._scratchActivationByPC; activationByPC.clear();
        for (const pc of thirds) {
            const midi = normPC(pc.midiValue);
            const act = getNoteActivation(midi);
            if (act > 0) activationByPC.set(midi, act);
        }

        const color = this._scratchColor;
        const matrix = this._scratchMatrix;
        const dirtyPCs = this._dirtyPCs;
        let anyUpdated = false;

        for (let i = 0; i < this.nodeData.length; i++) {
            const data = this.nodeData[i];
            // Skip nodes whose PC didn't change this frame, unless the node's letter is mid-slide
            // (an animating accidental z-offset). A sliding node must follow its layer every frame
            // even though its activation is steady, so a held altered note tracks up to its new
            // spelling instead of staying lit at the pre-alteration layer.
            const sliding = (this._letterZOffset.get(data.pc.letterName) ?? 0) !== 0;
            if (!dirtyPCs.has(data.midiPC) && !sliding) continue;
            anyUpdated = true;

            const isActive = activeSet.has(data.nodeKey);
            const isPenaltyAllowed = this.isWithinPenaltyThreshold(data.pc);
            const isEnharmonic = data.isEnharmonicNote
                && this.isWithinEnharmonicDistance(data.pc)
                && isPenaltyAllowed;
            // Use smoothed activation values for visual properties
            const smoothAct = this._smoothedByPC[data.midiPC];
            const activation = (isFree && isActive)
                ? smoothAct
                : (isFree && isEnharmonic && this.activateEnharmonics)
                    ? smoothAct * 0.5
                    : 0;
            const isHeld = heldLetterAcc.has(data.nodeKey);
            const heldSmooth = this._smoothedHeldByPC[data.midiPC];
            let glowVal = 0;

            if (isHeld) {
                // Actively held: show the EXACT scale-degree spectrum colour (the same
                // key/spelling-driven palette the piano keys + spectrum panel use), fully
                // self-illuminated. No blue blend and glow pinned to 1 so the hue matches
                // exactly: the smoothed-held blend used to freeze ~5-8% short of 1 (the
                // dirty gate stops updates once Δheld < threshold), leaving a residual
                // blue/shading tint that shifted saturated hues. Bead-grow still animates
                // via heldSmooth on the scale below.
                color.copy(this.heldTarget(data.midiPC));
                glowVal = 1;
            } else if (isActive && heldSmooth > 0.01) {
                // Releasing a held note: fade the spectrum colour + glow back down.
                color.copy(this._activeBlue).lerp(this.heldTarget(data.midiPC), heldSmooth);
                glowVal = heldSmooth;
            } else if (isActive && activation > 0) {
                color.set(0x90caf9);
            } else if (isActive) {
                color.set(0x90caf9);
            } else if (isEnharmonic) {
                const enhAct = this.activateEnharmonics ? smoothAct : 0;
                const enhHeldSmooth = this.activateEnharmonics ? heldSmooth : 0;
                if (enhHeldSmooth > 0.01) {
                    color.set(EXTRA_NODE_GRAY);
                    color.lerp(this.heldTarget(data.midiPC), enhHeldSmooth);
                    glowVal = enhHeldSmooth;
                } else {
                    color.set(enhAct > 0.001 ? EXTRA_NODE_GRAY : EXTRA_NODE_GRAY_DIM);
                }
            } else {
                color.set(EXTRA_NODE_GRAY_DIM);
            }
            this.nodeInstanced.setColorAt(i, color);
            if (this.nodeGlowAttr) (this.nodeGlowAttr.array as Float32Array)[i] = glowVal;

            // Update scale for activation glow (smoothed)
            const enhAct = (isEnharmonic && this.activateEnharmonics) ? smoothAct : 0;
            const baseScale = (isActive && activation > 0) ? 0.8 + 0.4 * activation
                : isActive ? 1.0
                : isEnharmonic ? 0.6 + 0.2 * enhAct
                : 0.6;
            // Blend toward held scale (1.2) based on smoothed held intensity
            const scale = baseScale + (1.2 - baseScale) * heldSmooth;
            matrix.makeScale(scale, scale, scale);
            const zOff = this._letterZOffset.get(data.pc.letterName) ?? 0;
            matrix.setPosition(data.x, data.y, data.z + zOff);
            this.nodeInstanced.setMatrixAt(i, matrix);
        }

        if (anyUpdated) {
            this.nodeInstanced.instanceMatrix.needsUpdate = true;
            if (this.nodeInstanced.instanceColor) this.nodeInstanced.instanceColor.needsUpdate = true;
            if (this.nodeGlowAttr) this.nodeGlowAttr.needsUpdate = true;
        }
    }

    /** Colour a held node blends toward: the PC's scale-degree spectrum colour
     *  (key/spelling-driven), or gold if none is supplied. Parses into a reused
     *  scratch colour so no per-frame allocation. */
    private heldTarget(midiPC: number): THREE.Color {
        const hex = this.config.getHeldNoteColor?.(midiPC) ?? null;
        return hex ? this._scratchHeldColor.set(hex) : this._scratchGoldColor;
    }

    // ── Triangles (merged geometry) ────────────────────────────────

    private buildTriangles(): void {
        const { getTriadColor, cols, rows, getNoteActivation, getThirds } = this.config;
        const numCols = cols();
        const numRows = rows();
        const thirds = getThirds();
        const heldPCs = this.config.getHeldPCs();

        // Build activation map by MIDI pitch class (not letter:accidental)
        // so cross-layer nodes with enharmonic spellings (E# vs F) still activate.
        const activationByPC = new Map<number, number>();
        for (const pc of thirds) {
            const midi = normPC(pc.midiValue);
            const act = getNoteActivation(midi);
            if (act > 0) activationByPC.set(midi, act);
        }
        // Also include held PCs not covered by scale notes, so triangles
        // with non-scale vertices (e.g. aug6 Db-F-Cb when B is held) can activate.
        for (const midi of heldPCs) {
            if (!activationByPC.has(midi)) {
                const act = getNoteActivation(midi);
                if (act > 0) activationByPC.set(midi, act);
            }
        }

        // Build exact-spellings set for quality computation (exact vs enharmonic)
        const exactSpellings = new Set<string>();
        for (const pc of thirds) {
            exactSpellings.add(`${pc.letterName}:${pc.accidental}`);
        }

        const tris = computeLatticeTriangles(
            this.currentNodes, getTriadColor, numCols, numRows, this.layers
        );

        if (tris.length === 0) return;

        // Separate accumulators for flat and tilted subgroups
        const flatPos: number[] = [], flatColor: number[] = [], flatUv: number[] = [];
        const tiltedPerfectPos: number[] = [], tiltedPerfectColor: number[] = [], tiltedPerfectUv: number[] = [];
        const tiltedNonPerfectPos: number[] = [], tiltedNonPerfectColor: number[] = [], tiltedNonPerfectUv: number[] = [];
        let flatCount = 0, tiltedPerfectCount = 0, tiltedNonPerfectCount = 0;

        // Per-interval wire accumulators
        const wireBuckets = new Map<string, { positions: number[]; colors: number[] }>();
        const wireCountByInterval = new Map<string, number>();
        // Track letter + z for each wire vertex (parallel to wireBuckets positions)
        const wireLetterData = new Map<string, { letter: string; z: number }[]>();

        // Layer-0 grid wires (P5 + M3): shown when Z=0 toggle is active
        const layerZeroWirePos: number[] = [];
        const layerZeroWireColor: number[] = [];
        const LAYER_ZERO_GRID_INTERVALS = new Set(['P5', 'M3']);

        this.triData = [];

        // When Rhombi is off, dim cross-layer triangles default to upper-heavy
        // (2 vertices on sharper layer). At a cross-layer cell where both the ▽ and △
        // are diminished triads of DIFFERENT PC groups (dim7 pair), the △ is normally
        for (let t = 0; t < tris.length; t++) {
            const tri = tris[t];
            const distinctLayers = new Set(tri.vertices.map(v => v.layer)).size;
            const triSpellings = tri.vertices.map(v => `${v.pc.letterName}:${v.pc.accidental}`) as [string, string, string];
            const isExactMatch = triSpellings.every(s => exactSpellings.has(s));

            // Never allow enharmonic triads to span 3+ layers, regardless of
            // settings, except when suspensionTilt is on. Cadential 6/4 needs
            // the 3-layer C-E♯-G𝄪 triangle, and it's enharmonic by construction.
            if (!isExactMatch && distinctLayers >= 3 && !this.suspensionTilt) continue;

            // 3-Layer toggle applies to exact-scale triads.
            if (!this.show3LayerTriads && distinctLayers >= 3) continue;
            if (tri.tiltAngle > 0) {
                const isExotic = EXOTIC_TRIAD_TYPES.has(tri.triadType);
                // Exotic types (aug3, dim3) only exist as cross-layer triads,
                // so they bypass the Fill Tilted gate; just need 2+ scale notes
                if (isExotic) {
                    const scaleCount = tri.vertices.filter(v => v.isScaleNote).length;
                    if (scaleCount < 2) continue;
                } else if (!this.showTiltedPerfect && !this.suspensionTilt) {
                    // "Fill Tilted" off: hide perfect triads, show all others.
                    // suspensionTilt overrides the cull so 6/4's tilted major
                    // (C-E♯-G𝄪) reaches triData and the bias can light it.
                    const isPerfect = tri.triadType === 'major' || tri.triadType === 'minor';
                    if (isPerfect) continue;
                }
            } else {
                // Flat same-layer: exotic types still need 2+ scale notes
                if (EXOTIC_TRIAD_TYPES.has(tri.triadType)) {
                    const scaleCount = tri.vertices.filter(v => v.isScaleNote).length;
                    if (scaleCount < 2) continue;
                }
            }
            const v = tri.vertices;
            const triPCs = v.map(n => normPC(n.pc.midiValue)) as [number, number, number];

            // Classify edges first so we can detect seconds
            const edges: [number, number][] = [[0, 1], [1, 2], [2, 0]];
            const edgeIntervals = new Set<string>();
            const edgeMapping: { interval: string; wireIdx: number }[] = [];

            for (const [a, b] of edges) {
                const interval = classifyEdgeInterval(v[a].pc, v[b].pc);
                edgeIntervals.add(interval);
            }

            // Triangles containing a second (M2 or m2) are not valid triads: never activate
            const hasSecond = edgeIntervals.has('M2') || edgeIntervals.has('m2');
            // A5 edge in a major/minor/dim triad means enharmonic misspelling (e.g. E-G-B# for C major)
            const isMisspelled = edgeIntervals.has('A5') &&
                (tri.triadType === 'major' || tri.triadType === 'minor' || tri.triadType === 'diminished');
            const invalid = hasSecond || isMisspelled;

            const act0 = activationByPC.get(triPCs[0]) ?? 0;
            const act1 = activationByPC.get(triPCs[1]) ?? 0;
            const act2 = activationByPC.get(triPCs[2]) ?? 0;
            const rawActivation = Math.min(act0, act1, act2);
            const activation = invalid ? 0 : rawActivation;

            // Quality: 1.0 for PC match; enharmonic triads only while they have resonance
            const getResAct = this.config.getResonanceActivation;
            const isEnhAllowed = this.activateEnharmonics && this.showEnharmonicTriads[tri.triadType];
            const enhRes = getResAct ? Math.min(getResAct(triPCs[0]), getResAct(triPCs[1]), getResAct(triPCs[2])) : 0;
            const quality = (activation > 0 && (isExactMatch
                || (isEnhAllowed && enhRes > 0.01))) ? 1.0 : 0;

            const triColor = new THREE.Color(tri.color);
            // Resonance triads: compute continuous strength from min resonance level
            const resStrength = invalid ? 0 : (getResAct
                ? Math.min(getResAct(triPCs[0]), getResAct(triPCs[1]), getResAct(triPCs[2]))
                : (heldPCs.has(triPCs[0]) && heldPCs.has(triPCs[1]) && heldPCs.has(triPCs[2]) ? 1 : 0));
            // Interpolate between active and held opacity based on resonance strength
            const wireLerp = TRI_WIRE_ACTIVE + resStrength * (TRI_WIRE_HELD - TRI_WIRE_ACTIVE);
            const wireOpacity = TRI_WIRE_BASE + activation * quality * wireLerp;

            // Compute per-face shading from face normal · light direction
            const ax = v[1].x - v[0].x, ay = v[1].y - v[0].y, az = v[1].z - v[0].z;
            const bx = v[2].x - v[0].x, by = v[2].y - v[0].y, bz = v[2].z - v[0].z;
            let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nLen; ny /= nLen; nz /= nLen;
            // Light direction (normalized 5,10,7)
            const dot = Math.abs(nx * 0.378 + ny * 0.756 + nz * 0.535);
            const shade = 0.55 + 0.45 * dot; // ambient floor 0.55, full light 1.0

            const isTilted = tri.tiltAngle > 0;
            const isPerfectTriad = tri.triadType === 'major' || tri.triadType === 'minor';
            const meshGroup: TriMeshGroup = !isTilted ? 'flat' : (isPerfectTriad ? 'tiltedPerfect' : 'tiltedNonPerfect');
            const targetPos = meshGroup === 'flat'
                ? flatPos
                : (meshGroup === 'tiltedPerfect' ? tiltedPerfectPos : tiltedNonPerfectPos);
            const targetColor = meshGroup === 'flat'
                ? flatColor
                : (meshGroup === 'tiltedPerfect' ? tiltedPerfectColor : tiltedNonPerfectColor);
            const targetUv = meshGroup === 'flat'
                ? flatUv
                : (meshGroup === 'tiltedPerfect' ? tiltedPerfectUv : tiltedNonPerfectUv);
            const meshIdx = meshGroup === 'flat'
                ? flatCount++
                : (meshGroup === 'tiltedPerfect' ? tiltedPerfectCount++ : tiltedNonPerfectCount++);

            for (let vi = 0; vi < 3; vi++) {
                targetPos.push(v[vi].x, v[vi].y, v[vi].z);

                // UV from world position: z offset shifts pattern between layers
                const uvScale = 0.8;
                targetUv.push(v[vi].x * uvScale, (v[vi].y + v[vi].z * 0.37) * uvScale);

                // Filled: interpolate between active and held opacity with resonance
                const fillLerp = TRI_OPACITY_BASE * TRI_FILL_SCALE + resStrength * (TRI_OPACITY_HELD - TRI_OPACITY_BASE * TRI_FILL_SCALE);
                const fillOpacity = activation * quality * fillLerp;
                targetColor.push(triColor.r * fillOpacity * shade, triColor.g * fillOpacity * shade, triColor.b * fillOpacity * shade);
            }

            // Accumulate wireframe edges by interval type (skip seconds: not real edges)
            edgeIntervals.clear();
            for (const [a, b] of edges) {
                const interval = classifyEdgeInterval(v[a].pc, v[b].pc);
                edgeIntervals.add(interval);

                // Don't create wire segments for seconds
                if (interval === 'M2' || interval === 'm2') continue;
                // Mesh shows only same-layer edges: skip cross-layer wires
                if (v[a].layer !== v[b].layer) continue;

                // Collect layer-0 P5/M3 edges for the Z=0 grid overlay
                if (v[a].layer === 0 && LAYER_ZERO_GRID_INTERVALS.has(interval)) {
                    const baseOpacity = 0.25;
                    layerZeroWirePos.push(
                        v[a].x, v[a].y, v[a].z,
                        v[b].x, v[b].y, v[b].z,
                    );
                    layerZeroWireColor.push(
                        triColor.r * baseOpacity, triColor.g * baseOpacity, triColor.b * baseOpacity,
                        triColor.r * baseOpacity, triColor.g * baseOpacity, triColor.b * baseOpacity,
                    );
                }

                if (!wireBuckets.has(interval)) {
                    wireBuckets.set(interval, { positions: [], colors: [] });
                    wireCountByInterval.set(interval, 0);
                }
                const bucket = wireBuckets.get(interval)!;
                const wireIdx = wireCountByInterval.get(interval)!;
                wireCountByInterval.set(interval, wireIdx + 1);

                bucket.positions.push(
                    v[a].x, v[a].y, v[a].z,
                    v[b].x, v[b].y, v[b].z
                );
                bucket.colors.push(
                    triColor.r * wireOpacity, triColor.g * wireOpacity, triColor.b * wireOpacity,
                    triColor.r * wireOpacity, triColor.g * wireOpacity, triColor.b * wireOpacity
                );

                // Track letter + z for wire vertex animation
                if (!wireLetterData.has(interval)) wireLetterData.set(interval, []);
                wireLetterData.get(interval)!.push(
                    { letter: v[a].pc.letterName, z: v[a].z },
                    { letter: v[b].pc.letterName, z: v[b].z },
                );

                edgeMapping.push({ interval, wireIdx });
            }

            this.triData.push({
                pcs: triPCs,
                spellings: triSpellings,
                letters: [v[0].pc.letterName, v[1].pc.letterName, v[2].pc.letterName] as [LetterName, LetterName, LetterName],
                accidentals: [v[0].pc.accidental, v[1].pc.accidental, v[2].pc.accidental],
                triadType: tri.triadType,
                color: tri.color,
                edgeIntervals,
                edgeMapping,
                hasSecond,
                isMisspelled,
                meshIdx,
                meshGroup,
                shade,
                tilted: isTilted,
            });
        }

        // Build PC→triangle index for sparse updates
        this._pcToTriangles.clear();
        this._activeTriIndices.clear();
        for (let t = 0; t < this.triData.length; t++) {
            for (const pc of this.triData[t].pcs) {
                let list = this._pcToTriangles.get(pc);
                if (!list) { list = []; this._pcToTriangles.set(pc, list); }
                list.push(t);
            }
        }

        // Build letter → triangle vertex index mapping for z-offset animation
        this._letterToTriVerts.clear();
        for (let t = 0; t < this.triData.length; t++) {
            const { meshIdx, meshGroup, spellings } = this.triData[t];
            const srcPos = meshGroup === 'flat'
                ? flatPos
                : (meshGroup === 'tiltedPerfect' ? tiltedPerfectPos : tiltedNonPerfectPos);
            for (let vi = 0; vi < 3; vi++) {
                const letter = spellings[vi].split(':')[0];
                let arr = this._letterToTriVerts.get(letter);
                if (!arr) { arr = []; this._letterToTriVerts.set(letter, arr); }
                arr.push({ idx: meshIdx * 3 + vi, z: srcPos[meshIdx * 9 + vi * 3 + 2], meshGroup });
            }
        }

        // Flat triangles: never get hatched pattern unless "All" is on
        if (flatCount > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flatPos), 3));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(flatColor), 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(flatUv), 2));
            geo.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true, transparent: true, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending,
                map: (this.showTrianglePattern && this.meshAll) ? this.patternTexture : null,
            });
            this.triMesh = new THREE.Mesh(geo, mat);
            this.triangleGroup.add(this.triMesh);
        }

        // Tilted perfect triangles: get hatched pattern when enabled
        if (tiltedPerfectCount > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tiltedPerfectPos), 3));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tiltedPerfectColor), 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(tiltedPerfectUv), 2));
            geo.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true, transparent: true, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending,
                map: this.showTrianglePattern ? this.patternTexture : null,
            });
            this.triMeshTiltedPerfect = new THREE.Mesh(geo, mat);
            this.triangleGroup.add(this.triMeshTiltedPerfect);
        }

        // Tilted non-perfect triangles: filled by default, optional mesh with dedicated toggle
        if (tiltedNonPerfectCount > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tiltedNonPerfectPos), 3));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tiltedNonPerfectColor), 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(tiltedNonPerfectUv), 2));
            geo.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                vertexColors: true, transparent: true, side: THREE.DoubleSide,
                depthWrite: false, blending: THREE.AdditiveBlending,
                map: (this.showTrianglePattern && this.meshTiltedNonPerfect) ? this.patternTexture : null,
            });
            this.triMeshTiltedNonPerfect = new THREE.Mesh(geo, mat);
            this.triangleGroup.add(this.triMeshTiltedNonPerfect);
        }

        // Build per-interval wireframe LineSegments
        for (const [interval, data] of wireBuckets) {
            const wireGeo = new THREE.BufferGeometry();
            wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.positions), 3));
            wireGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(data.colors), 3));

            const wireMat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 1,
            });

            const wire = new THREE.LineSegments(wireGeo, wireMat);
            wire.visible = this.showIntervals[interval] !== false;
            this.intervalWires.set(interval, wire);
            this.triangleGroup.add(wire);
        }

        // Build layer-0 grid wires (visible when Z=0 toggle is active)
        if (layerZeroWirePos.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(layerZeroWirePos), 3));
            geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(layerZeroWireColor), 3));
            const mat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 1,
            });
            this.layerZeroWires = new THREE.LineSegments(geo, mat);
            this.layerZeroWires.visible = this.showLayerZeroOnly;
            this.triangleGroup.add(this.layerZeroWires);
        }

        // Build letter → wire vertex mapping for z-offset animation
        this._letterToWireVerts.clear();
        for (const [interval, entries] of wireLetterData) {
            for (let i = 0; i < entries.length; i++) {
                const { letter, z } = entries[i];
                if (!this._letterToWireVerts.has(letter)) this._letterToWireVerts.set(letter, new Map());
                const byInterval = this._letterToWireVerts.get(letter)!;
                if (!byInterval.has(interval)) byInterval.set(interval, []);
                byInterval.get(interval)!.push({ idx: i, z });
            }
        }
    }

    private updateTriangleActivations(): void {
        if (!this.triMesh && !this.triMeshTiltedPerfect && !this.triMeshTiltedNonPerfect) return;
        const { getThirds } = this.config;

        // Build exact-spellings set + per-letter accidental map for quality
        // computation. The accidental map is the accumulator's currently-resolved
        // spelling per letter, used by the diatonic anchor to reject alteration
        // triangles whose vertex letter resolves to a different accidental.
        const thirds = getThirds();
        const exactSpellings = this._scratchExactSpellings; exactSpellings.clear();
        const resolvedAccByLetter = this._scratchResolvedAccByLetter; resolvedAccByLetter.clear();
        for (const pc of thirds) {
            exactSpellings.add(`${pc.letterName}:${pc.accidental}`);
            resolvedAccByLetter.set(pc.letterName as LetterName, pc.accidental);
        }

        // Diatonic anchor: when on, classify triangles as anchor/alteration vs
        // the natural-major-or-minor baseline of the current root, route anchor
        // triangle activation through letter slots (any spelling of letter L
        // contributes to L's activation), and dim alteration triangles.
        // 'anchor' takes priority over 'exact' so the natural baseline keeps
        // its letter-based activation even when the selected scale (e.g.
        // harmonic minor) places an alteration into `thirds`.
        // Maps are scratch + cached: rebuilt only when the anchor array reference
        // changes (memoized in tonnetz.ts so the same key returns the same array).
        let anchorPCByLetter: Map<LetterName, number> | null = null;
        let anchorAccByLetter: Map<LetterName, number> | null = null;
        let anchorPCSet: Set<number> | null = null;
        if (this.diatonicAnchor && this.config.getDiatonicAnchor) {
            const anchor = this.config.getDiatonicAnchor();
            if (anchor && anchor.length > 0) {
                anchorPCByLetter = this._scratchAnchorPCByLetter;
                anchorAccByLetter = this._scratchAnchorAccByLetter;
                anchorPCSet = this._scratchAnchorPCSet;
                if (anchor !== this._anchorScratchRef) {
                    anchorPCByLetter.clear();
                    anchorAccByLetter.clear();
                    anchorPCSet.clear();
                    for (const pc of anchor) {
                        const pcMidi = normPC(pc.midiValue);
                        anchorPCByLetter.set(pc.letterName as LetterName, pcMidi);
                        anchorAccByLetter.set(pc.letterName as LetterName, pc.accidental);
                        anchorPCSet.add(pcMidi);
                    }
                    this._anchorScratchRef = anchor;
                }
            }
        }

        // Suspension bias: when the toggle is on and the accumulator has
        // detected sus2/sus4/cadential 6-4, prepare a preferred-spelling lookup
        // so triangles whose altered vertices match (E♯, E♭♭, G𝄪) light up
        // regardless of the manual aug3/dim3 enharmonic toggle.
        let preferredSpellingStrings: Map<number, string> | null = null;
        if (this.suspensionTilt && this.config.getPreferredSpelling) {
            const prefMap = this.config.getPreferredSpelling();
            if (prefMap && prefMap.size > 0) {
                preferredSpellingStrings = new Map();
                for (const [pc, ps] of prefMap) {
                    preferredSpellingStrings.set(pc, `${ps.letter}:${ps.accidental}`);
                }
            }
        }

        const flatColorAttr = this.triMesh?.geometry.getAttribute('color') as THREE.BufferAttribute | null;
        const tiltedPerfectColorAttr = this.triMeshTiltedPerfect?.geometry.getAttribute('color') as THREE.BufferAttribute | null;
        const tiltedNonPerfectColorAttr = this.triMeshTiltedNonPerfect?.geometry.getAttribute('color') as THREE.BufferAttribute | null;

        // Collect wire color attrs per interval
        const wireColorAttrs = this._scratchWireColorAttrs; wireColorAttrs.clear();
        for (const [interval, wire] of this.intervalWires) {
            wireColorAttrs.set(interval, wire.geometry.getAttribute('color') as THREE.BufferAttribute);
        }

        const triColorCache = this._scratchTriColorCache; triColorCache.clear();

        // --- Sparse update: only iterate triangles whose PCs have activation or were active last frame ---
        const toUpdate = this._scratchTriUpdateSet; toUpdate.clear();
        // Previously active triangles: need update to fade out
        for (const idx of this._activeTriIndices) toUpdate.add(idx);
        // Precompute letter-based activations once per frame (was 3× per anchor
        // triangle = many redundant Set.has lookups).
        let letterActivation: Map<LetterName, number> | null = null;
        if (anchorPCByLetter && anchorPCSet) {
            letterActivation = this._scratchLetterActivation;
            letterActivation.clear();
            for (const [letter, pc] of anchorPCByLetter) {
                letterActivation.set(letter, this.letterActivationFor(pc, anchorPCSet));
            }
        }

        // Triangles containing PCs with smoothed activation > 0
        for (let pc = 0; pc < 12; pc++) {
            if (this._smoothedByPC[pc] > 0.001 || this._resonanceByPC[pc] > 0.01) {
                const list = this._pcToTriangles.get(pc);
                if (list) for (const idx of list) toUpdate.add(idx);
                // Diatonic anchor: an alteration of letter L (e.g., B♮ at PC 11)
                // should also light the anchor triangle for L (Bb-D-F at PC 10).
                // Only propagate ±1 when the played PC is NOT itself an anchor
                // PC: playing a diatonic note shouldn't pull in extra anchor
                // triangles via spurious neighbor activation.
                if (anchorPCSet && !anchorPCSet.has(pc)) {
                    const listUp = this._pcToTriangles.get((pc + 1) % 12);
                    if (listUp) for (const idx of listUp) toUpdate.add(idx);
                    const listDn = this._pcToTriangles.get((pc + 11) % 12);
                    if (listDn) for (const idx of listDn) toUpdate.add(idx);
                }
            }
        }

        const newActive = this._scratchNewActive; newActive.clear();
        let anyFillChange = false;
        let changedWireIntervals: Set<string> | null = null;

        for (const t of toUpdate) {
            const entry = this.triData[t];
            const { pcs, spellings, letters, accidentals, edgeMapping, hasSecond, isMisspelled, meshIdx } = entry;
            const invalid = hasSecond || isMisspelled;

            const isExactMatch = spellings.every(s => exactSpellings.has(s));

            // Diatonic anchor classification, priority: anchor > alteration > exact > null.
            //   - 'anchor': all 3 spellings match the natural-baseline anchor (letter-based activation, full opacity)
            //   - 'alteration': exactly ONE letter's accidental differs from anchor, by exactly ±1 (faded overlay, PC-based activation)
            //   - 'exact': matches the selected scale's spellings (PC-based, full opacity); falls through when anchor doesn't apply
            //   - null: not in any of the above categories
            let displayClass: 'exact' | 'anchor' | 'alteration' | null = null;
            if (anchorPCByLetter && anchorAccByLetter) {
                const allLettersInAnchor = anchorPCByLetter.has(letters[0])
                    && anchorPCByLetter.has(letters[1])
                    && anchorPCByLetter.has(letters[2]);
                if (allLettersInAnchor) {
                    let differCount = 0;
                    let differIdx = -1;
                    let differDistance = 0;
                    for (let i = 0; i < 3; i++) {
                        const anchorAcc = anchorAccByLetter.get(letters[i])!;
                        if (accidentals[i] !== anchorAcc) {
                            differCount++;
                            differIdx = i;
                            differDistance = Math.abs(accidentals[i] - anchorAcc);
                        }
                    }
                    if (differCount === 0) {
                        displayClass = 'anchor';
                    } else if (differCount === 1 && differDistance === 1
                            && anchorPCSet && !anchorPCSet.has(pcs[differIdx])
                            && resolvedAccByLetter.get(letters[differIdx]) === accidentals[differIdx]) {
                        // Reject enharmonic respellings (Cb-D-F in C major where
                        // Cb sits on anchor B's PC) AND reject alterations whose
                        // letter doesn't match the accumulator's currently-resolved
                        // spelling. In A harmonic minor (G resolves to G#, A
                        // resolves to A natural), the Ab vertex (A:-1) doesn't
                        // match A's resolved spelling (0), so it's rejected.
                        displayClass = 'alteration';
                    }
                }
            }
            if (!displayClass && isExactMatch) {
                displayClass = 'exact';
            }

            // Activation source:
            //   - anchor: letter-based, played PC contributes to letter L if PC == L's
            //     anchor PC, OR PC is ±1 from L's anchor AND PC is not another letter's
            //     anchor PC (so playing C doesn't spuriously activate letter B's slot
            //     in C major where C and B are 1 semitone apart).
            //   - everything else: direct PC activation as today
            let act0: number, act1: number, act2: number;
            if (displayClass === 'anchor') {
                act0 = letterActivation!.get(letters[0])!;
                act1 = letterActivation!.get(letters[1])!;
                act2 = letterActivation!.get(letters[2])!;
            } else {
                act0 = this._smoothedByPC[pcs[0]];
                act1 = this._smoothedByPC[pcs[1]];
                act2 = this._smoothedByPC[pcs[2]];
            }
            const activation = invalid ? 0 : Math.min(act0, act1, act2);

            // Enharmonic triads only activate while they have resonance (short-term memory)
            const isEnhAllowed = this.activateEnharmonics && this.showEnharmonicTriads[entry.triadType];
            const enhRes = Math.min(this._resonanceByPC[pcs[0]], this._resonanceByPC[pcs[1]], this._resonanceByPC[pcs[2]]);
            // Suspension match: every altered vertex uses the preferred spelling
            // and every preferred PC is one of the triangle's vertices.
            let matchesPreferred = false;
            if (preferredSpellingStrings) {
                matchesPreferred = true;
                for (const [pc, want] of preferredSpellingStrings) {
                    const i = pcs.indexOf(pc);
                    if (i < 0 || spellings[i] !== want) { matchesPreferred = false; break; }
                }
            }
            const quality = (activation > 0 && (isExactMatch
                || displayClass === 'anchor'
                || displayClass === 'alteration'
                || (isEnhAllowed && enhRes > 0.01)
                || matchesPreferred)) ? 1.0 : 0;

            let triColor = triColorCache.get(entry.color);
            if (!triColor) {
                triColor = new THREE.Color(entry.color);
                triColorCache.set(entry.color, triColor);
            }

            const rawRes = invalid ? 0 : Math.min(
                this._resonanceByPC[pcs[0]], this._resonanceByPC[pcs[1]], this._resonanceByPC[pcs[2]]);
            const resStrength = rawRes * rawRes;
            const fillLerp = TRI_OPACITY_BASE * TRI_FILL_SCALE + resStrength * (TRI_OPACITY_HELD - TRI_OPACITY_BASE * TRI_FILL_SCALE);
            // Alteration overlay dim factor: preferred-spelling triangles (sus/6-4) win and skip dim
            const opacityScale = (displayClass === 'alteration' && !matchesPreferred) ? ALTERATION_OPACITY_FACTOR : 1.0;
            const fillOpacity = activation * quality * fillLerp * opacityScale;
            const shade = entry.shade;
            const colorAttr = entry.meshGroup === 'flat'
                ? flatColorAttr
                : (entry.meshGroup === 'tiltedPerfect' ? tiltedPerfectColorAttr : tiltedNonPerfectColorAttr);
            if (colorAttr) {
                for (let vi = 0; vi < 3; vi++) {
                    const base = meshIdx * 3 + vi;
                    colorAttr.setXYZ(base, triColor.r * fillOpacity * shade, triColor.g * fillOpacity * shade, triColor.b * fillOpacity * shade);
                }
            }
            anyFillChange = true;

            const wireLerp = TRI_WIRE_ACTIVE + resStrength * (TRI_WIRE_HELD - TRI_WIRE_ACTIVE);
            const wireOpacity = TRI_WIRE_BASE + activation * quality * wireLerp * opacityScale;
            for (const em of edgeMapping) {
                const attr = wireColorAttrs.get(em.interval);
                if (!attr) continue;
                const base = em.wireIdx * 2;
                attr.setXYZ(base, triColor.r * wireOpacity, triColor.g * wireOpacity, triColor.b * wireOpacity);
                attr.setXYZ(base + 1, triColor.r * wireOpacity, triColor.g * wireOpacity, triColor.b * wireOpacity);
                if (!changedWireIntervals) changedWireIntervals = new Set();
                changedWireIntervals.add(em.interval);
            }

            if (fillOpacity > 0.001 || wireOpacity > TRI_WIRE_BASE + 0.001) {
                newActive.add(t);
            }
        }

        // Swap active sets
        this._activeTriIndices.clear();
        for (const idx of newActive) this._activeTriIndices.add(idx);

        // Only flag buffers that actually changed
        if (anyFillChange) {
            if (flatColorAttr) flatColorAttr.needsUpdate = true;
            if (tiltedPerfectColorAttr) tiltedPerfectColorAttr.needsUpdate = true;
            if (tiltedNonPerfectColorAttr) tiltedNonPerfectColorAttr.needsUpdate = true;
        }
        if (changedWireIntervals) {
            for (const interval of changedWireIntervals) {
                const attr = wireColorAttrs.get(interval);
                if (attr) attr.needsUpdate = true;
            }
        }
    }

    // ── Scale Path ─────────────────────────────────────────────────

    private buildScalePath(): void {
        const thirds = this.config.getThirds();
        const segments = computeScalePathV2(thirds, this.zSpacing);

        if (segments.length === 0) return;

        // Scale path x uses absolute extendedFifthsPos * X_SPACING;
        // shift to grid coordinates (relative to startFifths) and mirror if reversed
        const xShift = -this.currentStartFifths * X_SPACING;
        const fifthsForward = this.config.getFifthsForward?.() ?? true;
        const zInverted = this.config.getZInverted?.() ?? false;
        const mirrorX = (x: number) => {
            const gridX = x + xShift;
            return fifthsForward ? this.gridMaxX - gridX : gridX;
        };
        const mirrorZ = (z: number) => zInverted ? -z : z;

        for (const seg of segments) {
            const points = [
                new THREE.Vector3(mirrorX(seg.from.x), seg.from.y, mirrorZ(seg.from.z)),
                new THREE.Vector3(mirrorX(seg.to.x), seg.to.y, mirrorZ(seg.to.z)),
            ];
            const geo = new THREE.BufferGeometry().setFromPoints(points);

            let color: number;
            let linewidth = 2;
            if (seg.intervalType === 'd5') {
                color = PATH_COLOR_D5;
                linewidth = 3;
            } else if (seg.intervalType === 'A5') {
                color = PATH_COLOR_A5;
            } else {
                color = PATH_COLOR_P5;
            }

            const mat = new THREE.LineBasicMaterial({
                color,
                linewidth,
                transparent: true,
                opacity: 0.8,
            });
            const line = new THREE.Line(geo, mat);
            this.pathGroup.add(line);

            // Double-line for d5 segments (tritone emphasis)
            if (seg.intervalType === 'd5') {
                const offset = new THREE.Vector3(0, 0.05, 0.05);
                const points2 = [
                    new THREE.Vector3().copy(points[0]).add(offset),
                    new THREE.Vector3().copy(points[1]).add(offset),
                ];
                const geo2 = new THREE.BufferGeometry().setFromPoints(points2);
                const mat2 = new THREE.LineBasicMaterial({
                    color: PATH_COLOR_D5,
                    linewidth: 1,
                    transparent: true,
                    opacity: 0.5,
                });
                this.pathGroup.add(new THREE.Line(geo2, mat2));
            }
        }
    }

    // ── Enharmonic arrow target PCs ──────────────────────────────────

    /** Pre-compute the set of MIDI PCs that enharmonic arrows point TO. */
    private computeEnharmonicTargetPCs(): Set<number> {
        const result = new Set<number>();
        const thirds = this.config.getThirds();
        if (thirds.length < 2) return result;

        const sorted = [...thirds].sort(
            (a, b) => extendedFifthsPos(a.letterName, a.accidental)
                    - extendedFifthsPos(b.letterName, b.accidental)
        );

        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const diff = normPC(sorted[j].midiValue - sorted[i].midiValue);
                const ic = Math.min(diff, 12 - diff);
                if (ic !== 6) continue;

                const loMidi = normPC(sorted[i].midiValue);
                const hiMidi = normPC(sorted[j].midiValue);

                // Enharmonic of hi resolves DOWN → target is hiMidi - 1
                result.add((hiMidi + 11) % 12);
                // Enharmonic of lo resolves UP → target is loMidi + 1
                result.add((loMidi + 1) % 12);
            }
        }
        return result;
    }

    // ── Resolution Arrows ──────────────────────────────────────────

    private buildArrows(): void {
        const thirds = this.config.getThirds();
        if (thirds.length < 2) return;

        // Sort scale notes by extended fifths position
        const sorted = [...thirds].sort(
            (a, b) => extendedFifthsPos(a.letterName, a.accidental)
                    - extendedFifthsPos(b.letterName, b.accidental)
        );

        // Find d5 pairs (tritone = 6 semitones) and their semitone resolutions
        const scaleMidis = new Set(sorted.map(n => normPC(n.midiValue)));
        const resolutionSet = new Map<number, number>(); // sourceMidi → targetMidi
        // Enharmonic nodes resolve in the OPPOSITE direction from their scale counterpart
        // (e.g. G# resolves UP to A, but Ab resolves DOWN to G)
        const enharmonicResolutionSet = new Map<number, number>();

        for (let i = 0; i < sorted.length; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                const diff = normPC(sorted[j].midiValue - sorted[i].midiValue);
                const ic = Math.min(diff, 12 - diff);
                if (ic !== 6) continue;

                const loMidi = normPC(sorted[i].midiValue);
                const hiMidi = normPC(sorted[j].midiValue);

                // hi (sharps side) resolves UP by semitone
                const targetHi = (hiMidi + 1) % 12;
                if (scaleMidis.has(targetHi)) resolutionSet.set(hiMidi, targetHi);

                // lo (flats side) resolves DOWN by semitone
                const targetLo = (loMidi + 11) % 12;
                if (scaleMidis.has(targetLo)) resolutionSet.set(loMidi, targetLo);

                // Enharmonic of hi resolves DOWN (opposite); no scale check,
                // target just needs to exist as a node on the adjacent layer
                enharmonicResolutionSet.set(hiMidi, (hiMidi + 11) % 12);

                // Enharmonic of lo resolves UP (opposite)
                enharmonicResolutionSet.set(loMidi, (loMidi + 1) % 12);
            }
        }

        if (resolutionSet.size === 0 && enharmonicResolutionSet.size === 0) return;

        // Index nodes by (midi, layer, row) for target lookup and by (midi, layer) for source lookup
        const nodesByMidiLayerRow = new Map<string, LatticeNode>();
        const nodesByMidiLayer = new Map<string, LatticeNode[]>();
        for (const n of this.currentNodes) {
            const midi = normPC(n.pc.midiValue);
            nodesByMidiLayerRow.set(`${midi}:${n.layer}:${n.gridRow}`, n);
            const mlKey = `${midi}:${n.layer}`;
            let arr = nodesByMidiLayer.get(mlKey);
            if (!arr) { arr = []; nodesByMidiLayer.set(mlKey, arr); }
            arr.push(n);
        }

        const coneGeo = new THREE.ConeGeometry(ARROW_HEAD_WIDTH, ARROW_HEAD_LENGTH, 8);

        // For each source node with a resolution, find the target
        // on an adjacent layer in the SAME ROW (along the P5 axis only).
        // Scale nodes use resolutionSet; enharmonic nodes use enharmonicResolutionSet
        // (opposite direction, e.g. G# → A but Ab → G).
        const allSourceMidis = new Set([...resolutionSet.keys(), ...enharmonicResolutionSet.keys()]);
        for (const sourceMidi of allSourceMidis) {
            const scaleTarget = resolutionSet.get(sourceMidi);
            const enhTarget = enharmonicResolutionSet.get(sourceMidi);

            for (const layer of [-1, 0, 1]) {
                const sourceNodes = nodesByMidiLayer.get(`${sourceMidi}:${layer}`);
                if (!sourceNodes) continue;
                for (const n of sourceNodes) {
                    // Collect all applicable resolutions for this source node
                    const targets: { midi: number; isEnh: boolean }[] = [];
                    if (n.isScaleNote && scaleTarget !== undefined) {
                        targets.push({ midi: scaleTarget, isEnh: false });
                    }
                    if (enhTarget !== undefined && (n.isScaleNote || (n.isEnharmonicNote && this.isWithinEnharmonicDistance(n.pc)))) {
                        targets.push({ midi: enhTarget, isEnh: true });
                    }
                    if (targets.length === 0) continue;

                    // Look on adjacent layers, same row.
                    // Scale arrows: target must be a scale node.
                    // Enharmonic arrows: target must be on a different gridCol
                    // (prevents vertical arrows like E#→E## directly above/below).
                    for (const { midi: tMidi, isEnh } of targets) {
                        for (const adj of [layer - 1, layer + 1]) {
                            if (adj < -1 || adj > 1) continue;
                            const tgt = nodesByMidiLayerRow.get(`${tMidi}:${adj}:${n.gridRow}`);
                            if (!tgt) continue;
                            if (isEnh ? (tgt.gridCol === n.gridCol) : !tgt.isScaleNote) continue;
                            this.createArrow(n, tgt, coneGeo, sourceMidi, tMidi, isEnh);
                        }
                    }
                }
            }
        }
    }

    private createArrow(
        sourceNode: LatticeNode, targetNode: LatticeNode,
        coneGeo: THREE.ConeGeometry,
        sourceMidi: number, targetMidi: number,
        isEnharmonic = false,
    ): void {
        const sourcePos = new THREE.Vector3(sourceNode.x, sourceNode.y, sourceNode.z);
        const targetPos = new THREE.Vector3(targetNode.x, targetNode.y, targetNode.z);

        // Shorten arrow by NODE_RADIUS at each end
        const dir = new THREE.Vector3().subVectors(targetPos, sourcePos).normalize();
        const start = sourcePos.clone().addScaledVector(dir, NODE_RADIUS);
        const end = targetPos.clone().addScaledVector(dir, -NODE_RADIUS - ARROW_HEAD_LENGTH * 0.5);

        // Shaft: use a cylinder mesh instead of Line (WebGL clamps linewidth to 1px)
        const shaftLen = start.distanceTo(end);
        const shaftGeo = new THREE.CylinderGeometry(ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, shaftLen, 6, 1);
        const shaftMat = new THREE.MeshBasicMaterial({
            color: ARROW_COLOR_DIM,
            transparent: true,
            opacity: 0, // start invisible: only shown when source is active
            depthTest: false,
        });
        const shaft = new THREE.Mesh(shaftGeo, shaftMat);
        // Position at midpoint, orient along arrow direction
        const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
        shaft.position.copy(mid);
        const up = new THREE.Vector3(0, 1, 0);
        shaft.quaternion.setFromUnitVectors(up, dir);

        // Arrowhead (cone)
        const coneMat = new THREE.MeshBasicMaterial({
            color: ARROW_COLOR_DIM,
            transparent: true,
            opacity: 0,
            depthTest: false,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        const conePos = targetPos.clone().addScaledVector(dir, -NODE_RADIUS);
        cone.position.copy(conePos);
        // Orient: ConeGeometry default axis is +Y, rotate to point along dir
        cone.quaternion.setFromUnitVectors(up, dir);

        const group = new THREE.Group();
        group.add(shaft);
        group.add(cone);
        this.arrowGroup.add(group);

        this.arrowData.push({
            fromPC: sourceMidi,
            toPC: targetMidi,
            toLetterIdx: LETTER_INDICES[targetNode.pc.letterName] ?? 0,
            arrow: group,
            shaftMat,
            coneMat,
            targetGridKey: `${targetNode.gridRow}:${targetNode.layer}:${targetNode.gridCol}`,
            isEnharmonic,
        });
    }

    private updateArrowActivations(): void {
        if (this.arrowData.length === 0) return;

        const { getNoteActivation, getHeldPCs, getActivePCs } = this.config;
        const heldPCs = getHeldPCs();
        const activePCs = getActivePCs();

        // Build activation field (may be empty in key mode; that's OK,
        // computeArrowLit falls back to heldPCs/activePCs)
        const activationField = new Map<number, number>();
        for (let pc = 0; pc < 12; pc++) {
            const act = getNoteActivation(pc);
            if (act > 0) activationField.set(pc, act);
        }

        // Build resonance field for short-term arrow gating (uses pre-computed array)
        const shortTermField = (() => {
            const f = new Map<number, number>();
            for (let pc = 0; pc < 12; pc++) {
                const act = this._resonanceByPC[pc];
                if (act > 0) f.set(pc, act);
            }
            return f.size > 0 ? f : null;
        })();

        const noteOnTimestamps = this.config.getNoteOnTimestamps?.() ?? new Map<number, number>();
        const resolvedMidi = this.config.getResolvedMidi?.() ?? null;
        // A5 is a scale-level relationship: check both short-term and long-term fields
        const isActive = (pc: number) => heldPCs.has(pc) || activePCs.has(pc)
            || (shortTermField ? (shortTermField.get(pc) ?? 0) > LIT_THRESHOLD : false)
            || (activationField.size > 0 ? (activationField.get(pc) ?? 0) > LIT_THRESHOLD : false);
        const goldColor = this._scratchGoldColor;
        const copperColor = this._scratchCopperColor;

        // Pre-pass: find source PCs whose scale arrow has resolved,
        // so enharmonic arrows from the same source also dim.
        const resolvedScaleSources = new Set<number>();
        for (const ad of this.arrowData) {
            if (ad.isEnharmonic) continue;
            const fromAct = activationField.get(ad.fromPC) ?? 0;
            const fromActive = heldPCs.has(ad.fromPC) || activePCs.has(ad.fromPC) || fromAct > 0;
            if (!fromActive) continue;
            const toTime = noteOnTimestamps.get(ad.toPC) ?? 0;
            const fromTime = noteOnTimestamps.get(ad.fromPC) ?? 0;
            if (toTime > fromTime) resolvedScaleSources.add(ad.fromPC);
        }

        for (const ad of this.arrowData) {
            // Skip enharmonic arrows when enharmonics are disabled,
            // or when the scale arrow from the same source has resolved
            if (ad.isEnharmonic && (!this.activateEnharmonics || resolvedScaleSources.has(ad.fromPC))) {
                ad.shaftMat.opacity = 0;
                ad.coneMat.opacity = 0;
                continue;
            }

            let strength = computeArrowLit(
                ad.fromPC, ad.toPC,
                heldPCs, activePCs,
                activationField, noteOnTimestamps,
                shortTermField,
            );
            if (strength > 0 && resolvedMidi && hasNonPerfectFifth(ad.toPC, ad.toLetterIdx, resolvedMidi, isActive)) {
                strength = 0;
            }

            if (strength <= 0) {
                ad.shaftMat.opacity = 0;
                ad.coneMat.opacity = 0;
                continue;
            }

            // In free mode, scale opacity by smoothed activation level; in key mode use full
            const fromAct = this._smoothedByPC[ad.fromPC];
            const baseOpacity = fromAct > 0 ? fromAct : 1;
            const enhMultiplier = ad.isEnharmonic ? 0.5 : 1;
            const opacity = Math.max(0.3, baseOpacity * strength) * enhMultiplier;

            ad.shaftMat.color.set(ARROW_COLOR_LIT);
            ad.shaftMat.opacity = opacity;
            ad.coneMat.color.set(ARROW_COLOR_LIT);
            ad.coneMat.opacity = opacity;

            // (Gold target highlight removed; arrows alone mark targets;
            //  gold ring now applied to held notes in updateNodeActivations.)
        }

        if (this.nodeInstanced?.instanceColor) {
            this.nodeInstanced.instanceColor.needsUpdate = true;
        }
    }

    // ── Labels ─────────────────────────────────────────────────────

    private createLabel(text: string, opacity: number): THREE.Sprite {
        // Try atlas first
        const entry = this.labelAtlas.getEntry(text);
        if (entry) {
            // Clone the atlas texture and set UV offset
            const mat = new THREE.SpriteMaterial({
                map: this.labelAtlas.texture,
                transparent: true,
                depthWrite: false,
                opacity: Math.min(1, opacity),
            });
            // Use custom UV via a cloned texture with offset/repeat
            const tex = this.labelAtlas.texture.clone();
            tex.offset.set(entry.u, entry.v);
            tex.repeat.set(entry.w, entry.h);
            tex.needsUpdate = true;
            mat.map = tex;

            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(0.6, 0.3, 1);
            return sprite;
        }

        // Fallback: individual canvas
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 32;
        const ctx = canvas.getContext('2d')!;
        ctx.font = 'bold 20px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, opacity)})`;
        ctx.fillText(text, 32, 16);

        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(0.6, 0.3, 1);
        return sprite;
    }

    private createCoordLabel(text: string): THREE.Sprite {
        const canvas = document.createElement('canvas');
        canvas.width = 192;
        canvas.height = 32;
        const ctx = canvas.getContext('2d')!;
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(180, 255, 180, 0.7)';
        ctx.fillText(text, 96, 16);
        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(1.5, 0.25, 1);
        return sprite;
    }

    // ── Axes ──────────────────────────────────────────────────────

    private buildAxes(): void {
        if (!this.showAxes) return;
        const numCols = Math.floor(this.config.cols() / 2);
        const numRows = this.config.rows();

        const xLen = (numCols * X_SPACING + numRows * ROW_SHIFT) / 2;
        const yLen = numRows * Y_SPACING;
        const zMin = this.layerMin * this.zSpacing;
        const zMax = this.layerMax * this.zSpacing;

        const tickLen = 0.15;

        const axes: { dir: THREE.Vector3; from: number; to: number; color: number; label: string; spacing: number; tickDir: THREE.Vector3 }[] = [
            { dir: new THREE.Vector3(1, 0, 0), from: 0, to: xLen, color: 0xff4444, label: '5ths', spacing: X_SPACING, tickDir: new THREE.Vector3(0, 1, 0) },
            { dir: new THREE.Vector3(0, 1, 0), from: 0, to: yLen, color: 0x44ff44, label: '3rds', spacing: Y_SPACING, tickDir: new THREE.Vector3(1, 0, 0) },
            { dir: new THREE.Vector3(0, 0, 1), from: zMin, to: zMax, color: 0x4488ff, label: '♯', spacing: this.zSpacing, tickDir: new THREE.Vector3(1, 0, 0) },
        ];

        for (const axis of axes) {
            if (axis.to <= axis.from) continue;

            // Axis line
            const lineGeo = new THREE.BufferGeometry().setFromPoints([
                axis.dir.clone().multiplyScalar(axis.from),
                axis.dir.clone().multiplyScalar(axis.to),
            ]);
            const lineMat = new THREE.LineBasicMaterial({
                color: axis.color,
                transparent: true,
                opacity: 0.4,
            });
            this.axisGroup.add(new THREE.Line(lineGeo, lineMat));

            // Tick marks
            const tickPositions: number[] = [];
            const firstTick = Math.ceil(axis.from / axis.spacing);
            const lastTick = Math.floor(axis.to / axis.spacing);
            for (let i = firstTick; i <= lastTick; i++) {
                if (i === 0) continue;
                const p = axis.dir.clone().multiplyScalar(i * axis.spacing);
                const t = axis.tickDir.clone().multiplyScalar(tickLen);
                tickPositions.push(
                    p.x - t.x, p.y - t.y, p.z - t.z,
                    p.x + t.x, p.y + t.y, p.z + t.z,
                );
            }
            if (tickPositions.length > 0) {
                const tickGeo = new THREE.BufferGeometry();
                tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(tickPositions, 3));
                const tickMat = new THREE.LineBasicMaterial({
                    color: axis.color,
                    transparent: true,
                    opacity: 0.3,
                });
                this.axisGroup.add(new THREE.LineSegments(tickGeo, tickMat));
            }

            // Label at positive end: offset perpendicular so it doesn't overlap nodes
            const labelSprite = this.createLabel(axis.label, 0.7);
            const labelPos = axis.dir.clone().multiplyScalar(axis.to + 0.4);
            labelPos.add(axis.tickDir.clone().multiplyScalar(-0.5));
            labelSprite.position.copy(labelPos);
            this.axisGroup.add(labelSprite);

            // Label at negative end (for z-axis: flat symbol)
            if (axis.from < 0) {
                const negLabel = this.createLabel('♭', 0.7);
                const negPos = axis.dir.clone().multiplyScalar(axis.from - 0.4);
                negPos.add(axis.tickDir.clone().multiplyScalar(-0.5));
                negLabel.position.copy(negPos);
                this.axisGroup.add(negLabel);
            }
        }
    }

    // ── Camera ─────────────────────────────────────────────────────

    centerCamera(): void {
        const numCols = Math.floor(this.config.cols() / 2);
        const numRows = this.config.rows();

        // Center on the middle of the grid
        const cx = (numCols / 2) //* X_SPACING;
        const cy = (numRows / 2) //* Y_SPACING;
        const cz = 0;

        // Shift target right so the lattice appears more centered in the panel
        const panX = numCols * X_SPACING * 0.3;
        this.controls.target.set(cx + panX, cy, cz);

        const maxExtent = Math.max(numCols * X_SPACING, numRows * Y_SPACING, 3 * this.zSpacing);
        const dist = maxExtent * 0.5; // enharmonic viz: closer default framing (was 1.15), zoom in more
        this.camera.position.set(cx + panX, cy - dist * 1.0, cz + dist * 0.45);
        this.camera.updateProjectionMatrix();
        this.controls.update();
    }
}
