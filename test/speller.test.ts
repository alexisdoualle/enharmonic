/**
 * Product smoke + curated fixture replay.
 * Confirms Speller / look-ahead / two-pass run and commit one spelling per onset.
 * Spelling *correctness* against ground truth is graded by the parity bench
 * (`test/eval/run.ts`); this file only checks that every onset commits a reading.
 */

import { assert, assertEq, suite, test } from './framework.js';
import { Speller, outwardPairs, resolveStep, spellTwoPass, type Pitch, type PitchClass } from '../src/index.js';
import { spellTwoPassTraced } from '../src/two-pass.js';
import { FIXTURES, loadEvents, drive as driveSpellings, onNotes } from './eval/fixtures.js';

const tok = (sp: Pitch | null): string =>
    sp ? sp.step + (sp.alter > 0 ? '#'.repeat(sp.alter) : sp.alter < 0 ? 'b'.repeat(-sp.alter) : '') : '·';

const drive = (s: Speller, events: ReturnType<typeof loadEvents>): string[] =>
    driveSpellings(s, events).map(tok);

suite('Speller smoke', () => {
    test('resolveStep exposes octave-agnostic look-ahead direction', () => {
        assertEq(resolveStep(65, 30), 1);     // E♯4 → F♯1
        assertEq(resolveStep(30, 65), -1);    // F♯1 → E♯4
        assertEq(resolveStep(60, 62), 0);
    });

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
    // hint, and getResolvedScale, both flow through the slimmed snapshot()/suppliedKey surface.
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
        assert(traced.notes.every(n => n.forward != null && n.backward != null && n.selected != null),
            'expected a forward, backward, and selected spelling for every note');
    });

    // After a just-played G♮, the recency guard penalises the same-letter flip to G♯, so pc 8 is spelled
    // A♭ (the real-time preset has no separate co-onset sounding-tiebreak mechanism, see the
    // soundingTiebreak audit note in CLAUDE.local.md). This pins that real-time tradeoff, which nets
    // positive corpus-wide.
    test('recency guard spells pc 8 as A♭ right after a G♮', () => {
        const s = new Speller();
        for (const [i, midi] of [60, 62, 64, 65, 67, 68].entries()) {
            s.noteOn(midi, { t: i * 1000 });
            if (midi !== 68) s.noteOff(midi);
        }
        assertEq(tok(s.getSpelling(68)), 'Ab');
    });
});

