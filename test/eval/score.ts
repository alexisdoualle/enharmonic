/**
 * Three-tier, side-corrected scoring of predicted spellings against ground truth.
 *
 * Every prediction spells the *same sounding pitch* as its expected counterpart, so a
 * mismatch is never a wrong note — only a wrong enharmonic *side*. We grade on the line
 * of fifths: `offset = fifths(pred) - fifths(expected)` is 0 for an exact match and a
 * nonzero multiple of 12 for an enharmonic respelling (C♯ vs D♭ differ by 12 fifths).
 *
 *   correct  — offset 0 (exact match).
 *   flipped  — nonzero offset shared by another note within ±`radius` onsets: the passage
 *              was read coherently on the other side (a defensible alternative reading).
 *   wrong    — nonzero offset that no neighbour shares: an isolated error that breaks the
 *              locally-uniform offset.
 *
 * `radius` mirrors the lab's consensus window (see memory consensus-window-sustained-flip):
 * a sustained side-flip is coherent, a lone flip is a genuine error.
 */

import type { Pitch } from '../../src/index.js';

const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Line-of-fifths position of a spelling: letter position + 7 per sharp. */
export function fifths(step: string, alter: number): number {
    return LETTER_FIFTHS[step]! + 7 * alter;
}

export interface Tiers {
    correct: number;
    flipped: number;
    wrong: number;
    /** onsets with no read-back (should be 0 for a healthy speller). */
    unread: number;
    total: number;
}

export function scoreTiers(
    pred: readonly (Pitch | null)[],
    expected: readonly { step: string; alter: number }[],
    radius = 16,
): Tiers {
    if (pred.length !== expected.length) {
        throw new Error(`prediction/expected length mismatch: ${pred.length} vs ${expected.length}`);
    }
    const offset = pred.map((p, i) =>
        p ? fifths(p.step, p.alter) - fifths(expected[i]!.step, expected[i]!.alter) : NaN);

    let correct = 0, flipped = 0, wrong = 0, unread = 0;
    for (let i = 0; i < offset.length; i++) {
        const o = offset[i]!;
        if (Number.isNaN(o)) { unread++; continue; }
        if (o === 0) { correct++; continue; }
        let coherent = false;
        const lo = Math.max(0, i - radius), hi = Math.min(offset.length - 1, i + radius);
        for (let j = lo; j <= hi; j++) {
            if (j !== i && offset[j] === o) { coherent = true; break; }
        }
        if (coherent) flipped++; else wrong++;
    }
    return { correct, flipped, wrong, unread, total: offset.length };
}
