/**
 * Product smoke + curated fixture replay.
 * Confirms Speller / look-ahead / two-pass run and commit one spelling per onset.
 * Spelling *correctness* against ground truth is graded by the parity bench
 * (`test/eval/run.ts`); this file only checks that every onset commits a reading.
 */

import { assert, assertEq, suite, test } from './framework.js';
import { Speller, degreeKeys, dominantChords, localKeys, outwardPairs, resolutionDirs, resolveStep, sideKeys, centredSideKeys, spellTwoPass, type Pitch, type PitchClass } from '../src/index.js';
import { isKeyDegree, isWideLeadingTone } from '../src/key.js';
import { spellTwoPassTraced } from '../src/two-pass.js';
import { SpellingEngine, LA_PRESET, RT_PRESET, TP_PASS_PRESET } from '../src/engine.js';
import { anchoredSideKeys } from '../src/key-side.js';
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

    test('outwardPairs: a German sixth repeated past the window still meets by its first moves', () => {
        // A♭ C E♭ F♯ struck ten times, then G B D G: the meeting onset is beyond the 8-onset window, but the
        // first moves of F♯ and A♭ (re-strikes skipped) land on that one onset.
        const ger6 = [56, 60, 63, 66];
        const chords = [...Array.from({ length: 10 }, () => ger6), [55, 59, 62, 67]];
        const notes = chords.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k, tOff: k + 1 })));
        const op = outwardPairs(notes);
        assertEq(op.partner[3], 0); assertEq(op.role[3], 1);
        assert(outwardPairs(notes, 8, { firstMoveMeet: false }).partner.slice(0, 4).every(p => p < 0), 'met inside the window without first moves');
    });

    test('outwardPairs: a unison meet pairs only when it resolves into a chord (chordMeet)', () => {
        // C F♯ A♭ → G: F♯ rises and A♭ falls onto ONE G. A bare G is two voices passing; a struck G chord is an aug6.
        const at = (chords: number[][]) => chords.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k, tOff: k + 1 })));
        const bare = at([[60, 66, 68], [67]]), chord = at([[60, 66, 68], [55, 59, 67]]);
        assert(outwardPairs(bare).partner.every(p => p < 0), 'paired on a bare unison');
        assertEq(outwardPairs(bare, 8, { chordMeet: 0 }).partner[1], 2);
        assertEq(outwardPairs(chord).partner[1], 2); assertEq(outwardPairs(chord).role[1], 1);
    });

    test('key → side: a D♭-major passage is read as D♭ (−5) and holds the flat side', () => {
        // I–IV–V–I in D♭ major, four times. Keyless, the speller parks sharp and spells the tonic C♯–E♯–G♯.
        const prog = [[49, 61, 65, 68], [54, 61, 66, 70], [56, 60, 63, 68], [49, 61, 65, 68]];
        const notes = Array.from({ length: 16 }, (_, k) => prog[k % 4]!.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 }))).flat();
        const x = sideKeys(notes);
        assert(x.every(v => v === -5), `side keys ${x.join(',')}`);
        const spell = (side: boolean) => {
            const s = new Speller({ lookAhead: true });
            notes.forEach((n, i) => s.noteOn(n.midi, { t: n.tOn, ...(side ? { sideKey: x[i]! } : {}) }));
            return [61, 65, 68].map(m => tok(s.getSpelling(m))).join(' ');
        };
        assertEq(spell(false), 'C# E# G#');
        assertEq(spell(true), 'Db F Ab');
    });

    test('a dominant names its tendency tones: E7 → Am7 keeps the G♯ against a falling line', () => {
        // Op. 28 No. 4 m3–5 in outline: D ø7 (F A♭ D C) → E7 (E G♯ D B) → Am7 over G. The G♯ falls to the bass G,
        // so the look-ahead votes A♭ (and the D ø7 just wrote A♭); E7 resolves a fifth down, so G♯ is its third.
        const prog = [[53, 56, 62, 72], [52, 56, 62, 71], [43, 57, 60, 64]];
        const notes = prog.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        const doms = dominantChords(notes);
        assertEq(doms.map(d => d ? d.root : '.').join(' '), '. . . . 4 4 4 4 . . . .');
        // Reach: the same E7 struck again before the Am7 is skipped (same root); one onset of reach does not see past it.
        const twice = [[52, 56, 62, 71], [52, 56, 62, 71], [43, 57, 60, 64]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        assert(dominantChords(twice)[0] !== null, 'reach 16 sees the Am7');
        assert(dominantChords(twice, { reach: 1, unit: 'onsets' })[0] === null, 'reach 1 does not');
        const spell = (use: boolean) => {
            const s = new Speller({ lookAhead: true });
            let gs = '';
            notes.forEach((n, i) => {
                let dir = 0;
                for (let j = i + 1; j < notes.length && !dir; j++) if (notes[j]!.tOn !== n.tOn) dir = resolveStep(n.midi, notes[j]!.midi);
                if (n.tOn === 1000 && !gs) gs = tok(s.getSpelling(56));
                s.noteOn(n.midi, { t: n.tOn, resolveDir: dir, ...(use ? { dominant: doms[i] } : {}) });
            });
            return gs;
        };
        assertEq(spell(false), 'Ab');
        assertEq(spell(true), 'G#');
    });

    test('resolutionDirs: past the 16-note buffer, follow the note\'s own voice until it moves by a semitone', () => {
        // G♯4 (68) struck with E3 (52) ten times, then a tone up (70: does not end the wait), then A4 (69). The
        // 16-note buffer holds only repeats and the E3s, so it is silent; the own voice rises a semitone.
        const notes = [...Array.from({ length: 10 }, (_, k) => [52, 68].map(m => ({ midi: m, tOn: k * 250 }))).flat(),
            { midi: 70, tOn: 2500 }, { midi: 69, tOn: 2750 }];
        const r = resolutionDirs(notes);
        assertEq(r.dir[1], 1); assertEq(r.exact[1], 1);
        assertEq(resolutionDirs(notes, { mode: 'window' }).dir[1], 0);
        assertEq(resolutionDirs(notes, { max: 16 }).dir[1], 0);
        // Inside the buffer the rule is unchanged: a co-struck semitone still counts.
        assertEq(resolutionDirs([{ midi: 68, tOn: 0 }, { midi: 67, tOn: 0 }, { midi: 69, tOn: 1 }]).dir[0], -1);
    });

    test('spellTwoPass options: the rule and the wedge can be switched off', () => {
        const notes = [...cMinor, [56, 60, 63, 66], [55, 59, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        assertEq(spellTwoPass(notes, { aug6Outward: false, aug6Wedge: false }).length, notes.length);
        assertEq(tok({ ...spellTwoPass(notes)[19]!, octave: 4 }), 'F#');
        assertEq(spellTwoPass(notes, { triangleFreeContext: false }).length, notes.length);
        assertEq(spellTwoPass(notes, { keySide: false }).length, notes.length);
        assertEq(spellTwoPass(notes, { struckTriadThird: false }).length, notes.length);
    });

    test('spellTwoPass struckTriadThird: a struck triad spells its third member', () => {
        // Clair de lune m36:1, D♭–F–A♭ struck together (D♭ doubled in the bass): the merge wrote E♯ for Debussy's F
        // (E♯–A♭, a diminished fourth inside the triad); the rule completes the triad.
        const notes = onNotes(loadEvents('debussy_clair_de_lune'));
        assertEq([notes[831]!.midi, notes[831]!.tOn], [77, 78750]);
        assertEq(tok({ ...spellTwoPass(notes)[831]!, octave: 5 }), 'F');
        assertEq(tok({ ...spellTwoPass(notes, { struckTriadThird: false })[831]!, octave: 5 }), 'E#');
    });

    test('centredSideKeys reads the offline side key on centred onsets', () => {
        // D♭ major, I–IV–V–I (D♭ F A♭ / G♭ B♭ D♭ / A♭ C E♭ / D♭ F A♭): the side key is D♭ (−5) at every note.
        const chords = [[61, 65, 68], [66, 70, 73], [68, 72, 75], [61, 65, 68]];
        const notes = chords.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500 })));
        const x = centredSideKeys(notes);
        assertEq(x.length, notes.length);
        assert(x.every(v => v === -5), `D♭ major reads −5, got ${x.join(',')}`);
    });

    test('centredSideKeys keyReturn: a key keeps its side on return after a forced respell', () => {
        // Pathétique ii: A♭ minor (−7) → F♭ major, past the ±7 limit, forced to E major (+4, from m42) → A♭ minor
        // again (m47:2.33, note 992). The return keeps A♭ minor's −7; without the rule it chains from E to G♯ minor (+5).
        const notes = onNotes(loadEvents('beethoven_pathetique_adagio'));
        const on = centredSideKeys(notes), off = centredSideKeys(notes, undefined, false);
        assertEq([on[814], off[814]], [4, 4]);
        assertEq([on[992], off[992]], [-7, 5]);
        assert(on.slice(992, 1172).every(v => v === -7), 'A♭ minor holds −7 until m53');
        assertEq(spellTwoPass(notes, { keyReturn: false }).length, notes.length);
    });

    test('spellTwoPass keySignatures: a six-flat signature settles the F♯/G♭ tie flat', () => {
        // E♭ minor / G♭ major (i iv V i III v III). The inferred key has six accidentals and cannot choose, so the
        // passes count from C and come out in D♯ minor; the notated six flats (or six sharps) choose the side.
        const chords = [[51, 58, 63, 66], [56, 59, 63, 68], [58, 62, 65, 70], [51, 58, 63, 66], [54, 61, 66, 70], [49, 56, 61, 65], [54, 58, 61, 66]];
        const notes = chords.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        const spell = (o: object) => spellTwoPass(notes, o).map(p => tok({ ...p!, octave: 4 })).join(' ');
        const flat = 'Eb Bb Eb Gb Ab Cb Eb Ab Bb D F Bb Eb Bb Eb Gb Gb Db Gb Bb Db Ab Db F Gb Bb Db Gb';
        assertEq(spell({ keySignatures: notes.map(() => -6) }), flat);
        assert(spell({}).startsWith('D# A# D# F#'), 'without a signature the tie counts from C (sharp)');
        assert(spell({ keySignatures: notes.map(() => 6) }).endsWith('F# A# C# F#'), 'six sharps keep the sharp side throughout');
        assertEq(spell({ keySignatures: notes.map(() => -6), keySignatureAnchor: false }), spell({}));
    });

    test('spellTwoPass keySignatures: a passage far from its signature keeps the inferred side', () => {
        // Pathétique ii, four flats throughout: the E major passage (m42–49, note 814) is four fifths from the
        // signature, so its side stays the inferred key's (+4); the A♭ major opening is anchored on −4.
        const notes = onNotes(loadEvents('beethoven_pathetique_adagio'));
        const sigs = notes.map(() => -4);
        const inferred = centredSideKeys(notes);
        const anchored = anchoredSideKeys(notes, sigs, inferred);
        assertEq([anchored[0], anchored[814]], [-4, 4]);
        assertEq(JSON.stringify(spellTwoPass(notes, { keySignatures: sigs }).slice(814, 992)), JSON.stringify(spellTwoPass(notes).slice(814, 992)));
    });

    test('spellTwoPass keySignatures: the dominant of a seven-sharp signature keeps the sharp side', () => {
        // G♯ major, I IV V7 I twice, under seven sharps (C♯ major's dominant, as in WTC I/3). G♯ major needs eight
        // sharps, so its reading within ±7 is A♭ major; the signature's neighbourhood is measured without that limit.
        const chords = [[56, 60, 63, 68], [49, 61, 65, 68], [51, 63, 67, 70, 73], [56, 60, 63, 68]];
        const notes = [...chords, ...chords].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        const spell = (o: object) => spellTwoPass(notes, o).map(p => tok({ ...p!, octave: 4 })).join(' ');
        assertEq(anchoredSideKeys(notes, notes.map(() => 7), centredSideKeys(notes))[0], 7);
        assert(spell({ keySignatures: notes.map(() => 7) }).startsWith('G# B# D# G# C# C# E# G# D# D# F## A# C#'), 'seven sharps: G♯ major with F𝄪');
        assert(spell({}).startsWith('Ab C Eb'), 'keyless: A♭ major');
        assertEq(spell({ keySignatures: notes.map(() => -7) }), spell({}));
    });

    test('spellTwoPass keySignatures: none, all unknown, or anchor off is identical to before', () => {
        const notes = onNotes(loadEvents('debussy_clair_de_lune'));
        const before = JSON.stringify(spellTwoPass(notes));
        assertEq(JSON.stringify(spellTwoPass(notes, { keySignatures: notes.map(() => null) })), before);
        assertEq(JSON.stringify(spellTwoPass(notes, { keySignatures: notes.map(() => -5), keySignatureAnchor: false })), before);
        assertEq(JSON.stringify(spellTwoPass(notes, { keySignatures: notes.map(() => -5), keySide: false })), JSON.stringify(spellTwoPass(notes, { keySide: false })));
        let threw = false; try { spellTwoPass(notes, { keySignatures: [0] }); } catch { threw = true; }
        assert(threw, 'a keySignatures array of the wrong length throws');
    });

    test('spellTwoPass shortFlip: a short off-side region inside agreeing surroundings takes their side', () => {
        // Handel Op. 2/9 iv, notes around m71–76 (Meredith; onset.duration in tatums of 125 ms, then midi). E major → G♯ minor →
        // C♯ minor, all sharp in Handel. The merge took the flat pass for about 30 onsets inside sharp context
        // (A♭ minor, D♭ minor, B𝄫, E𝄫); the rule gives the region back to the sharp pass, Handel's spelling.
        const notes = ('0.4.76 4.8.49 4.4.73 4.2.76 6.2.73 8.2.68 8.8.80 10.2.73 12.8.61 12.2.76 14.2.73 16.2.68 16.8.76 18.2.73 ' +
            '20.8.61 20.2.76 22.2.73 24.2.68 24.4.73 26.2.73 28.8.60 28.72.68 28.24.75 28.24.78 32.8.78 36.8.60 40.8.75 ' +
            '44.8.60 48.4.68 52.8.61 52.24.73 52.24.76 56.8.80 60.8.49 64.8.76 68.8.49 72.4.73 76.8.56 76.24.72 76.4.75 ' +
            '76.24.80 80.4.72 84.8.56 84.16.68 92.8.56 100.8.53 100.48.65 100.24.73 100.24.80 104.8.83 108.8.53 112.8.80 ' +
            '116.8.53 120.8.73 124.8.53 124.24.73 124.24.83 128.8.80 132.8.53 136.8.77 140.8.53 144.8.73 148.8.54 ' +
            '148.24.66 148.24.73 148.24.81 152.4.69 156.8.54 156.16.66 164.8.54 172.8.55 172.48.67 172.24.75 172.24.82 ' +
            '176.8.85 180.8.55 184.8.82 188.8.55 192.8.75 196.8.55 196.24.75 196.24.85 200.8.82 204.8.55 208.8.79 ' +
            '212.8.55 216.8.75 220.8.56 220.24.68 220.24.75 220.24.83 224.4.71 228.8.56 228.16.68 236.8.56 244.8.48 ' +
            '244.24.66 244.24.75 244.24.81 248.8.81 252.8.48 256.8.78 260.8.48 264.8.75 268.8.48 268.24.68 268.24.75 ' +
            '268.24.78 272.8.80 276.8.48 280.8.75 284.8.48 288.4.68 292.8.49 292.24.68 292.24.73 292.24.76 292.4.80 ' +
            '296.4.76 300.8.49 300.16.73 308.8.49 316.8.53 316.24.59 316.24.68 316.24.74 320.8.74 324.8.53 328.8.71 ' +
            '332.8.53 336.8.68 340.8.53 340.24.61 340.24.68 340.24.73 344.8.73 348.8.53 352.8.68 356.8.53 360.4.61 ' +
            '364.8.54 364.24.61 364.24.66 364.24.69 364.4.73 368.4.69 372.8.54 372.16.66 380.8.54 388.8.46 388.24.58 ' +
            '388.24.66 388.24.73 388.4.76 392.8.66 396.8.46 400.8.73 404.8.46 408.4.76 412.8.47 412.24.59 412.24.66 ' +
            '412.24.75 420.8.47 428.8.47').split(' ').map(s => s.split('.').map(Number))
            .map(([on, dur, midi]) => ({ midi: midi!, tOn: on! * 125, tOff: (on! + dur!) * 125 }));
        const spell = (o: object) => spellTwoPass(notes, o).map(p => tok({ ...p!, octave: 4 }));
        const on = spell({ runRepair: false }), off = spell({ shortFlip: false, runRepair: false });   // shortFlip alone
        const changed = on.flatMap((s, k) => s === off[k] ? [] : [k]);
        assertEq([changed.length, changed[0], changed[changed.length - 1]], [47, 70, 129]);
        assertEq([off[86], off[95], off[98], off[116], off[122]], ['Eb', 'C', 'Bbb', 'Fb', 'F']);
        assertEq([on[86], on[95], on[98], on[116], on[122]], ['D#', 'B#', 'A', 'E', 'E#']);
        assertEq([off[70], on[70]], ['G', 'F##']);
    });
});

