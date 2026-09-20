/**
 * Speller — the shipped real-time product API.
 *
 * One class, two latency modes over the single {@link SpellingEngine}:
 *   - `new Speller()`                    → real-time (recency guard + spiral fold + diatonic-anchor leash)
 *   - `new Speller({ lookAhead: true })` → near-real-time (adds letter-aware look-ahead + vertical guard)
 *
 * For offline use with the whole piece in hand, see {@link spellTwoPass} (highest accuracy).
 *
 * The speller is frameless and detects no key: the side/orientation it settles on is an emergent
 * statistic of the notes it has committed, never a detected key signature.
 */

import type { Pitch, PitchClass } from './pitch.js';
import type { NoteContext } from './kernel.js';
import { SpellingEngine, RT_PRESET, LA_PRESET } from './engine.js';

export interface SpellerOptions {
    /**
     * Letter-aware look-ahead: the caller supplies each note's resolution direction
     * (`NoteContext.resolveDir`) from a small forward buffer, so a spelling can wait for
     * what comes next instead of committing blind. Default `false` (pure real-time).
     */
    lookAhead?: boolean;
}

export class Speller {
    private readonly engine: SpellingEngine;
    readonly lookAhead: boolean;

    constructor(opts: SpellerOptions = {}) {
        this.lookAhead = opts.lookAhead ?? false;
        this.engine = new SpellingEngine(this.lookAhead ? LA_PRESET : RT_PRESET);
    }

    noteOn(midi: number, ctx: NoteContext = {}): void {
        this.engine.noteOn(midi, ctx.t, ctx.resolveDir ?? 0);
    }

    noteOff(midi: number): void {
        this.engine.noteOff(midi);
    }

    getSpelling(midi: number): Pitch | null {
        return this.engine.getSpelling(midi);
    }

    /**
     * Re-seed. No-arg / empty clears frame state (cold start). A 7-letter scale is a
     * soft key-signature hint. `hard` is accepted for API compatibility; the engine has no
     * hard pin (the frame is always free to drift), so it is treated as a soft seed.
     */
    reset(scale?: readonly PitchClass[], hard = false): void {
        this.engine.reset(scale ?? [], hard);
    }

    /** Current 7-letter surface. */
    getResolvedScale(): PitchClass[] | null {
        return this.engine.getResolvedScale();
    }
}

export type { NoteContext };
