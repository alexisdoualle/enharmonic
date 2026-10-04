/**
 * CoreSpeller: four principles, nothing else. Interval scoring, the 7-letter limit, a
 * recency guard and a spiral fold. One scale, its slots overwritten and never reverted.
 *
 * Recency guard (principle 3): interval scoring skips the candidate's own letter, so it
 * misses A♭ right after A♮. The guard docks a letter respelled within a few onsets. It
 * stops flicker, not modulation.
 *
 * Spiral fold (principle 4): interval scoring can't tell D♭ from C♯, so the scale can walk
 * a comma sharp (C𝄪 D♯ E♯ F𝄪 G♯ A♯ B♯). When its average drifts more than 8 fifths from
 * D, every slot moves one comma back (E♯ becomes F, B♯ becomes C).
 *
 * Not exported from index.ts or the package: Speller beats it at the same latency. It
 * lives in src/ so the bench can score it as Core. examples/core-speller.ts is the
 * standalone copy; test/examples/standalone.test.ts keeps the two identical.
 */

import type { Pitch, PitchClass } from './pitch.js';
import { acc, C_MAJOR, candidates, letter, LETTER_ORDER, lofOf, pitchClass, spellingOf } from './lof.js';
import { intervalScore } from './scoring.js';
import type { NoteContext } from './kernel.js';

export class CoreSpeller {
    /** Principle 2: one spelling (line-of-fifths position) per letter slot. */
    private scale: number[] = [...C_MAJOR];
    /** midi → the spelling committed for that sounding note. Per note, so read-back survives a
     *  later note overwriting the same letter slot. */
    private active = new Map<number, number>();
    /** Principle 3 memory: letter slot → the onset and spelling last committed there. */
    private lastByLetter: ({ onset: number; n: number } | undefined)[] = [];
    /** Onset counter (co-struck notes sharing a `t` are one onset); −1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;

    /**
     * @param recencyGuard  G, penalty for respelling a letter within K onsets (0 turns principle 3 off).
     * @param guardWindow  K, the guard window in onsets.
     * @param doubleAccidentalPenalty  subtracted from any ♯♯/♭♭ candidate (default 0 = off).
     * @param foldRadius  R, the spiral fold radius in fifths around D (0 turns principle 4 off).
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
        // `active` is kept: a held note keeps its spelling across a reset. Clearing it made a low C
        // held into the C♯-major WTC prelude read back as B♯.
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
        // move every slot one comma (12 fifths) back toward D: same pitches, other letters.
        const off = this.scale.reduce((a, b) => a + b, 0) - 7 * 2;
        if (this.foldRadius && Math.abs(off) > 7 * this.foldRadius) {
            const k = -12 * Math.sign(off);
            for (const n of [...this.scale]) this.scale[letter(n + k)] = n + k;
        }
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The current scale, C to B (for the viz). */
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