suite('leading-tone gate', () => {
    const dMinor = [[50, 62, 65, 69], [55, 62, 67, 70], [57, 61, 64, 67], [50, 62, 65, 69]];
    const notesOf = (chords: number[][]) => chords.flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500 })));
    /** The look-ahead votes (laDelta) on the last note after `chords`, struck with `ctx`. */
    const votes = (chords: number[][], midi: number, ctx: { resolveDir: number; key: { tonic: number; minor: boolean } | null }, gate = true): string => {
        const e = new SpellingEngine({ ...LA_PRESET, leadingToneGate: gate });
        chords.forEach((c, k) => {
            if (k) for (const m of chords[k - 1]!) e.noteOff(m, k * 500);
            for (const m of c) e.noteOn(m, k * 500);
        });
        e.noteOn(midi, chords.length * 500, ctx.resolveDir, 0, undefined, 0, ctx.key);
        return e.decision()!.candidates.map(c => `${tok({ ...c.c, octave: 4 })}${c.laDelta}`).sort().join(' ');
    };

    test('localKeys reads D minor around a D-minor cadence, with either table', () => {
        for (const table of ['temperley', 'tonic-triad'] as const) {
            const k = localKeys(notesOf(dMinor), { table, radius: 6 });
            assert(k.every(x => x !== null && x.tonic === 2 && x.minor), `${table}: ${JSON.stringify(k[0])}`);
        }
    });

    test('localKeys reads a window of onsets centred on the note', () => {
        // Four onsets of C major, then four of F♯ major: radius 1 sees only its neighbours.
        const cMaj = [60, 64, 67], fsMaj = [66, 70, 73];
        const k = localKeys(notesOf([cMaj, cMaj, cMaj, cMaj, fsMaj, fsMaj, fsMaj, fsMaj]), { radius: 1 });
        assertEq(k[0]!.tonic, 0); assertEq(k[k.length - 1]!.tonic, 6);
    });

    test('a falling C♯ in D minor gets no letter-step vote; without the key it votes D♭', () => {
        // A C-major chord last, so the surface spells C (the falling target) rather than keeping A7's C♯.
        const dm = { tonic: 2, minor: true }, withC = [...dMinor, [48, 60, 64, 67]];
        assertEq(votes(withC, 61, { resolveDir: -1, key: dm }), 'B##0 C#0 Db0');
        assertEq(votes(withC, 61, { resolveDir: -1, key: null }), 'B##0 C#-2 Db2');
        assertEq(votes(withC, 61, { resolveDir: -1, key: dm }, false), 'B##0 C#-2 Db2');
    });

    test('rising notes and non-leading tones keep the look-ahead', () => {
        const dm = { tonic: 2, minor: true };
        // (Rising into the natural D: the leading-tone boost adds 1 to the step vote.)
        assertEq(votes(dMinor, 61, { resolveDir: 1, key: dm }), 'B##0 C#3 Db-3');
        // E♭ falling in D minor is not one of its leading tones (♯4 G♯, raised 6th B, raised 7th C♯).
        assert(votes(dMinor, 63, { resolveDir: -1, key: dm }).includes('2'), 'E♭/D♯ lost its look-ahead vote');
    });

    test('spellTwoPass: the gate can be switched off', () => {
        const notes = [...dMinor, [53, 61], [53, 60], [58, 62, 65]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        assertEq(spellTwoPass(notes, { leadingToneGate: false }).length, notes.length);
        assertEq(spellTwoPass(notes).length, notes.length);
    });
});

