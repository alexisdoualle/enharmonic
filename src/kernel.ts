/**
 * SpellerKernel — the composable spelling engine.
 *
 * This is the toolbox core: a fixed note loop (enumerate candidates → score
 * against a frame → commit) parameterised by two pluggable parts:
 *
 *   - a {@link Substrate}, which owns all frame state. It answers "what scale
 *     do I score this note against?" (`frameFor`), records the chosen spelling
 *     (`commit`), and serves read-back (`readBack` / `frameLookup`). Different
 *     substrates implement different memory models — slot-mutating *persistent*
 *     (Core/heptatonic) vs reverting *diatonic base* — behind one
 *     interface, so the kernel never knows which it is driving.
 *   - a {@link ScoringPolicy}, which ranks each candidate against the frame
 *     (the interval-relatedness pillar, by default).
 *
 * Every known speller becomes `new SpellerKernel(substrate, scoring)` plus a
 * set of post-commit repair passes (added in later phases). P1 proves the
 * persistent substrate + interval scoring is byte-identical to `CoreSpeller`.
 */

import { enharmonicCandidatesFor } from './candidates.js';
import type { Letter, Pitch, PitchClass } from './pitch.js';
import { intervalScore } from './scoring.js';

/** Per-note context passed to the substrate. Streaming-only spellers ignore the
 *  optional fields; time-windowed / look-ahead substrates read them. */
export interface NoteContext {
    /** Look-ahead resolution direction (+1 up, -1 down, 0 none). Base/keep-alive use it; persistent ignores. */
    readonly resolveDir?: number;
    /** Event timestamp in ms. Box-window substrates need it; persistent ignores. */
    readonly t?: number;
    /** The co-onset chord (all midis sounding at this note's onset, same t). The cheap same-onset
     *  look-ahead for a vertical tie-break; substrates that don't use it ignore it. */
    readonly chord?: readonly number[];
    /** Resolution-confirmed flip-back side (+1 sharp / −1 flat / 0 none), precomputed by a look-ahead
     *  driver: a struck dominant-7th whose target tonic triad actually arrives. When supplied it
     *  REPLACES the substrate's immediate (streaming) dominant detector, gating the orientation flip
     *  on real resolution so dom7-SHAPED chords that never resolve don't misfire. Batch/notation only. */
    readonly flipSide?: number;
}

/** A candidate spelling paired with its frame score, in `enharmonicCandidatesFor` order. */
export interface ScoredCandidate {
    readonly c: PitchClass;
    readonly score: number;
}

/**
 * Read-only substrate snapshot for the between-notes {@link Substrate.snapshot}. A side channel:
 * the substrate reports what it already holds, so reading it never changes a spelling. Both fields
 * optional (a substrate with no notion of one omits it).
 */
export interface SubstrateTrace {
    /** Current surface (frame + overlays), LETTERS order — backs `Speller.getResolvedScale`. */
    readonly resolvedScale?: readonly PitchClass[] | undefined;
    /** The BARE frame (diatonic collection, before the keep-alive and sounding overlays that
     *  produce {@link resolvedScale}), LETTERS order. Read-only instrumentation: where it differs from
     *  the surface is exactly the overlays' contribution. Omitted when the substrate has no frame yet. */
    readonly frame?: readonly PitchClass[] | undefined;
    /** SPIRAL mode: the SIGNED line-of-fifths tonic that renders the frame (D♭=−5 vs C♯=+7 are distinct
     *  positions a mod-12 relative-major pc cannot tell apart) — backs the two-pass section-flip.
     *  Undefined when spiral off. */
    readonly frameLofTonic?: number | undefined;
    /** Canonical signed line-of-fifths spelling of the frame's relative-major key. Unlike
     * {@link frameLofTonic}, this is also available when spiral continuity is off. */
    readonly frameKeyLof?: number | undefined;
}

/** A frame state model. Owns the resolved-scale memory; the kernel only orchestrates. */
export interface Substrate {
    /** The 7-letter scale to score this note's candidates against. */
    frameFor(midi: number, ctx: NoteContext): Map<Letter, PitchClass>;
    /**
     * Select and store the spelling for this note from the scored candidates,
     * then run any internal repair passes. Selection lives here (not in the
     * kernel) because it depends on what the substrate already holds — Core
     * takes the top score and overwrites; the slot model avoids letter
     * conflicts and may stash a shadow spelling.
     */
    commit(midi: number, scored: readonly ScoredCandidate[], ctx: NoteContext): void;
    /** The note's OWN committed spelling while it is sounding, else null. */
    readBack(midi: number): PitchClass | null;
    /** Frame-based fallback: the spelling the current frame assigns to midi's pitch class, else null. */
    frameLookup(midi: number): PitchClass | null;
    /** Re-seed the frame to an explicit scale (respell). `hard` pins the collection (a manual override
     *  ignores the window) vs a soft key-signature hint (default) that yields to the window. */
    reset(scale: readonly PitchClass[], hard?: boolean): void;
    /** Release a sounding note. */
    noteOff(midi: number): void;
    /** Optional instrumentation: current surface + frame internals, read-only, sampled between notes. */
    snapshot?(): SubstrateTrace;
}

/** Ranks a candidate spelling against the current frame. Higher wins. */
export interface ScoringPolicy {
    score(candidate: PitchClass, frame: Map<Letter, PitchClass>): number;
}

/** The interval-relatedness pillar (Milne-derived consonance scoring). */
export const intervalScoring: ScoringPolicy = {
    score: (candidate, frame) => intervalScore(candidate, frame),
};

export class SpellerKernel {
    constructor(
        private readonly substrate: Substrate,
        private readonly scoring: ScoringPolicy = intervalScoring,
    ) {}

    noteOn(midi: number, ctx: NoteContext = {}): void {
        const frame = this.substrate.frameFor(midi, ctx);
        const candidates = enharmonicCandidatesFor(midi);
        const scored = candidates.map(c => ({ c, score: this.scoring.score(c, frame) }));
        this.substrate.commit(midi, scored, ctx);
    }

    /** Read-only substrate snapshot for instrumentation (current surface + frame internals), or
     *  undefined if the substrate reports none. Does not mutate state. */
    snapshot(): SubstrateTrace | undefined {
        return this.substrate.snapshot?.();
    }

    noteOff(midi: number): void {
        this.substrate.noteOff(midi);
    }

    reset(scale: readonly PitchClass[], hard = false): void {
        this.substrate.reset(scale, hard);
    }

    getSpelling(midi: number): Pitch | null {
        const pc = this.substrate.readBack(midi) ?? this.substrate.frameLookup(midi);
        if (pc === null) return null;
        const octave = Math.floor(midi / 12) - 1;
        return { step: pc.step, alter: pc.alter, octave };
    }
}
