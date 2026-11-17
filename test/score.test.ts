/**
 * The three-tier scorer at the composer's own seams (classifyOnsets: moved seam, edge).
 *
 * Synthetic passages, one chord per onset: the composer writes a flat section, then respells to a sharp one (his
 * seam). Predictions shift some notes by one comma. Cases from Alexis's viz audit (enharmonic-lab
 * narrative/overnight/2026-11-17/moved-seam.md): a vertical section of three or more pitch classes placed a beat
 * from his seam is a flip; two notes are too local and stay wrong; a note at his spelling at the edge of a flip is
 * correct; a note left behind inside a flip is wrong.
 */
import { suite, test, assertEq } from './framework.js';
import { classifyOnsets, type Tier } from './eval/score.js';
import type { Pitch } from '../src/index.js';

const P = (s: string): Pitch => ({ step: s[0] as Pitch['step'], alter: (s.slice(1) === '#' ? 1 : s.slice(1) === 'b' ? -1 : 0) as Pitch['alter'], octave: 4 });
/** One chord per onset, chords as space-separated names. */
const build = (chords: string[]) => {
    const notes: string[] = [], keys: number[] = [];
    chords.forEach((c, k) => { for (const s of c.split(' ')) { notes.push(s); keys.push(k); } });
    return { notes, keys };
};
const tiersOf = (exp: string[], pred: string[], keys: number[]): Tier[] => classifyOnsets(pred.map(P), exp.map(P), keys);
const count = (t: Tier[], from: number, to: number, tier: Tier) => t.slice(from, to).filter(x => x === tier).length;

// D♭ major, 24 onsets; then C♯ minor (Chopin's respelling), 24 onsets.
const flat = Array.from({ length: 24 }, (_, k) => (k % 2 ? 'Db F Ab' : 'Gb Bb Db'));
const sharp = Array.from({ length: 24 }, (_, k) => (k % 2 ? 'C# E G#' : 'G# B# D#'));
const enh: Record<string, string> = { Db: 'C#', F: 'E#', Ab: 'G#', Gb: 'F#', Bb: 'A#', Eb: 'D#', 'C#': 'Db', E: 'Fb', 'G#': 'Ab', B: 'Cb', 'B#': 'C', 'D#': 'Eb', 'E#': 'F', 'A#': 'Bb', 'F#': 'Gb' };

suite('scorer: moved seams and flip edges', () => {
    test('a vertical section of 3+ pitch classes a beat before the composer\'s seam is flipped', () => {
        const { notes, keys } = build([...flat, ...sharp]);
        const n0 = 21 * 3, n1 = 24 * 3;   // onsets 21-23, the last three flat chords, written sharp
        const pred = notes.map((s, i) => (i >= n0 && i < n1 ? enh[s]! : s));
        const t = tiersOf(notes, pred, keys);
        assertEq(count(t, n0, n1, 'flipped'), n1 - n0);
        assertEq(t.filter(x => x === 'wrong').length, 0);
    });
    test('two notes at the seam are too local and stay wrong', () => {
        const { notes, keys } = build([...flat.slice(0, 23), 'Db Ab', ...sharp]);
        const n0 = 23 * 3, n1 = n0 + 2;   // the one two-note chord before the seam, written sharp
        const pred = notes.map((s, i) => (i >= n0 && i < n1 ? enh[s]! : s));
        assertEq(count(tiersOf(notes, pred, keys), n0, n1, 'wrong'), 2);
    });
    test('a note at the composer\'s spelling at a flip\'s edge is correct', () => {
        // Late switch: the sharp section is written flat throughout (a flip). Before the seam the texture thins to a
        // single repeated A♭ (Op. 28/15 m27), so the ±16-onset vote around the last A♭s is mostly the flipped
        // chords after the seam; those A♭s match the composer and border the flip.
        const { notes, keys } = build([...flat.slice(0, 12), ...Array.from({ length: 12 }, () => 'Ab'), ...sharp]);
        const n1 = 12 * 3 + 12;
        const pred = notes.map((s, i) => (i >= n1 ? enh[s]! : s));
        const t = tiersOf(notes, pred, keys);
        assertEq(count(t, 0, n1, 'wrong'), 0);
        assertEq(count(t, n1, t.length, 'flipped'), t.length - n1);
    });
    test('a note left behind inside a flip is wrong (D♯–G–A♯ for E♭–G–B♭)', () => {
        // A long flip (onsets 10-69 respelled, so it owns the consensus) with the G left at the composer's G.
        const chords = Array.from({ length: 80 }, () => 'Eb G Bb');
        const { notes, keys } = build(chords);
        const pred = notes.map((s, i) => (i >= 30 && i < 210 ? enh[s] ?? s : s));
        const t = tiersOf(notes, pred, keys);
        assertEq(t.slice(75, 165).filter((x, k) => k % 3 === 1 && x === 'wrong').length, 30);   // G, onsets 25-54
    });
});
