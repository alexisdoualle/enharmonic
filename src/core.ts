/**
 * CoreSpeller: the four-principle foundation.
 *
 * Interval (aug/dim) scoring, the 7-letter limit, a recency guard and a spiral fold, nothing else:
 * the minimal causal baseline the real-time Speller (look-ahead is an option) and the
 * two-pass function `spellTwoPass` build on. Frameless and persistent: one drifting scale whose slots are
 * overwritten, never reverted.
 *
 * The recency guard (principle 3) docks a candidate whose letter was last committed at a
 * different accidental within a few onsets, so a slot cannot flicker A♮→A♭→A♮ against its
 * recent self. Interval scoring reads a candidate against the OTHER letters only and so
 * misses that same-letter clash; the guard is the missing self-consistency term. Bounded
 * on purpose (a short window): it blocks flicker, not real modulation.
 *
 * The spiral fold (principle 4) keeps the scale on the conventional side of the spiral of
 * fifths. Interval scoring is relative: it cannot tell D♭ from C♯, so a run of sharp choices
 * can walk the whole scale a comma sharp (C𝄪 D♯ E♯ F𝄪 G♯ A♯ B♯) with nothing to pull it back.
 * The fold is the absolute brake: when the scale's average line-of-fifths position drifts more
 * than 8 fifths from D, every slot moves one comma back toward D (E♯ becomes F, B♯ becomes C).
 *
 * Not part of the product API. It is the weakest speller (highest wrong%), dominated
 * at its own latency by Speller, so it is not re-exported from index.ts and the
 * package exports keep it off the npm surface. It lives in src/ (not an example) so
 * the bench can score it as Core; reach it only by an in-repo path import.
 *
 * The self-contained ~100-line version is examples/core-speller.ts (zero imports),
 * kept in lockstep with this class (identical spellings on every fixture) by
 * test/examples/standalone.test.ts.
 */

import type { Pitch, PitchClass } from './pitch.js';
import { acc, C_MAJOR, candidates, letter, LETTER_ORDER, lofOf, pitchClass, spellingOf } from './lof.js';
import { intervalScore } from './scoring.js';
import type { NoteContext } from './kernel.js';

export class CoreSpeller {
    /** Principle 2, the 7-letter limit: one spelling (line-of-fifths position) per letter slot, the
     *  drifting scale. */
    private scale: number[] = [...C_MAJOR];
    /** midi → the spelling COMMITTED for that note while it's sounding. Stored per-note (not just
     *  the letter) so read-back returns the note's own spelling, even if a later same-letter note
     *  with a different pitch class overwrites the shared slot. */
    private active = new Map<number, number>();
    /** Recency guard (principle 3) memory: letter slot → the onset and spelling last committed there. */
    private lastByLetter: ({ onset: number; n: number } | undefined)[] = [];
    /** Onset counter (co-struck notes sharing a `t` are one onset); −1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;

    /**
     * @param recencyGuard  G, penalty for a same-letter/different-accidental clash within K onsets
     *  (default 2 = on; 0 ablates principle 3, leaving the two-principle interval baseline).
     * @param guardWindow  K, the guard window in onsets.
     * @param doubleAccidentalPenalty over-rotation cap (default 0 = off): subtract this from any
     *  |alter| ≥ 2 candidate before the argmax, so a ♯♯/♭♭ spelling is picked only when it out-scores
     *  every single-accidental rival by more than the cap.
     * @param foldRadius  R, the spiral fold radius in fifths around D (default 8; 0 ablates principle 4).
     */
    constructor(
        private readonly recencyGuard = 2,
        private readonly guardWindow = 3,
        private readonly doubleAccidentalPenalty = 0,
        private readonly foldRadius = 8,
    ) {}

    reset(scale: readonly PitchClass[]): void {
        this.scale = [...C_MAJOR];
        this.lastByLetter = [];   // a new frame forgets the recency guard's memory
        // NOTE: `active` (currently-sounding notes) is deliberately NOT cleared. A note that has
        // already committed and is still sounding keeps its own spelling until its own note-off: a
        // key-signature change (respell/reset) under a held note does not respell it. Clearing it here
        // orphaned held pitches so getSpelling() fell through to the new frame at note-off (a low C held
        // across the seam into the C♯-major WTC prelude read back as B♯). See getSpelling()'s
        // sounding-branch, which returns each note's own committed spelling.
        for (const pc of scale) {
            const n = lofOf(pc);
            this.scale[letter(n)] = n;
        }
    }

    noteOn(midi: number, ctx?: NoteContext): void {
        // Advance the onset at each new `t` (co-struck notes share one; the guard window counts onsets).
        const t = ctx?.t;
        if (t === undefined || t !== this.lastT) {
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        let best: number | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const n of candidates(midi)) {
            // Principle 1: score the candidate's intervals against the scale.
            let s = intervalScore(n, this.scale);
            if (this.doubleAccidentalPenalty && Math.abs(acc(n)) >= 2) s -= this.doubleAccidentalPenalty;
            // Principle 3: dock a candidate whose letter was just committed at a different accidental.
            const last = this.lastByLetter[letter(n)];
            if (this.recencyGuard && last && last.n !== n && this.onset - last.onset <= this.guardWindow) {
                s -= this.recencyGuard;
            }
            if (s > bestScore) {
                bestScore = s;
                best = n;
            }
        }
        if (best === null) return;
        // Principle 2: the winner overwrites its letter's slot.
        this.scale[letter(best)] = best;
        this.active.set(midi, best);
        // Principle 3: remember when this letter was set.
        this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
        // Principle 4: the scale's line-of-fifths sum, measured from D (2 per slot). Past the radius,
        // shift every slot one comma (12 fifths) back toward D: same pitches, other letters.
        const off = this.scale.reduce((a, b) => a + b, 0) - 7 * 2;
        if (this.foldRadius && Math.abs(off) > 7 * this.foldRadius) {
            const k = -12 * Math.sign(off);
            for (const n of [...this.scale]) this.scale[letter(n + k)] = n + k;
        }
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** Read-only snapshot of the current 7-letter frame, C to B (introspection; e.g. the viz). */
    getResolvedScale(): PitchClass[] {
        return LETTER_ORDER.map(s => spellingOf(this.scale[s]!));
    }

    /** The spelling of a sounding note (its committed one), else the scale's spelling of its pitch class,
     *  searching the letters C to B. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const n = this.active.get(midi)
            ?? LETTER_ORDER.map(s => this.scale[s]!).find(m => pitchClass(m) === ((midi % 12) + 12) % 12);
        return n === undefined ? null : { ...spellingOf(n), octave };
    }
}
