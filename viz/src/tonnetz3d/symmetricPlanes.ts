/**
 * Symmetric-chord planes: the enharmonic continuation of an augmented triad or a diminished seventh,
 * drawn as the diagonal sheet it forms in the 3D lattice.
 *
 * The lattice is one infinite grid over the line of fifths, n = x + 4y + 7z (C = 0; x = fifths, y = major
 * thirds, z = accidental layers). A symmetric chord divides the octave equally, so its spellings are
 * closed under the interval that generates it, and that interval's LoF step divides the comma (12):
 *
 *   augmented triad   M3 = +4 on the LoF, so its spellings are { n ≡ r (mod 4) }   (r = 0..3, four chords)
 *   diminished 7th    m3 = −3 on the LoF, so its spellings are { n ≡ r (mod 3) }   (r = 0..2, three chords)
 *
 * Because 4 ≡ 0 and 7 ≡ −1 (mod 4), n ≡ x − z (mod 4): every cell of one augmented triad lies on the
 * planes x − z = const. Because 4 ≡ 7 ≡ 1 (mod 3), n ≡ x + y + z (mod 3): every cell of one dim7 lies on
 * the planes x + y + z = const. Each such plane is a sheet tiled by the chord's own triangles:
 *
 *   aug sheet   steps a = (0, 1, 0)  (+4, M3 in a layer)   b = (1, −1, 1)  (+4, M3 across a layer)
 *               a + b = (1, 0, 1)  (+8, a fifth and a sharp: C → G♯)          → triangles C–E–G♯
 *   dim7 sheet  steps u = (1, −1, 0) (−3, m3 in a layer)   v = (0, 1, −1)  (−3, M3 then a flat: C → E → E♭)
 *               u + v = (1, 0, −1) (−6, a fifth and a flat: C → G♭)           → triangles C–E♭–G♭
 *
 * Walking a sheet stacks the generating interval forever (A♭–C–E–G♯–B♯–D𝄪…, or D♯–F♯–A–C–E♭–G♭–B𝄫…):
 * the same pitch classes recur a comma further along the spiral each cycle. That is the picture of why the
 * chord serves modulation (it sits on every key's doorstep) and why the vertical alone cannot fix its
 * spelling (every cell of the sheet is the same sound).
 *
 * Pure geometry + three.js objects: the scene hands in its current nodes (positions already mirrored /
 * flipped as displayed) and gets back a group to add. Grid indices (gridCol, gridRow, layer) are the
 * lattice coordinates, so the arithmetic above applies directly to them.
 */
import * as THREE from 'three';
import type { LatticeNode } from './LatticeGeometry';

export type SymKind = 'aug' | 'dim7';
/** One symmetric chord: its kind and the residue of its spellings' LoF positions (C = 0). */
export interface SymClass { kind: SymKind; residue: number }
/** `focus`: one main sheet per chord (nearest the struck spellings) plus faint parallel copies.
 *  `all`: every sheet of every listed chord at equal weight. */
export type SymPlaneMode = 'focus' | 'all';
export interface SymPlaneSpec {
    classes: SymClass[];
    mode: SymPlaneMode;
    /** `letter:accidental` keys of the notes actually sounding, as spelled: their cells are ringed. */
    emphasis: ReadonlySet<string>;
}

const MOD: Record<SymKind, number> = { aug: 4, dim7: 3 };
/** The two unit steps spanning each kind's sheet, in (col, row, layer). */
const STEPS: Record<SymKind, [[number, number, number], [number, number, number]]> = {
    aug: [[0, 1, 0], [1, -1, 1]],
    dim7: [[1, -1, 0], [0, 1, -1]],
};
/** Which parallel sheet a cell sits on (constant along both steps). */
const sheetId = (kind: SymKind, c: number, r: number, l: number) => kind === 'aug' ? c - l : c + r + l;

const FIFTHS = 'FCGDAEB';
const mod = (a: number, m: number) => ((a % m) + m) % m;
/** Line-of-fifths position, C = 0 (G = 1, F = −1, F♯ = 6, B♭ = −2 …). */
export const lofOf = (letter: string, accidental: number) => FIFTHS.indexOf(letter) - 1 + 7 * accidental;
/** LoF position of a pitch class's "home" spelling (any spelling gives the same residue mod 3 and 4). */
const lofOfPc = (pc: number) => mod(7 * pc, 12);

