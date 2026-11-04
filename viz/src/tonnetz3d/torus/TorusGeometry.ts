/**
 * Pure geometry for the torus view. Vendored from the tonnetz app (src/tonnetz/4D-torus/TorusGeometry.ts).
 */

import { FIFTHS_ORDER } from '../LatticeGeometry.js';
import type { LetterName, NoteDisplayMode } from '../types.js';
import { NoteDisplayUtils } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────

export const TAU = 2 * Math.PI;
export const R = 3.0;       // major radius (center of torus to tube center)
export const r_ = 1.2;      // minor radius (tube radius)
export const SUB = 24;       // triangle subdivision count
export const EDGE_SEGS = 48; // edge interpolation segments

export type TriadQuality = 'major' | 'minor' | 'diminished' | 'augmented' | 'flat5' | 'aug6';

export interface TorusColor {
    hex: number;
    css: string;
    r: number;
    g: number;
    b: number;
}

export const COL: Record<TriadQuality, TorusColor> = {
    major:      { hex: 0xecc050, css: '#ecc050', r: 0.93, g: 0.75, b: 0.31 },
    minor:      { hex: 0x7eaad8, css: '#7eaad8', r: 0.49, g: 0.67, b: 0.85 },
    diminished: { hex: 0xd07090, css: '#d07090', r: 0.82, g: 0.44, b: 0.56 },
    augmented:  { hex: 0xc8e6c9, css: '#c8e6c9', r: 0.78, g: 0.90, b: 0.79 },
    flat5:      { hex: 0xf25c4c, css: '#f25c4c', r: 0.95, g: 0.36, b: 0.50 },
    aug6:       { hex: 0xf5be9e, css: '#f5be9e', r: 0.96, g: 0.75, b: 0.62 },
};

// ── Small helpers ────────────────────────────────────────────────────

export function mod(n: number, m: number): number {
    return ((n % m) + m) % m;
}

export function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

// ── Torus parametric surface ─────────────────────────────────────────

/** Map lattice (x, y) to torus angles (theta, phi) via the (2, -1) winding. */
export function latticeToAngles(x: number, y: number): { theta: number; phi: number } {
    return {
        theta: (4 * Math.PI / 7) * x + (6 * Math.PI / 7) * y,
        phi:  -(2 * Math.PI / 7) * x + (4 * Math.PI / 7) * y,
    };
}

/** Parametric torus surface position. */
export function torusPos(theta: number, phi: number, rTube: number = r_): [number, number, number] {
    return [
        (R + rTube * Math.cos(phi)) * Math.cos(theta),
        rTube * Math.sin(phi),
        (R + rTube * Math.cos(phi)) * Math.sin(theta),
    ];
}

/** Torus surface outward normal (unit-length on a circular torus). */
export function torusNrm(theta: number, phi: number): [number, number, number] {
    return [
        Math.cos(phi) * Math.cos(theta),
        Math.sin(phi),
        Math.cos(phi) * Math.sin(theta),
    ];
}

// ── Note / accidental helpers ────────────────────────────────────────

export type LetterAccidentals = Record<LetterName, number>;

export function defaultLetterAccidentals(): LetterAccidentals {
    return { F: 0, C: 0, G: 0, D: 0, A: 0, E: 0, B: 0 } as LetterAccidentals;
}

/** Accidental level for a fifths-chain position. */
export function levelFromX(
    x: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
): number {
    const naturalPos = baseWindowStart + mod(x - baseWindowStart, 7);
    const octaves = (x - naturalPos) / 7;
    if (octaves !== 0) return octaves;
    return letterAccidentals[FIFTHS_ORDER[mod(x, 7)] as LetterName] || 0;
}

/** Effective tube radius for a given accidental level. */
export function rEffFromLevel(level: number, d: number): number {
    return Math.max(0.01, r_ + d * level);
}

/** Effective tube radius for a fifths-chain position. */
export function rEff(x: number, baseWindowStart: number, letterAccidentals: LetterAccidentals, d: number): number {
    return rEffFromLevel(levelFromX(x, baseWindowStart, letterAccidentals), d);
}

