/**
 * Enharmonic candidate generation.
 *
 * For a given MIDI value, every letter whose pitch class matches it with an accidental in [−2, +2]
 * (double-flat through double-sharp). This is the candidate set the Speller chooses from when committing
 * a spelling. The speller itself reads the line-of-fifths integers ({@link candidates} in lof.ts); this is
 * the same list as {step, alter} for callers.
 *
 * Order: by |alter| ascending, then sharp before flat.
 * Examples:
 *   enharmonicCandidatesFor(0)  → [C, B#, Dbb]      (mags 0, 1, 2)
 *   enharmonicCandidatesFor(1)  → [C#, Db, B##]     (C# / Db both mag 1; sharp wins the tie)
 *   enharmonicCandidatesFor(8)  → [G#, Ab]          (only 2 within ±2 accidentals)
 */

import type { PitchClass } from './pitch.js';
import { candidates, spellingOf } from './lof.js';

export function enharmonicCandidatesFor(midi: number): PitchClass[] {
    return candidates(midi).map(spellingOf);
}
