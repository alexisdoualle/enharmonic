/**
 * Three-tier, side-corrected scoring of predicted spellings against ground truth.
 *
 * Every prediction spells the *same sounding pitch* as its expected counterpart, so a
 * mismatch is never a wrong note — only a wrong enharmonic *side*. We grade on the line
 * of fifths: `offset = fifths(pred) - fifths(expected)` is 0 for an exact match and a
 * nonzero multiple of 12 for an enharmonic respelling (C♯ vs D♭ differ by 12 fifths).
 *
 *   correct  — offset 0 (exact match).
 *   flipped  — a nonzero offset that WINS the plurality vote in its ±`radius` window: the whole
 *              local passage was read coherently on the other side (a defensible reading).
 *   wrong    — a nonzero offset that does NOT win its window's plurality: a lone or minority
 *              off-side note that breaks the locally-uniform offset (a genuine error).
 *
 * The plurality vote is the lab's `tiersFromOffsets` rule (see memory
 * consensus-window-sustained-flip): a legitimate flip is a SUSTAINED multi-bar section, so an
 * off-side note counts as `flipped` only when its side actually dominates the neighbourhood —
 * the surrounding correct (offset-0) notes out-vote a 2–3 note minority. A weaker "any single
 * neighbour shares the offset" test lets a pair of identical isolated mistakes masquerade as a
 * coherent flip (the WTC1 onset-209/217 G♯-for-A♭ pair Alexis caught); plurality calls them wrong.
 */

import type { Pitch } from '../../src/index.js';

const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Line-of-fifths position of a spelling: letter position + 7 per sharp. */
export function fifths(step: string, alter: number): number {
    return LETTER_FIFTHS[step]! + 7 * alter;
}

export type Tier = 'correct' | 'flipped' | 'wrong' | 'unread';

export interface Tiers {
    correct: number;
    flipped: number;
    wrong: number;
    /** onsets with no read-back (should be 0 for a healthy speller). */
    unread: number;
    total: number;
}

/**
 * Per-onset tier for a prediction stream — the ONE place the correct/flipped/wrong split is
 * defined. The bench gate ({@link scoreTiers}) and the viz (`viz/src/replay.ts`) both consume this,
 * so a viz tally can never diverge from what the parity baseline blesses. (It drifted once, when the
 * viz carried a private naïve copy that painted every same-pitch-class miss as `flipped` — Alexis
 * caught a lone G♯-for-A♭ mislabelled "coherent side" on WTC1 prelude.)
 *
 * `null` expected marks an unscored onset (no ground truth) → neutral `correct`; the bench never
 * passes those, but the viz can, so the shared definition tolerates them.
 */
export function classifyOnsets(
    pred: readonly (Pitch | null)[],
    expected: readonly ({ step: string; alter: number } | null)[],
    radius = 16,
): Tier[] {
    // offset 0 = exact, a nonzero multiple of 12 = enharmonic respelling; null = unscored, NaN = unread.
    const offset = pred.map((p, i) => {
        const e = expected[i];
        if (!e) return null;
        return p ? fifths(p.step, p.alter) - fifths(e.step, e.alter) : NaN;
    });
    return offset.map((o, i) => {
        if (o === null) return 'correct';        // unscored onset — neutral
        if (Number.isNaN(o)) return 'unread';
        if (o === 0) return 'correct';
        // Coherent side = this note's offset WINS the plurality of its ±radius window (correct
        // offset-0 notes vote too, so a minority off-side note loses and stays `wrong`). First-seen
        // order breaks ties, so the pervasive offset-0 wins any tie against a sparse flip.
        const votes = new Map<number, number>();
        const lo = Math.max(0, i - radius), hi = Math.min(offset.length - 1, i + radius);
        for (let j = lo; j <= hi; j++) {
            const v = offset[j];
            if (v === null || Number.isNaN(v)) continue;
            votes.set(v, (votes.get(v) ?? 0) + 1);
        }
        let winner = 0, best = -1;
        for (const [v, n] of votes) if (n > best) { best = n; winner = v; }
        return o === winner ? 'flipped' : 'wrong';
    });
}

export function scoreTiers(
    pred: readonly (Pitch | null)[],
    expected: readonly { step: string; alter: number }[],
    radius = 16,
): Tiers {
    if (pred.length !== expected.length) {
        throw new Error(`prediction/expected length mismatch: ${pred.length} vs ${expected.length}`);
    }
    const tiers = classifyOnsets(pred, expected, radius);
    let correct = 0, flipped = 0, wrong = 0, unread = 0;
    for (const t of tiers) {
        if (t === 'correct') correct++;
        else if (t === 'flipped') flipped++;
        else if (t === 'wrong') wrong++;
        else unread++;
    }
    return { correct, flipped, wrong, unread, total: tiers.length };
}
