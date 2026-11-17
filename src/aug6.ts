/**
 * Augmented sixths by outward convergence: the look-ahead context the engine's aug6 rule reads.
 *
 * Proposition: two tones ten semitones apart that move outward and meet on one pitch class are an
 * augmented sixth, and the rising tone is the ♯4 (A♭–C–E♭–F♯ → G: F♯ rises and A♭ falls onto G). Its
 * spelling is ten fifths sharp of its partner's, never the dominant seventh's minor seventh (G♭).
 *
 * {@link outwardPairs} finds the pairs from the notes alone (it needs the future, so it is look-ahead or
 * offline context, like `resolveDir`). The engine decides whether the convergence is functional, by the key
 * gate in its `aug6Outward` option, and applies it.
 */

/** A note with its onset and release times (any `t` units). */
export interface OutwardNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

/** Per note (same order as the input): the index of its outward partner (−1 none) and its role,
 *  +1 for the rising upper tone (the ♯4), −1 for the falling lower tone (the ♭6). */
export interface OutwardPairs {
    readonly partner: number[];
    readonly role: number[];
}

/** Options for {@link outwardPairs}. */
export interface OutwardOptions {
    /** MEETING BY FIRST MOVES. The two tones of an augmented sixth also meet when their first moves (re-strikes
     *  skipped, {@link firstMoves}) land on one onset, however far away: a German sixth repeated across many
     *  onsets (Haydn Sym. 99/ii) resolves past the look window, but both tones still move at once. Default
     *  `true`. */
    firstMoveMeet?: boolean;
    /** A UNISON MEET RESOLVES INTO A CHORD. When the two goals are one pitch (the tones a major second apart
     *  closing onto a unison), the pair counts only if the meeting onset strikes at least this many notes. Two
     *  lone voices crossing on one note are passing, not an augmented sixth: in C minor, A♭ and F♯ landing on
     *  a struck G chord are an aug6; the same two tones meeting on a bare G are not. 0 turns it off. Default 3
     *  (the look-ahead tier); `spellTwoPass` passes 0 unless `aug6ChordMeet` is set. */
    chordMeet?: number;
}

import { groupOnsets, type Onsets } from './onsets.js';

const pcOf = (m: number) => ((m % 12) + 12) % 12;

/** How many onsets after a note the move finder looks for its first semitone move. */
const MOVE_ONSETS = 64;
/** How far (in notes) on either side of a note to look for notes still sounding at its onset. */
const SOUNDING_NOTES = 64;

/**
 * Each note's FIRST semitone move, read by onset: skip every later onset that strikes the note's pitch
 * class again (a repeated or re-voiced chord is not a move), then take the first onset whose nearest
 * semitone neighbour (nearest in register, any octave) lies on one side only. `dir` is +1 if that onset
 * strikes the semitone above at the exact pitch (and not the one below), −1 for the one below, 0 otherwise;
 * `at` is the onset the move lands on (−1: no move). Note-offs are never read, so the finder survives
 * performance timing.
 */
function firstMoves(notes: readonly OutwardNote[], on: Onsets): { dir: number[]; at: number[] } {
    const dir = notes.map(() => 0), at = notes.map(() => -1);
    const count = on.start.length - 1;
    // Per onset, a bitmask of the pitch classes it strikes.
    const pcs = new Array<number>(count).fill(0);
    notes.forEach((note, i) => { pcs[on.of[i]!] = pcs[on.of[i]!]! | (1 << pcOf(note.midi)); });
    notes.forEach(({ midi: m }, a) => {
        const c0 = on.of[a]!;
        for (let c = c0 + 1; c < count && c - c0 <= MOVE_ONSETS; c++) {
            if (pcs[c]! & (1 << pcOf(m))) continue;
            // Distance to the nearest note whose pitch class is a semitone above / below m's.
            let above = Infinity, below = Infinity;
            for (let i = on.start[c]!; i < on.start[c + 1]!; i++) {
                const o = notes[i]!.midi, pd = pcOf(o - m);
                if (pd === 1) above = Math.min(above, Math.abs(o - m));
                if (pd === 11) below = Math.min(below, Math.abs(o - m));
            }
            if (above === below) continue;   // no neighbour, or one each side at the same distance
            dir[a] = above === 1 ? 1 : below === 1 ? -1 : 0;
            at[a] = c;
            return;
        }
    });
    return { dir, at };
}

