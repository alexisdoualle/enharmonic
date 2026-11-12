/**
 * The small shared surface the streaming API and the two-pass driver use: the look-ahead context
 * object and the resolution-step helper that fills it. The speller itself is the self-contained
 * {@link SpellingEngine} in engine.ts.
 */

import type { LocalKey } from './key.js';

/** Per-note context passed to the speller. */
export interface NoteContext {
    /** Look-ahead resolution direction (+1 up, −1 down, 0 none), supplied from a small forward buffer.
     *  Used only in look-ahead mode; the real-time and two-pass paths ignore it. */
    readonly resolveDir?: number;
    /** The same at the exact pitch (+1 if the note's semitone above in the same octave comes first, −1 for
     *  the semitone below, 0 neither): the note's own line, not another voice. Look-ahead mode only. */
    readonly resolveExact?: number;
    /** Event timestamp. Notes sharing a `t` are one onset (a chord); a new `t` starts a new onset. */
    readonly t?: number;
    /** Augmented-sixth context: the midi of a sounding tone ten semitones away that, with this note, moves
     *  outward to one pitch class (see `outwardPairs`, which fills this and {@link outwardRole}). Look-ahead
     *  mode only; omit it to switch the aug6 rule off. */
    readonly outwardPartner?: number;
    /** This note's role in that pair: +1 the rising upper tone (the ♯4), −1 the falling lower tone. */
    readonly outwardRole?: number;
    /** The local key around the note (see `localKeys`, which reads it on onsets centred on the note): a
     *  falling note that is one of its leading tones keeps the key's name instead of the look-ahead's letter
     *  step. Look-ahead mode only; omit it to switch the leading-tone gate off. */
    readonly localKey?: LocalKey | null;
}

/**
 * Semitone step from `from` to `to` IGNORING the octave: +1 up, −1 down, 0 otherwise; the test a
 * look-ahead driver applies over its forward buffer to fill {@link NoteContext.resolveDir}.
 *
 * A resolution is a semitone on the line, and the voice that answers it need not be in the same octave
 * (an E♯ can resolve to an F♯ two octaves down in the bass), which an exact-midi scan misses. Ignoring
 * the octave costs nothing measurable in false positives.
 */
export function resolveStep(from: number, to: number): number {
    const iv = (((to - from) % 12) + 12) % 12;
    return iv === 1 ? 1 : iv === 11 ? -1 : 0;
}

/** Semitone step from `from` to `to` at the exact pitch: +1, −1, or 0. Fills {@link NoteContext.resolveExact}. */
export function resolveExactStep(from: number, to: number): number {
    return to === from + 1 ? 1 : to === from - 1 ? -1 : 0;
}
