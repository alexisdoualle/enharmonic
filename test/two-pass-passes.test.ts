/**
 * `spellTwoPass`: the look-ahead speller run both ways, its side key read on onsets centred on each note.
 *
 * The side key both passes read is centred on each note. Going round the spiral from A♭ major (−4), C♭ major (−7)
 * is nearer than B major (+5), so a centred reader deepened from A♭ hears a sharp-key passage as its flat twin (it
 * wrote the E-major pages of Chopin's Prelude Op. 28 No. 17 as F♭). Past ±5 accidentals the passes get no side key
 * and the previous one holds. Without that cap the Pathétique Adagio (A♭ major) goes from 10 wrong / 0 flipped to
 * 66 / 77.
 *
 * Keyless, the centred key is deepened forward and backward in time; where the readings differ, a key on the opening
 * tonic takes the reading nearer the opening side and any other key the reading with fewer accidentals. Forward only,
 * Op. 28/15's return to D♭ major is read as C♯ major from its C♯-minor section (176 flipped notes) and Op. 109's
 * B-major section as C♭ major (549).
 */
import { suite, test, assert, assertEq } from './framework.js';
import { spellTwoPass, type Pitch } from '../src/index.js';
import { sectionStarts } from '../src/key-side.js';
import { loadEvents, loadExpected, onNotes, onsetKeys } from './eval/fixtures.js';
import { scoreTiers } from './eval/score.js';

suite('two-pass side keys', () => {
    test('Pathétique Adagio (A♭ major): side key capped at ±5, no flips', () => {
        const id = 'beethoven_pathetique_adagio', ev = loadEvents(id);
        const t = scoreTiers(spellTwoPass(onNotes(ev)) as (Pitch | null)[], loadExpected(id), onsetKeys(ev));
        assertEq(t.flipped, 0);
        assert(t.wrong <= 10, `wrong ${t.wrong} > 10`);
    });
    test('keyless side seams: a return home and a remote key take the conventional side', () => {
        const flips = (id: string) => { const ev = loadEvents(id); return scoreTiers(spellTwoPass(onNotes(ev)) as (Pitch | null)[], loadExpected(id), onsetKeys(ev)).flipped; };
        const r = flips('chopin_prelude_op28_no15'), o = flips('beethoven_op109');
        assert(r <= 67, `Op. 28/15 flipped ${r} > 67`);
        assert(o <= 40, `Op. 109 flipped ${o} > 40`);
    });
    // Section breaks: a silence of 2 s, or of 0.5 s where the key read on each side moves three fifths or more.
    test('section breaks: a long silence, or a short one where the key moves', () => {
        const piece = (gap: number, second: readonly number[][]) => {
            const notes: { midi: number; tOn: number; tOff: number }[] = []; let t = 0;
            const play = (cs: readonly number[][]) => { for (let r = 0; r < 8; r++) for (const c of cs) { for (const m of c) notes.push({ midi: m, tOn: t, tOff: t + 400 }); t += 400; } };
            play(cMajor);
            t += gap;
            play(second);
            return notes;
        };
        const cMajor = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], eMajor = [[64, 68, 71], [69, 73, 76], [71, 75, 78], [64, 68, 71]];
        assertEq(sectionStarts(piece(2000, cMajor)), [96], 'silence of 2 s, same key');
        assertEq(sectionStarts(piece(1000, cMajor)), [], 'silence of 1 s, same key');
        assertEq(sectionStarts(piece(1000, eMajor)), [96], 'silence of 1 s, C to E major (four fifths)');
        assertEq(sectionStarts(piece(400, eMajor)), [], 'silence under 0.5 s');
    });
});
