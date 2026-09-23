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
}

/** A full record of one commit decision (display only). */
export interface DecisionTrace {
    readonly frame: PitchClass[];              // LETTERS-order surface the candidates were scored against
    readonly candidates: DecisionCandidate[];  // enharmonicCandidatesFor order
    readonly chosen: PitchClass;
    readonly override: DecisionOverride;        // what (if anything) overrode the argmax
}