/** MIDI pitch class (0-11) from a fifths-chain position. */
export function pcFromFifthIndex(
    x: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
): number {
    const naturalPC = mod(5 + 7 * x, 12);
    if (x >= baseWindowStart && x <= baseWindowStart + 6) {
        const letter = FIFTHS_ORDER[mod(x, 7)] as LetterName;
        return mod(naturalPC + (letterAccidentals[letter] || 0), 12);
    }
    return naturalPC;
}

/** Display name (e.g. "C", "F♯", "B♭") from a fifths-chain position. */
export function nameFromFifthIndex(
    x: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
    displayMode: NoteDisplayMode = 'letter',
): string {
    const letter = FIFTHS_ORDER[mod(x, 7)] as LetterName;
    const absOctaves = Math.floor((x - mod(x, 7)) / 7);
    if (x >= baseWindowStart && x <= baseWindowStart + 6) {
        const acc = (letterAccidentals[letter] || 0) + absOctaves;
        return NoteDisplayUtils.toDisplayName(letter, displayMode, true, acc);
    }
    return NoteDisplayUtils.toDisplayName(letter, displayMode, true, absOctaves);
}

/** Triad suffix for display. */
export function triadSuffix(type: TriadQuality, displayMode: NoteDisplayMode = 'letter'): string {
    const solfegeDot = displayMode === 'solfege' || displayMode === 'solfege_english';
    if (type === 'major') return 'maj';
    if (type === 'minor') return solfegeDot ? 'm.' : 'm';
    if (type === 'diminished') return '\u00b0';
    if (type === 'augmented') return '+';
    if (type === 'flat5') return '(\u266d5)';
    if (type === 'aug6') return 'aug6';
    return '?';
}

// ── Triad quality classification ─────────────────────────────────────

export function triadQualityFromPCs(
    rootX: number,
    thirdX: number,
    fifthX: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
): TriadQuality | null {
    const root = pcFromFifthIndex(rootX, baseWindowStart, letterAccidentals);
    const i3 = mod(pcFromFifthIndex(thirdX, baseWindowStart, letterAccidentals) - root, 12);
    const i5 = mod(pcFromFifthIndex(fifthX, baseWindowStart, letterAccidentals) - root, 12);
    if (i3 === 4 && i5 === 7) return 'major';
    if (i3 === 3 && i5 === 7) return 'minor';
    if (i3 === 3 && i5 === 6) return 'diminished';
    if (i3 === 4 && i5 === 8) {
        if (mod(fifthX - rootX, 7) === 1) return 'augmented';
        return null;
    }
    if (i3 === 4 && i5 === 6) return 'flat5';
    if (i3 === 4 && i5 === 10) return 'aug6';
    return null;
}

// ── Domain / face builders ───────────────────────────────────────────

export interface TorusNote {
    x: number;
    name: string;
    level: number;
    isBase: boolean;
}

export interface TorusFace {
    verts: [number, number][];       // 3 lattice-space vertices: [fifthsIndex, row]
    cornerLevels: number[];          // accidental level at each corner
    notes: string[];                 // display names of the 3 notes
    rootX: number;                   // fifths index of the root
    quality: TriadQuality;
    labelLattice: { x: number; y: number };
    isDiatonicShell: boolean;
    side?: 'sharp' | 'flat';
    name?: string;
    groupKey?: string;
    isBase?: boolean;
    // MIDI PCs of the 3 notes (root, third, fifth by fifths index)
    pcs?: number[];
    // Fifths-chain indices for the 3 notes (for color computation)
    fifthsIndices?: number[];
}

function wrapToBaseWindow(x: number, baseWindowStart: number): number {
    return baseWindowStart + mod(x - baseWindowStart, 7);
}

function isUpperFace(face: TorusFace): boolean {
    return (face.verts[0][1] + face.verts[1][1] + face.verts[2][1]) / 3 < 0.5;
}

function preferUpperForChord(face: TorusFace): boolean {
    return face.quality === 'minor' || face.quality === 'diminished';
}

export function buildFifthsDomain(
    left: number,
    right: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
    displayMode: NoteDisplayMode = 'letter',
): TorusNote[] {
    const notes: TorusNote[] = [];
    for (let x = left; x <= right; x++) {
        notes.push({
            x,
            name: nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode),
            level: levelFromX(x, baseWindowStart, letterAccidentals),
            isBase: x >= baseWindowStart && x <= baseWindowStart + 6,
        });
    }
    return notes;
}