/** The symmetric chords whose every pitch class is in `pcs`: augmented triads, then diminished sevenths. */
export function symClassesIn(pcs: ReadonlySet<number>): SymClass[] {
    const out: SymClass[] = [];
    for (let k = 0; k < 4; k++) if ([0, 4, 8].every(d => pcs.has((k + d) % 12))) out.push({ kind: 'aug', residue: lofOfPc(k) % 4 });
    for (let k = 0; k < 3; k++) if ([0, 3, 6, 9].every(d => pcs.has((k + d) % 12))) out.push({ kind: 'dim7', residue: lofOfPc(k) % 3 });
    return out;
}
/** Every augmented triad (4) or every diminished seventh (3). */
export const allSymClasses = (kind: SymKind): SymClass[] =>
    Array.from({ length: MOD[kind] }, (_, residue) => ({ kind, residue }));

// Colours on the scene's dark ground. Focus mode: one hue per kind (green = augmented, as in the triad
// palette; pink = diminished). All mode: the interleaved sheets of one kind each get their own hue.
const KIND_COLOR: Record<SymKind, string> = { aug: '#7bd88f', dim7: '#ff8fc8' };
const ALL_COLORS: Record<SymKind, string[]> = {
    aug: ['#7bd88f', '#5ec8f2', '#ffd166', '#c79bf2'],
    dim7: ['#ff8fc8', '#5ed6c4', '#ffb26b'],
};

export interface SymPlaneResult {
    group: THREE.Group;
    /** Per chord, its continuation as spelled on its main sheet (A♭ – C – E – G♯ – B♯ …), in stacking
     *  order, each spelling flagged when it is one of the struck notes. */
    captions: { kind: SymKind; color: string; chain: { label: string; struck: boolean }[] }[];
}

interface LabelSource { texture: THREE.Texture; getEntry(label: string): { u: number; v: number; w: number; h: number } | undefined }

/** Build the sheets for `spec` over the displayed lattice `nodes`. `labelOf` gives a node's display name. */
export function buildSymmetricPlanes(
    nodes: readonly LatticeNode[],
    spec: SymPlaneSpec,
    atlas: LabelSource,
    labelOf: (n: LatticeNode) => string,
): SymPlaneResult {
    const group = new THREE.Group();
    group.name = 'symmetric-planes';
    const captions: SymPlaneResult['captions'] = [];
    if (spec.classes.length === 0 || nodes.length === 0) return { group, captions };

    const centre = new THREE.Vector3();
    for (const n of nodes) centre.add(new THREE.Vector3(n.x, n.y, n.z));
    centre.multiplyScalar(1 / nodes.length);
    const struck = (n: LatticeNode) => spec.emphasis.has(`${n.pc.letterName}:${n.pc.accidental}`);

    const labels: LabelItem[] = [];
    for (const cls of spec.classes) {
        const sheets = computeSheets(nodes, cls);
        // Main sheet (focus mode): the one holding the most cells of the struck spellings; ties go to the
        // sheet whose cells sit nearest the middle of the window (where the key's neighbourhood is drawn).
        let main: Sheet | undefined;
        if (spec.mode === 'focus') {
            let best = -1, bestD = Infinity;
            for (const sh of sheets) {
                if (sh.triangles.length === 0) continue;
                const hits = sh.cells.filter(struck).length;
                const d = sh.cells.reduce((s, n) => s + centre.distanceTo(new THREE.Vector3(n.x, n.y, n.z)), 0) / sh.cells.length;
                if (hits > best || (hits === best && d < bestD)) { best = hits; bestD = d; main = sh; }
            }
        }
        const colorOf = spec.mode === 'all' ? ALL_COLORS[cls.kind][cls.residue]! : KIND_COLOR[cls.kind];
        const color = new THREE.Color(colorOf);
        for (const sh of sheets) {
            const weight: Weight = spec.mode === 'all' ? 'all' : sh === main ? 'main' : 'echo';
            drawSheet(group, labels, sh, color, weight, struck, labelOf);
        }
        // Caption: the main sheet's spellings in stacking order (aug: up by M3 = +4; dim7: up by m3 = −3).
        const capCells = spec.mode === 'focus' ? main?.cells ?? [] : sheets.flatMap(sh => sh.cells);
        captions.push({ kind: cls.kind, color: colorOf, chain: chainOf(capCells, cls.kind).map(n => ({ label: labelOf(n), struck: struck(n) })) });
    }
    if (labels.length) group.add(labelMesh(labels, atlas));
    return { group, captions };
}

