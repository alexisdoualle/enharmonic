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
