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
     *  skipped, {@link firstExactMoves}) land on one onset, however far away: a German sixth repeated across many
     *  onsets (Haydn Sym. 99/ii) resolves past the look window, but both tones still move at once. Default
     *  `true`. */
    firstMoveMeet?: boolean;
}

const pcOf = (m: number) => ((m % 12) + 12) % 12;

/** How many onsets after a note the onset finder looks for its first semitone move. */
const MOVE_ONSETS = 64;
/** How far (in notes) on either side of a note to look for notes still sounding at its onset. */
const SOUNDING_NOTES = 64;

/**
 * Each note's FIRST semitone move at the exact pitch, read by onset: skip every later onset that strikes
 * the note's pitch class again (a repeated or re-voiced chord is not a move), then take the first onset
 * holding a note a semitone away in any octave. +1 if that onset has the semitone above at the exact pitch
 * (and not the one below), −1 for the one below, 0 otherwise. Note-offs are never read, so the finder
 * survives performance timing. Notes must be sorted by onset; co-struck notes share an exact `tOn`.
 * `at` receives, per note, the index of the first note of the onset its move lands on (−1: no move).
 */
function firstExactMoves(notes: readonly OutwardNote[], at: number[]): number[] {
    const n = notes.length;
    const exact = new Array<number>(n).fill(0);
    const clusterOf = new Array<number>(n);
    const cStart: number[] = [];
    let lastT = NaN;
    for (let i = 0; i < n; i++) {
        if (cStart.length === 0 || notes[i]!.tOn !== lastT) { cStart.push(i); lastT = notes[i]!.tOn; }
        clusterOf[i] = cStart.length - 1;
    }
    const C = cStart.length;
    const cEnd = (c: number) => (c + 1 < C ? cStart[c + 1]! : n);
    const struck = new Array<number>(C).fill(0);
    for (let c = 0; c < C; c++) for (let i = cStart[c]!; i < cEnd(c); i++) struck[c]! |= 1 << pcOf(notes[i]!.midi);
    for (let a = 0; a < n; a++) {
        const m = notes[a]!.midi, c0 = clusterOf[a]!, bit = 1 << pcOf(m);
        for (let g = c0 + 1; g < C && g - c0 <= MOVE_ONSETS; g++) {
            if (struck[g]! & bit) continue;
            // The nearest semitone neighbour in register decides the direction; equidistant neighbours above
            // and below conflict and say nothing.
            let best = Infinity, bd = 0, conflict = false, up = false, dn = false;
            for (let i = cStart[g]!; i < cEnd(g); i++) {
                const o = notes[i]!.midi, pd = pcOf(o - m);
                if (pd !== 1 && pd !== 11) continue;
                const d = pd === 1 ? 1 : -1, dist = Math.abs(o - m);
                if (o === m + 1) up = true;
                if (o === m - 1) dn = true;
                if (dist < best) { best = dist; bd = d; conflict = false; }
                else if (dist === best && d !== bd) conflict = true;
            }
            const x = up && !dn ? 1 : dn && !up ? -1 : 0;
            if ((conflict ? 0 : bd) === 0 && x === 0) continue;
            exact[a] = x;
            at[a] = cStart[g]!;
            break;
        }
    }
    return exact;
}

/**
 * Outward-convergence pairs. Note x and a note y still sounding at x's onset form a pair when:
 *   - x is ten semitones above y by pitch class (an augmented sixth or a minor seventh by pitch);
 *   - the major third above y sounds too (the chord's third: C in A♭–C–E♭–F♯);
 *   - each tone's first move ({@link firstExactMoves}) is outward: x up a semitone, y down a semitone;
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
    const n = notes.length;
    const partner = new Array<number>(n).fill(-1), role = new Array<number>(n).fill(0);
    const moveAt = new Array<number>(n).fill(-1);
    const moves = firstExactMoves(notes, moveAt);
    for (let x = 0; x < n; x++) {
        const t = notes[x]!.tOn;
        const sounding: number[] = [];
        for (let k = Math.max(0, x - SOUNDING_NOTES); k < Math.min(n, x + SOUNDING_NOTES); k++)
            if (notes[k]!.tOn <= t && notes[k]!.tOff > t) sounding.push(k);
        for (const y of sounding) {
            if (y === x || pcOf(notes[x]!.midi - notes[y]!.midi) !== 10) continue;
            if (moves[x] !== 1 || moves[y] !== -1) continue;
            if (!sounding.some(k => pcOf(notes[k]!.midi - notes[y]!.midi) === 4)) continue;
            let g = x; while (g < n && notes[g]!.tOn === t) g++;
            let met = false;
            for (let seen = 0; g < n && seen < look; seen++) {
                const tg = notes[g]!.tOn; let up = false, dn = false;
                while (g < n && notes[g]!.tOn === tg) {
                    if (notes[g]!.midi === notes[x]!.midi + 1) up = true;
                    if (notes[g]!.midi === notes[y]!.midi - 1) dn = true;
                    g++;
                }
                if (up && dn) { met = true; break; }
            }
            // "The two tones meet when their first moves, re-strikes skipped, land on one onset."
            if (!met && firstMoveMeet && moveAt[x]! >= 0 && moveAt[x] === moveAt[y]) met = true;
            if (!met) continue;
            if (partner[x]! < 0) { partner[x] = y; role[x] = 1; }
            if (partner[y]! < 0) { partner[y] = x; role[y] = -1; }
            break;
        }
    }
    return { partner, role };
}
