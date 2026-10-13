import { assertEq, suite, test } from './framework.js';
import { alteredFifths, bandBridges, fifthQuality, lofOf, lofRuns } from '../viz/src/spirals.js';

const scale = (...names: string[]) => names.map(s => lofOf({ step: s[0]!, alter: s.slice(1) === '#' ? 1 : s.slice(1) === 'b' ? -1 : 0 }));
const arcs = (...names: string[]) => alteredFifths(scale(...names)).map(a => `${fifthQuality(a.k)} ${a.from}>${a.to}`);

suite('spirals: altered-fifth arcs', () => {
    test('C major: only the B–F diminished fifth', () => {
        assertEq(arcs('C', 'D', 'E', 'F', 'G', 'A', 'B'), ['d5 5>-1']);
    });
    test('A harmonic minor: A5 C–G♯, d5 G♯–D, d5 B–F', () => {
        assertEq(arcs('A', 'B', 'C', 'D', 'E', 'F', 'G#'), ['A5 0>8', 'd5 8>2', 'd5 5>-1']);
    });
    test('E harmonic minor: A5 G–D♯, d5 D♯–A, d5 F♯–C', () => {
        assertEq(arcs('E', 'F#', 'G', 'A', 'B', 'C', 'D#'), ['A5 1>9', 'd5 9>3', 'd5 6>0']);
    });
    test('a missing letter draws no cycle', () => {
        assertEq(arcs('C', 'D', 'E', 'F', 'G', 'A'), []);
    });
});

suite('spirals: band runs on the pitch spiral', () => {
    test('C major is one run of seven fifths', () => {
        assertEq(lofRuns(scale('C', 'D', 'E', 'F', 'G', 'A', 'B')), [[-1, 5]]);
    });
    test('A harmonic minor breaks at G♯', () => {
        assertEq(lofRuns(scale('A', 'B', 'C', 'D', 'E', 'F', 'G#')), [[-1, 0], [2, 5], [8, 8]]);
    });
});

suite('spirals: dashed bridges where the band breaks', () => {
    const bridges = (...names: string[]) => bandBridges(scale(...names)).map(b => `${fifthQuality(b.k)} ${b.from}>${b.to}`);
    test('C major: none', () => {
        assertEq(bridges('C', 'D', 'E', 'F', 'G', 'A', 'B'), []);
    });
    test('A harmonic minor: A5 over C–G, d5 over G–D', () => {
        assertEq(bridges('A', 'B', 'C', 'D', 'E', 'F', 'G#'), ['A5 0>1', 'd5 1>2']);
    });
    test('E harmonic minor: A5 over G–D, d5 over D–A', () => {
        assertEq(bridges('E', 'F#', 'G', 'A', 'B', 'C', 'D#'), ['A5 1>2', 'd5 2>3']);
    });
    test('A♯ and E♯ raised together: A5 over D–A, P5 over A–E, d5 over E–B', () => {
        assertEq(bridges('B', 'C#', 'D', 'E#', 'F#', 'G', 'A#'), ['A5 2>3', 'P5 3>4', 'd5 4>5']);
    });
});
