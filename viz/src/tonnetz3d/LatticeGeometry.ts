import { PitchClass } from './core/PitchClass';
import { LetterNameUtils } from './types';
import type { LetterName } from './types';

// ── Types ──────────────────────────────────────────────────────────

export interface LatticeNode {
    x: number;            // col * X_SPACING + row stagger
    y: number;            // row * Y_SPACING
    z: number;            // layer * Z_SPACING
    pc: PitchClass;
    fifthsPos: number;    // extended fifths position (...-7..0..6..13..)
    gridCol: number;      // column within the grid (0..numCols-1)
    gridRow: number;      // row (0..numRows-1)
    layer: number;
    isScaleNote: boolean;
    isEnharmonicNote: boolean;  // same MIDI PC as a scale note, different spelling
}

export interface LatticeTriangle {
    vertices: [LatticeNode, LatticeNode, LatticeNode];
    color: string;
    triadType: string;    // 'major'|'minor'|'diminished'|'augmented'|...
    tiltAngle: number;    // 0 = flat (diatonic), >0 = crosses layers
}

export interface ScalePathSegment {
    from: { x: number; y: number; z: number; pc: PitchClass };
    to: { x: number; y: number; z: number; pc: PitchClass };
    intervalType: 'P5' | 'd5' | 'A5';
    crossesLayer: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

export const X_SPACING = 1.4;   // horizontal gap between fifths-chain columns
export const Y_SPACING = X_SPACING * Math.sqrt(3) / 2;  // equilateral triangle row height ≈ 1.21
export const Z_SPACING = 0.1;   // depth gap between accidental layers

// Fifths-chain letter ordering: index 0 = F, 1 = C, ... 6 = B
export const FIFTHS_ORDER: LetterName[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

// Each row going DOWN shifts by +4 fifths positions (= major third interval).
// This produces the standard tonnetz tiling where:
//   horizontal adjacency = P5 (1 fifth step)
//   diagonal ↘ = M3 (4 fifth steps)
//   diagonal ↗ = m3 (3 fifth steps)
export const ROW_SHIFT = 4;

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Get the base fifths-chain index (0-6) for a letter name.
 */
export function fifthsIndex(letter: LetterName): number {
    return FIFTHS_ORDER.indexOf(letter);
}

/**
 * Extended fifths position for a note with accidentals.
 * Natural F = 0, C = 1, ..., B = 6.
 * F# = 7, C# = 8, ..., Bb = -1, Eb = -2, etc.
 */
export function extendedFifthsPos(letter: LetterName, accidental: number): number {
    return FIFTHS_ORDER.indexOf(letter) + accidental * 7;
}

/**
 * Convert an extended fifths-chain position to a note (letter + accidental).
 * fifthsPos 0 = F natural, 1 = C natural, ..., 6 = B natural
 * fifthsPos 7 = F#, 8 = C#, ..., -1 = Bb, -2 = Eb, etc.
 */
export function noteFromFifthsPos(fifthsPos: number): { letter: LetterName; accidental: number } {
    // JS modulo can be negative, so normalize to 0-6
    const letterIdx = ((fifthsPos % 7) + 7) % 7;
    const letter = FIFTHS_ORDER[letterIdx];
    // accidental = how many full cycles of 7 away from the base letter
    const accidental = (fifthsPos - letterIdx) / 7;
    return { letter, accidental };
}

function normPC(pc: number): number {
    return ((pc % 12) + 12) % 12;
}

// ── Node computation ───────────────────────────────────────────────

/**
 * Compute the startFifths value that centers the scale path in the grid.
 * Since each row shifts by +ROW_SHIFT fifths, we offset so the scale's
 * median fifths position lands at the center of the middle row.
 */
export function computeStartFifths(
    scaleNotes: PitchClass[],
    numCols: number,
    numRows: number,
): number {
    // Get extended fifths positions for all scale notes
    const positions = scaleNotes.map(pc => extendedFifthsPos(pc.letterName, pc.accidental));
    // Median position
    const sorted = [...positions].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Center: the middle of the grid (middleRow, middleCol) should equal the median
    const middleRow = Math.floor(numRows / 2);
    const middleCol = Math.floor(numCols / 2);
    return median - middleCol - middleRow * ROW_SHIFT;
}

/**
 * Compute 3D node positions using the self-contained fifths-chain grid.
 *
 * The grid is defined by:
 * - x-axis (cols): chain of perfect fifths. Column c has fifthsPos = startFifths + c.
 * - y-axis (rows): major third offsets. Each row down shifts by +ROW_SHIFT fifths.
 * - z-axis (layers): uniform accidental shifts. Layer +1 raises all accidentals by 1.
 *
 * The note at grid position (col, row, layer):
 *   baseFifthsPos = startFifths + col + row * ROW_SHIFT
 *   { letter, baseAccidental } = noteFromFifthsPos(baseFifthsPos)
 *   accidental = baseAccidental + layer
 *   pc = PitchClass(letter, accidental)
 */
export function computeLatticeNodes(
    scaleNotes: PitchClass[],
    numCols: number,
    numRows: number,
    startFifths: number,
    layers: number[] = [-1, 0, 1],
    zSpacing: number = Z_SPACING,
): LatticeNode[] {
    const nodes: LatticeNode[] = [];

    // Build set of active pitch classes (letter + accidental) for highlighting
    const activeSet = new Set<string>();
    const activePCSet = new Set<number>();
    for (const pc of scaleNotes) {
        activeSet.add(`${pc.letterName}:${pc.accidental}`);
        activePCSet.add(normPC(pc.midiValue));
    }

    for (const layer of layers) {
        for (let row = 0; row <= numRows; row++) {
            for (let col = 0; col <= numCols; col++) {
                const baseFifthsPos = startFifths + col + row * ROW_SHIFT;
                const { letter, accidental: baseAcc } = noteFromFifthsPos(baseFifthsPos);
                const layerAcc = baseAcc + layer;
                const pc = new PitchClass(letter, layerAcc);
                const isScaleNote = activeSet.has(`${letter}:${layerAcc}`);
                const isEnharmonicNote = !isScaleNote && activePCSet.has(normPC(pc.midiValue));

                // Each row shifts right by half a column for equilateral triangles
                const rowStagger = row * X_SPACING / 2;
                const x = col * X_SPACING + rowStagger;
                const y = row * Y_SPACING;
                const z = layer * zSpacing;

                nodes.push({
                    x, y, z,
                    pc,
                    fifthsPos: baseFifthsPos,
                    gridCol: col,
                    gridRow: row,
                    layer,
                    isScaleNote,
                    isEnharmonicNote,
                });
            }
        }
    }

    return nodes;
}

// ── Edge interval classification ──────────────────────────────────

/** Classify an edge by its interval class, using letter-name steps to disambiguate ic2. */
export function classifyEdgeInterval(pc1: PitchClass, pc2: PitchClass): string {
    const semi = ((pc2.midiValue - pc1.midiValue) % 12 + 12) % 12;
    const ic = Math.min(semi, 12 - semi);

    // Use letter-name steps to disambiguate enharmonic interval classes
    const steps = LetterNameUtils.steps(pc1.letterName, pc2.letterName);
    const minSteps = Math.min(steps, (7 - steps) % 7);

    switch (ic) {
        case 5: return minSteps <= 2 ? 'A3' : 'P5';
        case 4: return minSteps <= 2 ? 'M3' : 'A5';  // M3 = 2 letter steps, A5/d4 = 3+ steps
        case 3: return minSteps <= 1 ? 'A2' : 'm3';  // A2 = 1 letter step (Db→E), m3 = 2 steps (A→C)
        case 6: return 'd5';
        case 2: return minSteps <= 1 ? 'M2' : 'A6';  // M2 = 1 letter step, A6/d3 = 2+ steps
        case 1: return 'm2';
        default: return 'P1';
    }
}

/**
 * Check whether three notes form valid triad letter names (consecutive thirds).
 * Valid patterns from root: {2,4} (standard tertian) or {2,5} (augmented 6th).
 */
export function hasValidTriadLetters(a: PitchClass, b: PitchClass, c: PitchClass): boolean {
    const notes = [a, b, c];
    for (let r = 0; r < 3; r++) {
        const root = notes[r].letterName;
        const others = notes.filter((_, i) => i !== r);
        const steps = others.map(n => LetterNameUtils.steps(root, n.letterName));
        steps.sort((x, y) => x - y);
        if (steps[0] === 2 && (steps[1] === 4 || steps[1] === 5)) return true;
    }
    return false;
}

/** Check whether a triangle (3 notes) contains any second (M2, m2, or A2) edge. */
export function triangleHasSecond(a: PitchClass, b: PitchClass, c: PitchClass): boolean {
    for (const [p, q] of [[a, b], [b, c], [a, c]] as [PitchClass, PitchClass][]) {
        const iv = classifyEdgeInterval(p, q);
        if (iv === 'M2' || iv === 'm2' || iv === 'A2') return true;
    }
    return false;
}

// ── Triangle computation ───────────────────────────────────────────

/**
 * Determine the triad type from 3 notes' semitone intervals.
 *
 * Tries each of the 3 notes as root and checks if the ascending semitone
 * intervals match a known pattern. This rotation search is necessary because
 * the same set of intervals maps to different patterns depending on which
 * note is treated as root — e.g. C-F-G is [5,7] from C (sus4) but [2,7]
 * from F (sus2). Similarly, [4,7] from C = major, but from E the same
 * triad gives [3,8] and from G it gives [5,9]. Only root position matches.
 *
 * For exotic types like aug3 ([5,7]), semitones alone are ambiguous — a P4
 * and an A3 are both 5 semitones — so we verify spelling via letter names.
 * 5, 7 is a Sus4 chord. It's enharmonic to a Sus2 chord a 4th away.
 * However Suspended chords don't create triangles on a linear P5 chain.
 * The enharmonic Aug3 and dim3 do, though.
 */
export function classifyTriad(a: PitchClass, b: PitchClass, c: PitchClass): string {
    // Reject triads whose spelling contains a second (M2/m2)
    if (triangleHasSecond(a, b, c)) return 'unknown';
    // Reject triads whose letter names don't form consecutive thirds
    if (!hasValidTriadLetters(a, b, c)) return 'unknown';

    const notes = [a, b, c];
    const semitones = notes.map(n => normPC(n.midiValue));

    for (let r = 0; r < 3; r++) {
        const root = semitones[r];
        const others = semitones.filter((_, i) => i !== r);
        const intervals = others.map(o => normPC(o - root)).sort((a, b) => a - b);

        if (intervals[0] === 4 && intervals[1] === 7) return 'major';
        if (intervals[0] === 3 && intervals[1] === 7) return 'minor';
        if (intervals[0] === 3 && intervals[1] === 6) return 'diminished';
        if (intervals[0] === 4 && intervals[1] === 8) return 'augmented';
        if (intervals[0] === 4 && intervals[1] === 6) return 'flat5';
        if (intervals[0] === 4 && intervals[1] === 10) return 'aug6';
        if (intervals[0] === 5 && intervals[1] === 7) {
            // Verify the 5-semitone interval is actually an A3, not a P4
            const rootPC = notes[r];
            const thirdPC = notes.find((n, i) => i !== r && normPC(n.midiValue - rootPC.midiValue) === 5)!;
            if (classifyEdgeInterval(rootPC, thirdPC) === 'A3') return 'aug3';
        }
    }
    // dim3 + P5 (e.g. C-Ebb-G): checked in a second pass because [2,7] from
    // one root can coexist with [5,7] aug3 from another — aug3 takes precedence
    for (let r = 0; r < 3; r++) {
        const root = semitones[r];
        const others = semitones.filter((_, i) => i !== r);
        const intervals = others.map(o => normPC(o - root)).sort((a, b) => a - b);
        if (intervals[0] === 2 && intervals[1] === 7) return 'dim3';
    }
    return 'unknown';
}

/**
 * Build triangles from the grid, computing triad types internally.
 *
 * The triangular tiling connects adjacent nodes. For each cell (row, col),
 * we form up-pointing and down-pointing triangles from the surrounding nodes.
 */
export function computeLatticeTriangles(
    nodes: LatticeNode[],
    getTriadColor: (type: string, notes?: PitchClass[]) => string,
    numCols: number,
    numRows: number,
    layers: number[] = [-1, 0, 1]
): LatticeTriangle[] {
    const triangles: LatticeTriangle[] = [];

    // Index nodes by (layer, row, col) for fast lookup
    const nodeMap = new Map<string, LatticeNode>();
    for (const node of nodes) {
        nodeMap.set(`${node.layer}:${node.gridRow}:${node.gridCol}`, node);
    }

    // For each layer, build the 2D triangular tiling.
    // With ROW_SHIFT = 4, the four corners of grid cell (row, col) have fifths positions:
    //   topLeft  = P,   topRight  = P+1
    //   bottomLeft = P+4, bottomRight = P+5
    // The two valid triads are:
    //   Down-pointing: topLeft(P), topRight(P+1), bottomLeft(P+4)  → P5, m3, M3
    //   Up-pointing:   topRight(P+1), bottomLeft(P+4), bottomRight(P+5) → m3, P5, M3
    for (const layer of layers) {
        for (let row = 0; row < numRows; row++) {
            for (let col = 0; col < numCols; col++) {
                const topLeft = nodeMap.get(`${layer}:${row}:${col}`);
                const topRight = nodeMap.get(`${layer}:${row}:${col + 1}`);
                const bottomLeft = nodeMap.get(`${layer}:${row + 1}:${col}`);
                const bottomRight = nodeMap.get(`${layer}:${row + 1}:${col + 1}`);

                // Down-pointing triangle: topLeft, topRight, bottomLeft
                if (topLeft && topRight && bottomLeft) {
                    const triadType = classifyTriad(topLeft.pc, topRight.pc, bottomLeft.pc);
                    const zValues = [topLeft.z, topRight.z, bottomLeft.z];
                    const zRange = Math.max(...zValues) - Math.min(...zValues);
                    const tiltAngle = Math.atan2(zRange, X_SPACING) * (180 / Math.PI);

                    triangles.push({
                        vertices: [topLeft, topRight, bottomLeft],
                        color: getTriadColor(triadType, [topLeft.pc, topRight.pc, bottomLeft.pc]),
                        triadType,
                        tiltAngle,
                    });
                }

                // Up-pointing triangle: topRight, bottomLeft, bottomRight
                if (topRight && bottomLeft && bottomRight) {
                    const triadType = classifyTriad(topRight.pc, bottomLeft.pc, bottomRight.pc);
                    const zValues = [topRight.z, bottomLeft.z, bottomRight.z];
                    const zRange = Math.max(...zValues) - Math.min(...zValues);
                    const tiltAngle = Math.atan2(zRange, X_SPACING) * (180 / Math.PI);

                    triangles.push({
                        vertices: [topRight, bottomLeft, bottomRight],
                        color: getTriadColor(triadType, [topRight.pc, bottomLeft.pc, bottomRight.pc]),
                        triadType,
                        tiltAngle,
                    });
                }
            }
        }
    }

    // Cross-layer triad triangles spanning adjacent accidental layers.
    // All triad types (major, minor, diminished, augmented, flat5, aug6)
    // are found via generalized search; classifyTriad rejects invalid combos.

    function tryPushCrossLayerTriangle(
        a: LatticeNode, b: LatticeNode, c: LatticeNode
    ): void {
        // Reject triangles spanning too many layers
        const sortedLayers = [a.layer, b.layer, c.layer].sort((x, y) => x - y);
        const span = sortedLayers[2] - sortedLayers[0];
        if (span > 2) return;
        // Span=2 only valid if all 3 layers are consecutive (one vertex per layer)
        if (span === 2 && sortedLayers[1] !== sortedLayers[0] + 1) return;

        const triadType = classifyTriad(a.pc, b.pc, c.pc);
        if (triadType === 'unknown') return;
        const zValues = [a.z, b.z, c.z];
        const zRange = Math.max(...zValues) - Math.min(...zValues);
        const tiltAngle = Math.atan2(zRange, X_SPACING) * (180 / Math.PI);
        triangles.push({
            vertices: [a, b, c],
            color: getTriadColor(triadType, [a.pc, b.pc, c.pc]),
            triadType,
            tiltAngle,
        });
    }

    // Generalized cross-layer triangle search.
    // For each pair of adjacent layers, find triangles spanning 2 or 3 layers.
    // Numeric dedup: encode (layer, row, col) as a single integer, pack sorted triple into one key.
    // Max node ID ≈ 20*4096 + 50*64 + 50 ≈ 85170; triple key < 8.6e14 < Number.MAX_SAFE_INTEGER.
    const crossLayerSeen = new Set<number>();
    const ID_BASE = 100000;

    for (let li = 1; li < layers.length; li++) {
        const L_upper = layers[li];
        const L_lower = layers[li - 1];
        if (L_upper - L_lower !== 1) continue;

        for (let r = 0; r <= numRows; r++) {
            for (let c = 0; c <= numCols; c++) {
                const nodeA = nodeMap.get(`${L_upper}:${r}:${c}`);
                if (!nodeA) continue;
                const idA = (L_upper + 10) * 4096 + r * 64 + c;

                // Check all nearby nodes on the lower layer as potential partner B
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const nodeB = nodeMap.get(`${L_lower}:${r + dr}:${c + dc}`);
                        if (!nodeB) continue;
                        const idB = (L_lower + 10) * 4096 + (r + dr) * 64 + (c + dc);

                        // C must be within 1 grid step of both A and B
                        const minR = Math.max(r - 1, r + dr - 1);
                        const maxR = Math.min(r + 1, r + dr + 1);
                        const minC = Math.max(c - 1, c + dc - 1);
                        const maxC = Math.min(c + 1, c + dc + 1);

                        // Check all layers for nodeC (not just L_upper/L_lower)
                        // so triads spanning 3 layers can be found (e.g. aug6: Ab♭₋₁-C₀-F#₊₁)
                        for (const cLayer of layers) {
                            for (let cr = minR; cr <= maxR; cr++) {
                                for (let cc = minC; cc <= maxC; cc++) {
                                    const nodeC = nodeMap.get(`${cLayer}:${cr}:${cc}`);
                                    if (!nodeC || nodeC === nodeA || nodeC === nodeB) continue;

                                    // Dedup: sort 3 numeric IDs, pack into one number
                                    const idC = (cLayer + 10) * 4096 + cr * 64 + cc;
                                    let lo = idA, mid = idB, hi = idC;
                                    if (lo > mid) { const t = lo; lo = mid; mid = t; }
                                    if (mid > hi) { const t = mid; mid = hi; hi = t; }
                                    if (lo > mid) { const t = lo; lo = mid; mid = t; }
                                    const key = lo + mid * ID_BASE + hi * ID_BASE * ID_BASE;
                                    if (crossLayerSeen.has(key)) continue;
                                    crossLayerSeen.add(key);

                                    tryPushCrossLayerTriangle(nodeA, nodeB, nodeC);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return triangles;
}

// ── Scale path computation ─────────────────────────────────────────

/**
 * Compute the scale path through 3D space.
 * Sorts the 7 scale notes by extendedFifthsPos and connects consecutive pairs.
 * Each segment is classified as P5, d5, or A5 based on semitone distance.
 */
export function computeScalePathV2(
    scaleNotes: PitchClass[],
    zSpacing: number = Z_SPACING,
): ScalePathSegment[] {
    // Sort scale notes by extended fifths position
    const sorted = [...scaleNotes].sort(
        (a, b) => extendedFifthsPos(a.letterName, a.accidental)
              - extendedFifthsPos(b.letterName, b.accidental)
    );

    const segments: ScalePathSegment[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
        const from = sorted[i];
        const to = sorted[i + 1];

        const fromEFP = extendedFifthsPos(from.letterName, from.accidental);
        const toEFP = extendedFifthsPos(to.letterName, to.accidental);

        const fromX = fromEFP * X_SPACING;
        const fromZ = from.accidental * zSpacing;
        const toX = toEFP * X_SPACING;
        const toZ = to.accidental * zSpacing;

        // Classify interval by semitone distance
        const semitones = ((to.midiValue - from.midiValue) % 12 + 12) % 12;
        let intervalType: 'P5' | 'd5' | 'A5';
        if (semitones === 7 || semitones === 5) {
            intervalType = 'P5';
        } else if (semitones === 6) {
            intervalType = 'd5';
        } else {
            intervalType = 'A5'; // semitones === 8 or 4
        }

        const crossesLayer = from.accidental !== to.accidental;

        segments.push({
            from: { x: fromX, y: 0, z: fromZ, pc: from },
            to: { x: toX, y: 0, z: toZ, pc: to },
            intervalType,
            crossesLayer,
        });
    }

    return segments;
}
