/**
 * LOCAL compare (viz/src/compare.ts): another speller's predictions are scored by the same classifier
 * and onset grouping as ours. No third-party data is needed: feeding the comparison our own spellings,
 * or the score's, pins the arithmetic.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, assertEq, suite, test } from './framework.js';
import { REPO_ROOT, loadExpected } from './eval/fixtures.js';
import { buildReplay, type RawEvent } from '../viz/src/replay.js';
import { buildComparison, parseSpelling, withOctave } from '../viz/src/compare.js';

const ID = 'mozart_k545';
const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', ID, 'events.json'), 'utf8')) as RawEvent[];
const expected = loadExpected(ID);

suite('viz compare', () => {
    test('parseSpelling reads ASCII spellings, double accidentals included', () => {
        assertEq(parseSpelling('C#'), { step: 'C', alter: 1 });
        assertEq(parseSpelling('Bbb'), { step: 'B', alter: -2 });
        assertEq(parseSpelling('F##'), { step: 'F', alter: 2 });
        assertEq(parseSpelling('E'), { step: 'E', alter: 0 });
        assertEq(parseSpelling(null), null);
    });

    test('withOctave keeps the sounding pitch across the octave boundary', () => {
        assertEq(withOctave({ step: 'B', alter: 1 }, 60), { step: 'B', alter: 1, octave: 3 });
        assertEq(withOctave({ step: 'C', alter: -1 }, 71), { step: 'C', alter: -1, octave: 5 });
        assertEq(withOctave({ step: 'D', alter: -1 }, 61), { step: 'D', alter: -1, octave: 4 });
    });

    for (const mode of ['rt', 'tp'] as const) {
        test(`${ID}/${mode}: our own spellings as "theirs" differ nowhere and tally like ours`, () => {
            const r = buildReplay(mode, raw, expected);
            const c = buildComparison(r, r.snapshots.map(s => s.committed), expected, 'self', 'self');
            assertEq(c.nDiffer, 0);
            assertEq(c.tally, r.tally);
        });
    }

    test(`${ID}/tp: the score as "theirs" is all exact, and differs exactly where ours is not exact`, () => {
        const r = buildReplay('tp', raw, expected);
        const c = buildComparison(r, expected.map(e => parseSpelling(e.step + (e.alter > 0 ? '#'.repeat(e.alter) : 'b'.repeat(-e.alter)))), expected, 'score', 'score');
        assertEq(c.tally.wrong, 0);
        assertEq(c.tally.correct, c.tally.total);
        const notExact = r.snapshots.filter(s => s.committed && s.expected && (s.committed.step !== s.expected.step || s.committed.alter !== s.expected.alter)).length;
        assertEq(c.nDiffer, notExact);
        // An offset-0 straggler is wrong yet matches the score, so this is <=, not ==.
        assert(c.differOursWrong <= r.tally.wrong && c.differOursWrong > 0);
        const NAT: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        assert(c.theirs.every((p, k) => !p || (p.octave + 1) * 12 + NAT[p.step]! + p.alter === r.snapshots[k]!.midi), 'theirs sounds at the note\'s MIDI');
    });
});
