/**
 * The viz's own per-note decision-trace shape: a display record the scoring panel and copy view render.
 *
 * It is deliberately viz-local: `replay.ts` ADAPTS each speller's native decision (the shipped
 * {@link SpellingEngine}'s `Decision`, or a mode's own trace) into this one shape, so the panels have a
 * single stable contract and never depend on any one speller's internal trace type. Recording a trace
 * never changes a spelling; it mirrors what the argmax saw.
 */

import type { PitchClass } from '../../src/index.js';

/** What (if anything) overrode the base-frame argmax for this note. Shipped presets only ever emit
 *  `'none'`; the other tags are kept so older recorded traces still render. */
export type DecisionOverride =
    | 'none' | 'lookahead-vertical-gate' | 'lookahead-coherence-gate' | 'sounding-tiebreak' | 'rel-minor-lt';

/** One candidate's scoring breakdown. `base` is the interval-consonance score; the deltas are each
 *  mechanism's contribution (0 when its mechanism is off). `nsDelta` is the general "other penalties"
 *  column: for the shipped engine it carries the drift-leash + vertical-guard total. */
export interface DecisionCandidate {
    readonly c: PitchClass;
    readonly base: number;
    readonly laDelta: number;
    readonly nsDelta: number;
    readonly guardDelta?: number;
    readonly sideDelta?: number;
    /** Shipped-engine terms (undefined for Core / control traces). */
    readonly vertDelta?: number;
    readonly daDelta?: number;
    readonly leanDelta?: number;
}

/** Every term the engine applied: the printed total is base + these, exactly. */
export const candidateTotal = (c: DecisionCandidate): number =>
    c.base + c.laDelta + c.nsDelta + (c.guardDelta ?? 0) + (c.sideDelta ?? 0)
    + (c.vertDelta ?? 0) + (c.daDelta ?? 0) + (c.leanDelta ?? 0);

/** Non-guard, non-side, non-LA "other" terms (for naming what moved the pick). */
export const otherDelta = (c: DecisionCandidate): number =>
    c.nsDelta + (c.vertDelta ?? 0) + (c.daDelta ?? 0) + (c.leanDelta ?? 0);

export interface DeltaCol { h: string; title: string; val: (c: DecisionCandidate) => number }

/** The delta columns, STRUCTURAL per speller (never per-onset values) so the layout does not jump between
 *  notes. Shared by the scoring panel and the copy text. Engine traces: Side (if the preset has a side
 *  anchor), Grd, LA (iff look-ahead is enabled for the run), Vrt, DA, Lean. Core/control: LA + NS. */
export function deltaColumns(cands: readonly DecisionCandidate[], laActive: boolean): DeltaCol[] {
    const engine = cands.some(c => c.vertDelta !== undefined || c.guardDelta !== undefined || c.sideDelta !== undefined);
    if (!engine) return [
        { h: 'LA', title: 'look-ahead delta', val: c => c.laDelta },
        { h: 'NS', title: 'neighbour-step delta', val: c => c.nsDelta },
    ];
    const cols: DeltaCol[] = [];
    if (cands.some(c => c.sideDelta !== undefined)) cols.push({ h: 'Side', title: 'side-anchor penalty: −anchor × fifths outside the collection', val: c => c.sideDelta ?? 0 });
    cols.push({ h: 'Grd', title: 'recency-guard penalty', val: c => c.guardDelta ?? 0 });
    if (laActive) cols.push({ h: 'LA', title: 'look-ahead: step toward the resolution', val: c => c.laDelta });
    cols.push({ h: 'Vrt', title: 'vertical guard: misspelled third in a struck perfect triad', val: c => c.vertDelta ?? 0 });
    cols.push({ h: 'DA', title: 'double-accidental penalty', val: c => c.daDelta ?? 0 });
    cols.push({ h: 'Lean', title: 'chromatic sharp lean (leading-tone tendency)', val: c => c.leanDelta ?? 0 });
    return cols;
}

/** A full record of one commit decision (display only). */
export interface DecisionTrace {
    readonly frame: PitchClass[];              // LETTERS-order surface the candidates were scored against
    readonly candidates: DecisionCandidate[];  // enharmonicCandidatesFor order
    readonly chosen: PitchClass;
    readonly override: DecisionOverride;        // what (if anything) overrode the argmax
}
