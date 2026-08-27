/**
 * Three-tier, side-corrected scoring of predicted spellings against ground truth —
 * the COMMA-OFFSET COHERENCE metric. This is a faithful port of the lab's blessed
 * scorer (`enharmonic-lab/test/parity/sideclass.ts::tiersFromOffsets`), so the
 * numbers this repo reports are identical to the paper's.
 *
 * Every prediction spells the *same sounding pitch* as its expected counterpart, so a
 * mismatch is never a wrong note — only a wrong enharmonic *side*. Grade on the line of
 * fifths: `commaOffset = (lof(pred) − lof(expected)) / 12` is 0 for an exact match and a
 * nonzero integer for an enharmonic respelling (C♯ vs D♭ differ by one comma). A note is
 * measured NOT against the composer directly but against its LOCAL CONSENSUS offset — the
 * dominant offset of the ±`radius` ONSET window around it:
 *
 *   correct  — offset EQUALS the consensus AND the consensus is 0 (matches the composer, unflipped).
 *   flipped  — offset EQUALS a NONZERO consensus (the whole neighbourhood is uniformly shifted; a
 *              defensible side choice — magnitude irrelevant, a uniform −2 passage is a flip).
 *   wrong    — offset BREAKS the consensus. This INCLUDES an offset-0 straggler stranded inside a
 *              flipped passage (a natural that failed to flip with its neighbours — an incoherent
 *              MIX, not a clean flip), as well as a lone off-side note inside an unflipped passage.
 *   unread   — no read-back (pred null). Should be 0 for a healthy speller.
 *
 * Two properties are essential and were both missing from an earlier lenient version of this file
 * (which under-reported `wrong`, most visibly on the frameless Core over heavily-flipped movements):
 *   1. Matching the composer (offset 0) is NOT a per-note pass — an offset-0 note that breaks a
 *      flipped consensus is `wrong`.
 *   2. The consensus window is measured in ONSETS (co-struck notes share one onset), not raw note
 *      indices — otherwise a wide window collapses to a few chords on polyphonic music.
 *
 * A wide consensus radius (±16 onsets ≈ two bars) is what stops a short run of identical
 * mis-spellings from forming its own false "consensus" and masquerading as a coherent flip.
 */

import type { Pitch } from '../../src/index.js';

const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Signed line-of-fifths position of a spelling: letter position + 7 per sharp. */
export function fifths(step: string, alter: number): number {
    return LETTER_FIFTHS[step]! + 7 * alter;
}

/**
 * Signed comma-offset of a prediction from the composer's spelling: how many commas (12-fifth steps)
 * the prediction sits from the score (composer A♯ + prediction B♭ → −1). `null` when they are NOT the
 * same pitch (offset is not a whole number of commas) — a genuine wrong PITCH, never a side choice.
 */
export function commaOffset(
    pred: { step: string; alter: number } | null | undefined,
    exp: { step: string; alter: number } | null | undefined,
): number | null {
    if (!pred || !exp) return null;
    const d = fifths(pred.step, pred.alter) - fifths(exp.step, exp.alter);
    return d % 12 === 0 ? d / 12 : null;
}

/** Radius (in ONSETS) of the local-consensus window the flip/wrong vote runs over. */
export const CONSENSUS_RADIUS = 16;

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
 * Per-onset tier for a prediction stream — the ONE place the correct/flipped/wrong split is defined.
 * The bench gate ({@link scoreTiers}) and the viz (`viz/src/replay.ts`) both consume this, so a viz
 * tally can never diverge from what the parity baseline blesses.
 *
 * `onsetKey[i]` groups co-struck notes: predictions sharing a value are one sonority and the vote
 * counts them as one onset step. `null` expected marks an unscored onset (no ground truth) → neutral
 * `correct`, and it does not vote; the bench never passes those, but the viz can.
 */
export function classifyOnsets(
    pred: readonly (Pitch | null)[],
    expected: readonly ({ step: string; alter: number } | null)[],
    onsetKey: readonly (string | number)[],
    radius = CONSENSUS_RADIUS,
): Tier[] {
    const n = pred.length;
    // Votable comma-offset per note; null = does not vote (unscored, unread, or a genuine wrong pitch).
    const offsets: (number | null)[] = pred.map((p, i) => {
        const e = expected[i];
        if (e == null || p == null) return null;
        return commaOffset(p, e);
    });
    // Map each note to a contiguous onset index (first-seen distinct key → next index).
    const onsetPos = new Map<string | number, number>();
    const onsetIdx = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        const k = onsetKey[i]!;
        if (!onsetPos.has(k)) onsetPos.set(k, onsetPos.size);
        onsetIdx[i] = onsetPos.get(k)!;
    }
    const nOnsets = onsetPos.size;
    const byOnset: number[][] = Array.from({ length: nOnsets }, () => []);
    for (let i = 0; i < n; i++) byOnset[onsetIdx[i]!]!.push(i);

    return pred.map((_p, i) => {
        const e = expected[i];
        if (e == null) return 'correct';            // unscored onset — neutral
        if (pred[i] == null) return 'unread';        // no read-back
        const off = offsets[i];
        if (off == null) return 'wrong';             // committed but a genuinely different pitch
        // Vote over every note whose onset is within ±radius onsets of this one.
        const oi = onsetIdx[i]!;
        const votes = new Map<number, number>();
        for (let o = Math.max(0, oi - radius); o <= Math.min(nOnsets - 1, oi + radius); o++) {
            for (const j of byOnset[o]!) {
                const v = offsets[j];
                if (v != null) votes.set(v, (votes.get(v) ?? 0) + 1);
            }
        }
        // Dominant offset; ties broken toward the value closest to 0, then the more negative (flat) side.
        let best = 0, bestCnt = -1;
        for (const [v, c] of votes) {
            if (c > bestCnt || (c === bestCnt && (Math.abs(v) < Math.abs(best) || (Math.abs(v) === Math.abs(best) && v < best)))) {
                best = v; bestCnt = c;
            }
        }
        const consensus = bestCnt < 0 ? 0 : best;
        if (off !== consensus) return 'wrong';
        return consensus === 0 ? 'correct' : 'flipped';
    });
}

export function scoreTiers(
    pred: readonly (Pitch | null)[],
    expected: readonly { step: string; alter: number }[],
    onsetKey: readonly (string | number)[],
    radius = CONSENSUS_RADIUS,
): Tiers {
    if (pred.length !== expected.length) {
        throw new Error(`prediction/expected length mismatch: ${pred.length} vs ${expected.length}`);
    }
    if (onsetKey.length !== pred.length) {
        throw new Error(`onsetKey/prediction length mismatch: ${onsetKey.length} vs ${pred.length}`);
    }
    const tiers = classifyOnsets(pred, expected, onsetKey, radius);
    let correct = 0, flipped = 0, wrong = 0, unread = 0;
    for (const t of tiers) {
        if (t === 'correct') correct++;
        else if (t === 'flipped') flipped++;
        else if (t === 'wrong') wrong++;
        else unread++;
    }
    return { correct, flipped, wrong, unread, total: tiers.length };
}
