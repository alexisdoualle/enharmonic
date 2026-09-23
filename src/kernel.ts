/**
 * The small shared surface the streaming API and the two-pass driver use: the look-ahead context
 * object and the resolution-step helper that fills it. The speller itself is the self-contained
 * {@link SpellingEngine} in engine.ts.
 */

/** Per-note context passed to the speller. */
export interface NoteContext {
    /** Look-ahead resolution direction (+1 up, −1 down, 0 none), supplied from a small forward buffer.
     *  Used only in look-ahead mode; the real-time and two-pass paths ignore it. */
    readonly resolveDir?: number;
    /** Event timestamp. Notes sharing a `t` are one onset (a chord); a new `t` starts a new onset. */
    readonly t?: number;
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
