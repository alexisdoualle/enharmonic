/**
 * Public API for `enharmonic`.
 *
 *   Speller              — real-time; `{ lookAhead: true }` → near-real-time (small forward buffer)
 *   spellTwoPass         — offline (whole piece in hand; highest accuracy)
 *
 * Pitch / interval helpers are exported for callers that want typed spellings.
 */

export { Speller } from './speller.js';
export type { SpellerOptions } from './speller.js';
export { resolveStep } from './kernel.js';
export type { NoteContext } from './kernel.js';

export { spellTwoPass } from './two-pass.js';
export type { TwoPassNote, TwoPassOptions } from './two-pass.js';

export type { Pitch, PitchClass, Letter, Accidental } from './pitch.js';
export { midiOf, pitchClassValue, pitchToString } from './pitch.js';

export type { Interval, IntervalQuality } from './interval.js';
export { intervalBetween, intervalLabel } from './interval.js';

export { enharmonicCandidatesFor } from './candidates.js';
