/**
 * Speller — the shipped product API (paper rungs 2 / 3).
 *
 * One class, latency modes:
 *   - `new Speller()`                 → real-time (diatonic + sticky, spiral on)
 *   - `new Speller({ lookAhead: true })` → near-real-time (letter-aware look-ahead)
 *
 * Offline ceiling is {@link spellTwoPass} (rung 4), not this class.
 */

import type { Pitch, PitchClass } from './pitch.js';
import type { NoteContext } from './kernel.js';
import { SpellerKernel } from './kernel.js';
import { BoxWindowSubstrate, type BoxWindowSubstrateOptions } from './box.js';

export interface SpellerOptions {
    /** Virtual clock for the time-windowed frame. Default `Date.now`. */
    clock?: () => number;
    /** Letter-aware look-ahead (paper rung 3). Default `false` (rung 2). */
    lookAhead?: boolean;
}

const NEIGHBOUR_STEP: BoxWindowSubstrateOptions = {
    neighbourStep: true,
    neighbourRunGate: 2,
    neighbourStepWeight: 2,
    neighbourVerticalGate: true,
};
const SOUNDING_TIEBREAK: BoxWindowSubstrateOptions = {
    soundingTiebreak: true,
    stWindow: 'coonset',
    stEpsilon: 0,
};
const BOX_DEFAULTS: BoxWindowSubstrateOptions = {
    preferRelMinorLT: true,
    frameWindowMs: 16000,
};

function createDiatonicSticky(opts: BoxWindowSubstrateOptions = {}): SpellerKernel {
    return new SpellerKernel(new BoxWindowSubstrate({
        ...NEIGHBOUR_STEP, ...SOUNDING_TIEBREAK, spiral: true, ...BOX_DEFAULTS, ...opts,
        keepAlive: true, stickyEvict: 'oldest',
    }));
}

function createDiatonicStickyLA(opts: BoxWindowSubstrateOptions = {}): SpellerKernel {
    return new SpellerKernel(new BoxWindowSubstrate({
        ...NEIGHBOUR_STEP, lookAheadVerticalGate: true, lookAheadCoherenceGate: true,
        spiral: true, parallelThirdGate: true, ...BOX_DEFAULTS, ...opts,
        keepAlive: true, lookAhead: true, lookAheadMode: 'letter', stickyEvict: 'oldest',
    }));
}

export class Speller {
    private readonly kernel: SpellerKernel;
    readonly lookAhead: boolean;

    constructor(opts: SpellerOptions = {}) {
        this.lookAhead = opts.lookAhead ?? false;
        const box = opts.clock !== undefined ? { clock: opts.clock } : {};
        this.kernel = this.lookAhead
            ? createDiatonicStickyLA(box)
            : createDiatonicSticky(box);
    }

    noteOn(midi: number, ctx: NoteContext = {}): void {
        this.kernel.noteOn(midi, ctx);
    }

    noteOff(midi: number): void {
        this.kernel.noteOff(midi);
    }

    getSpelling(midi: number): Pitch | null {
        return this.kernel.getSpelling(midi);
    }

    /**
     * Re-seed. No-arg / empty clears frame state (cold start). A 7-letter scale is a
     * soft key-signature hint; `hard: true` pins for manual override.
     */
    reset(scale?: readonly PitchClass[], hard = false): void {
        this.kernel.reset(scale ?? [], hard);
    }

    /** Current 7-letter surface (frame + keep-alive + sounding), if available. */
    getResolvedScale(): PitchClass[] | null {
        const snap = this.kernel.snapshot();
        return snap?.resolvedScale ? [...snap.resolvedScale] : null;
    }
}

export type { NoteContext };
