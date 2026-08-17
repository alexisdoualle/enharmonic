/**
 * Pitch and PitchClass — plain immutable objects.
 */

export type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

/** Double-flat through double-sharp. The Speller does not produce more remote spellings. */
export type Accidental = -2 | -1 | 0 | 1 | 2;

export interface Pitch {
    readonly step: Letter;
    readonly alter: Accidental;
    /** Scientific Pitch Notation octave number. Middle C = C4. */
    readonly octave: number;
}

export interface PitchClass {
    readonly step: Letter;
    readonly alter: Accidental;
}

/** Natural pitch class of each letter (C = 0). */
const LETTER_BASE = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
} as const satisfies Record<Letter, number>;

const ACCIDENTAL_SUFFIX = {
    [-2]: 'bb',
    [-1]: 'b',
    0: '',
    1: '#',
    2: '##',
} as const satisfies Record<Accidental, string>;

/** Standard MIDI number for a Pitch. C4 = 60. Throws if outside 0..127. */
export function midiOf(p: Pitch): number {
    const midi = 12 * (p.octave + 1) + LETTER_BASE[p.step] + p.alter;
    if (midi < 0 || midi > 127) {
        throw new RangeError(`midiOf: ${pitchToString(p)} (midi ${midi}) out of range 0..127`);
    }
    return midi;
}

/** 12-tone pitch class (0..11). C = 0. */
export function pitchClassValue(p: PitchClass | Pitch): number {
    return ((LETTER_BASE[p.step] + p.alter) % 12 + 12) % 12;
}

/** Human-readable string. "C#4" for Pitch, "Eb" for PitchClass. */
export function pitchToString(p: Pitch | PitchClass): string {
    const base = `${p.step}${ACCIDENTAL_SUFFIX[p.alter]}`;
    return 'octave' in p ? `${base}${p.octave}` : base;
}
