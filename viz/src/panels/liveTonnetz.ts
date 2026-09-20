import { LiveSpeller, connectLiveInput, type LiveState } from '../live.js';
import type { Snapshot } from '../replay.js';
import { selectSevenNodeLoF } from '../tonnetzLine.js';
import { PitchClass } from '../tonnetz3d/core/PitchClass.js';
import { classifyTriad } from '../tonnetz3d/LatticeGeometry.js';

const LETTER_COLOR: Record<string, string> = {
    C: '#cb6a62', G: '#e0975a', D: '#cdb45c', A: '#6fb389',
    E: '#5aa79b', B: '#6f95c4', F: '#9c78bd',
};
const LOF: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const LOF_LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const SCALE_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pcOf = (midi: number) => ((midi % 12) + 12) % 12;
const spellingKey = (p: { step: string; alter: number }) => `${p.step}:${p.alter}`;
const glyph = (alter: number) => alter === 0 ? '' : alter === 1 ? '♯' : alter === -1 ? '♭' : alter === 2 ? '𝄪' : '𝄫';
const textOn = (hex: string) => {
    const n = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * n[0]! + 0.587 * n[1]! + 0.114 * n[2]! > 150 ? '#222' : '#fff';
};

/**
 * Debug coordinate contract for the live coiled Tonnetz.
 *
 *   (x, y, z) identifies a node, with C at (0, 0, 0):
 *   - x is the central line-of-fifths spiral: F=(-1,0,0), G=(1,0,0),
 *     and the C# seven positions away is (7,0,0).
 *   - y is the major-third / thirds direction: E next to C is (0,1,0).
 *   - z is the accidental-layer direction: C# next to C is (0,0,1).
 *
 * The node's spelling is determined by n = x + 4*y + 7*z, then `pitchAt(n)`
 * converts that extended line-of-fifths position to a letter and accidental.
 * Keep this comment next to the coordinate labels: agents can use a reported
 * (x,y,z) to locate the exact node and understand its intended note identity.
 */
function pitchAt(n: number): { step: string; alter: number } {
    const step = LOF_LETTERS[((n % 7) + 7) % 7]!;
    return { step, alter: Math.round((n - LOF[step]!) / 7) };
}
function labelAt(n: number): string { const p = pitchAt(n); return p.step + glyph(p.alter); }

// The central fifths spiral runs through B♯ at x=12 (B=5 plus one accidental turn).
const W = 940, H = 700, CX = 470, CY = 350, XLO = -8, XHI = 12;
const LIVE_COORDS_KEY = 'enharmonic.live.coordinates';
const LIVE_COLLAPSE_Z_KEY = 'enharmonic.live.collapseZ';
const LIVE_Z_ROTATION_KEY = 'enharmonic.live.zRotation';
function loadToggle(key: string, fallback: boolean): boolean {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value === '1';
    } catch { return fallback; }
}
function saveToggle(key: string, value: boolean): void {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* storage blocked */ }
}
function loadSlider(key: string, fallback: number): number {
    try {
        const value = Number(localStorage.getItem(key));
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
    } catch { return fallback; }
}
function saveSlider(key: string, value: number): void {
    try { localStorage.setItem(key, String(value)); } catch { /* storage blocked */ }
}
function loadNumber(key: string, fallback: number, min: number, max: number): number {
    try {
        const value = Number(localStorage.getItem(key));
        return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    } catch { return fallback; }
}
function saveNumber(key: string, value: number): void {
    try { localStorage.setItem(key, String(value)); } catch { /* storage blocked */ }
}
function raw(x: number, y: number, z: number): [number, number] {
    // Geometry follows the same coordinate contract above. x winds around the
    // central spiral, y offsets the two thirds spirals, and z offsets the flat/
    // sharp copies. This is only the screen projection; note identity is n.
    const angle = (-90 + 30 * x + 15 * y) * Math.PI / 180;
    const radius = 104 + 8 * (x - XLO) + 26 * y;
    const za = angle + Math.PI / 6 + zRotationDegrees * Math.PI / 180;
    return [CX + radius * Math.cos(angle) + z * 18 * Math.cos(za),
        CY + radius * Math.sin(angle) + z * 18 * Math.sin(za)];
}
let collapseZProjection = 0;
let zRotationDegrees = 0;
function pos(x: number, y: number, z: number): [number, number] {
    // Keep sparse z/thirds vertices on their semantic side of the z=0 home node.
    // In particular, the dynamic aug6 vertex (2,1,-1) belongs on the negative-z side.
    // collapseZProjection continuously interpolates from the fully collapsed z=0
    // projection (0) to the normal z projection (1); the slider direction is intentional.
    return raw(x, y, z * collapseZProjection);
}
function pcPoint(k: number, radius: number): [number, number] {
    const a = (-90 + 30 * k) * Math.PI / 180;
    return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}