suite('key-degree gate', () => {
    /** The look-ahead votes on the last note after `chords`, struck with `resolveDir` and the key-degree key. */
    const votes = (chords: number[][], midi: number, resolveDir: number, key: { tonic: number; minor: boolean } | null, gate = true): string => {
        const e = new SpellingEngine({ ...LA_PRESET, keyDegreeGate: gate });
        chords.forEach((c, k) => {
            if (k) for (const m of chords[k - 1]!) e.noteOff(m, k * 500);
            for (const m of c) e.noteOn(m, k * 500);
        });
        e.noteOn(midi, chords.length * 500, resolveDir, 0, undefined, 0, null, key);
        return e.decision()!.candidates.map(c => `${tok({ ...c.c, octave: 4 })}${c.laDelta}`).sort().join(' ');
    };
    // C major, then D major: the surface spells F♯, so F rising to F♯ has a letter-step target.
    const ctx = [[48, 60, 64, 67], [50, 62, 66, 69]];

    test('in C major F rising to F♯ keeps F (F♯ is not in the key); in A major it votes E♯', () => {
        assertEq(votes(ctx, 65, 1, { tonic: 0, minor: false }), 'E#0 F0 Gbb0');
        assertEq(votes(ctx, 65, 1, { tonic: 9, minor: false }), 'E#2 F-2 Gbb0');
        assertEq(votes(ctx, 65, 1, null), 'E#2 F-2 Gbb0');
        assertEq(votes(ctx, 65, 1, { tonic: 0, minor: false }, false), 'E#2 F-2 Gbb0');
    });

    test('isKeyDegree: major degrees, and natural minor with the raised 6th and 7th', () => {
        const c = { tonic: 0, minor: false }, am = { tonic: 9, minor: true };
        assertEq([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(p => isKeyDegree(p, c)).join(','), '0,2,4,5,7,9,11');
        assertEq([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(p => isKeyDegree(p, am)).join(','), '0,2,4,5,6,7,8,9,11');
    });

    test('degreeKeys counts notes, not onsets; spellTwoPass: the gate can be switched off', () => {
        const notes = [...ctx, [53, 65], [54, 66], [55, 59, 62, 67]].flatMap((c, k) => c.map(m => ({ midi: m, tOn: k * 500, tOff: k * 500 + 500 })));
        assertEq(degreeKeys(notes).length, notes.length);
        assertEq(spellTwoPass(notes, { keyDegreeGate: false }).length, notes.length);
        assertEq(spellTwoPass(notes).length, notes.length);
    });
});

suite('held-letter target', () => {
    /** The look-ahead votes on F♯/G♭ rising (resolveDir +1) after `chords`, with the leading-tone gate's key. */
    const votes = (chords: number[][], key: { tonic: number; minor: boolean } | null, held = true): string => {
        const e = new SpellingEngine({ ...LA_PRESET, heldLetterTarget: held });
        chords.forEach((c, k) => {
            if (k) for (const m of chords[k - 1]!) e.noteOff(m, k * 500);
            for (const m of c) e.noteOn(m, k * 500);
        });
        e.noteOn(66, chords.length * 500, 1, 1, undefined, 0, key);
        return e.decision()!.candidates.map(c => `${tok({ ...c.c, octave: 4 })}${c.laDelta}`).sort().join(' ');
    };
    // C major, then E♭–G♭–B♭–D♭ over it: the G slot holds G♭, so F♯ rising to G finds no G in the surface.
    const cM = [48, 60, 64, 67], ctx = [cM, cM, [51, 54, 58, 61]];

    test('F♯ rising to G while G♭ holds the G slot votes the step when the key names F♯ a leading tone', () => {
        assertEq(votes(ctx, { tonic: 7, minor: false }), 'E##0 F#2 Gb-2');            // G major: F♯ is its ♮7
        assertEq(votes(ctx, { tonic: 7, minor: false }, false), 'E##0 F#0 Gb0');
        assertEq(votes(ctx, { tonic: 1, minor: false }), 'E##0 F#0 Gb0');             // D♭ major: G♭ is its 4th
        assertEq(votes(ctx, null), 'E##0 F#0 Gb0');
    });

    test('isWideLeadingTone: major ♮7 ♯4 ♯1 ♯5 2; minor ♯7 ♯4 ♯6 ♯1 2', () => {
        const c = { tonic: 0, minor: false }, am = { tonic: 9, minor: true };
        assertEq([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(p => isWideLeadingTone(p, c)).join(','), '1,2,6,8,11');
        assertEq([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(p => isWideLeadingTone(p, am)).join(','), '3,6,8,10,11');
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

suite('key signature (keyTonic / setKey)', () => {
    // The signature names the collection until the music contradicts it: a note with no context takes the
    // signature's spelling, and after setKey, the new signature's. Both latency modes share the key path.
    const LOF_STEP = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
    const lofName = (n: number): string => { const a = Math.floor((n + 1) / 7); return LOF_STEP[n + 1 - 7 * a]! + (a > 0 ? '#'.repeat(a) : 'b'.repeat(-a)); };
    const lofPc = (n: number): number => ((7 * n) % 12 + 12) % 12;
    /** Play `steps` (each a chord of MIDI keys, 500 ms apart); `before[i]` runs before step i. */
    const play = (s: Speller, steps: number[][], before: Record<number, (s: Speller) => void> = {}): string => {
        let t = 0;
        return steps.map((ch, i) => {
            before[i]?.(s);
            for (const m of ch) s.noteOn(m, { t });
            const names = ch.map(m => tok(s.getSpelling(m))).join(' ');
            t += 500;
            for (const m of ch) s.noteOff(m, { t });
            return names;
        }).join(' | ');
    };
    for (const lookAhead of [false, true]) {
        const mode = lookAhead ? 'look-ahead' : 'real-time';
        const keyed = (keyTonic: number) => new Speller({ keyTonic, lookAhead });

        test(`${mode}: a first note takes the signature's spelling, for every key from 7 flats to 7 sharps`, () => {
            for (let k = -7; k <= 7; k++) for (let n = k - 1; n <= k + 5; n++) {
                assertEq(play(keyed(k), [[60 + lofPc(n)]]), lofName(n), `key ${k}: first ${lofName(n)}`);
            }
        });

        test(`${mode}: in three flats (C minor) a first A♭ is A♭`, () => {
            assertEq(play(keyed(-3), [[68]]), 'Ab');
        });

        test(`${mode}: a D♭-major scale from a cold start is spelled in D♭`, () => {
            assertEq(play(keyed(-5), [[61], [63], [65], [66], [68], [70], [72], [73]]), 'Db | Eb | F | Gb | Ab | Bb | C | Db');
        });

        test(`${mode}: a C♭-major scale from a cold start is spelled in C♭`, () => {
            assertEq(play(keyed(-7), [[59], [61], [63], [64], [66], [68], [70], [71]]), 'Cb | Db | Eb | Fb | Gb | Ab | Bb | Cb');
        });

        test(`${mode}: after C major, setKey(D♭) spells the first D♭ triad in D♭`, () => {
            assertEq(play(keyed(0), [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67], [61, 65, 68], [66, 70, 73]], { 4: s => s.setKey(-5) }),
                'C E G | F A C | G B D | C E G | Db F Ab | Gb Bb Db');
        });

        test(`${mode}: setKey mid-stream in a keyless start names the new collection`, () => {
            assertEq(play(new Speller({ lookAhead }), [[60, 64, 67], [68]], { 1: s => s.setKey(-3) }), 'C E G | Ab');
        });

        test(`${mode}: the signature names only what the music has not contradicted (C major, E G♯ B A keeps G♯)`, () => {
            assertEq(play(keyed(0), [[64], [68], [71], [69]]), 'E | G# | B | A');
            assertEq(play(keyed(0), [[64, 68, 71], [57, 60, 64]]), 'E G# B | A C E');
        });

        test(`${mode}: restating the current key changes nothing`, () => {
            const steps = [[60], [63], [67], [66], [68], [61]];
            assertEq(play(keyed(-3), steps, { 3: s => s.setKey(-3) }), play(keyed(-3), steps));
        });
    }

    // A key the caller gives outranks the speller's own key estimate. The look-ahead's inferred side key (sideKeys)
    // used to re-centre the fold whenever it changed, so under a notated D♭ signature an inferred C♯ major (+7)
    // folded the frame back to sharps one note after the signature placed it (Chopin Op. 28/15 m77).
    const playSided = (s: Speller, steps: number[][], side: (i: number) => number): string => {
        let t = 0;
        return steps.map((ch, i) => {
            for (const m of ch) s.noteOn(m, { t, sideKey: side(i) });
            const names = ch.map(m => tok(s.getSpelling(m))).join(' ');
            t += 500;
            for (const m of ch) s.noteOff(m, { t });
            return names;
        }).join(' | ');
    };
    const dflat = [[61, 65, 68], [66, 70, 73], [68, 72, 75], [61, 65, 68], [63, 66, 70], [68, 72, 75], [61, 65, 68]];
    test('look-ahead: an inferred C♯ major does not pull a D♭ signature to sharps', () => {
        assertEq(playSided(new Speller({ lookAhead: true, keyTonic: -5 }), dflat, i => (i < 2 ? -5 : 7)),
            'Db F Ab | Gb Bb Db | Ab C Eb | Db F Ab | Eb Gb Bb | Ab C Eb | Db F Ab');
    });
    // The signature decides the side (the comma) of the inferred key, not the key: an inferred key a comma away
    // from a conventional reading nearer the signature takes that reading (C♯ major under five flats → D♭ major);
    // a modulation the signature does not name still moves the fold (F minor under four sharps; Grieg's Morning
    // Mood m38, whose C F A would otherwise drift to B♯ E♯ G𝄪).
    test('look-ahead: under a signature the inferred key keeps its key and takes the signature\'s side', () => {
        const fold = (sig: number, sides: number[]): number => {
            const e = new SpellingEngine(LA_PRESET);
            e.keySignature(sig);
            sides.forEach((x, k) => { e.sideKey(x); e.noteOn(60, k * 500); e.noteOff(60, k * 500 + 250); });
            return (e as unknown as { foldCenter: number }).foldCenter - 2;
        };
        assertEq(fold(-5, [-5, 7]), -5, 'C♯ major (+7) under D♭ major: D♭ major');
        assertEq(fold(4, [4, -4]), -4, 'A♭ major (−4) under E major: A♭ major, no G♯ major (+8)');
        assertEq(fold(0, [0, -7]), 5, 'C♭ major (−7) under C major: B major (+5), the nearer conventional side');
        assertEq(fold(-1, [-1, 6]), -6, 'the F♯/G♭ tie under one flat: G♭ major');
        assertEq(fold(7, [7, -4]), 8, 'A♭ major (−4) under seven sharps: G♯ major (+8), one fifth from the signature');
        assertEq(fold(-7, [-7, 4]), -8, 'E major (+4) under seven flats: F♭ major (−8), one fifth from the signature');
    });
});

suite('seven-accidental twin (real-time frameTwin)', () => {
    // A frame move to a collection that needs seven accidentals lands on its five-accidental twin: E → B → F♯ →
    // C♯ major by fifths, each key a run of I–IV–V–I cadences, ends in D♭ major in real time. With a key supplied
    // the signature names the side and the rule is off.
    const cadence = (t: number): number[][] => [[t, t + 4, t + 7], [t + 5, t + 9, t + 12], [t + 7, t + 11, t + 14], [t, t + 4, t + 7]].map(c => c.map(m => 48 + m));
    const steps = [4, 11, 6, 1].flatMap(k => Array.from({ length: 16 }, () => cadence(k)).flat());
    const lastCadence = (s: { noteOn(m: number, c: { t: number }): void; noteOff(m: number, c: { t: number }): void; getSpelling(m: number): Pitch | null }): string => {
        let t = 0;
        const out = steps.map(ch => {
            for (const m of ch) s.noteOn(m, { t });
            const names = ch.map(m => tok(s.getSpelling(m))).join(' ');
            t += 500;
            for (const m of ch) s.noteOff(m, { t });
            return names;
        });
        return out.slice(-4).join(' | ');
    };
    test('real-time: C♯ major reached by fifths is written D♭ major', () => {
        assertEq(lastCadence(new Speller()), 'Db F Ab | Gb Bb Db | Ab C Eb | Db F Ab');
    });
    test('without the rule the frame keeps C♯ major by continuity', () => {
        const e = new SpellingEngine({ ...RT_PRESET, frameTwin: false });
        assertEq(lastCadence({ noteOn: (m, c) => e.noteOn(m, c.t), noteOff: (m, c) => e.noteOff(m, c.t), getSpelling: m => e.getSpelling(m) }),
            'C# E# G# | F# A# C# | G# B# D# | C# E# G#');
    });
    test('real-time with a key supplied (E major): the rule is off', () => {
        assertEq(lastCadence(new Speller({ keyTonic: 4 })), 'C# E# G# | F# A# C# | G# B# D# | C# E# G#');
    });
    test('look-ahead does not apply the rule', () => {
        assertEq(LA_PRESET.frameTwin, undefined);
    });
});

suite('minor collection holds its leading tone (minorLeadingTone, real time and look-ahead)', () => {
    // C natural minor up the scale (only B♭ heard), then G–?–G: the frame's collection (E♭ major) is heard as its
    // relative C minor, so the chromatic note takes the raised 7th's slot: F♯ (it completes B–D–F♯), not G♭.
    const seq = [60, 62, 63, 65, 67, 68, 70, 72, 67, 66, 67];
    const last3 = (s: { noteOn(m: number, t: number): void; noteOff(m: number, t: number): void; getSpelling(m: number): Pitch | null }): string => {
        let t = 0;
        const out = seq.map(m => { s.noteOn(m, t); const n = tok(s.getSpelling(m)); t += 500; s.noteOff(m, t); return n; });
        return out.slice(-3).join(' ');
    };
    const eng = (e: SpellingEngine) => ({ noteOn: (m: number, t: number) => e.noteOn(m, t), noteOff: (m: number, t: number) => e.noteOff(m, t), getSpelling: (m: number) => e.getSpelling(m) });
    test('real-time: C minor G–F♯–G', () => {
        const sp = new Speller();
        assertEq(last3({ noteOn: (m, t) => sp.noteOn(m, { t }), noteOff: (m, t) => sp.noteOff(m, { t }), getSpelling: m => sp.getSpelling(m) }), 'G F# G');
    });
    test('without the rule the chromatic note is G♭', () => {
        assertEq(last3(eng(new SpellingEngine({ ...RT_PRESET, minorLeadingTone: false }))), 'G Gb G');
    });
    test('look-ahead: C minor G–F♯–G, as real time', () => {
        const sp = new Speller({ lookAhead: true });
        assertEq(last3({ noteOn: (m, t) => sp.noteOn(m, { t }), noteOff: (m, t) => sp.noteOff(m, { t }), getSpelling: m => sp.getSpelling(m) }), 'G F# G');
    });
    test('look-ahead without the rule: G♭', () => {
        assertEq(last3(eng(new SpellingEngine({ ...LA_PRESET, minorLeadingTone: false }))), 'G Gb G');
    });
    test('two-pass does not apply the rule', () => {
        assertEq(TP_PASS_PRESET.minorLeadingTone, undefined);
    });
});

suite('struck triad weighs 2 in real time (verticalOwnTriad)', () => {
    // Events [t, on, midi]; each note is read at its note-off, as the parity bench reads it.
    type Ev = [number, boolean, number];
    const scale = (ms: number[]): Ev[] => ms.flatMap((m, i): Ev[] => [[i * 500, true, m], [i * 500 + 400, false, m]]);
    const chord = (t: number, ms: number[], dur = 400): Ev[] => [...ms.map((m): Ev => [t, true, m]), ...ms.map((m): Ev => [t + dur, false, m])];
    const read = (opts: typeof RT_PRESET, ev: Ev[], from: number): string => {
        const e = new SpellingEngine(opts); const out: string[] = [];
        for (const [t, on, m] of [...ev].sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]))) {
            if (on) e.noteOn(m, t); else { out.push(tok(e.getSpelling(m))); e.noteOff(m, t); }
        }
        return out.slice(from).join(' ');
    };
    const G_MAJOR = [67, 69, 71, 72, 74, 76, 78, 79], C_MAJOR = [60, 62, 64, 65, 67, 69, 71, 72], B_MINOR = [59, 61, 62, 64, 66, 67, 69, 71];
    // The real-time reading before this rule: weight 1, the triad read on committed spellings, guard window 3.
    const BEFORE = { ...RT_PRESET, verticalWeight: 1, verticalPcTriad: false, verticalOwnTriad: false, guardWindow: 3 };
    test('G major, then a struck E♭ major triad: E♭ G B♭ (the triad overrules the sharp lean)', () => {
        const ev = [...scale(G_MAJOR), ...chord(4000, [51, 55, 58])];
        assertEq(read(RT_PRESET, ev, 8), 'Eb G Bb');
        assertEq(read(BEFORE, ev, 8), 'D# G A#');
    });
    test('C major, then a struck F minor triad: F A♭ C', () => {
        const ev = [...scale(C_MAJOR), ...chord(4000, [53, 56, 60])];
        assertEq(read(RT_PRESET, ev, 8), 'F Ab C');
        assertEq(read(BEFORE, ev, 8), 'F G# C');
    });
    test('a chromatic neighbour beside a held triad is not its misspelled third: B minor + E♯', () => {
        // B–D–F♯ held, then E♯ → F♯ above it. E♯ is in no triad, so its aug2 with D is not counted.
        const ev = [...scale(B_MINOR), ...chord(4000, [47, 59, 62, 66], 1500), ...chord(4500, [77]), ...chord(5000, [78])];
        assertEq(read(RT_PRESET, ev, 8).split(' ').slice(0, 2).join(' '), 'E# F#');
        assertEq(read({ ...RT_PRESET, verticalOwnTriad: false }, ev, 8).split(' ').slice(0, 2).join(' '), 'F F#');
    });
    test('a third whose triad already sounds the other third is its neighbour: F–A–C held + G♯', () => {
        // G♯/A♭ against a ringing F–A–C is A's chromatic neighbour, not F minor's third.
        const ev = [...scale(C_MAJOR), ...chord(4000, [53, 57, 60], 1500), ...chord(4500, [68]), ...chord(5000, [69])];
        assertEq(read(RT_PRESET, ev, 8).split(' ').slice(0, 2).join(' '), 'G# A');
        assertEq(read({ ...RT_PRESET, verticalOwnTriad: false }, ev, 8).split(' ').slice(0, 2).join(' '), 'Ab A');
    });
    test('real time only: look-ahead and two-pass keep their guard', () => {
        assertEq(LA_PRESET.verticalOwnTriad, undefined);
        assertEq(TP_PASS_PRESET.verticalOwnTriad, undefined);
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
