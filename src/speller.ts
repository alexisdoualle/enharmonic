/**
 * Speller — the shipped real-time product API.
 *
 * One class, two latency modes:
 *   - `new Speller()`                    → real-time (diatonic anchor, spiral on)
 *   - `new Speller({ lookAhead: true })` → near-real-time (letter-aware look-ahead)
 *
 * For offline use with the whole piece in hand, see {@link spellTwoPass} (highest accuracy).
 */

import type { Pitch, PitchClass } from './pitch.js';
import type { NoteContext } from './kernel.js';
import { SpellerKernel } from './kernel.js';
import { DiatonicBaseSubstrate, type DiatonicBaseSubstrateOptions } from './base.js';

export interface SpellerOptions {
    /** Virtual clock for the time-windowed frame. Default `Date.now`. */
    clock?: () => number;
    /**
     * Letter-aware look-ahead: the caller supplies each note's resolution direction
     * (`NoteContext.resolveDir`) from a small forward buffer, so a spelling can wait for
     * what comes next instead of committing blind. Default `false` (pure real-time).
     */
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
    // TODO: Re-run the full corpus scoring before finalizing this as the permanent default. The previous
    // time-window experiment (400 ms) drifted chopin_prelude_op28_no15/rt by 2 wrong → flipped and
    // bach_jesu_meine_freude/rt by 7 correct → wrong; this restores the original onset-count mechanism.
    stWindow: 'onsets',
    stBufferN: 5,
    stEpsilon: 0,
};
const ANCHOR_DEFAULTS: DiatonicBaseSubstrateOptions = {
    preferRelMinorLT: true,
    baseWindowMs: 16000,
};

/**
 * The exact DiatonicBaseSubstrate option bundles the two shipped modes run — real-time and near-real-time
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

/*
 * FUTURE — near-real-time revision API (not implemented).
 *
 * The gap this fills is REVISABILITY, not side-awareness. `Speller` commits forward-only
 * and never revises a spelling it has emitted; a note's spelling is also discarded on
 * `noteOff` (no per-onset history; `getSpelling` is keyed by midi, not onset). But some
 * spellings only become decidable AFTER the note that needs them is already out the door —
 * classically at a boundary, where notes committed just before the context shifted are left
 * stranded on the old spelling while their neighbours move on, so the passage reads as an
 * incoherent MIX (a `wrong`, not a clean flip). That is a pure COHERENCE repair on the
 * already-emitted notes ("these no longer cohere with their neighbours, re-spell them") — it
 * needs no side/orientation oracle. Forward-only look-ahead structurally cannot reach those
 * notes; the two-pass BACKWARD pass can, which is the whole of what it adds here.
 *
 * A consumer that wants "spell live, then correct on hindsight" — a piano-roll or chord
 * identifier flipping an already-shown G♯ to A♭ once the line clarifies — must today run
 * {@link spellTwoPass} over a sliding window of recent notes and diff the result itself.
 *
 * The intended near-real-time capability is for `Speller` to own this: retain a BOUNDED
 * history of recent onsets and emit a revision signal — e.g. "the note 4 onsets ago, read
 * as G♯, is now A♭" — so consumers can repair in place rather than re-running two-pass.
 * That needs three things this API lacks: (1) onset identity (`noteOn` returns a token, or
 * accepts a caller id), (2) retained per-onset history, (3) a change event / callback.
 * Voice/onset attribution is the known hard part (see the respell notes).
 */
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
