/**
 * CoreSpeller: the three-principle enharmonic speller, self-contained.
 *
 * The basic spelling model in one file, zero imports. A truncated version of the
 * shipped real-time Speller: the three principles alone, without the settings that
 * correct the enharmonic side. `src/core.ts` is the source of truth; this file is a
 * derived copy, pinned to it by `test/examples/standalone.test.ts` (equal spellings
 * on every fixture). Kept for pedagogy. On its own, this model reads spellings coherently
 * (intervals right, flicker-free), at the cost of sometimes landing on the wrong side of the
 * spiral of fifths (C# vs Db).
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

// ── Constant tables ──────────────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
/** Natural pitch class of each letter (C = 0). */
const LETTER_BASE: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Line-of-fifths position of each natural (F=-1 to B=+5); the fifth-distance axis principle 2 scores on. */
const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

// ── Enharmonic candidates ────────────────────────────────────────────────────

/** The seven letters in fifths order; F is at line-of-fifths position -1, B at +5. */
const FIFTHS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;

/**
 * Spelling at line-of-fifths position `n` (C=0). +1 is a fifth (C, G, D), +7 is one
 * accidental (E♭, E, E♯), so the letter cycles every 7 steps: F♭♭(-15) to B♯♯(+19).
 */
function spellingAt(n: number): PitchClass {
    return { step: FIFTHS[((n + 1) % 7 + 7) % 7]!, alter: Math.floor((n + 1) / 7) as Accidental };
}

/**
 * The 35 spellings bucketed by pitch class. Cut the line of fifths (F♭♭ at -15 to
 * B♯♯ at +19) into rows of 12 and stack: a fifth adds 7 to the pitch class (mod 12),
 * so spellings 12 fifths apart share a class and align in a column.
 *
 *   F♭♭ C♭♭ G♭♭ D♭♭ A♭♭ E♭♭ B♭♭ F♭  C♭  G♭  D♭  A♭    more flat
 *   E♭  B♭  F   C   G   D   A   E   B   F♯  C♯  G♯    naturals in the middle
 *   D♯  A♯  E♯  B♯  F♯♯ C♯♯ G♯♯ D♯♯ A♯♯ E♯♯ B♯♯       more sharp
 *   3   10  5   0   7   2   9   4   11  6   1   8    pitch class (ordered by fifths)
 *
 * Each column is one class holding two or three spellings (pc 8 has only A♭, G♯).
 * Reading by letter, each accidental step moves the class by one (E♭ 3, E 4, E♯ 5).
 * buildCandidates fills the columns, then sorts each plainest first (smallest
 * accidental, sharp before flat on a tie) so noteOn's argmax reaches the natural or
 * nearest accidental first.
 */
function buildCandidates(): PitchClass[][] {
    const byPc: PitchClass[][] = Array.from({ length: 12 }, () => []);
    for (let n = -15; n <= 19; n++) {
        byPc[((7 * n) % 12 + 12) % 12]!.push(spellingAt(n)); // wrap position n onto its pitch class
    }
    for (const pile of byPc) pile.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || b.alter - a.alter);
    return byPc;
}
/** Pitch class (0-11) to its spellings, plainest first; noteOn picks from this. */
const CANDIDATES: readonly (readonly PitchClass[])[] = buildCandidates();

// ── Interval scoring (principle 2) ─────────────────────────────────────────────

/** Line-of-fifths position of a spelling (C=0): the natural's fifth-position + 7*accidental.
 *  One accidental = 7 steps (E♭, E, E♯); one fifth = 1 step (C, G, D). */
function lofOf(p: PitchClass): number {
    return LETTER_CHROMA[p.step] + 7 * p.alter;
}

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
function consonance(a: PitchClass, b: PitchClass): number {
    const d = Math.abs(lofOf(a) - lofOf(b));
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** Sum of a candidate's consonance against the rest of the resolved scale. Higher = better fit. */
function intervalScore(candidate: PitchClass, resolved: ReadonlyMap<Letter, PitchClass>): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue; // candidate replaces this slot
        total += consonance(candidate, pc);
    }
    return total;
}

// ── The recency guard (principle 3) ────────────────────────────────────────────

/** Penalty G for a same-letter/different-accidental clash, over a window of K onsets. */
const GUARD_PENALTY = 2;
const GUARD_WINDOW = 3;

// ── The speller ──────────────────────────────────────────────────────────────

export class CoreSpeller {
    /** Principle 1, the 7-letter limit: one spelling per letter A-G, the drifting scale. Starts at C major. */
    private resolved = new Map<Letter, PitchClass>();
    /** Spelling committed for each sounding note, so note-off reads back that note's own
     *  spelling even if a later same-letter note has overwritten the slot. */
    private active = new Map<number, PitchClass>();
    /** Recency guard memory: letter -> the onset + accidental last committed there. */
    private lastByLetter = new Map<Letter, { onset: number; alter: Accidental }>();
    /** Onset counter (co-struck notes sharing a `t` are one onset); -1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;

    constructor() {
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
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
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of CANDIDATES[midi % 12]!) {
            let s = intervalScore(c, this.resolved);
            // Principle 3: dock a candidate whose letter was just committed at a different accidental.
            const last = this.lastByLetter.get(c.step);
            if (last && last.alter !== c.alter && this.onset - last.onset <= GUARD_WINDOW) s -= GUARD_PENALTY;
            if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best === null) return;
        this.resolved.set(best.step, best);
        this.active.set(midi, best);
        this.lastByLetter.set(best.step, { onset: this.onset, alter: best.alter });
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The spelling of a sounding note (its committed one), else the scale's current spelling of it. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const sounding = this.active.get(midi);
        if (sounding) return { step: sounding.step, alter: sounding.alter, octave };
        const target = ((midi % 12) + 12) % 12;
        for (const L of LETTERS) {
            const pc = this.resolved.get(L)!;
            if (((LETTER_BASE[pc.step] + pc.alter) % 12 + 12) % 12 === target) {
                return { step: pc.step, alter: pc.alter, octave };
            }
        }
        return null;
    }

    /** Read-only snapshot of the current 7-letter scale (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }
}
