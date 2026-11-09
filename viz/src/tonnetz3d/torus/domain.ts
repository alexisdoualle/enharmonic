/**
 * The piece of the flat lattice that folds into the torus: one fundamental domain of 14 whole lattice
 * triangles (each of the 7 triads twice), as in the tonnetz app's tools/diagrams/tonnetz-fold.html:
 *
 *      D  A  E  B        top row: the same notes as the bottom row; they glue when rolled
 *    B  F  C  G  D       middle row, with B (the diminished triad) on the left
 *      D  A  E  B        bottom row
 *
 * Coordinates are the torus lattice (x, y) of TorusGeometry (note = x - 2y on the fifths chain, F = 0):
 * middle row (x, 0), top row (x - 2, 1), bottom row (x + 1, -1). Lattice cell offset (dc, dr) is torus
 * (dc - dr, dr), so the block sits on the lattice as is: nothing is cut.
 */
import {
    mod, latticeToAngles, levelFromX, pcFromFifthIndex, triadQualityFromPCs,
    type LetterAccidentals, type TriadQuality,
} from './TorusGeometry.js';

const SUB = 12;   // subdivisions per triangle edge, so faces curve smoothly when rolled and bent

/** A face: one lattice triangle, i.e. one triad of the surface. */
export interface Face {
    key: string;                  // root:quality, shared by both copies of the same chord
    rootX: number;                // root, fifths index 0..6 (F = 0)
    quality: TriadQuality | null; // null: not a recognised triad on these spellings
    pcs: number[];
}

/** One face, subdivided. `bary` gives each vertex's weights on `corners`. */
export interface Piece {
    face: Face;
    corners: [number, number][];  // the lattice triangle (torus x, y), in mesh winding order
    xy: number[];                 // torus lattice x, y per vertex
    bary: number[];               // 3 weights per vertex
    level: number[];              // accidental level per vertex
    index: number[];
    cx: number;                   // centroid
    cy: number;
    top: boolean;                 // above the middle row (chord labels go on one copy per chord)
}

export interface NoteCopy { x: number; y: number; letter: number }

export interface Domain {
    pieces: Piece[];
    notes: NoteCopy[];
    edges: [number, number][];    // lattice edges of the block, as pairs of indices into `notes`
    phiShift: number;             // added to every phi, so the block's middle sits at phiC
    thetaC: number;               // fold centre: theta at the middle of the block, phi on the sheet's side of the tube
    phiC: number;
    centre: [number, number];     // centre of the block (lattice), put under the lattice camera
}

const letterAt = (x: number, y: number): number => mod(x - 2 * y, 7);

/** Folded angles of a domain point. */
export function domainAngles(d: Domain, x: number, y: number): { theta: number; phi: number } {
    const a = latticeToAngles(x, y);
    return { theta: a.theta, phi: a.phi + d.phiShift };
}