/** One parallel sheet of a symmetric chord: its cells, and its unit triangles / edges (each triangle is the
 *  chord's own triad: C–E–G♯ for aug, C–E♭–G♭ for dim7). */
export interface Sheet {
    id: number;
    cells: LatticeNode[];
    triangles: [LatticeNode, LatticeNode, LatticeNode][];
    edges: [LatticeNode, LatticeNode][];
}

/** Split the cells of `cls` among the displayed `nodes` into its parallel sheets and triangulate each.
 *  Pure (no three.js objects), so the music can be unit-tested. */
export function computeSheets(nodes: readonly LatticeNode[], cls: SymClass): Sheet[] {
    const key = (c: number, r: number, l: number) => `${c}:${r}:${l}`;
    const at = new Map<string, LatticeNode>();
    for (const n of nodes) at.set(key(n.gridCol, n.gridRow, n.layer), n);
    const m = MOD[cls.kind];
    const [s1, s2] = STEPS[cls.kind];
    const s12: [number, number, number] = [s1[0] + s2[0], s1[1] + s2[1], s1[2] + s2[2]];
    const step = (n: LatticeNode, d: [number, number, number]) => at.get(key(n.gridCol + d[0], n.gridRow + d[1], n.layer + d[2]));
    const byId = new Map<number, Sheet>();
    for (const n of nodes) {
        if (mod(lofOf(n.pc.letterName, n.pc.accidental), m) !== cls.residue) continue;
        const id = sheetId(cls.kind, n.gridCol, n.gridRow, n.layer);
        let sh = byId.get(id);
        if (!sh) { sh = { id, cells: [], triangles: [], edges: [] }; byId.set(id, sh); }
        sh.cells.push(n);
    }
    for (const sh of byId.values()) {
        for (const p of sh.cells) {
            const a = step(p, s1), b = step(p, s2), ab = step(p, s12);
            if (a && ab) sh.triangles.push([p, a, ab]);
            if (b && ab) sh.triangles.push([p, b, ab]);
            // Unit edges: both steps and their sum (the chord's own intervals), each once from its lower end.
            if (a) sh.edges.push([p, a]);
            if (b) sh.edges.push([p, b]);
            if (ab) sh.edges.push([p, ab]);
        }
    }
    return [...byId.values()].sort((x, y) => x.id - y.id);
}

/** The distinct spellings among `cells`, in stacking order: aug upward by major thirds (+4 on the LoF),
 *  dim7 upward by minor thirds (−3). Returns one representative cell per spelling. */
export function chainOf(cells: readonly LatticeNode[], kind: SymKind): LatticeNode[] {
    const uniq = new Map<number, LatticeNode>();
    for (const n of cells) uniq.set(lofOf(n.pc.letterName, n.pc.accidental), n);
    return [...uniq.keys()].sort((a, b) => kind === 'aug' ? a - b : b - a).map(n => uniq.get(n)!);
}

type Weight = 'main' | 'echo' | 'all';
const FILL_OPACITY: Record<Weight, number> = { main: 0.34, echo: 0.035, all: 0.14 };
const EDGE_OPACITY: Record<Weight, number> = { main: 1, echo: 0.14, all: 0.5 };
const LABEL_OPACITY: Record<Weight, number> = { main: 1, echo: 0.22, all: 0.6 };
const RING_OPACITY: Record<Weight, number> = { main: 1, echo: 0.18, all: 0.5 };

interface LabelItem { x: number; y: number; z: number; label: string; opacity: number; color: THREE.Color }

