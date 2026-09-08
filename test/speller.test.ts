/**
 * Product smoke + curated fixture replay.
 * Confirms Speller / look-ahead / two-pass run and commit one spelling per onset.
 * Spelling *correctness* against ground truth is graded by the parity bench
 * (`test/eval/run.ts`); this file only checks that every onset commits a reading.
 */

import { assert, assertEq, suite, test } from './framework.js';
import { Speller, spellTwoPass, type Pitch, type PitchClass } from '../src/index.js';
import { spellTwoPassTraced } from '../src/two-pass.js';
import { FIXTURES, loadEvents, drive as driveSpellings, onNotes } from './eval/fixtures.js';

const tok = (sp: Pitch | null): string =>
    sp ? sp.step + (sp.alter > 0 ? '#'.repeat(sp.alter) : sp.alter < 0 ? 'b'.repeat(-sp.alter) : '') : '·';

const drive = (s: Speller, events: ReturnType<typeof loadEvents>): string[] =>
    driveSpellings(s, events).map(tok);

suite('Speller smoke', () => {
    test('C major triad spells C E G', () => {
        const s = new Speller();
        s.noteOn(60, { t: 0 });
        s.noteOn(64, { t: 0 });
        s.noteOn(67, { t: 0 });
        assertEq(tok(s.getSpelling(60)), 'C');
        assertEq(tok(s.getSpelling(64)), 'E');
        assertEq(tok(s.getSpelling(67)), 'G');
    });

    // These two exercise the paths the parity bench does NOT: the reset(scale) soft key-signature
    // hint, and getResolvedScale — both flow through the slimmed snapshot()/suppliedKey surface.
    test('reset(scale) key hint orients an ambiguous pitch class', () => {
        const dMajor: PitchClass[] = [
            { step: 'D', alter: 0 }, { step: 'E', alter: 0 }, { step: 'F', alter: 1 },
            { step: 'G', alter: 0 }, { step: 'A', alter: 0 }, { step: 'B', alter: 0 }, { step: 'C', alter: 1 },
        ];
        const s = new Speller();
        s.reset(dMajor);
        s.noteOn(61, { t: 0 });                       // pc 1: C♯ (in D major) not D♭
        assertEq(tok(s.getSpelling(61)), 'C#');
    });

    test('getResolvedScale returns the current 7-letter surface', () => {
        const s = new Speller();
        s.noteOn(60, { t: 0 });
        const scale = s.getResolvedScale();
        assert(scale !== null && scale.length === 7, 'expected a 7-letter surface');
    });

    test('two-pass trace is output-identical to the production resolver', () => {
        const notes = onNotes(loadEvents('mozart_k545'));
        const production = spellTwoPass(notes);
        const traced = spellTwoPassTraced(notes);
        assertEq(JSON.stringify(traced.spellings), JSON.stringify(production));
        assertEq(traced.notes.length, notes.length);
        assert(traced.notes.every(n => n.forward.frameKeyLof != null && n.backward.frameKeyLof != null), 'expected canonical keys for both passes');
    });

    test('onset recency buffer keeps harmonic-major A♭ after C D E F G', () => {
        const s = new Speller({ clock: () => 0 });
        for (const [i, midi] of [60, 62, 64, 65, 67, 68].entries()) {
            s.noteOn(midi, { t: i * 1000 });
            if (midi !== 68) s.noteOff(midi);
        }
        assertEq(tok(s.getSpelling(68)), 'Ab');
    });
});

suite('curated fixtures', () => {
    for (const id of FIXTURES) {
        test(`${id}: real-time commits one spelling per onset`, () => {
            const ev = loadEvents(id);
            const out = drive(new Speller(), ev);
            assert(out.length > 0);
            assert(out.every(t => t !== '·'), `${id}: abstain/unread`);
        });

        test(`${id}: look-ahead commits one spelling per onset`, () => {
            const ev = loadEvents(id);
            const out = drive(new Speller({ lookAhead: true }), ev);
            assert(out.every(t => t !== '·'), `${id}: LA abstain/unread`);
        });

        test(`${id}: two-pass length matches onsets`, () => {
            const ev = loadEvents(id);
            const notes = onNotes(ev);
            const spelled = spellTwoPass(notes);
            assertEq(spelled.length, notes.length);
            assert(spelled.every(p => p !== null), `${id}: two-pass null`);
        });
    }
});
