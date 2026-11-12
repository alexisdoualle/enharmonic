import { assert, assertEq, suite, test } from './framework.js';
import { computeLatticeNodes, ROW_SHIFT } from '../viz/src/tonnetz3d/LatticeGeometry.js';
import { PitchClass } from '../viz/src/tonnetz3d/core/PitchClass.js';
import { allSymClasses, chainOf, computeSheets, lofOf, symClassesIn, type SymClass } from '../viz/src/tonnetz3d/symmetricPlanes.js';
import type { LatticeNode } from '../viz/src/tonnetz3d/LatticeGeometry.js';
import type { LetterName } from '../viz/src/tonnetz3d/types.js';

// The 3D panel's window, built exactly as TonnetzSceneV2.rebuild does for the viz (cols() = 15 → 7,
// rows 5, layers −1..1, z-gap 0.8, maxAccidentals 1 relative to the layer).
const NUM_COLS = 7, NUM_ROWS = 5;
const START = 3 - Math.floor(NUM_COLS / 2) - Math.floor(NUM_ROWS / 2) * ROW_SHIFT;
const C_MAJOR = 'CDEFGAB'.split('').map(l => new PitchClass(l as LetterName, 0));
const NODES: LatticeNode[] = computeLatticeNodes(C_MAJOR, NUM_COLS, NUM_ROWS, START, [-1, 0, 1], 0.8)
    .filter(n => Math.abs(n.pc.accidental - n.layer) <= 1);

const pc = (n: LatticeNode) => ((n.pc.midiValue % 12) + 12) % 12;
const SYM = (n: LatticeNode) => n.pc.letterName + (n.pc.accidental > 0 ? '#'.repeat(n.pc.accidental) : 'b'.repeat(-n.pc.accidental));
const LETTERS = 'CDEFGAB';
const letterSteps = (a: LatticeNode, b: LatticeNode) => (LETTERS.indexOf(b.pc.letterName) - LETTERS.indexOf(a.pc.letterName) + 7) % 7;
const pcsOf = (cls: SymClass): number[] => {
    const cell = NODES.find(n => ((lofOf(n.pc.letterName, n.pc.accidental) % (cls.kind === 'aug' ? 4 : 3)) + 12) % (cls.kind === 'aug' ? 4 : 3) === cls.residue)!;
    const step = cls.kind === 'aug' ? 4 : 3;
    return Array.from({ length: 12 / step }, (_, i) => (pc(cell) + i * step) % 12).sort((a, b) => a - b);
};

suite('3D lattice: symmetric-chord planes', () => {
    test('detects aug triads and dim7s from the sounding pitch classes', () => {
        assertEq(symClassesIn(new Set([0, 4, 8])), [{ kind: 'aug', residue: 0 }]);             // C E G♯
        assertEq(symClassesIn(new Set([0, 4, 8, 10])).length, 1);                             // C7♯5 contains one
        assertEq(symClassesIn(new Set([6, 9, 0, 3])), [{ kind: 'dim7', residue: 0 }]);          // F♯°7
        assertEq(symClassesIn(new Set([0, 4, 7])), []);                                        // C major: none
        assertEq(symClassesIn(new Set([11, 2, 5])), []);                                       // B° triad is not a dim7
    });

    for (const cls of [...allSymClasses('aug'), ...allSymClasses('dim7')]) {
        const sheets = computeSheets(NODES, cls);
        const pcs = pcsOf(cls);
        test(`${cls.kind} ${cls.residue}: every cell is the chord, every cell is on one sheet`, () => {
            const cells = sheets.flatMap(s => s.cells);
            for (const n of cells) assert(pcs.includes(pc(n)), `${SYM(n)} is not in ${pcs}`);
            const expected = NODES.filter(n => pcs.includes(pc(n)));
            assertEq(cells.length, expected.length, 'sheets partition the chord’s cells');
        });
        test(`${cls.kind} ${cls.residue}: each triangle is the chord's own triad, correctly spelled`, () => {
            for (const s of sheets) for (const [p, a, b] of s.triangles) {
                const ns = [p, a, b].map(n => lofOf(n.pc.letterName, n.pc.accidental)).sort((x, y) => x - y);
                if (cls.kind === 'aug') {
                    // Stacked major thirds: +4, +4 on the LoF, letters a third apart (C–E–G♯).
                    assertEq([ns[1]! - ns[0]!, ns[2]! - ns[1]!], [4, 4]);
                    const [r, t, f] = [p, a, b].sort((x, y) => lofOf(x.pc.letterName, x.pc.accidental) - lofOf(y.pc.letterName, y.pc.accidental));
                    assertEq([letterSteps(r!, t!), letterSteps(t!, f!)], [2, 2]);
                } else {
                    // Stacked minor thirds: −3, −3 on the LoF (C–E♭–G♭), letters a third apart.
                    assertEq([ns[1]! - ns[0]!, ns[2]! - ns[1]!], [3, 3]);
                    const [r, t, f] = [p, a, b].sort((x, y) => lofOf(y.pc.letterName, y.pc.accidental) - lofOf(x.pc.letterName, x.pc.accidental));
                    assertEq([letterSteps(r!, t!), letterSteps(t!, f!)], [2, 2]);
                }
            }
        });
        test(`${cls.kind} ${cls.residue}: each sheet is flat and spells one unbroken stack of thirds`, () => {
            const step = cls.kind === 'aug' ? 4 : -3;
            for (const s of sheets) {
                const chain = chainOf(s.cells, cls.kind).map(n => lofOf(n.pc.letterName, n.pc.accidental));
                for (let i = 1; i < chain.length; i++) assertEq(chain[i]! - chain[i - 1]!, step, `gap in sheet ${s.id}`);
                if (s.cells.length < 4) continue;
                // Coplanarity: every cell lies on the plane through three non-collinear ones.
                const [o, ...rest] = s.cells;
                const v = (n: LatticeNode) => [n.x - o!.x, n.y - o!.y, n.z - o!.z];
                const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
                let normal: number[] | null = null;
                for (let i = 0; i < rest.length && !normal; i++) for (let j = i + 1; j < rest.length && !normal; j++) {
                    const c = cross(v(rest[i]!), v(rest[j]!));
                    if (Math.hypot(...c) > 1e-6) normal = c;
                }
                if (!normal) continue;
                for (const n of rest) {
                    const d = v(n);
                    assert(Math.abs(d[0]! * normal[0]! + d[1]! * normal[1]! + d[2]! * normal[2]!) < 1e-6, `sheet ${s.id} not planar`);
                }
            }
        });
    }

    test('the A♭–C–E–G♯–B♯ continuation sits on one sheet', () => {
        const names = computeSheets(NODES, { kind: 'aug', residue: 0 }).map(s => chainOf(s.cells, 'aug').map(SYM).join(' '));
        assert(names.some(n => n.includes('Ab C E G# B#')), names.join(' | '));
    });
    test('the F♯°7 continuation D♯–F♯–A–C–E♭ sits on one sheet', () => {
        const names = computeSheets(NODES, { kind: 'dim7', residue: 0 }).map(s => chainOf(s.cells, 'dim7').map(SYM).join(' '));
        assert(names.some(n => n.includes('D# F# A C Eb')), names.join(' | '));
    });
});
