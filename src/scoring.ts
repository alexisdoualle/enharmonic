/**
 * Interval scoring for CoreSpeller. A candidate is scored against the OTHER letters of the
 * resolved scale by summing per-interval consonance:
 *
 *   P4, P5, and 3rds / 6ths          +1   consonant
 *   P1, P8, 2nds / 7ths               0   neutral
 *   augmented / diminished           −1   dissonant
 *   doubly aug/dim and beyond        −2   extreme (clamped)
 *
 * Higher wins. A candidate that forms consonant intervals with the existing scale is preferred, which
 * is what locks the scale into key. Derived from Andrew Milne's interval-relatedness model, adapted to
 * pitch spelling (the candidate replaces its own slot, so that self-relationship is not scored).
 */

import { rawIntervalBetween } from './interval.js';
import type { Letter, PitchClass } from './pitch.js';

/** Signed quality + interval number → consonance score. */
function scoreFor(quality: number, number: number): number {
    if (quality === 0) return (number === 4 || number === 5) ? 1 : 0;   // P4/P5 vs P1/P8
    const absQ = Math.abs(quality);
    if (absQ === 1) return (number === 3 || number === 6) ? 1 : 0;      // 3rds/6ths vs 2nds/7ths
    if (absQ === 2) return -1;                                          // augmented / diminished
    return -2;                                                          // doubly aug/dim and beyond
}

/** Total interval score of a candidate against the other scale letters. Higher = better fit. */
export function intervalScore(
    candidate: PitchClass,
    resolved: ReadonlyMap<Letter, PitchClass>,
): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue;
        const { quality, number } = rawIntervalBetween(candidate, pc);
        total += scoreFor(quality, number);
    }
    return total;
}