/** phiC: the side of the tube the flat sheet lies on (fold.latticeSide). */
export function buildDomain(acc: LetterAccidentals, phiC: number): Domain {
    const MID = (k: number): [number, number] => [k, 0];
    const TOP = (k: number): [number, number] => [k - 2, 1];
    const BOT = (k: number): [number, number] => [k + 1, -1];
    const B: [number, number] = [-1, 0];
    const tris: [number, number][][] = [];
    for (let k = 0; k < 3; k++) {
        tris.push([MID(k), MID(k + 1), TOP(k + 1)]);   // major, up
        tris.push([TOP(k), TOP(k + 1), MID(k)]);       // minor, up
        tris.push([MID(k), MID(k + 1), BOT(k + 1)]);   // major, down
        tris.push([BOT(k), BOT(k + 1), MID(k)]);       // minor, down
    }
    tris.push([B, MID(0), TOP(0)], [B, MID(0), BOT(0)]);   // diminished, up and down

    const faces = new Map<string, Face>();
    const pieces = tris.map(v => {
        const face = faceOf(v, acc, faces);
        const lv = v.map(([x, y]) => levelFromX(letterAt(x, y), 0, acc));
        return subdivide(v, lv, face);
    });

    const nodes: [number, number][] = [B];
    for (let k = 0; k < 4; k++) nodes.push(MID(k), TOP(k), BOT(k));
    const notes = nodes.map(([x, y]) => ({ x, y, letter: letterAt(x, y) }));
    const at = (p: [number, number]): number => nodes.findIndex(n => n[0] === p[0] && n[1] === p[1]);
    const edgeKeys = new Set<string>(), edges: [number, number][] = [];
    for (const v of tris) for (let i = 0; i < 3; i++) {
        const a = at(v[i]!), b = at(v[(i + 1) % 3]!);
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push([a, b]); }
    }

    // Fold centre: the block's middle, so the roll and the bend are symmetric. Its phi is turned to phiC
    // (a fixed phase round the tube, as the resting torus's vortex does anyway), so the sheet starts
    // horizontal, seen from above.
    let th = 0, ph = 0, n = 0, cx = 0, cy = 0;
    for (const v of tris) for (const [x, y] of v) {
        const a = latticeToAngles(x, y);
        th += a.theta; ph += a.phi; cx += x; cy += y; n++;
    }
    return {
        pieces, notes, edges,
        phiShift: phiC - ph / n,
        thetaC: th / n, phiC,
        centre: [cx / n, cy / n],
    };
}

/** The triad of a lattice triangle. On the fifths chain every triad's letters are {r, r + 1, r + 4}
 *  (root, fifth, third): the root is the letter whose +1 and +4 are both present. Major, minor or other
 *  comes from the spellings. */
function faceOf(v: [number, number][], acc: LetterAccidentals, faces: Map<string, Face>): Face {
    const L = v.map(([x, y]) => letterAt(x, y));
    const root = L.find(r => L.includes(mod(r + 1, 7)) && L.includes(mod(r + 4, 7)))!;
    const third = mod(root + 4, 7), fifth = mod(root + 1, 7);
    const quality = triadQualityFromPCs(root, third, fifth, 0, acc);
    const key = `${root}:${quality ?? 'other'}`;
    let f = faces.get(key);
    if (!f) {
        f = { key, rootX: root, quality, pcs: [root, third, fifth].map(x => pcFromFifthIndex(x, 0, acc)) };
        faces.set(key, f);
    }
    return f;
}

/** Subdivide a lattice triangle. One winding (clockwise in x, y) for the whole sheet, as the app's meshes. */
function subdivide(tri: [number, number][], lv: number[], face: Face): Piece {
    let [a, b, c] = tri as [[number, number], [number, number], [number, number]];
    let [la, lb, lc] = lv as [number, number, number];
    const cr = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (cr > 0) { [b, c] = [c, b]; [lb, lc] = [lc, lb]; }
    const xy: number[] = [], bary: number[] = [], level: number[] = [], index: number[] = [], row: number[][] = [];
    for (let u = 0; u <= SUB; u++) {
        row[u] = [];
        for (let v = 0; v <= SUB - u; v++) {
            const w = SUB - u - v;
            row[u]!.push(xy.length / 2);
            xy.push((w * a[0] + u * b[0] + v * c[0]) / SUB, (w * a[1] + u * b[1] + v * c[1]) / SUB);
            bary.push(w / SUB, u / SUB, v / SUB);
            level.push((w * la + u * lb + v * lc) / SUB);
        }
    }
    for (let u = 0; u < SUB; u++) {
        for (let v = 0; v < SUB - u; v++) {
            index.push(row[u]![v]!, row[u + 1]![v]!, row[u]![v + 1]!);
            if (v < SUB - u - 1) index.push(row[u + 1]![v]!, row[u + 1]![v + 1]!, row[u]![v + 1]!);
        }
    }
    const cy = (a[1] + b[1] + c[1]) / 3;
    return { face, corners: [a, b, c], xy, bary, level, index, cx: (a[0] + b[0] + c[0]) / 3, cy, top: cy > 0 };
}
