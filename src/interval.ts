/**
 * Diatonic intervals: plain immutable objects.
 *
 * Zero runtime dependencies. The chroma-based interval-quality formula in
 * `qualityFromChroma` is adapted from Brian Bowman's meantonal project
 * (https://github.com/meantonal/meantonal-js, MIT License), applied directly
 * to chroma computed from (letter, alter), which sidesteps the (whole-step,
 * half-step) vector representation meantonal uses and we don't otherwise need.
 */

import type { Letter, PitchClass } from './pitch.js';

export type IntervalQuality =
    | 'P'   // perfect
    | 'M'   // major
    | 'm'   // minor
    | 'A'   // augmented
    | 'd'   // diminished
    | 'AA'  // doubly augmented
    | 'dd'; // doubly diminished

export interface Interval {
    readonly quality: IntervalQuality;
    /** 1 (unison) through 8 (octave). Always reduced. */
    readonly number: number;
}

/** Diatonic position of each letter (C=0, D=1, …, B=6). */
const LETTER_IDX = {
    C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6,
} as const satisfies Record<Letter, number>;

/** Line-of-fifths position of each natural letter (F=-1, C=0, G=+1, …, B=+5). */
const LETTER_CHROMA = {
    F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5,
} as const satisfies Record<Letter, number>;

/**
 * Line-of-fifths position of a pitch-class spelling. Naturals run F=-1…B=+5;
 * each accidental shifts by ±7 (so F♯=+6, B♭=-2, E♯=+11, B𝄫=-9). The integer
 * distance between two positions is the count of fifths separating them: a
 * spelling's "remoteness" from a tonal center.
 */
export function lineOfFifths(pc: PitchClass): number {
    return LETTER_CHROMA[pc.step] + 7 * pc.alter;
}

/** Signed quality → label. 0=P, ±1=M/m, ±2=A/d, ±3=AA/dd. */
const QUALITY_LABEL: Record<number, IntervalQuality> = {
    0: 'P',
    1: 'M', '-1': 'm',
    2: 'A', '-2': 'd',
    3: 'AA', '-3': 'dd',
};

/**
 * Signed interval quality as a pure function of line-of-fifths chroma.
 * 0=P, ±1=M/m, ±2=A/d, ±3=AA/dd, …
 */
function qualityFromChroma(c: number): number {
    if (Math.abs(c) <= 1) return 0;
    if (c > 0 && c <= 5) return Math.floor((c + 5) / 7);
    if (c < 0 && c >= -5) return Math.ceil((c - 5) / 7);
    if (c > 5) return Math.floor((c + 8) / 7);
    return Math.floor((c - 2) / 7);
}

/**
 * Internal: raw interval data, NOT clamped. Used by src/scoring.ts where
 * extreme qualities (AAA+/ddd+) can occur and must be handled rather than
 * thrown on. NOT re-exported from src/index.ts.
 *
 * `quality` is the signed integer: 0=P, ±1=M/m, ±2=A/d, ±3=AA/dd,
 * ±4+ for further extremes.
 */
export function rawIntervalBetween(
    from: PitchClass,
    to: PitchClass,
): { quality: number; number: number } {
    // Ascending letter distance, 0=unison … 6=seventh.
    const letterDist = (LETTER_IDX[to.step] - LETTER_IDX[from.step] + 7) % 7;

    // Line-of-fifths chroma of each PC; each accidental shifts chroma by ±7.
    const chromaFrom = LETTER_CHROMA[from.step] + 7 * from.alter;
    const chromaTo = LETTER_CHROMA[to.step] + 7 * to.alter;
    const intervalChroma = chromaTo - chromaFrom;

    // Same letter but `to` is flatter than `from` (e.g. C → C♭): treat as
    // the ascending diminished octave d8.
    const stepspan = letterDist === 0 && intervalChroma < 0 ? 7 : letterDist;

    return {
        quality: qualityFromChroma(intervalChroma),
        number: stepspan + 1,
    };
}

/**
 * Interval from `from` to `to`, reduced to 1..8 (unison through octave),
 * taken as the *upward* direction. `intervalBetween(C, G)` = P5;
 * `intervalBetween(G, C)` = P4.
 *
 * Extreme qualities beyond AA/dd are clamped to AA/dd so the public API
 * never throws on unusual but legal inputs.
 */
export function intervalBetween(from: PitchClass, to: PitchClass): Interval {
    const { quality: rawQ, number } = rawIntervalBetween(from, to);
    const clamped = Math.max(-3, Math.min(3, rawQ));
    return { quality: QUALITY_LABEL[clamped]!, number };
}

/** Standard label, e.g. "P5", "m3", "AA4". */
export function intervalLabel(i: Interval): string {
    return `${i.quality}${i.number}`;
}
