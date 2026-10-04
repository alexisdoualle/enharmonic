/**
 * CoreSpeller: four principles, one file, no imports.
 *
 * Meredith clean (195,972 notes), each principle added in turn:
 *
 *                              exact   coherent   wrong
 *   principles 1 + 2          92.95%    99.12%    0.88%
 *   + 3 (recency guard)       97.56%    99.44%    0.56%
 *   + 4 (spiral fold)         99.37%    99.46%    0.54%
 *   real-time Speller         99.53%    99.58%    0.42%
 *
 * The real-time Speller cut down to its four principles, without the side tracking.
 * `src/core.ts` is the source of truth; `test/examples/standalone.test.ts` keeps this
 * copy identical to it on every fixture.
 *
 * It spells coherently but can put a passage on the wrong side of the spiral of fifths.
 * A whole section one comma off is flipped, not wrong: D♭ major spelled as C♯ major.
 * A note that misses the shift is wrong: in C♯ F G♯, the F should be E♯.
 *
 * Four principles:
 *   1. INTERVAL SCORING. Of a pitch's spellings, pick the one with the most consonant
 *      intervals against the running scale (consonances score up, augmented and
 *      diminished down). The scale settles into a key without detecting one.
 *   2. THE 7-LETTER LIMIT. The scale holds one spelling per letter A-G. Each note
 *      replaces its letter's slot, so spelling a note means choosing its letter.
 *   3. THE RECENCY GUARD. Interval scoring skips the candidate's own letter, so it
 *      misses A♭ right after A♮. The guard docks a letter respelled within K onsets.
 *      It stops flicker, not modulation.
 *   4. THE SPIRAL FOLD. Interval scoring can't tell D♭ from C♯, so the scale can walk
 *      a comma sharp (C𝄪 D♯ E♯ F𝄪 G♯ A♯ B♯). When its average drifts more than 8 fifths
 *      from D, every slot moves one comma back (E♯ becomes F, B♯ becomes C). Every
 *      major key from F♭ to G♯ stays inside.
 *
 * One scale, its slots overwritten and never reverted. The shipped Speller adds a
 * diatonic-anchor leash that tracks the side passage by passage, and an optional
 * look-ahead. spellTwoPass runs it offline in two passes.
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
/** Letter slots in note-name order C D E F G A B, for output and read-back. */
const LETTER_ORDER = [1, 3, 5, 0, 2, 4, 6] as const;

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

// ── Enharmonic candidates ────────────────────────────────────────────────────

/**
 * Every spelling of `midi`'s pitch class. Cut the line of fifths (F♭♭ at -15 to B♯♯ at +19)
 * into rows of 12 and stack them:
 *
 *   F♭♭ C♭♭ G♭♭ D♭♭ A♭♭ E♭♭ B♭♭ F♭  C♭  G♭  D♭  A♭    n = -15..-4
 *   E♭  B♭  F   C   G   D   A   E   B   F♯  C♯  G♯    n =  -3..8
 *   D♯  A♯  E♯  B♯  F♯♯ C♯♯ G♯♯ D♯♯ A♯♯ E♯♯ B♯♯       n =   9..19
 *   3   10  5   0   7   2   9   4   11  6   1   8    pitch class
 *
 * Each column is one pitch class: spellings of the same pitch sit 12 fifths apart.
 * A fifth is 7 semitones, so position n has pitch class 7n mod 12. Since 7 × 7 = 49
 * = 1 (mod 12), the inverse is the same map: n0 = 7·pc mod 12 is the spelling of pc
 * in 0..11 (C to E♯). The others are n0 - 24, n0 - 12 and n0 + 12, kept within
 * -15..19. A column holds two or three spellings (pc 8 has only A♭ and G♯).
 */
function candidates(midi: number): number[] {
    const n0 = (7 * (midi % 12)) % 12;
    const out: number[] = [];
    for (let n = n0 - 24; n <= n0 + 12; n += 12) {
        if (n >= -15 && n <= 19) out.push(n); // within a double flat or double sharp
    }
    return out;
}

// ── Interval scoring (principle 1) ─────────────────────────────────────────────

/**
 * Consonance of the interval between two spellings, the whole of principle 1 as one number.
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

// ── The spiral fold (principle 4) ────────────────────────────────────────────

/** Fold centre (D) and radius R, in fifths: fold when the scale's average sits more than R from D. */
const FOLD_CENTRE = 2;
const FOLD_RADIUS = 8;

// ── The speller ──────────────────────────────────────────────────────────────

export class CoreSpeller {
    /** Principle 2, the 7-letter limit: one spelling per letter, the drifting scale. Starts at C major. */
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
        let best: number | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const n of candidates(midi)) {
            // Principle 1 scores the candidate; principle 3 docks it.
            const s = intervalScore(n, this.scale) - this.guardPenalty(n);
            if (s > bestScore || (s === bestScore && plainer(n, best!))) { bestScore = s; best = n; }
        }
        if (best === null) return;
        // Principle 2: the winner overwrites its letter's slot.
        this.scale[letter(best)] = best;
        this.active.set(midi, best);
        // Principle 3: remember when this letter was set.
        this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
        // Principle 4: past the radius, shift every slot one comma (12 fifths) back toward D.
        const off = this.scale.reduce((a, b) => a + b, 0) - 7 * FOLD_CENTRE;
        if (Math.abs(off) > 7 * FOLD_RADIUS) {
            const k = -12 * Math.sign(off);
            for (const n of [...this.scale]) this.scale[letter(n + k)] = n + k;
        }
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The spelling of a sounding note (its committed one), else the scale's spelling of its pitch class,
     *  searching the letters C to B. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const n = this.active.get(midi)
            ?? LETTER_ORDER.map(s => this.scale[s]!).find(m => pitchClass(m) === midi % 12);
        return n === undefined ? null : { ...spellingOf(n), octave };
    }

    /** Read-only snapshot of the current 7-letter scale, C to B (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTER_ORDER.map(s => spellingOf(this.scale[s]!));
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
