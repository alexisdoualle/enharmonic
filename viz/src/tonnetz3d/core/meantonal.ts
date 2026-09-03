/**
 * Bridge utilities between meantonal library and our codebase
 */
import { Interval as MInterval } from 'meantonal';

export { Pitch as MPitch, Interval as MInterval, SPN } from 'meantonal';

/**
 * Convert accidental number to SPN notation (#, b, ##, bb, etc.)
 */
export function accidentalToSPN(acc: number): string {
    if (acc > 0) return '#'.repeat(acc);
    if (acc < 0) return 'b'.repeat(-acc);
    return '';
}

/**
 * Create meantonal Interval from semitones + diatonic steps.
 * Formula: w = semitones - steps, h = 2*steps - semitones
 */
export function mInterval(semitones: number, steps: number): MInterval {
    return new MInterval(semitones - steps, 2 * steps - semitones);
}
