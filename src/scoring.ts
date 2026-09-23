/**
 * Principle 2: interval scoring, the single source shared by CoreSpeller (src/core.ts) and the shipped
 * SpellingEngine (src/engine.ts). A candidate is scored against the OTHER letters of the resolved scale
 * by summing per-interval consonance, read straight off the line-of-fifths distance between the two
 * spellings, so the interval never has to be named:
 *
 *   d = 1        P5 / P4                 → +1     d = 3, 4   3rds / 6ths            → +1
 *   d = 0, 2, 5  unison / 2nds / 7ths    →  0     d = 6..12  augmented / diminished → −1
 *   d ≥ 13       doubly aug / dim        → −2
 *
 * Higher wins: a candidate that forms consonant intervals with the existing scale is preferred, which is
 * what locks the scale into key with no explicit key detection.
 */

import { lineOfFifths } from './interval.js';
import type { Letter, PitchClass } from './pitch.js';

/** Consonance of the interval between two spellings, read off their line-of-fifths distance `d`. */
export function consonance(a: PitchClass, b: PitchClass): number {
    const d = Math.abs(lineOfFifths(a) - lineOfFifths(b));
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** Total interval score of a candidate against the other scale letters (its own slot excluded, since the
 *  candidate replaces it). Higher = better fit. */
export function intervalScore(
    candidate: PitchClass,
    resolved: ReadonlyMap<Letter, PitchClass>,
): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue;
        total += consonance(candidate, pc);
    }
    return total;
}
