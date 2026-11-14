/**
 * LOOK UNTIL THE NOTE RESOLVES (look-ahead context): where each note resolves, read from the notes that follow.
 *
 * The look-ahead's letter-aware vote needs a note's resolution direction (`NoteContext.resolveDir` /
 * `resolveExact`): +1 when it moves up a semitone, −1 down, 0 unknown. The first reader is the forward buffer: the
 * first note a semitone away (any octave for `resolveDir`, the exact pitch for `resolveExact`) among the next
 * `window` notes. When that finds nothing, a note whose own voice repeats, holds or rests is still waiting to
 * resolve, so the reader follows the note's OWN voice (its register: the same octave) until it moves by a semitone:
 * notes struck with it are not its resolution, a re-strike of the note extends the scan, a step of a tone does not
 * end it (the voice may pass on to its semitone), and the scan stops at `max` notes. Mozart Requiem Introitus m45:
 * G♯ hammered eight times across doubled parts rises to A 80 notes later; the 16-note buffer sees no semitone and
 * the speller wrote A♭, the own-voice scan finds the rise and it writes G♯.
 *
 * REACH is a theory parameter, not a latency budget: about one chromatic note in six resolves beyond 16 notes
 * (doubled or repeated chords, hammered notes, a voice resting while others move), and following them pays up to
 * about 128 notes. A live caller who wants the rule exactly must buffer that far, or pass `mode: 'window'`.
 */

import { resolveExactStep, resolveStep } from './kernel.js';

/** A note as {@link resolutionDirs} reads it, in onset order (onset ascending, bass first within a chord). */
export interface ResolutionNote { readonly midi: number; readonly tOn: number }

/** How far the resolution reader looks. */
export interface ResolutionReach {
    /** `'window'`: only the forward buffer. `'own-voice'`: the buffer first; when it finds no semitone, follow the
     *  note's own voice until it moves by a semitone, up to `max` notes. */
    readonly mode?: 'window' | 'own-voice';
    /** Notes after the note read by the forward buffer. Default 16. */
    readonly window?: number;
    /** `'own-voice'`: notes after the note (co-struck ones included) the voice is followed for. Default 128. */
    readonly max?: number;
    /** Both counts are in notes (on-events). Only `'notes'` exists: a time reach (1 s, 2 s, 4 s) lost to it. */
    readonly unit?: 'notes';
}

/** The default reach: the 16-note buffer, then the note's own voice up to 128 notes. */
export const RESOLUTION_REACH: Required<ResolutionReach> = { mode: 'own-voice', window: 16, max: 128, unit: 'notes' };

/** Per note (input order): its resolution direction for `resolveDir` (`dir`, any octave) and `resolveExact`
 *  (`exact`, exact pitch). The own-voice scan fills `dir`, and `exact` when the buffer left it at 0. */
export function resolutionDirs(notes: readonly ResolutionNote[], reach: ResolutionReach = {}): { dir: number[]; exact: number[] } {
    const { mode, window, max } = { ...RESOLUTION_REACH, ...reach };
    const n = notes.length;
    const dir = new Array<number>(n).fill(0), exact = new Array<number>(n).fill(0);
    for (let a = 0; a < n; a++) {
        const m = notes[a]!.midi;
        for (let b = a + 1; b < n && b - a <= window; b++) {
            if (dir[a] === 0) dir[a] = resolveStep(m, notes[b]!.midi);
            if (exact[a] === 0) exact[a] = resolveExactStep(m, notes[b]!.midi);
            if (dir[a] !== 0 && exact[a] !== 0) break;
        }
        if (mode === 'own-voice' && dir[a] === 0) {
            dir[a] = ownVoiceStep(notes, a, max);
            if (exact[a] === 0) exact[a] = dir[a]!;
        }
    }
    return { dir, exact };
}

/** The note's own voice, onset by onset after its own: the first onset that does not re-strike the note and strikes
 *  a semitone above or below it (same octave) gives the direction (both at once: 0); 0 if none within `max` notes. */
function ownVoiceStep(notes: readonly ResolutionNote[], a: number, max: number): number {
    const A = notes[a]!, n = notes.length;
    let b = a + 1;
    while (b < n && notes[b]!.tOn === A.tOn) b++;          // struck with it: not its resolution
    while (b < n && b - a <= max) {
        const t0 = notes[b]!.tOn;
        let e = b, re = false, up = false, down = false;
        for (; e < n && notes[e]!.tOn === t0; e++) {
            const d = notes[e]!.midi - A.midi;
            if (d === 0) re = true; else if (d === 1) up = true; else if (d === -1) down = true;
        }
        if (!re && (up || down)) return up && down ? 0 : up ? 1 : -1;
        b = e;
    }
    return 0;
}