suite('aug6 outward convergence', () => {
    /** Chords one onset apart; the pair (hi, lo) at chord `at` gets its outward context when `ctx`. No
     *  resolveDir, so only the aug6 rule can tell the ♯4 from the minor seventh. */
    const run = (chords: number[][], at: number, hi: number, lo: number, ctx: boolean): string => {
        const s = new Speller({ lookAhead: true });
        chords.forEach((c, k) => {
            if (k) for (const m of chords[k - 1]!) s.noteOff(m, { t: k * 500 });
            for (const m of c) s.noteOn(m, ctx && k === at && (m === hi || m === lo)
                ? { t: k * 500, outwardPartner: m === hi ? lo : hi, outwardRole: m === hi ? 1 : -1 } : { t: k * 500 });
        });
        return chords[chords.length - 1]!.map(m => tok(s.getSpelling(m))).join(' ');
    };
    const cMinor = [[48, 60, 63, 67], [53, 60, 65, 68], [55, 59, 62, 67], [48, 60, 63, 67]];

    test('a German sixth in C minor spells its rising tone F♯, and G♭ without the context', () => {
        const ger6 = [...cMinor, [56, 60, 63, 66]];
        assertEq(run(ger6, 4, 66, 56, true), 'Ab C Eb F#');
        assertEq(run(ger6, 4, 66, 56, false), 'Ab C Eb Gb');
    });

    test('key gate: a dominant seventh whose diatonic seventh rises (E7/D → D♯) keeps D', () => {
        const aMajor = [[45, 57, 61, 64], [50, 57, 62, 66], [52, 56, 59, 64], [45, 57, 61, 64], [50, 52, 56, 59]];
        assertEq(run(aMajor, 4, 50, 52, true), 'D E G# B');
    });

    test('outwardPairs: tones that leave outward and meet on one pitch class pair up', () => {
        // A♭ C E♭ F♯ → G B D G: F♯ rises to G, A♭ falls to G.
        const notes = [[56, 60, 63, 66], [55, 59, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k, tOff: k + 1 })));
        const op = outwardPairs(notes);
        assertEq(op.partner[3], 0); assertEq(op.role[3], 1);     // F♯, rising
        assertEq(op.partner[0], 3); assertEq(op.role[0], -1);    // A♭, falling
    });

    test('outwardPairs: no pair when a tone first moves the other way, or without the third', () => {
        // F♯ first falls to F, then a later onset happens to hold G with G: not a convergence.
        const fallsFirst = [[56, 60, 63, 66], [56, 60, 63, 65], [55, 59, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k, tOff: k + 1 })));
        assert(outwardPairs(fallsFirst).partner.every(p => p < 0), 'pair despite a falling first move');
        const noThird = [[56, 63, 66], [55, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k, tOff: k + 1 })));
        assert(outwardPairs(noThird).partner.every(p => p < 0), 'pair without the major third above the lower tone');
    });

    test('spellTwoPass options: the rule and the wedge can be switched off', () => {
        const notes = [...cMinor, [56, 60, 63, 66], [55, 59, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        assertEq(spellTwoPass(notes, { aug6Outward: false, aug6Wedge: false }).length, notes.length);
        assertEq(tok({ ...spellTwoPass(notes)[19]!, octave: 4 }), 'F#');
    });
});

suite('resolved surface', () => {
    // The surface includes the note just committed: its letter's slot holds exactly its spelling.
    for (const id of FIXTURES) {
        for (const lookAhead of [false, true]) {
            test(`${id}: ${lookAhead ? 'look-ahead' : 'real-time'} surface holds each committed note`, () => {
                const s = new Speller({ lookAhead });
                for (const e of loadEvents(id)) {
                    if (e.type !== 'on') { s.noteOff(e.midi); continue; }
                    s.noteOn(e.midi, { t: e.t });
                    const sp = s.getSpelling(e.midi)!;
                    const slot = s.getResolvedScale()!.find(p => p.step === sp.step)!;
                    assert(slot.alter === sp.alter, `${id} t=${e.t}: committed ${tok(sp)}, surface ${tok({ ...slot, octave: 0 })}`);
                }
            });
        }
    }
});

suite('onset tolerance', () => {
    // A performed chord: the k-th distinct pitch of each onset arrives 7k ms late (a unison keeps its
    // pitch's time, so it stays one onset).
    const spread = (events: ReturnType<typeof loadEvents>) => {
        let t0 = NaN, k = 0;
        const at = new Map<number, number>();
        return events.map(e => {
            if (e.type !== 'on') return e;
            if (e.t !== t0) { t0 = e.t; k = 0; at.clear(); }
            if (!at.has(e.midi)) at.set(e.midi, e.t + 7 * k++);
            return { ...e, t: at.get(e.midi)! };
        });
    };

    for (const id of FIXTURES) {
        test(`${id}: spread chords with onsetTolerance spell as exact-t chords`, () => {
            const ev = loadEvents(id);
            // Same tolerance on both sides: a fixture's own near-simultaneous notes (rolled chords) group the same way.
            const exact = drive(new Speller({ onsetTolerance: 50 }), ev);
            const spreadOut = drive(new Speller({ onsetTolerance: 50 }), spread(ev));
            const diff = exact.findIndex((t, i) => t !== spreadOut[i]);
            assert(diff < 0, `${id}: onset ${diff}: ${exact[diff]} vs ${spreadOut[diff]}`);
        });
    }
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
