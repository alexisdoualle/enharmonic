import { Pitch } from './Pitch';
import { Step, IntervalType, LetterNameUtils } from '../types';

/**
 * Represents a musical interval between two pitches
 */
export class Interval {
    constructor(
        public readonly firstNote: Pitch,
        public readonly secondNote: Pitch,
        public readonly step: Step,
        public readonly type: IntervalType,
        public readonly ascending: boolean
    ) {}

    /**
     * Check if this interval is a tritone (augmented 4th or diminished 5th)
     */
    get isTritone(): boolean {
        return (this.step === Step.FOURTH && this.type === IntervalType.AUGMENTED) ||
               (this.step === Step.FIFTH && this.type === IntervalType.DIMINISHED);
    }

    /**
     * Check if this interval is a unison or octave
     */
    get isUnisonOrOctave(): boolean {
        return this.step === Step.UNISON || this.step === Step.OCTAVE;
    }

    /**
     * Check if two notes form a relative interval (minor 3rd or major 6th)
     */
    static isRelative(firstNote: Pitch, secondNote: Pitch): boolean {
        const interval = Pitch.ascendingInterval(firstNote, secondNote, false);
        return (interval.step === Step.THIRD && interval.type === IntervalType.MINOR) ||
               (interval.step === Step.SIXTH && interval.type === IntervalType.MAJOR);
    }

    /**
     * Get the inverted interval
     */
    getInvertedInterval(): Interval {
        // Invert the step
        const invertedStep = Step.UNISON + (7 - this.step) % 7;

        // Invert the type
        let invertedType: IntervalType;
        switch (this.type) {
            case IntervalType.MAJOR:
                invertedType = IntervalType.MINOR;
                break;
            case IntervalType.MINOR:
                invertedType = IntervalType.MAJOR;
                break;
            case IntervalType.AUGMENTED:
                invertedType = IntervalType.DIMINISHED;
                break;
            case IntervalType.DIMINISHED:
                invertedType = IntervalType.AUGMENTED;
                break;
            case IntervalType.PERFECT:
                invertedType = IntervalType.PERFECT;
                break;
            case IntervalType.DOUBLE_AUGMENTED:
                invertedType = IntervalType.DOUBLE_DIMINISHED;
                break;
            case IntervalType.DOUBLE_DIMINISHED:
                invertedType = IntervalType.DOUBLE_AUGMENTED;
                break;
            default:
                invertedType = IntervalType.PERFECT;
        }

        return new Interval(this.secondNote, this.firstNote, invertedStep, invertedType, !this.ascending);
    }

    /**
     * Get a string representation of the interval
     */
    toString(): string {
        const stepNames: Record<Step, string> = {
            [Step.UNISON]: '1',
            [Step.SECOND]: '2',
            [Step.THIRD]: '3',
            [Step.FOURTH]: '4',
            [Step.FIFTH]: '5',
            [Step.SIXTH]: '6',
            [Step.SEVENTH]: '7',
            [Step.OCTAVE]: '8',
            [Step.NINTH]: '9',
            [Step.TENTH]: '10',
            [Step.ELEVENTH]: '11',
            [Step.TWELFTH]: '12',
            [Step.THIRTEENTH]: '13',
            [Step.FOURTEENTH]: '14',
            [Step.FIFTEENTH]: '15'
        };

        const typeSymbols: Record<IntervalType, string> = {
            [IntervalType.DOUBLE_AUGMENTED]: 'AA',
            [IntervalType.AUGMENTED]: 'A',
            [IntervalType.MAJOR]: 'M',
            [IntervalType.PERFECT]: 'P',
            [IntervalType.MINOR]: 'm',
            [IntervalType.DIMINISHED]: 'd',
            [IntervalType.DOUBLE_DIMINISHED]: 'dd'
        };

        const direction = this.ascending ? '↑' : '↓';
        return `${typeSymbols[this.type]}${stepNames[this.step]}`;//${direction}`;
    }
} 