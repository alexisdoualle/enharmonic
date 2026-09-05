/**
 * Scoring primitives for the Speller.
 *
 * Each candidate is scored against the *other* letters in the current
 * resolved scale by summing per-interval scores:
 *
 *   P4, P5                        +1   perfect consonance
 *   M3, m3, M6, m6                +1   imperfect consonance
 *   P1, M2, m2, M7, m7             0   neutral
 *   A / d (any interval number)   −1   dissonant
 *   AA / dd                       −2   extreme dissonance
 *   AAA+ / ddd+                   −2   extreme dissonance (clamped — more
 *                                      distortion is never less dissonant)
 *
 * Higher score wins. The consonance bonuses are what cause the algorithm
 * to lock in to a key: a candidate that forms strong-consonance intervals
 * with the existing scale is preferred over one that forms dissonant ones.
 *
 * The interval-score table is derived from Andrew Milne's interval-
 * relatedness model, adapted to the pitch-spelling context (we compare
 * each candidate against a fully-resolved 7-letter scale and treat
 * doubly-augmented and beyond as strong opposition).
 */

import { rawIntervalBetween } from './interval.js';
import type { Letter, PitchClass } from './pitch.js';

// TODO: add an estimate of the contribution of each mechanism to the score

/** Signed quality + interval number → score. */
function scoreFor(quality: number, number: number): number {
    if (quality === 0) {
        if (number === 4 || number === 5) return 1;
        return 0; // P1, P8: neutral
    }
    const absQ = Math.abs(quality);
    if (absQ === 1) {
        if (number === 3 || number === 6) return 1;
        return 0; // 2nds and 7ths: neutral
    }
    if (absQ === 2) return -1; // Augmented / diminished
    return -2; // Doubly-augmented / diminished and beyond: extreme dissonance
}

/**
 * Total interval score for a candidate against the resolved scale, skipping
 * the candidate's own letter slot (which it would replace if chosen).
 * Higher = better fit.
 */
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

/** Total interval score against a recency buffer. Unlike {@link intervalScore}, this deliberately
 * scores each committed spelling as an individual vote: repeated letters are not collapsed into a
 * seven-slot map. This is the onset-count-based tie buffer used by the original lab speller. */
export function intervalBufferScore(
    candidate: PitchClass,
    buffer: readonly PitchClass[],
): number {
    let total = 0;
    for (const pc of buffer) {
        if (pc.step === candidate.step) continue;
        const { quality, number } = rawIntervalBetween(candidate, pc);
        total += scoreFor(quality, number);
    }
    return total;
}

/**
 * relativeAccDist.
 *
 * Distance (in accidentals) between the candidate and the *current* spelling
 * of its letter slot. Captures "scale loyalty" — once the D slot has been
 * set to Db by prior context, a later candidate spelling D for midi 61
 * pays a cost of |0 − (−1)| = 1, while Db pays 0. The Speller subtracts
 * `ACC_WEIGHT_PENALTY × relativeAccDist` from the candidate's combined score.
 *
 * **Marginal-ablation impact** (the three non-interval terms — relativeAccDist
 * + rootBonus + leadingToneBonus — added together alone to CoreSpeller's
 * per-note picker, no reassign): **−3.70pp wks / −15.90pp nks**. They REGRESS
 * when bolted onto a non-reassigning base. Inside the full Speller's
 * reassign+gate machinery they earn ~+0.8pp net (see the older scoring-
 * mechanism ablation in the comments below). Don't add them to a streaming
 * algorithm without also adding reassign-by-recency.
 */
export function relativeAccDist(
    candidate: PitchClass,
    resolved: ReadonlyMap<Letter, PitchClass>,
): number {
    const slot = resolved.get(candidate.step);
    if (!slot) return 0;
    return Math.abs(candidate.alter - slot.alter);
}

/**
 * rootBonus.
 *
 * Awards a structural bonus when the candidate sits as the *root* of a
 * triad-shaped relationship with the rest of the resolved scale:
 *
 *   +1   if some other letter sits a P5 above the candidate
 *   +1   additional if some other letter ALSO sits a M3 above the candidate
 *        (so a candidate that is the root of a major triad implied by the
 *        scale gets +2 total; a candidate that has a fifth-above but no
 *        third-above gets +1; one with only a third gets 0).
 */
export function rootBonus(
    candidate: PitchClass,
    resolved: ReadonlyMap<Letter, PitchClass>,
): number {
    let hasFifthAbove = false;
    let hasMajorThirdAbove = false;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue;
        const { quality, number: num } = rawIntervalBetween(candidate, pc);
        if (quality === 0 && num === 5) hasFifthAbove = true;
        if (quality === 1 && num === 3) hasMajorThirdAbove = true;
    }
    let bonus = 0;
    if (hasFifthAbove) bonus += 1;
    if (hasMajorThirdAbove && hasFifthAbove) bonus += 1;
    return bonus;
}

/**
 * leadingToneBonus.
 *
 * Identifies the candidate as the major 3rd of a V chord whose root sits in
 * the resolved scale — i.e., the leading tone of an implied tonic. In minor
 * keys the raised 7th *is* the M3 of V; this bonus recovers it without any
 * explicit tonic detection.
 *
 * Rule (loose form):
 *   candidate X gets +2 if there exist scale members Y, Z (both ≠ X) such
 *   that Y is P5 above Z AND X is M3 above Y.
 *
 * The bonus is +2 rather than +1 because the leading-tone resolution is
 * a *structural* signal — it should be strong enough to overcome a small
 * intervalScore deficit when both candidates are otherwise tied (an
 * earlier +1 left it dominated by intervalScore in mildly-chromatic
 * passages; +2 recovers ~1pp on Grieg, Chopin Waltz, Debussy, Dukas and
 * smaller gains on others without regressing anything).
 *
 * Example — Beatles "Because" in C♯ minor, scale `[C#, D#, E, F#, G#, A, B]`:
 *   X=B♯, Y=G♯, Z=C♯. G♯ is P5 above C♯, B♯ is M3 above G♯ → +2.
 *   For X=C (natural): C is not M3 above any scale member → 0.
 *
 * Symmetric in A/d (no asymmetric interval scoring): the rule references
 * spellings (m2 vs A1 falls out of letter identity), not interval qualities.
 * Integer-only, locality-driven.
 */
export function leadingToneBonus(
    candidate: PitchClass,
    resolved: ReadonlyMap<Letter, PitchClass>,
): number {
    for (const [yLetter, yPc] of resolved) {
        if (yLetter === candidate.step) continue;
        const xy = rawIntervalBetween(yPc, candidate);
        if (xy.quality !== 1 || xy.number !== 3) continue;
        for (const [zLetter, zPc] of resolved) {
            if (zLetter === yLetter || zLetter === candidate.step) continue;
            const zy = rawIntervalBetween(zPc, yPc);
            if (zy.quality === 0 && zy.number === 5) {
                return 2;
            }
        }
    }
    return 0;
}
