/**
 * Speller — the shipped product API (paper rungs 2 / 3).
 *
 * One class, latency modes:
 *   - `new Speller()`                 → real-time (diatonic anchor, spiral on)
 *   - `new Speller({ lookAhead: true })` → near-real-time (letter-aware look-ahead)
 *
 * Offline ceiling is {@link spellTwoPass} (rung 4), not this class.
 */

import type { Pitch, PitchClass } from './pitch.js';
import type { NoteContext } from './kernel.js';
import { SpellerKernel } from './kernel.js';
import { DiatonicBaseSubstrate, type DiatonicBaseSubstrateOptions } from './base.js';

export interface SpellerOptions {
    /** Virtual clock for the time-windowed frame. Default `Date.now`. */
    clock?: () => number;
    /** Letter-aware look-ahead (paper rung 3). Default `false` (rung 2). */
    lookAhead?: boolean;
}

const NEIGHBOUR_STEP: DiatonicBaseSubstrateOptions = {
    neighbourStep: true,
    neighbourRunGate: 2,
    neighbourStepWeight: 2,
    neighbourVerticalGate: true,
};
const SOUNDING_TIEBREAK: DiatonicBaseSubstrateOptions = {
    soundingTiebreak: true,
    stWindow: 'coonset',
    stEpsilon: 0,
};
const ANCHOR_DEFAULTS: DiatonicBaseSubstrateOptions = {
    preferRelMinorLT: true,
    baseWindowMs: 16000,
};

/**
 * The exact DiatonicBaseSubstrate option bundles the two shipped rungs run — rung 2 (real-time) and rung 3
 * (look-ahead). Exported for in-repo tooling ONLY (the `viz/` debugger builds the substrate from these
 * so it reads the identical algorithm — zero drift — and can enable the `trace` observer). NOT part of
 * the npm public surface: `index.ts` re-exports only {@link Speller} / {@link spellTwoPass}, so a path
 * import is the only way to reach these. The single source of truth for both the builders below and the
 * viz; keep them byte-equivalent to what {@link Speller} runs.
 */
export const DIATONIC_ANCHOR_OPTS: DiatonicBaseSubstrateOptions = {
    ...NEIGHBOUR_STEP, ...SOUNDING_TIEBREAK, spiral: true, ...ANCHOR_DEFAULTS,
    keepAlive: true, keepAliveEvict: 'oldest',
};
export const DIATONIC_ANCHOR_LA_OPTS: DiatonicBaseSubstrateOptions = {
    ...NEIGHBOUR_STEP, lookAheadVerticalGate: true, lookAheadCoherenceGate: true,
    spiral: true, parallelThirdGate: true, ...ANCHOR_DEFAULTS,
    keepAlive: true, lookAhead: true, lookAheadMode: 'letter', keepAliveEvict: 'oldest',
};

/** Internal preset builders (see {@link DIATONIC_ANCHOR_OPTS}). The keep-alive / look-ahead identity
 *  keys are re-pinned AFTER `opts` (as the original literal did), so a caller override — the injected
 *  `clock`, the viz `trace` — cannot change what makes this rung this rung. Byte-identical to before. */
export function createDiatonicAnchor(opts: DiatonicBaseSubstrateOptions = {}): SpellerKernel {
    return new SpellerKernel(new DiatonicBaseSubstrate({
        ...DIATONIC_ANCHOR_OPTS, ...opts, keepAlive: true, keepAliveEvict: 'oldest',
    }));
}

export function createDiatonicAnchorLA(opts: DiatonicBaseSubstrateOptions = {}): SpellerKernel {
    return new SpellerKernel(new DiatonicBaseSubstrate({
        ...DIATONIC_ANCHOR_LA_OPTS, ...opts, keepAlive: true, lookAhead: true, lookAheadMode: 'letter', keepAliveEvict: 'oldest',
    }));
}

export class Speller {
    private readonly kernel: SpellerKernel;
    readonly lookAhead: boolean;

    constructor(opts: SpellerOptions = {}) {
        this.lookAhead = opts.lookAhead ?? false;
        const base = opts.clock !== undefined ? { clock: opts.clock } : {};
        this.kernel = this.lookAhead
            ? createDiatonicAnchorLA(base)
            : createDiatonicAnchor(base);
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
