/**
 * Enharmonic candidate generation.
 *
 * For a given MIDI value, find every letter whose pitch class matches it
 * with an accidental in [-2, +2] (double-flat through double-sharp).
 * This is the candidate set the Speller chooses from when committing a
 * spelling.
 *
 * Order: by |alter| ascending, then by letter order (C, D, E, F, G, A, B).
 * Examples:
 *   enharmonicCandidatesFor(0)  → [C, B#, Dbb]      (mags 0, 1, 2)
 *   enharmonicCandidatesFor(1)  → [C#, Db, B##]     (C# / Db both mag 1; C wins on letter order)
 *   enharmonicCandidatesFor(8)  → [G#, Ab]          (only 2 within ±2 accidentals)
 */

import { LETTER_BASE, type Accidental, type Letter, type PitchClass } from './pitch.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly Letter[];

export function enharmonicCandidatesFor(midi: number): PitchClass[] {
    const pc = ((midi % 12) + 12) % 12;
    const found: { letter: Letter; alter: Accidental; order: number }[] = [];
    for (let i = 0; i < LETTERS.length; i++) {
        const letter = LETTERS[i]!;
        // Normalize the required accidental into [-6, +5], then accept if within ±2.
        const raw = ((pc - LETTER_BASE[letter]) % 12 + 12) % 12;
        const alter = raw > 6 ? raw - 12 : raw;
        if (Math.abs(alter) <= 2) {
            found.push({ letter, alter: alter as Accidental, order: i });
        }
    }
    found.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || a.order - b.order);
    return found.map(({ letter, alter }) => ({ step: letter, alter }));
}
