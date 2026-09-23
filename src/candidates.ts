/**
 * Enharmonic candidate generation.
 *
 * For a given MIDI value, every letter whose pitch class matches it with an accidental in [−2, +2]
 * (double-flat through double-sharp). This is the candidate set the Speller chooses from when committing
 * a spelling.
 *
 * Generated once from the line of fifths: the 35 spellings F♭♭(n=−15) … B♯♯(n=+19) bucketed by pitch
 * class, since a fifth adds 7 to the class (mod 12) so spellings 12 fifths apart share a class. Each
 * bucket is sorted plainest first (smallest |accidental|, sharp before flat on a tie), so the argmax
 * reaches the natural / nearest accidental first.
 *
 * Order: by |alter| ascending, then sharp before flat.
 * Examples:
 *   enharmonicCandidatesFor(0)  → [C, B#, Dbb]      (mags 0, 1, 2)
 *   enharmonicCandidatesFor(1)  → [C#, Db, B##]     (C# / Db both mag 1; sharp wins the tie)
 *   enharmonicCandidatesFor(8)  → [G#, Ab]          (only 2 within ±2 accidentals)
 */

import type { Accidental, Letter, PitchClass } from './pitch.js';

/** The seven letters in fifths order; F is at line-of-fifths position −1, B at +5. */
const FIFTHS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const satisfies readonly Letter[];

/** Spelling at line-of-fifths position `n` (C=0): +1 is a fifth (C, G, D), +7 is one accidental
 *  (E♭, E, E♯), so the letter cycles every 7 steps. */
function spellingAt(n: number): PitchClass {
    return { step: FIFTHS[((n + 1) % 7 + 7) % 7]!, alter: Math.floor((n + 1) / 7) as Accidental };
}

/** The 35 spellings bucketed by pitch class, each bucket plainest first. */
const CANDIDATES: readonly (readonly PitchClass[])[] = (() => {
    const byPc: PitchClass[][] = Array.from({ length: 12 }, () => []);
    for (let n = -15; n <= 19; n++) byPc[((7 * n) % 12 + 12) % 12]!.push(spellingAt(n));
    for (const pile of byPc) pile.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || b.alter - a.alter);
    return byPc;
})();

export function enharmonicCandidatesFor(midi: number): PitchClass[] {
    return CANDIDATES[((midi % 12) + 12) % 12]!.map(pc => ({ step: pc.step, alter: pc.alter }));
}