type Point = [number, number];

/** A gently bowed connection for the curved Tonnetz treatment used by the lab. */
function curve(a: Point, b: Point, bend: number, attrs: string): string {
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const cx = mx - (dy / length) * bend;
    const cy = my + (dx / length) * bend;
    return `<path d="M${a[0].toFixed(1)} ${a[1].toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}" fill="none" ${attrs}/>`;
}

/** Convert sampled spiral points into one smooth cubic Bézier path rather than a polyline. */
function smoothPath(points: Point[], attrs: string): string {
    if (points.length < 2) return '';
    let d = `M${points[0]![0].toFixed(1)} ${points[0]![1].toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)]!;
        const p1 = points[i]!;
        const p2 = points[i + 1]!;
        const p3 = points[Math.min(points.length - 1, i + 2)]!;
        const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return `<path d="${d}" fill="none" ${attrs}/>`;
}
function rowPath(y: number, attrs: string): string {
    const points = Array.from({ length: XHI - XLO + 1 }, (_, i) => pos(XLO + i, y, 0));
    return smoothPath(points, attrs);
}

const TRIAD_FALLBACK: Record<string, string> = {
    major: '#ffcc80', minor: '#abcefb', diminished: '#f8bbd9', augmented: '#c8e6c9',
    flat5: '#f295c4', aug6: '#f5be9e', aug3: '#b39ddb', dim3: '#80cbc4',
};
const MAJOR_HUE_LOW = 65, MAJOR_HUE_HIGH = 10;
const MINOR_HUE_LOW = 197, MINOR_HUE_HIGH = 236;
function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Keep isolated/faint nodes solid, but turn their letter colour into a very light pastel. */
function pastelize(hex: string, saturation = 0.22): string {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), originalLightness = (max + min) / 2;
    if (max === min) return hex;
    const chroma = max - min;
    const lightness = Math.max(originalLightness, 0.84);
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const hue = max === r ? (g - b) / chroma + (g < b ? 6 : 0)
        : max === g ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
    const hueToRgb = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    // Use the original hue/lightness, with the requested low saturation.
    const h = hue / 6;
    const rgb = [hueToRgb(h + 1 / 3), hueToRgb(h), hueToRgb(h - 1 / 3)];
    return `#${rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

function triangleColor(type: string, notes: { step: string; alter: number }[], filled: Set<string>): string {
    if ((type === 'major' || type === 'minor') && notes.length === 3) {
        const scale = [...filled].map(k => k.split(':').map(Number))
            .filter(([, y, z]) => y === 0 && z === 0).map(([x]) => x!);
        const min = Math.min(...scale), max = Math.max(...scale);
        if (scale.length > 1 && max > min) {
            const mean = notes.reduce((sum, n) => sum + (LOF[n.step]! + 7 * n.alter), 0) / 3;
            const t = Math.max(0, Math.min(1, (mean - min) / (max - min)));
            return type === 'major'
                ? hslToHex(MAJOR_HUE_LOW + t * (MAJOR_HUE_HIGH - MAJOR_HUE_LOW), 100, 75)
                : hslToHex(MINOR_HUE_LOW + t * (MINOR_HUE_HIGH - MINOR_HUE_LOW), 90, 80);
        }
    }
    return TRIAD_FALLBACK[type] ?? '#abcefb';
}

function trianglePath(cells: [number, number, number][]): string {
    const points = cells.map(c => pos(...c));
    const centre: Point = [
        points.reduce((sum, p) => sum + p[0], 0) / points.length,
        points.reduce((sum, p) => sum + p[1], 0) / points.length,
    ];
    let d = `M${points[0]![0].toFixed(1)} ${points[0]![1].toFixed(1)}`;
    for (let i = 0; i < points.length; i++) {
        const a = points[i]!, b = points[(i + 1) % points.length]!;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        // The old 0.18 factor was visually almost flat at this scale.  Use a real
        // inward bow so a face edge follows the same rounded language as the spiral
        // rows instead of reading as a straight polygon edge.
        const cx = mx + (centre[0] - mx) * 0.62;
        const cy = my + (centre[1] - my) * 0.62;
        d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
    }
    return `${d}Z`;
}

function scaleBadges(spellings: { step: string; alter: number }[]): string {
    const byLetter = new Map(spellings.map(p => [p.step, p]));
    return SCALE_LETTERS.map(letter => {
        const spelling = byLetter.get(letter);
        const label = spelling ? labelAt(LOF[letter]! + 7 * spelling.alter) : letter;
        const color = LETTER_COLOR[letter]!;
        const empty = spelling ? '' : ' empty';
        return `<div class="live-scale-cell" style="--scale-color:${color}"><button type="button" class="live-scale-adjust" data-step="${letter}" data-delta="1" aria-label="raise ${letter}">▲</button><span class="live-scale-badge${empty}" aria-label="${esc(label)}">${esc(label)}</span><button type="button" class="live-scale-adjust" data-step="${letter}" data-delta="-1" aria-label="lower ${letter}">▼</button></div>`;
    }).join('');
}

function renderSvg(s: LiveState, showCoords: boolean, collapseZ: number): string {
    collapseZProjection = collapseZ;
    const filled = new Set(s.filledCells);
    const held = new Set(s.heldPCs);
    const heldSpellings = new Set(s.heldSpellings);
    const centralFilled = new Set([...filled].map(k => k.split(':').map(Number))
        .filter(([, y, z]) => y === 0 && z === 0).map(([x]) => x!));
    // The active line of fifths is a graph, never a preference for natural spellings.
    // Prefer a continuous seven-position line using one active representation of each
    // scale spelling. This lets D melodic minor use C# at x=0,z=1 and C double harmonic
    // major use D♭/A♭ at x=2/3,z=-1, rather than their detached direct-central copies.
    const sevenNodeBackbone = s.backboneCells.length
        ? new Set(s.backboneCells)
        : selectSevenNodeLoF(filled);
    // Fallback for incomplete collections: retain the previous largest connected direct/z
    // component so individual live notes still have a sensible local prominence rule.
    const lofByX = new Map<number, string>();
    for (const x of centralFilled) lofByX.set(x, `${x}:0:0`);
    for (const key of filled) {
        const [x, y, z] = key.split(':').map(Number) as [number, number, number];
        if (y === 0 && z !== 0 && !centralFilled.has(x)
            && centralFilled.has(x - 1) && centralFilled.has(x + 1)) {
            lofByX.set(x, key);
        }
    }
    const lofComponents: string[][] = [];
    const unseenLoF = new Set(lofByX.keys());
    while (unseenLoF.size) {
        const start = unseenLoF.values().next().value as number;
        const component: string[] = [];
        const queue = [start];
        unseenLoF.delete(start);
        while (queue.length) {
            const x = queue.shift()!;
            component.push(lofByX.get(x)!);
            for (const next of [x - 1, x + 1]) {
                if (unseenLoF.delete(next)) queue.push(next);
            }
        }
        lofComponents.push(component);
    }
    const backboneLoF = new Set(sevenNodeBackbone ?? lofComponents.reduce<string[]>((largest, component) =>
        component.length > largest.length ? component : largest, []));
    const p: string[] = [`<svg class="live-tonnetz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="live coiled Tonnetz">`,
        `<rect width="${W}" height="${H}" fill="#fff"/>`];
    for (let k = 0; k < 12; k++) {
        const a = pcPoint(k, 45), b = pcPoint(k, 290);
        p.push(curve(a, b, k % 2 ? 9 : -9, `stroke="${held.has((7 * k) % 12) ? '#6ea8fe' : '#383e49'}" stroke-width="${held.has((7 * k) % 12) ? 1.8 : 0.7}"`));
    }
    for (const y of [-1, 0, 1]) p.push(rowPath(y, `stroke="${y === 0 ? '#747c89' : '#424955'}" stroke-width="${y === 0 ? 1.2 : 0.75}"`));
    for (let x = XLO; x <= XHI; x++) for (const y of [-1, 0]) {
        p.push(curve(pos(x, y, 0), pos(x, y + 1, 0), 3.5, 'stroke="#343a45" stroke-width="0.55"'));
        p.push(curve(pos(x, y + 1, 0), pos(x + 1, y, 0), -3.5, 'stroke="#343a45" stroke-width="0.55"'));
    }
    // The same triangular tiling as the Tonnetz: two flat triangles per cell, plus the two
    // cross-layer forms that become diminished/augmented (and later aug6/dim5) when z cells activate.
    const triangles: [string, [number, number, number][], boolean][] = [];
    for (let x = XLO; x < XHI; x++) for (const y of [-1, 0]) {
        triangles.push(['flat', [[x, y, 0], [x + 1, y, 0], [x, y + 1, 0]], true]);
        triangles.push(['flat', [[x + 1, y, 0], [x, y + 1, 0], [x + 1, y + 1, 0]], true]);
    }
    for (let x = XLO; x < XHI; x++) {
        triangles.push(['cross', [[x, 0, 0], [x + 1, -1, 0], [x + 1, 0, -1]], true]);
        triangles.push(['cross', [[x, 0, 0], [x, 1, 0], [x + 1, 0, 1]], true]);
        triangles.push(['cross', [[x + 1, 0, 0], [x, 1, 0], [x, 0, 1]], true]);
        triangles.push(['cross', [[x + 1, 0, 0], [x + 1, -1, 0], [x, 0, -1]], true]);
        triangles.push(['cross', [[x, 0, 0], [x, 1, 0], [x + 1, 0, -1]], true]);
        triangles.push(['cross', [[x - 1, 1, 0], [x, 0, -1], [x, 1, -1]], true]);
        // Opposite-side companion for a repaired z=+1 LoF gap: A–F–D# when
        // A=(x+1,0,0), F=(x+1,-1,0), and D#=(x,0,1).
        triangles.push(['hidden', [[x + 1, 0, 0], [x + 1, -1, 0], [x, 0, 1]], true]);
        // Upper companion around the same z-sibling: B–F#–D# when
        // B=(x-1,1,0), F#=(x,1,0), and D#=(x,0,1).
        triangles.push(['hidden', [[x - 1, 1, 0], [x, 1, 0], [x, 0, 1]], true]);
        // Sparse hidden-layer continuation: once an aug6 face reveals its thirds/Z vertex,
        // this local face reconnects that bridge to its same-layer neighbour.
        triangles.push(['hidden', [[x, 0, -1], [x, 1, -1], [x + 1, 0, -1]], true]);
        // Minor face F–A♭–C in the altered C-major surface:
        // F=(x,-1,0), A♭=(x,0,-1), C=(x+1,-1,0), for x=3.
        triangles.push(['hidden', [[x, -1, 0], [x, 0, -1], [x + 1, -1, 0]], true]);
    }
    // `connected` alone is not enough to decide prominence: an island can form a valid
    // local face with its thirds copies without joining the selected line of fifths.
    // Record only faces supported by an LoF-backbone vertex.
    // Every selected LoF position is prominent, even if it has no filled triangle yet.
    const backboneConnected = new Set<string>(backboneLoF);
    for (const [, cells] of triangles) {
        if (!cells.every(c => filled.has(`${c[0]}:${c[1]}:${c[2]}`))) continue;
        const notes = cells.map(([x, y, z]) => pitchAt(x + 4 * y + 7 * z));
        const pcs = notes.map(n => new PitchClass(n.step as any, n.alter));
        const type = classifyTriad(pcs[0]!, pcs[1]!, pcs[2]!);
        if (type === 'unknown') continue;
        const color = triangleColor(type, notes, filled);
        const sounding = cells.every(([x, y, z]) => heldSpellings.has(spellingKey(pitchAt(x + 4 * y + 7 * z))));
        const hasBackboneSupport = cells.some(([x, y, z]) => backboneLoF.has(`${x}:${y}:${z}`));
        if (hasBackboneSupport) cells.forEach(([x, y, z]) => backboneConnected.add(`${x}:${y}:${z}`));
        const faintSupport = !hasBackboneSupport;
        // A currently sounding note must not revive an otherwise disconnected island.
        const opacity = faintSupport ? 0.12 : sounding ? 0.78 : 0.42;
        const strokeWidth = faintSupport ? 0.55 : sounding ? 2.1 : 1.1;
        p.push(`<path d="${trianglePath(cells)}" fill="${color}" fill-opacity="${opacity}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`);
    }
    // The five coiled layers: three z=0 rows and the flat/sharp twins of the central row.
    const cells: [number, number, number][] = [];
    for (let x = XLO; x <= XHI; x++) for (const y of [-1, 0, 1]) cells.push([x, y, 0]);
    for (let x = XLO; x <= XHI; x++) cells.push([x, 0, -1], [x, 0, 1]);
    for (const key of filled) {
        const [x, y, z] = key.split(':').map(Number) as [number, number, number];
        if (z !== 0 && y !== 0 && x >= XLO && x <= XHI) cells.push([x, y, z]);
    }
    // When z projection is collapsed, the cells share screen coordinates.  Paint the
    // flat layer first, then the central layer, then the sharp layer: C♭ sits beneath C
    // while C♯ sits above it. Coordinate labels are still appended after every node.
    cells.sort(([, , zA], [, , zB]) => zA - zB);
    const coordLabels: string[] = [];
    // Draw every node from its semantic coordinate. The coordinate label is
    // deliberately generated from these same x/y/z values, not inferred from
    // screen position, so "(x,y,z)" in a bug report names this exact cell.
    for (const [x, y, z] of cells) {
        const [nx, ny] = pos(x, y, z); const note = pitchAt(x + 4 * y + 7 * z);
        const col = LETTER_COLOR[note.step]!; const isFilled = filled.has(`${x}:${y}:${z}`);
        const r = z === 0 && y === 0 ? 10 : z === 0 ? 8 : 6;
        // Nodes inherit prominence from the backbone-supported faces, rather than from
        // mere geometric connectedness. This makes every member of an isolated altered
        // island faint together, including its thirds-line companions.
        const faint = isFilled && !backboneConnected.has(`${x}:${y}:${z}`);
        const active = isFilled
            ? `fill="${faint ? pastelize(col) : col}" fill-opacity="1" stroke="${z !== 0 ? textOn(col) : y === 0 ? '#222' : '#fff'}" stroke-width="0.9"`
            : `fill="#fff" stroke="${col}" stroke-width="${z === -1 ? 0.45 : z === 0 && y === -1 ? 0.45 : 0.8}"`;
        p.push(`<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${r}" ${active} ${z !== 0 ? 'stroke-dasharray="2 1.6"' : ''}/>`);
        p.push(`<text x="${nx.toFixed(1)}" y="${(ny + (z === 0 ? 2.3 : 1.8)).toFixed(1)}" text-anchor="middle" font-size="${z === 0 && y === 0 ? 7.2 : z === 0 ? 6.1 : 4.8}" fill="${isFilled ? textOn(col) : col}" fill-opacity="1">${esc(labelAt(x + 4 * y + 7 * z))}</text>`);
        if (showCoords) {
            const coordY = ny + (z === 0 && y === 0 ? 16 : z === 0 ? 13 : 10);
            const coordText = `${x},${y},${z}`;
            const coordWidth = coordText.length * 2.8 + 2.5;
            coordLabels.push(`<rect class="live-coord-label-bg" x="${(nx - coordWidth / 2).toFixed(1)}" y="${(coordY - 4.5).toFixed(1)}" width="${coordWidth.toFixed(1)}" height="5.8" rx="1.2"/>`);
            coordLabels.push(`<text class="live-coord-label" x="${nx.toFixed(1)}" y="${coordY.toFixed(1)}" text-anchor="middle">${coordText}</text>`);
        }
    }
    p.push(`<circle cx="${CX}" cy="${CY}" r="39" fill="none" stroke="#4a515e" stroke-width="0.8"/>`);
    for (let k = 0; k < 12; k++) {
        const [x, y] = pcPoint(k, 39), pc = (7 * k) % 12, active = held.has(pc);
        const fill = WHITE_PC.has(pc) ? '#f7f7f4' : '#24262b';
        p.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${active ? 7.5 : 6}" fill="${fill}" stroke="${active ? '#6ea8fe' : '#555b66'}" stroke-width="${active ? 2 : 0.7}"/>`);
        p.push(`<text x="${x.toFixed(1)}" y="${(y + 2.3).toFixed(1)}" text-anchor="middle" font-size="7" fill="${WHITE_PC.has(pc) ? '#222' : '#fff'}">${pc}</text>`);
    }
    // Paint coordinates last so their white backing and text always sit above every node.
    p.push(...coordLabels);
    p.push(`<text x="${CX}" y="${CY + 3}" text-anchor="middle" font-size="7" fill="#939ba8">12 pc</text>`);
    p.push('</svg>'); return p.join('');
}

export interface LiveTonnetzController {
    /** The shared live model. Live input and playback both flow through it; the 3D panel subscribes too. */
    model: LiveSpeller;
    renderPlaybackSnapshot(snapshot: Snapshot | null): void;
}

export function initLiveTonnetz(host: HTMLElement): LiveTonnetzController {
    const model = new LiveSpeller();
    host.innerHTML = `<div class="live-header"><div class="panel-title">live coiled Tonnetz</div></div><div class="live-svg-host"></div><div class="live-scale" aria-label="current scale spelling"></div><div class="live-toolbar"><span class="live-status"></span><span class="live-last"></span><label class="live-coords-toggle"><input type="checkbox" checked /> coordinates</label><label class="live-z-slider">z spread <input type="range" min="0" max="1" step="0.01" aria-label="z spread" /></label><label class="live-z-slider">z rotation <input type="range" min="-180" max="180" step="1" aria-label="z rotation" /></label><button type="button" class="live-fullscreen">fullscreen</button><button type="button" class="live-reset">reset surface</button></div>`;
    const svgHost = host.querySelector('.live-svg-host') as HTMLElement;
    const scale = host.querySelector('.live-scale') as HTMLElement;
    scale.addEventListener('click', event => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.live-scale-adjust');
        if (!button) return;
        model.setScaleAlter(button.dataset.step!, Number(button.dataset.delta));
    });
    const status = host.querySelector('.live-status') as HTMLElement;
    const last = host.querySelector('.live-last') as HTMLElement;
    const coords = host.querySelector('.live-coords-toggle input') as HTMLInputElement;
    const zHome = host.querySelector('.live-z-slider input') as HTMLInputElement;
    const zRotation = host.querySelectorAll('.live-z-slider input')[1] as HTMLInputElement;
    coords.checked = loadToggle(LIVE_COORDS_KEY, true);
    zHome.value = String(loadSlider(LIVE_COLLAPSE_Z_KEY, 1));
    zRotation.value = String(loadNumber(LIVE_Z_ROTATION_KEY, 0, -180, 180));
    zRotationDegrees = Number(zRotation.value);
    let latestState: LiveState | null = null;
    const refreshSvg = () => { if (latestState) svgHost.innerHTML = renderSvg(latestState, coords.checked, Number(zHome.value)); };
    coords.addEventListener('change', () => { saveToggle(LIVE_COORDS_KEY, coords.checked); refreshSvg(); });
    zHome.addEventListener('input', () => { saveSlider(LIVE_COLLAPSE_Z_KEY, Number(zHome.value)); refreshSvg(); });
    zRotation.addEventListener('input', () => {
        zRotationDegrees = Number(zRotation.value);
        saveNumber(LIVE_Z_ROTATION_KEY, zRotationDegrees);
        refreshSvg();
    });
    const fullscreen = host.querySelector('.live-fullscreen') as HTMLButtonElement;
    (host.querySelector('.live-reset') as HTMLButtonElement).addEventListener('click', () => model.reset());
    const syncFullscreenLabel = () => {
        const active = document.fullscreenElement === host;
        fullscreen.textContent = active ? 'exit fullscreen' : 'fullscreen';
        fullscreen.setAttribute('aria-label', active ? 'exit fullscreen' : 'enter fullscreen');
    };
    fullscreen.addEventListener('click', () => {
        if (document.fullscreenElement === host) void document.exitFullscreen();
        else void host.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', syncFullscreenLabel);
    syncFullscreenLabel();
    model.subscribe(s => {
        latestState = s;
        scale.innerHTML = scaleBadges(s.scaleSpellings);
        svgHost.innerHTML = renderSvg(s, coords.checked, Number(zHome.value));
        status.textContent = s.midiStatus;
        last.textContent = s.lastSpelling ? `last: ${s.lastSpelling.step}${glyph(s.lastSpelling.alter)} · pc ${pcOf(s.lastMidi!)}` : 'strike a note';
    });
    connectLiveInput(model);
    return {
        model,
        renderPlaybackSnapshot(snapshot) {
            if (!snapshot) return;
            model.setPlaybackState(
                snapshot.resolvedScale ?? [
                    { step: 'C', alter: 0 }, { step: 'D', alter: 0 }, { step: 'E', alter: 0 },
                    { step: 'F', alter: 0 }, { step: 'G', alter: 0 }, { step: 'A', alter: 0 }, { step: 'B', alter: 0 },
                ],
                snapshot.sounding,
                snapshot.midi,
                snapshot.committed,
            );
        },
    };
}