export function buildFacesForRange(
    left: number,
    right: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
    showSingleFace: boolean = false,
    displayMode: NoteDisplayMode = 'letter',
): TorusFace[] {
    const faces: TorusFace[] = [];
    const hasFullWindow = (right - left) >= 6 && left <= baseWindowStart && right >= baseWindowStart + 6;

    // Helper to compute PCs for a face
    function facePCs(rootX: number, thirdX: number, fifthX: number): number[] {
        return [rootX, thirdX, fifthX].map(x => pcFromFifthIndex(x, baseWindowStart, letterAccidentals));
    }

    // 1) Full wrapped diatonic shell
    if (hasFullWindow) {
        for (let j = baseWindowStart; j <= baseWindowStart + 6; j++) {
            const upRoot = wrapToBaseWindow(j, baseWindowStart);
            const upThird = wrapToBaseWindow(j + 4, baseWindowStart);
            const upFifth = wrapToBaseWindow(j + 1, baseWindowStart);
            const upQuality = triadQualityFromPCs(upRoot, upThird, upFifth, baseWindowStart, letterAccidentals);
            if (upQuality) {
                faces.push({
                    verts: [[j, 0], [j - 1, 1], [j + 1, 0]],
                    cornerLevels: [levelFromX(upRoot, baseWindowStart, letterAccidentals), levelFromX(upThird, baseWindowStart, letterAccidentals), levelFromX(upFifth, baseWindowStart, letterAccidentals)],
                    notes: [upRoot, upThird, upFifth].map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
                    rootX: upRoot,
                    quality: upQuality,
                    labelLattice: { x: (j + (j - 1) + (j + 1)) / 3, y: (0 + 1 + 0) / 3 },
                    isDiatonicShell: true,
                    pcs: facePCs(upRoot, upThird, upFifth),
                });
            }

            const downRoot = wrapToBaseWindow(j + 4, baseWindowStart);
            const downThird = wrapToBaseWindow(j + 1, baseWindowStart);
            const downFifth = wrapToBaseWindow(j - 2, baseWindowStart);
            const downQuality = triadQualityFromPCs(downRoot, downThird, downFifth, baseWindowStart, letterAccidentals);
            if (downQuality) {
                faces.push({
                    verts: [[j - 1, 1], [j, 1], [j + 1, 0]],
                    cornerLevels: [levelFromX(downRoot, baseWindowStart, letterAccidentals), levelFromX(downFifth, baseWindowStart, letterAccidentals), levelFromX(downThird, baseWindowStart, letterAccidentals)],
                    notes: [downRoot, downThird, downFifth].map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
                    rootX: downRoot,
                    quality: downQuality,
                    labelLattice: { x: ((j - 1) + j + (j + 1)) / 3, y: (1 + 1 + 0) / 3 },
                    isDiatonicShell: true,
                    pcs: facePCs(downRoot, downThird, downFifth),
                });
            }

            // Cross-layer triangle
            const crossRoot = wrapToBaseWindow(j, baseWindowStart);
            const crossB = wrapToBaseWindow(j + 4, baseWindowStart);
            const crossC = wrapToBaseWindow(j + 3, baseWindowStart);
            const crossQuality = triadQualityFromPCs(crossRoot, crossB, crossC, baseWindowStart, letterAccidentals);
            if (crossQuality) {
                const crossPCs = facePCs(crossRoot, crossB, crossC);
                faces.push({
                    verts: [[j, 0], [j - 1, 1], [j - 2, 1]],
                    cornerLevels: [levelFromX(crossRoot, baseWindowStart, letterAccidentals), levelFromX(crossB, baseWindowStart, letterAccidentals), levelFromX(crossC, baseWindowStart, letterAccidentals)],
                    notes: [crossRoot, crossB, crossC].map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
                    rootX: crossRoot,
                    quality: crossQuality,
                    labelLattice: { x: (j + (j - 1) + (j - 2)) / 3, y: (0 + 1 + 1) / 3 },
                    isDiatonicShell: true,
                    pcs: crossPCs,
                });
                faces.push({
                    verts: [[j + 3, 0], [j + 4, 0], [j + 2, 1]],
                    cornerLevels: [levelFromX(crossC, baseWindowStart, letterAccidentals), levelFromX(crossB, baseWindowStart, letterAccidentals), levelFromX(crossRoot, baseWindowStart, letterAccidentals)],
                    notes: [crossRoot, crossB, crossC].map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
                    rootX: crossRoot,
                    quality: crossQuality,
                    labelLattice: { x: ((j + 3) + (j + 4) + (j + 2)) / 3, y: (0 + 0 + 1) / 3 },
                    isDiatonicShell: true,
                    pcs: crossPCs,
                });
            }
        }
    }

    function inRange(x: number): boolean {
        return x >= left && x <= right;
    }

    function addExtensionChord(rootX: number, thirdX: number, quality: TriadQuality): void {
        const fifthX = rootX + 1;
        const chordXs = [rootX, thirdX, fifthX];
        if (!chordXs.every(x => inRange(x))) return;
        if (triadQualityFromPCs(rootX, thirdX, fifthX, baseWindowStart, letterAccidentals) !== quality) return;
        const allInBaseWindow = chordXs.every(x => x >= baseWindowStart && x <= baseWindowStart + 6);
        if (hasFullWindow && allInBaseWindow) return;

        const maxIdx = Math.max(...chordXs);
        const minIdx = Math.min(...chordXs);
        const side: 'sharp' | 'flat' = maxIdx > baseWindowStart + 6 ? 'sharp' : (minIdx < baseWindowStart ? 'flat' : 'sharp');
        const extPCs = facePCs(rootX, thirdX, fifthX);

        faces.push({
            verts: [[rootX, 0], [rootX - 1, 1], [rootX + 1, 0]],
            cornerLevels: [levelFromX(rootX, baseWindowStart, letterAccidentals), levelFromX(thirdX, baseWindowStart, letterAccidentals), levelFromX(fifthX, baseWindowStart, letterAccidentals)],
            notes: chordXs.map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
            rootX,
            quality,
            labelLattice: { x: rootX, y: 1 / 3 },
            isDiatonicShell: false,
            side,
            pcs: extPCs,
        });

        const wrapShift = 7 * Math.round((baseWindowStart + 3 - (rootX - 4)) / 7);
        const d0 = rootX - 5 + wrapShift;
        const d1 = rootX - 4 + wrapShift;
        const d2 = rootX - 3 + wrapShift;
        faces.push({
            verts: [[d0, 1], [d1, 1], [d2, 0]],
            cornerLevels: [levelFromX(rootX, baseWindowStart, letterAccidentals), levelFromX(fifthX, baseWindowStart, letterAccidentals), levelFromX(thirdX, baseWindowStart, letterAccidentals)],
            notes: chordXs.map(x => nameFromFifthIndex(x, baseWindowStart, letterAccidentals, displayMode)),
            rootX,
            quality,
            labelLattice: { x: (d0 + d1 + d2) / 3, y: 2 / 3 },
            isDiatonicShell: false,
            side,
            pcs: extPCs,
        });
    }

    // 2) Extension faces
    for (let rootX = left; rootX <= right; rootX++) {
        addExtensionChord(rootX, rootX + 4, 'major');
        addExtensionChord(rootX, rootX - 3, 'minor');
    }

    // Single-face mode: pick one representative per chord
    if (showSingleFace) {
        const grouped = new Map<string, TorusFace[]>();
        faces.forEach(face => {
            const key = `${face.rootX}:${face.quality}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(face);
        });
        const singleFaces: TorusFace[] = [];
        grouped.forEach(group => {
            const preferUpper = preferUpperForChord(group[0]);
            const pick = group.find(face => isUpperFace(face) === preferUpper) || group[0];
            singleFaces.push(pick);
        });
        faces.length = 0;
        faces.push(...singleFaces);
    }

    // Annotate each face with name and groupKey
    faces.forEach(face => {
        const sep = displayMode === 'letter' || displayMode === 'letter_german' ? '' : ' ';
        face.name = `${nameFromFifthIndex(face.rootX, baseWindowStart, letterAccidentals, displayMode)}${sep}${triadSuffix(face.quality, displayMode)}`;
        face.groupKey = `${face.rootX}:${face.quality}`;
        face.isBase = face.rootX >= baseWindowStart && face.rootX <= baseWindowStart + 6;
    });

    return faces;
}

// ── Triangle mesh subdivision ────────────────────────────────────────

export interface LatticePoint {
    lx: number;
    ly: number;
    theta: number;
    phi: number;
    bary: [number, number, number];
}

export interface SubdividedMesh {
    positions: number[];   // flat xyz array
    normals: number[];     // flat xyz array
    indices: number[];     // triangle index array
    lattice: LatticePoint[];
}

export function buildInnerTriMesh(verts: [number, number][], sub: number = SUB): SubdividedMesh {
    const [v0, v1, v2] = verts;
    // Check 2D lattice winding
    const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1];
    const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1];
    const flip = (e1x * e2y - e1y * e2x) > 0;

    const positions: number[] = [];
    const normals: number[] = [];
    const lattice: LatticePoint[] = [];
    const grid: number[][] = [];

    for (let i = 0; i <= sub; i++) {
        grid[i] = [];
        for (let j = 0; j <= sub - i; j++) {
            const u = i / sub;
            const v = j / sub;
            const w = 1 - u - v;
            const lx = w * v0[0] + u * v1[0] + v * v2[0];
            const ly = w * v0[1] + u * v1[1] + v * v2[1];
            const a = latticeToAngles(lx, ly);
            positions.push(0, 0, 0);
            normals.push(0, 1, 0);
            lattice.push({ lx, ly, theta: a.theta, phi: a.phi, bary: [w, u, v] });
            grid[i].push(positions.length / 3 - 1);
        }
    }

    const indices: number[] = [];
    for (let i = 0; i < sub; i++) {
        for (let j = 0; j < sub - i; j++) {
            if (flip) {
                indices.push(grid[i][j], grid[i][j + 1], grid[i + 1][j]);
                if (j < sub - i - 1) indices.push(grid[i + 1][j], grid[i][j + 1], grid[i + 1][j + 1]);
            } else {
                indices.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
                if (j < sub - i - 1) indices.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
            }
        }
    }

    return { positions, normals, indices, lattice };
}

// ── Ghost tube geometry ──────────────────────────────────────────────

export function createGhostHornVertices(
    leftBound: number,
    rightBound: number,
    baseWindowStart: number,
    letterAccidentals: LetterAccidentals,
    d: number,
    shaftWidth: number = 1,
): { positions: number[]; indices: number[] } {
    const tubeSegs = 48;
    const xMin = leftBound - 1;
    const xMax = rightBound + 1;
    const xRange = Math.max(0.5, xMax - xMin);
    const totalSegs = Math.max(16, Math.round(128 * xRange / 7));
    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= totalSegs; i++) {
        const x = xMin + (i / totalSegs) * xRange;
        const theta = (4 * Math.PI / 7) * x;
        const localR = rEff(x, baseWindowStart, letterAccidentals, d);
        for (let j = 0; j <= tubeSegs; j++) {
            const phi = (j / tubeSegs) * TAU;
            const pos = torusPos(theta, phi, localR * shaftWidth);
            positions.push(pos[0], pos[1], pos[2]);
        }
    }

    for (let i = 0; i < totalSegs; i++) {
        for (let j = 0; j < tubeSegs; j++) {
            const a = i * (tubeSegs + 1) + j;
            const b = a + tubeSegs + 1;
            indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
    }

    return { positions, indices };
}

// ── Edge helpers ─────────────────────────────────────────────────────

export interface EdgeCoord {
    lx: number;
    ly: number;
    theta: number;
    phi: number;
    level: number;
}

export function buildEdgeCoords(
    a: [number, number],
    b: [number, number],
    levelA: number,
    levelB: number,
    segs: number = EDGE_SEGS,
): EdgeCoord[] {
    const coords: EdgeCoord[] = [];
    for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const lx = a[0] + (b[0] - a[0]) * t;
        const ly = a[1] + (b[1] - a[1]) * t;
        const level = levelA + (levelB - levelA) * t;
        const ang = latticeToAngles(lx, ly);
        coords.push({ lx, ly, theta: ang.theta, phi: ang.phi, level });
    }
    return coords;
}
