import type { LetterName } from '../types';
import { Step, IntervalType, LETTER_NAME_VALUES } from '../types';
import { PitchClass } from './PitchClass';
import { Interval } from './Interval';
import { MPitch, MInterval, SPN, accidentalToSPN, mInterval } from './meantonal';

/**
 * Represents a specific pitch with octave information.
 * Backed internally by a meantonal Pitch.
 */
export class Pitch {
    /** @internal meantonal Pitch backing this Pitch */
    readonly _mp: MPitch;
    readonly pitchClass: PitchClass;
    readonly octave: number;

    constructor(pitchClass: PitchClass, octave?: number);
    constructor(mp: MPitch);
    constructor(first: PitchClass | MPitch, octave: number = 4) {
        if (first instanceof PitchClass) {
            this.pitchClass = first;
            this.octave = octave;
            this._mp = SPN.toPitch(
                `${first.letterName}${accidentalToSPN(first.accidental)}${octave}`
            );
        } else {
            this._mp = first;
            this.octave = first.octave;
            this.pitchClass = new PitchClass(first);
        }
    }

    /**
     * Get full MIDI value including octave (0-127)
     */
    get fullMidiValue(): number {
        return this._mp.midi;
    }

    /**
     * Get frequency from MIDI value
     */
    get frequency(): number {
        return 440 * Math.pow(2, (this.fullMidiValue - 69) / 12);
    }

    /**
     * Get next pitch from interval
     */
    getNextFromInterval(semitones: number, step: number = 1): Pitch {
        const interval = mInterval(semitones, step);
        const result = this._mp.transposeReal(interval);
        return new Pitch(result);
    }

    /**
     * Convert to string representation with octave
     */
    toStringWithOctave(): string {
        return this.pitchClass.toString() + this.octave;
    }

    /**
     * Convert to string representation (without octave)
     */
    toString(): string {
        return this.pitchClass.toString();
    }

    /**
     * Parse from string with octave (e.g., "E4", "G♯5")
     */
    static fromStringWithOctave(str: string): Pitch {
        const lastChar = str.charAt(str.length - 1);
        const isDigit = /^\d$/.test(lastChar);

        if (isDigit) {
            const octave = parseInt(lastChar);
            const pitchClassStr = str.slice(0, -1);
            const pitchClass = PitchClass.fromString(pitchClassStr);
            return new Pitch(pitchClass, octave);
        } else {
            const pitchClass = PitchClass.fromString(str);
            return new Pitch(pitchClass, 5);
        }
    }

    /**
     * Parse from string (without octave)
     */
    static fromString(str: string, octave: number = 5): Pitch {
        const pitchClass = PitchClass.fromString(str);
        return new Pitch(pitchClass, octave);
    }

    /**
     * Create a Pitch with a specific PitchClass that sounds at the given MIDI value.
     * Correctly handles boundary-crossing pitch classes like C♭ and B♯.
     */
    static fromMidiValueWithSpelling(fullMidiValue: number, pitchClass: PitchClass): Pitch {
        const baseOctave = Math.floor(fullMidiValue / 12) - 1;
        const pcMidiValue = pitchClass.midiValue;
        const octaveAdjustment = pcMidiValue < 0 ? 1 : pcMidiValue > 11 ? -1 : 0;
        return new Pitch(pitchClass, baseOctave + octaveAdjustment);
    }

    /**
     * Create a new Pitch with a different enharmonic spelling but the same sounding pitch.
     */
    respell(newPitchClass: PitchClass): Pitch {
        return Pitch.fromMidiValueWithSpelling(this.fullMidiValue, newPitchClass);
    }

    /**
     * Check if equivalent (same pitch class and octave)
     */
    equals(other: Pitch): boolean {
        return this.pitchClass.equals(other.pitchClass) && this.octave === other.octave;
    }

    /**
     * Calculate the ascending interval between two pitches.
     * Uses meantonal's Interval.between() for the core calculation.
     */
    static ascendingInterval(from: Pitch, to: Pitch, wrapWithinTwoOctaves: boolean = false): Interval {
        // Sort notes by MIDI value to always deal with an ascending interval
        const [lower, higher] = from.fullMidiValue <= to.fullMidiValue
            ? [from, to]
            : [to, from];

        // Use meantonal to compute the interval
        let mIntv = MInterval.between(lower._mp, higher._mp);
        let stepspan = mIntv.stepspan;
        let quality = mIntv.quality;

        // Reduce compound intervals when not wrapping within two octaves
        if (!wrapWithinTwoOctaves && stepspan > 7) {
            const simple = mIntv.simple;
            stepspan = simple.stepspan;
            quality = simple.quality;
        }

        // Map stepspan to Step enum (values match directly)
        let stepEnum: Step;
        if (stepspan <= 14) {
            stepEnum = stepspan as Step;
        } else {
            // For very large intervals, reduce to extended range (8-14)
            stepEnum = (((stepspan - 1) % 7) + 8) as Step;
        }

        // Map meantonal quality to IntervalType.
        // Meantonal quality system:
        //   Perfect intervals (stepspan%7 in {0,3,4}): 0=P, ±2=A/d, ±3=AA/dd
        //   Imperfect intervals (stepspan%7 in {1,2,5,6}): ±1=M/m, ±2=A/d, ±3=AA/dd
        // Quality values ±2 and ±3 map the same for both types.
        let type: IntervalType;

        switch (quality) {
            case 3: type = IntervalType.DOUBLE_AUGMENTED; break;
            case 2: type = IntervalType.AUGMENTED; break;
            case 1: type = IntervalType.MAJOR; break;
            case 0: type = IntervalType.PERFECT; break;
            case -1: type = IntervalType.MINOR; break;
            case -2: type = IntervalType.DIMINISHED; break;
            case -3: type = IntervalType.DOUBLE_DIMINISHED; break;
            default:
                console.warn(`Unexpected interval quality: ${quality}, stepspan: ${stepspan}`);
                type = IntervalType.PERFECT;
                break;
        }

        const ascending = higher.fullMidiValue > lower.fullMidiValue;
        return new Interval(lower, higher, stepEnum, type, ascending);
    }
}
