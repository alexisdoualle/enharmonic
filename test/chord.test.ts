/** The viz chord finder ("the chord the speller thinks is sounding"). Display-only; pure. */
import { assert, assertEq, suite, test } from './framework.js';
import { findChord, chordText, type ChordNote } from '../viz/src/chord.js';
import { label } from '../viz/src/format.js';
import type { Letter, Accidental } from '../src/index.js';

const BASE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "Fb4 Ab4 Cb5*" → notes; a trailing `*` marks a note struck at this onset (default: struck). A `~` suffix = held. */
function notes(spec: string): ChordNote[] {
    return spec.trim().split(/\s+/).map(tok => {
        const held = tok.endsWith('~');
        const m = /^([A-G])(bb|b|##|#)?(-?\d)/.exec(tok)!;
        const alter = (m[2] ?? '').startsWith('#') ? (m[2]!.length) : -(m[2] ?? '').length;
        const octave = Number(m[3]);
        const midi = 12 * (octave + 1) + BASE[m[1]!]! + alter;
        return { midi, pitch: { step: m[1] as Letter, alter: alter as Accidental, octave }, struck: !held };
    });
}
const text = (spec: string) => chordText(findChord(notes(spec)), label);

suite('viz chord finder', () => {
    test('Fb Ab Cb is a complete F-flat major, A-flat and C-flat held', () => {
        const r = findChord(notes('Fb4 Ab4~ Cb5~'));
        assertEq([r.type, r.status, r.coherent], ['maj', 'complete', true]);
        assertEq(r.short, 'F♭');
        assertEq(chordText(r, label), 'F♭ major (complete; A♭, C♭ held)');
    });
    test('Ab Cb alone is no chord (a minor third)', () => {
        const r = findChord(notes('Ab4 Cb5'));
        assertEq(r.type, null);
        assertEq(chordText(r, label), 'none (A♭–C♭: a minor third)');
    });
    test('C E G Bb D: most pcs covered is C7, subset with extra D', () => {
        const r = findChord(notes('C3 E3 G3 Bb3 D4'));
        assertEq([r.type, r.status, r.root!.step], ['dom7', 'subset', 'C']);
        assertEq(r.extras.map(label), ['D']);
        assertEq(chordText(r, label), 'C dominant 7 ⊂ {C E G B♭ D} (subset; extra D)');
    });
    test('C E G with an added B-flat is a subset when the 7th is absent', () => {
        const r = findChord(notes('C4 E4 G4 D5'));
        assertEq([r.type, r.status], ['maj', 'subset']);
    });
    test('struck D# G A# is E-flat major by pc, flagged incoherent', () => {
        const r = findChord(notes('D#4 G4 A#4'));
        assertEq([r.type, r.coherent, r.status], ['maj', false, 'complete']);
        assert(chordText(r, label).startsWith('E♭ major by pc; spelled D♯–G–A♯ (incoherent)'), chordText(r, label));
    });
    test('C# E# G# is coherent (E# is the third of C# major)', () => {
        const r = findChord(notes('C#4 E#4 G#4'));
        assertEq([r.type, r.coherent, r.short], ['maj', true, 'C♯']);
    });
    test('B D F G# is a symmetric diminished 7, named from the lowest note', () => {
        const r = findChord(notes('B3 D4 F4 G#4'));
        assertEq([r.type, r.status, r.symmetric, r.coherent, r.short], ['dim7', 'complete', true, true, 'dim7']);
        assert(chordText(r, label).includes('B diminished 7 (symmetric: named from lowest note)'), chordText(r, label));
    });
    test('Ab C Eb F# is a German sixth; the same pcs with a Gb are a dominant 7', () => {
        const g = findChord(notes('Ab3 C4 Eb4 F#4'));
        assertEq([g.type, g.status, g.short], ['ger6', 'complete', 'Ger+6']);
        const d = findChord(notes('Ab3 C4 Eb4 Gb4'));
        assertEq([d.type, d.short], ['dom7', 'A♭7']);
    });
    test('Ab C F# is an Italian sixth, Ab C D F# a French sixth', () => {
        assertEq(findChord(notes('Ab3 C4 F#4')).type, 'it6');
        assertEq(findChord(notes('Ab3 C4 D4 F#4')).type, 'fr6');
    });
    test('G B D F is a complete G7', () => {
        const r = findChord(notes('G3 B3 D4 F4'));
        assertEq([r.type, r.status, r.short], ['dom7', 'complete', 'G7']);
        assertEq(text('G3 B3 D4 F4'), 'G dominant 7 (complete)');
    });
    test('a seventh with its 3rd and 7th but no 5th is PARTIAL; two triad notes are none', () => {
        const r = findChord(notes('G3 B3 F4'));
        assertEq([r.type, r.status, r.missing], ['dom7', 'partial', ['fifth']]);
        assertEq(findChord(notes('C4 E4')).type, null);
    });
    test('held vs struck: a chord of only struck notes lists no held notes', () => {
        assertEq(findChord(notes('C4 E4 G4')).held.length, 0);
    });
    test('empty and single notes are none', () => {
        assertEq(findChord([]).type, null);
        assertEq(text('C4'), 'none (one note)');
    });
});

import { triadColor } from '../viz/src/music/triadColor.js';
import { chordColor } from '../viz/src/chord.js';
suite('viz triadColor (shared with the Tonnetz panel)', () => {
    const cMaj = ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map(step => ({ step, alter: 0 }));
    const sp = (...xs: [string, number][]) => xs.map(([step, alter]) => ({ step, alter }));
    test('golden hexes unchanged by the refactor', () => {
        assertEq(triadColor('major', sp(['C', 0], ['E', 0], ['G', 0]), cMaj), '#ffd680');
        assertEq(triadColor('minor', sp(['A', 0], ['C', 0], ['E', 0]), cMaj), '#9ebffa');
        assertEq(triadColor('diminished', undefined, cMaj), '#f8bbd9');
    });
    test('chord lane: dominant 7 takes its triad colour; dim7 and aug6 take fixed colours', () => {
        const col = (spec: string) => chordColor(findChord(notes(spec)), cMaj as never);
        assertEq(col('G3 B3 D4 F4'), triadColor('major', sp(['G', 0], ['B', 0], ['D', 0]), cMaj));
        assertEq(col('B3 D4 F4 Ab4'), triadColor('diminished', undefined, cMaj));
    });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadExpected } from './eval/fixtures.js';
import { buildReplay, type RawEvent } from '../viz/src/replay.js';
import { chordAt, arpeggioChord, chordReading, chordReadingText } from '../viz/src/chord.js';

suite('viz chord arpeggio (longest chord-pure suffix)', () => {
    const real = (id: string) => buildReplay('rt', JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[], loadExpected(id), {});

    test('mozart_k545 step 11: C major via arpeggio (sounding alone is one note)', () => {
        const r = real('mozart_k545');
        assertEq(chordText(chordAt(r.snapshots[10]!), label), 'none (one note)');
        const c = chordReading(r, 10);
        assertEq([c.source, c.read.short], ['arpeggio', 'C']);
        assert(chordReadingText(c, label).startsWith('C major (arpeggio, last '), chordReadingText(c, label));
    });
    test('mozart_k545 step 28: F major via arpeggio over A4 F4 A4 A5 C4', () => {
        const r = real('mozart_k545');
        const c = chordReading(r, 27);
        assertEq([c.source, c.read.short, c.span], ['arpeggio', 'F', 5]);
        assertEq(chordReadingText(c, label), 'F major (arpeggio, last 5 notes)');
    });
    test('chopin op28 no15 step 401: D-flat major, sounding and complete, unchanged', () => {
        const r = real('chopin_prelude_op28_no15');
        const c = chordReading(r, 400);
        assertEq([c.source, c.read.short, c.read.status], ['sounding', 'D♭', 'complete']);
        assert(!chordReadingText(c, label).includes('arpeggio'), chordReadingText(c, label));
    });

    // Synthetic: committed spellings are plain naturals; notes 100 ms apart.
    const syn = (names: string) => names.split(' ').map((n, k) => {
        const midi = 60 + BASE[n]!;
        return { midi, onT: k * 100, committed: { step: n as Letter, alter: 0 as Accidental, octave: 4 } };
    });
    test('C E G is named C major from the third note', () => {
        const a = arpeggioChord(syn('C E G'), 2);
        assertEq([a?.read.short, a?.span], ['C', 3]);
    });
    test('C E G D E G: the D joins the span (Em7 subset) but E G D is not a complete chord, so none', () => {
        // the rule walks back through D (and G E) until C breaks it: span 5 = {E,G,D}, not equal to a template
        assertEq(arpeggioChord(syn('C E G D E G'), 5), null);
    });
    test('C E G D C: span {C,D} stops at G; none', () => {
        assertEq(arpeggioChord(syn('C E G D C'), 4), null);
    });
    test('a repeated chord tone keeps the span; the cap is 12 notes / 2000 ms', () => {
        assertEq(arpeggioChord(syn('C E G C E G C E G C E G C'), 12)?.span, 12);
        const slow = syn('C E G').map((n, k) => ({ ...n, onT: k * 1500 }));
        assertEq(arpeggioChord(slow, 2), null);   // C is 3000 ms back: span {E,G} only
    });
});