/**
 * Outward-convergence pairs. Note x and a note y still sounding at x's onset form a pair when:
 *   - x is ten semitones above y by pitch class (an augmented sixth or a minor seventh by pitch);
 *   - the major third above y sounds too (the chord's third: C in A♭–C–E♭–F♯);
 *   - each tone's first move ({@link firstMoves}) is outward: x up a semitone, y down a semitone;
 *   - one onset among the next `look` onsets after x's strikes both x+1 and y−1 at the exact pitch, so the
 *     two tones meet on one pitch class at once; or (`firstMoveMeet`) both first moves land on one onset.
 * x gets role +1 (rising) and y role −1 (falling); a note keeps its first pair. Whether the convergence is
 * an augmented sixth or a dominant seventh whose seventh happens to rise is left to the engine's key gate.
 *
 * Notes must be sorted by onset (co-struck notes share an exact `tOn`, in any order). Note-offs are read
 * only to know what is sounding at x's onset.
 */
export function outwardPairs(notes: readonly OutwardNote[], look = 8, opts: OutwardOptions = {}): OutwardPairs {
    const firstMoveMeet = opts.firstMoveMeet ?? true;
    const chordMeet = opts.chordMeet ?? 3;
    const n = notes.length;
    const partner = new Array<number>(n).fill(-1), role = new Array<number>(n).fill(0);
    const on = groupOnsets(notes);
    const moves = firstMoves(notes, on);
    const count = on.start.length - 1;
    const size = (c: number) => on.start[c + 1]! - on.start[c]!;
    const strikes = (c: number, midi: number) => {
        for (let i = on.start[c]!; i < on.start[c + 1]!; i++) if (notes[i]!.midi === midi) return true;
        return false;
    };

    for (let x = 0; x < n; x++) {
        if (moves.dir[x] !== 1) continue;
        const mx = notes[x]!.midi, t = notes[x]!.tOn, cx = on.of[x]!;
        const sounding: number[] = [];
        for (let k = Math.max(0, x - SOUNDING_NOTES); k < Math.min(n, x + SOUNDING_NOTES); k++)
            if (notes[k]!.tOn <= t && notes[k]!.tOff > t) sounding.push(k);
        for (const y of sounding) {
            const my = notes[y]!.midi;
            if (y === x || pcOf(mx - my) !== 10 || moves.dir[y] !== -1) continue;
            if (!sounding.some(k => pcOf(notes[k]!.midi - my) === 4)) continue;
            // Onset c strikes both goals; a unison meet (both goals one pitch) also needs a chord there.
            const unison = chordMeet > 0 && mx + 1 === my - 1;
            const meetsAt = (c: number) =>
                strikes(c, mx + 1) && strikes(c, my - 1) && !(unison && size(c) < chordMeet);
            let met = false;
            for (let c = cx + 1; c < count && c - cx <= look && !met; c++) met = meetsAt(c);
            // They also meet when their first moves, re-strikes skipped, land on one onset (which then
            // strikes both goals by definition).
            if (!met && firstMoveMeet && moves.at[x]! >= 0 && moves.at[x] === moves.at[y]) met = meetsAt(moves.at[x]!);
            if (!met) continue;
            if (partner[x]! < 0) { partner[x] = y; role[x] = 1; }
            if (partner[y]! < 0) { partner[y] = x; role[y] = -1; }
            break;
        }
    }
    return { partner, role };
}
