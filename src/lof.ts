/**
 * The line of fifths: the one integer every spelling is inside the speller.
 *
 *   ... A♭  E♭  B♭  F   C   G   D   A   E   B   F♯  C♯  G♯  D♯ ...
 *   ... -4  -3  -2  -1  0   1   2   3   4   5   6   7   8   9  ...
 *
 * +1 is a fifth (C, G, D). +7 is the same letter one accidental sharper (E♭ -3, E 4, E♯ 11). +12 is
 * the enharmonic comma: the same sounding note one turn around the spiral (C and B♯, D♭ and C♯).
 * Letter, accidental and pitch class are all read off n. The speller works on n; {step, alter} only
 * appears at the public API and in introspection traces.
 *
 * A scale is indexed by LETTER SLOT, the letter's place in fifths order (F=0, C=1, G=2, D=3, A=4,
 * E=5, B=6), so the natural of slot s sits at n = s - 1.
 */

import type { Accidental, Letter, PitchClass } from './pitch.js';

/** The seven letters in fifths order, indexed by letter slot. */
export const FIFTHS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const satisfies readonly Letter[];

/** Letter slots in note-name order C D E F G A B, for output and for any search whose tie order is by letter. */
export const LETTER_ORDER = [1, 3, 5, 0, 2, 4, 6] as const;

/** C major, indexed by letter slot: the cold-start scale. */
export const C_MAJOR = [-1, 0, 1, 2, 3, 4, 5] as const;

/** The enharmonic comma: shifting n by ±12 renotates the same sounding note (C and B♯, D♭ and C♯). */
export const COMMA = 12;

const SLOT: Record<Letter, number> = { F: 0, C: 1, G: 2, D: 3, A: 4, E: 5, B: 6 };

/** Letter slot of n, 0..6 in fifths order. The letter repeats every 7 steps. */
export function letter(n: number): number {
    return ((n + 1) % 7 + 7) % 7;
}

/** Accidental of n: -1 flat, 0 natural, +1 sharp. Naturals are F (-1) to B (5). */
export function acc(n: number): number {
    return Math.floor((n + 1) / 7);
}

/** Pitch class of n (0-11). A fifth is 7 semitones, so n sounds 7n mod 12. */
export function pitchClass(n: number): number {
    return ((7 * n) % 12 + 12) % 12;
}

/** n of a {step, alter} spelling. */
export function lofOf(p: { readonly step: Letter; readonly alter: number }): number {
    return SLOT[p.step] - 1 + 7 * p.alter;
}

/** {step, alter} of n. */
export function spellingOf(n: number): PitchClass {
    return { step: FIFTHS[letter(n)]!, alter: acc(n) as Accidental };
}

/** n of letter slot `s` with the accidental that lands it nearest centre `c`, clamped to [-2, +2]. */
export function letterAt(s: number, c: number): number {
    const alter = Math.max(-2, Math.min(2, Math.round((c - (s - 1)) / 7)));
    return s - 1 + 7 * alter;
}

/** The 35 spellings F♭♭ (-15) to B♯♯ (+19), bucketed by pitch class. Spellings of one pitch class sit
 *  12 apart, so each bucket holds two or three. Sorted plainest first (smallest accidental, sharp before
 *  flat on a tie), so an argmax that keeps the first of equal scores prefers the plainer spelling. */
const CANDIDATES: readonly (readonly number[])[] = (() => {
    const byPc: number[][] = Array.from({ length: 12 }, () => []);
    for (let n = -15; n <= 19; n++) byPc[pitchClass(n)]!.push(n);
    for (const pile of byPc) pile.sort((a, b) => Math.abs(acc(a)) - Math.abs(acc(b)) || acc(b) - acc(a));
    return byPc;
})();

/** Every spelling of `midi`'s pitch class within a double accidental, plainest first. */
export function candidates(midi: number): readonly number[] {
    return CANDIDATES[((midi % 12) + 12) % 12]!;
}
