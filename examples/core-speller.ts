/**
 * CoreSpeller: the three-principle enharmonic speller, self-contained.
 *
 * The basic spelling model in one file, zero imports. A truncated version of the
 * shipped real-time Speller: the three principles alone, without the settings that
 * correct the enharmonic side. `src/core.ts` is the source of truth; this file is a
 * derived copy, pinned to it by `test/examples/standalone.test.ts` (equal spellings
 * on every fixture). Kept for pedagogy. On its own, this model reads spellings coherently
 * (intervals right, flicker-free), at the cost of sometimes landing on the wrong side of the
 * spiral of fifths (C# vs Db). Note: coherent means an entire section is transposed to a comma: e.g.
 * a passage the composer wrote in Db major is spelled in C# major instead. A lone note cannot be
 * "flipped": if what was a Db major chord is spelled in C# major: C# F G#, "F" is considered "wrong", 
 * because it disagrees with its neighbors, even if that note was in the original score. 
 * It wasn't transposed correctly, it should be "E#".
 *
 * Three principles, and nothing else:
 *   1. The 7-LETTER LIMIT. A running "resolved scale" holds one spelling per letter
 *      A-G. Every note overwrites its letter's slot; spelling a note means choosing
 *      which letter to claim.
 *   2. INTERVAL SCORING. Among a pitch's enharmonic candidates, pick the one that
 *      forms the most consonant intervals with the rest of the resolved scale
 *      (consonances reward, augmented/diminished punish). The scale drifts into key
 *      with no explicit key detection.
 *   3. THE RECENCY GUARD. Interval scoring reads a candidate against the OTHER letters
 *      only, so it misses a same-letter clash (A♭ right after A♮). The guard docks a
 *      candidate whose letter was last committed at a different accidental within K
 *      onsets, so a slot cannot flicker against its recent self. Bounded on purpose: it
 *      blocks flicker, not real modulation.
 *
 * Frameless and persistent: one drifting scale whose slots are overwritten, never
 * reverted. The weakest form of the speller. The shipped Speller adds side
 * correction, an optional look-ahead, and more; spellTwoPass runs the same model
 * offline in two passes.
 *
 * The principles all but solve coherence (intervals right and
 * flicker-free, well under 1% incoherent). The residual gap from coherent to exact is
 * the SIDE: with no key-signature prior and no range cap, the scale can drift onto the
 * other enharmonic side of a passage (a coherent flip, e.g. D♭ F A♭ for C♯ E♯ G♯:
 * notation, not error). The full Speller fixes the side.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
/** Double-flat through double-sharp; the speller produces nothing more remote. */
type Accidental = -2 | -1 | 0 | 1 | 2;
interface PitchClass { readonly step: Letter; readonly alter: Accidental; }
interface Pitch { readonly step: Letter; readonly alter: Accidental; readonly octave: number; }

// ── The line of fifths ───────────────────────────────────────────────────────

/*
 * Inside the speller, every spelling is one integer n: its position on the line of fifths (C=0).
 *
 *   ... A♭  E♭  B♭  F   C   G   D   A   E   B   F♯  C♯  G♯  D♯ ...
 *   ... -4  -3  -2  -1  0   1   2   3   4   5   6   7   8   9  ...
 *
 * +1 is a fifth (C, G, D). +7 is the same letter one accidental sharper (E♭ -3, E 4, E♯ 11).
 * Letter, accidental and pitch class are all read off n. {step, alter} only appears at the
 * public API.
 */

/** The seven letters in fifths order, indexed by letter slot. */
const FIFTHS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;

/** Letter slot of n, 0..6 in fifths order (F C G D A E B). The letter repeats every 7 steps. */
function letter(n: number): number {
    return ((n + 1) % 7 + 7) % 7;
}

/** Accidental of n: -1 flat, 0 natural, +1 sharp. Naturals are F (-1) to B (5). */
function acc(n: number): number {
    return Math.floor((n + 1) / 7);
}

/** Pitch class of n (0-11). A fifth is 7 semitones, so n sounds 7n mod 12. */
function pitchClass(n: number): number {
    return ((7 * n) % 12 + 12) % 12;
}

/** Readable name of n (-3 -> "E♭"), for debugging. */
function name(n: number): string {
    const a = acc(n);
    return FIFTHS[letter(n)] + (a > 0 ? '♯'.repeat(a) : '♭'.repeat(-a));
}

/** Tie-break: true if `a` is plainer than `b` (fewer accidentals, then sharp over flat). */
function plainer(a: number, b: number): boolean {
    return Math.abs(acc(a)) < Math.abs(acc(b)) || (Math.abs(acc(a)) === Math.abs(acc(b)) && acc(a) > acc(b));
}

// ── Interval scoring (principle 2) ─────────────────────────────────────────────

/**
 * Consonance of the interval between two spellings, the whole of principle 2 as one number.
 * It depends only on their distance `d` on the line of fifths, so the interval never has
 * to be named: read the score straight off `d`.
 *   d = 1      P5 / P4              consonant  +1
 *   d = 3, 4   3rds / 6ths          consonant  +1
 *   d = 0,2,5  unison, 2nds, 7ths   neutral     0
 *   d = 6..12  augmented / dim.     dissonant  -1
 *   d >= 13    doubly aug / dim.    worse      -2
 */
