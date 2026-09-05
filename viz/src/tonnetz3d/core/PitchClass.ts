import type { LetterName } from '../types';
import { LETTER_NAME_VALUES, AccidentalUtils } from '../types';
import { MPitch, SPN, accidentalToSPN, mInterval } from './meantonal';

/**
 * Represents a pitch class (0-11) without octave information.
 * Backed internally by a meantonal Pitch.
 */
export class PitchClass {
    /** @internal meantonal Pitch backing this PitchClass */
    readonly _mp: MPitch;

    constructor(letterName: LetterName, accidental?: number);
    constructor(mp: MPitch);
    constructor(first: LetterName | MPitch, accidental: number = 0) {
        if (typeof first === 'string') {
            this._mp = SPN.toPitch(`${first}${accidentalToSPN(accidental)}0`);
        } else {
            this._mp = first;
        }
    }

    get letterName(): LetterName {
        return this._mp.letter as LetterName;
    }

    get accidental(): number {
        return this._mp.accidental;
    }

    /**
     * Get MIDI value (0-11 for pitch class).
     * Note: returns raw value which can be -1 for Cb or 12 for B#
     * for backward compatibility with octave boundary detection.
     */
    get midiValue(): number {
        return LETTER_NAME_VALUES[this.letterName] + this.accidental;
    }

    /**
     * Get next pitch class from interval
     */
    getNextFromInterval(semitones: number, step: number = 1): PitchClass {
        const interval = mInterval(semitones, step);
        const result = this._mp.transposeReal(interval);
        return new PitchClass(result);
    }

    /**
     * Convert to string representation
     */
    toString(): string {
        return this.letterName + AccidentalUtils.toSymbol(this.accidental);
    }

    /**
     * Parse from string
     */
    static fromString(str: string): PitchClass {
        const letter = str.charAt(0) as LetterName;
        const accidentalSymbol = str.slice(1);
        const accidental = AccidentalUtils.fromSymbol(accidentalSymbol);
        return new PitchClass(letter, accidental);
    }

    /**
     * Returns the absolute accidental distance from the scale note with the same letter name.
     * E.g. Ab in C major (A natural) → |(-1) - 0| = 1.
     * Returns Infinity if no scale note shares this letter.
     */
    accidentalDistanceFromScale(scale: PitchClass[]): number {
        for (const s of scale) {
            if (s.letterName === this.letterName) {
                return Math.abs(this.accidental - s.accidental);
            }
        }
        return Infinity;
    }

    /**
     * Check if equivalent (same MIDI value)
     */
    equals(other: PitchClass): boolean {
        return this.midiValue === other.midiValue;
    }
}