function drawSheet(
    group: THREE.Group, labels: LabelItem[], sh: Sheet, color: THREE.Color, weight: Weight,
    struck: (n: LatticeNode) => boolean, labelOf: (n: LatticeNode) => string,
): void {
    const flat = (ns: readonly LatticeNode[][]) => ns.flatMap(t => t.flatMap(n => [n.x, n.y, n.z]));
    if (sh.triangles.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(flat(sh.triangles), 3));
        const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: FILL_OPACITY[weight], side: THREE.DoubleSide, depthWrite: false,
        }));
        mesh.renderOrder = 2;
        group.add(mesh);
    }
    if (sh.edges.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(flat(sh.edges), 3));
        const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
            color, transparent: true, opacity: EDGE_OPACITY[weight], depthWrite: false,
        }));
        lines.renderOrder = 3;
        group.add(lines);
    }
    // Rings around every cell of the sheet; the struck spellings get a larger ring.
    const plain = sh.cells.filter(n => !struck(n)), hit = sh.cells.filter(struck);
    if (plain.length) group.add(rings(flat([plain]), color, 0.42, RING_OPACITY[weight]));
    if (hit.length) group.add(rings(flat([hit]), color, 0.6, Math.min(1, RING_OPACITY[weight] + 0.1)));
    for (const n of sh.cells) labels.push({ x: n.x, y: n.y, z: n.z, label: labelOf(n), opacity: LABEL_OPACITY[weight], color });
}

let ringTex: THREE.Texture | null = null;
function ringTexture(): THREE.Texture {
    if (ringTex) return ringTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.stroke();
    ringTex = new THREE.CanvasTexture(c);
    return ringTex;
}

function rings(pos: number[], color: THREE.Color, size: number, opacity: number): THREE.Points {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
        color, size, sizeAttenuation: true, map: ringTexture(), transparent: true, opacity, depthWrite: false, alphaTest: 0.05,
    }));
    pts.renderOrder = 4;
    return pts;
}

// Tinted billboard labels from the scene's glyph atlas, nudged just BELOW each node on screen (the
// scene's own white labels sit above it), so a cell's sheet spelling reads even where the node is hidden.
const LABEL_VS = /* glsl */`
attribute vec2 labelOffset;
attribute float labelOpacity;
attribute vec3 labelColor;
varying vec2 vUv;
varying float vOpacity;
varying vec3 vColor;
void main() {
    vUv = uv; vOpacity = labelOpacity; vColor = labelColor;
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    viewPos.xy += labelOffset;
    gl_Position = projectionMatrix * viewPos;
}`;
const LABEL_FS = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
varying float vOpacity;
varying vec3 vColor;
void main() {
    vec4 t = texture2D(map, vUv);
    if (t.a < 0.01) discard;
    gl_FragColor = vec4(vColor * t.rgb, t.a * vOpacity);
}`;

function labelMesh(items: LabelItem[], atlas: LabelSource): THREE.Mesh {
    const ok = items.map(i => ({ i, e: atlas.getEntry(i.label) })).filter(x => x.e);
    const n = ok.length;
    const pos = new Float32Array(n * 12), off = new Float32Array(n * 8), uv = new Float32Array(n * 8);
    const op = new Float32Array(n * 4), col = new Float32Array(n * 12), idx = new Uint32Array(n * 6);
    const hw = 0.26, hh = 0.13, dy = -0.27;
    const q: [number, number][] = [[-hw, dy - hh], [hw, dy - hh], [hw, dy + hh], [-hw, dy + hh]];
    const quv: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    ok.forEach(({ i, e }, k) => {
        for (let v = 0; v < 4; v++) {
            const j = k * 4 + v;
            pos.set([i.x, i.y, i.z], j * 3);
            off.set(q[v]!, j * 2);
            uv.set([e!.u + quv[v]![0] * e!.w, e!.v + quv[v]![1] * e!.h], j * 2);
            op[j] = i.opacity;
            col.set([i.color.r, i.color.g, i.color.b], j * 3);
        }
        idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('labelOffset', new THREE.BufferAttribute(off, 2));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('labelOpacity', new THREE.BufferAttribute(op, 1));
    g.setAttribute('labelColor', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
        uniforms: { map: { value: atlas.texture } }, vertexShader: LABEL_VS, fragmentShader: LABEL_FS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    return mesh;
}

/** Free the GPU buffers of a group built above (the shared atlas and ring textures are kept). */
export function disposeSymmetricPlanes(group: THREE.Group): void {
    group.traverse(o => {
        const obj = o as THREE.Mesh;
        obj.geometry?.dispose();
        const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(m => m.dispose()); else mat?.dispose();
    });
    group.clear();
}