function consonance(a: number, b: number): number {
    const d = Math.abs(a - b);
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** Sum of a candidate's consonance against the rest of the scale. Higher = better fit. */
function intervalScore(n: number, scale: readonly number[]): number {
    let total = 0;
    for (let slot = 0; slot < 7; slot++) {
        if (slot === letter(n)) continue; // candidate replaces this slot
        total += consonance(n, scale[slot]!);
    }
    return total;
}

// ── The recency guard (principle 3) ────────────────────────────────────────────

/** Penalty G for a same-letter/different-accidental clash, over a window of K onsets. */
const GUARD_PENALTY = 2;
const GUARD_WINDOW = 3;

// ── The speller ──────────────────────────────────────────────────────────────

export class CoreSpeller {
    /** Principle 1, the 7-letter limit: one spelling per letter, the drifting scale. Starts at C major. */
    //                          F   C  G  D  A  E  B
    private scale: number[] = [-1, 0, 1, 2, 3, 4, 5];
    /** Spelling committed for each sounding note, so note-off reads back that note's own
     *  spelling even if a later same-letter note has overwritten the slot. */
    private active = new Map<number, number>();
    /** Principle 3, the recency guard's memory: letter slot -> the onset and spelling last committed there. */
    private lastByLetter: ({ onset: number; n: number } | undefined)[] = [];
    /** Onset counter (co-struck notes sharing a `t` are one onset); -1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;

    /** Principle 3: GUARD_PENALTY if n's letter was committed at a different accidental
     *  within the last GUARD_WINDOW onsets, else 0. */
    private guardPenalty(n: number): number {
        const last = this.lastByLetter[letter(n)];
        return last && last.n !== n && this.onset - last.onset <= GUARD_WINDOW ? GUARD_PENALTY : 0;
    }

    /** Commit a spelling for `midi`: the candidate whose intervals best fit the current scale, less
     *  the recency-guard penalty. `t` groups co-struck notes (same `t`) into one onset; omit it to
     *  treat every call as its own onset. */
    noteOn(midi: number, t?: number): void {
        // Advance the onset at each new `t` (co-struck notes share one; the guard window counts onsets).
        if (t === undefined || t !== this.lastT) {
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        // The candidates are every spelling of this pitch class. Cut the line of fifths
        // (F♭♭ at -15 to B♯♯ at +19) into rows of 12 and stack them:
        //
        //   F♭♭ C♭♭ G♭♭ D♭♭ A♭♭ E♭♭ B♭♭ F♭  C♭  G♭  D♭  A♭    n = -15..-4
        //   E♭  B♭  F   C   G   D   A   E   B   F♯  C♯  G♯    n =  -3..8
        //   D♯  A♯  E♯  B♯  F♯♯ C♯♯ G♯♯ D♯♯ A♯♯ E♯♯ B♯♯       n =   9..19
        //   3   10  5   0   7   2   9   4   11  6   1   8    pitch class
        //
        // Each column is one pitch class: spellings of the same pitch sit 12 fifths apart.
        // A fifth is 7 semitones, so position n has pitch class 7n mod 12. Since 7 × 7 = 49
        // = 1 (mod 12), the inverse is the same map: n0 = 7·pc mod 12 is the spelling of pc
        // in 0..11 (C to E♯). The others are n0 - 24, n0 - 12 and n0 + 12, kept within
        // -15..19. A column holds two or three spellings (pc 8 has only A♭ and G♯).
        const n0 = (7 * (midi % 12)) % 12;
        let best: number | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (let n = n0 - 24; n <= n0 + 12; n += 12) {
            if (n < -15 || n > 19) continue; // beyond double flat or double sharp
            const s = intervalScore(n, this.scale) - this.guardPenalty(n);
            if (s > bestScore || (s === bestScore && plainer(n, best!))) { bestScore = s; best = n; }
        }
        if (best === null) return;
        // Principle 1: the winner overwrites its letter's slot.
        this.scale[letter(best)] = best;
        this.active.set(midi, best);
        // Principle 3: remember when this letter was set.
        this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The spelling of a sounding note (its committed one), else the scale's current spelling of it. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const n = this.active.get(midi) ?? this.scale.find(m => pitchClass(m) === midi % 12);
        return n === undefined ? null : { ...spellingOf(n), octave };
    }

    /** Read-only snapshot of the current 7-letter scale, in fifths order (introspection). */
    getResolvedScale(): PitchClass[] {
        return this.scale.map(spellingOf);
    }

    /** The scale by name, in fifths order, e.g. "F C G D A E B" or "F♯ C♯ G♯ D♯ A♯ E♯ B". */
    toString(): string {
        return this.scale.map(name).join(' ');
    }
}

/** {step, alter} of n, for the public API. */
function spellingOf(n: number): PitchClass {
    return { step: FIFTHS[letter(n)]!, alter: acc(n) as Accidental };
}
