/**
 * CoreSpeller: the three-principle foundation.
 *
 * The 7-letter limit, interval (aug/dim) scoring, and a recency guard, nothing else:
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
 * Not part of the product API. It is the weakest speller (highest wrong%), dominated
 * at its own latency by Speller, so it is not re-exported from index.ts and the
 * package exports keep it off the npm surface. It lives in src/ (not an example) so
 * the bench can score it as Core; reach it only by an in-repo path import.
 *
 * The self-contained ~100-line version is examples/core-speller.ts (zero imports),
 * kept in lockstep with this class (identical spellings on every fixture) by
 * test/examples/standalone.test.ts.
 */

import { enharmonicCandidatesFor } from './candidates.js';
import { pitchClassValue, type Letter, type Pitch, type PitchClass } from './pitch.js';
import { intervalScore } from './scoring.js';
import type { NoteContext } from './kernel.js';

const ALL_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly Letter[];

export class CoreSpeller {
    private resolved = new Map<Letter, PitchClass>();
    /** midi → the spelling COMMITTED for that note while it's sounding. Stored per-note (not just
     *  the letter) so read-back returns the note's own spelling, even if a later same-letter note
     *  with a different pitch class overwrites the shared slot. */
    private active = new Map<number, PitchClass>();
    /** Recency guard (principle 3) memory: letter → the onset + accidental last committed there. */
    private lastByLetter = new Map<Letter, { onset: number; alter: number }>();
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
     */
    constructor(
        private readonly recencyGuard = 2,
        private readonly guardWindow = 3,
        private readonly doubleAccidentalPenalty = 0,
    ) {
        this.snapToCMajor();
    }

    private snapToCMajor(): void {
        this.resolved.clear();
        for (const L of ALL_LETTERS) {
            this.resolved.set(L, { step: L, alter: 0 });
        }
    }

    reset(scale: readonly PitchClass[]): void {
        this.resolved.clear();
        this.lastByLetter.clear();   // a new frame forgets the recency guard's memory
        // NOTE: `active` (currently-sounding notes) is deliberately NOT cleared. A note that has
        // already committed and is still sounding keeps its own spelling until its own note-off: a
        // key-signature change (respell/reset) under a held note does not respell it. Clearing it here
        // orphaned held pitches so getSpelling() fell through to the new frame at note-off (a low C held
        // across the seam into the C♯-major WTC prelude read back as B♯). See getSpelling()'s
        // sounding-branch, which returns each note's own committed spelling.
        for (const pc of scale) {
            this.resolved.set(pc.step, { step: pc.step, alter: pc.alter });
        }
        for (const L of ALL_LETTERS) {
            if (!this.resolved.has(L)) {
                this.resolved.set(L, { step: L, alter: 0 });
            }
        }
    }

    noteOn(midi: number, ctx?: NoteContext): void {
        // Advance the onset at each new `t` (co-struck notes share one; the guard window counts onsets).
        const t = ctx?.t;
        if (t === undefined || t !== this.lastT) {
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        const candidates = enharmonicCandidatesFor(midi);
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of candidates) {
            let s = intervalScore(c, this.resolved);
            if (this.doubleAccidentalPenalty && Math.abs(c.alter) >= 2) s -= this.doubleAccidentalPenalty;
            // Principle 3: dock a candidate whose letter was just committed at a different accidental.
            const last = this.lastByLetter.get(c.step);
            if (this.recencyGuard && last && last.alter !== c.alter && this.onset - last.onset <= this.guardWindow) {
                s -= this.recencyGuard;
            }
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        if (best === null) return;
        this.resolved.set(best.step, best);
        this.active.set(midi, best);
        this.lastByLetter.set(best.step, { onset: this.onset, alter: best.alter });
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** Read-only snapshot of the current 7-letter frame (introspection; e.g. the viz). */
    getResolvedScale(): PitchClass[] {
        return ALL_LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }

    getSpelling(midi: number): Pitch | null {
        const sounding = this.active.get(midi);
        const targetPc = ((midi % 12) + 12) % 12;
        if (sounding !== undefined) {
            const octave = Math.floor(midi / 12) - 1;
            return { step: sounding.step, alter: sounding.alter, octave };
        }
        for (const L of ALL_LETTERS) {
            const pc = this.resolved.get(L)!;
            if (pitchClassValue(pc) === targetPc) {
                const octave = Math.floor(midi / 12) - 1;
                return { step: pc.step, alter: pc.alter, octave };
            }
        }
        return null;
    }
}
