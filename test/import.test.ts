/**
 * MusicXML import: the tempo map that turns quarter-note positions into milliseconds. The XML parsing
 * itself needs a DOM and is checked in the browser.
 */
import { assertEq, suite, test } from './framework.js';
import { tempoMap } from '../viz/src/import/musicxml.js';

suite('MusicXML import tempo', () => {
    test('no mark plays at 120', () => {
        const ms = tempoMap([]);
        assertEq(ms(4), 2000);
    });

    test('a tempo change speeds up only what follows it', () => {
        const ms = tempoMap([{ q: 0, bpm: 60 }, { q: 8, bpm: 120 }]);   // 2 bars of 4/4 slow, then twice as fast
        assertEq(ms(4), 4000);
        assertEq(ms(8), 8000);
        assertEq(ms(12), 10000);
    });

    test('marks repeated by each part, out of order, count once', () => {
        const ms = tempoMap([{ q: 8, bpm: 120 }, { q: 0, bpm: 60 }, { q: 8, bpm: 120 }, { q: 0, bpm: 60 }]);
        assertEq(ms(12), 10000);
    });

    test('a first mark after the start applies from the start', () => {
        const ms = tempoMap([{ q: 1, bpm: 60 }]);
        assertEq(ms(2), 2000);
    });
});
