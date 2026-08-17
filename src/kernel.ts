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
 *     (Core/heptatonic) vs reverting *box-window* (diatonic) — behind one
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
    /** Look-ahead resolution direction (+1 up, -1 down, 0 none). Box/sticky use it; persistent ignores. */
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
 * Substrate-specific internals, surfaced ONLY for instrumentation (the debugger viz). A read-only
 * side channel — the substrate records what its last `commit`/`frameScale` already computed, so
 * exposing it never changes a scored number or a spelling. All fields optional: a substrate that
 * has no notion of a given quantity (Core has no sticky layer) simply omits it.
 */
export interface SubstrateTrace {
    /** Per-candidate bonus the commit added to the base score, in `scored` order (base + this = total).
     *  The box look-ahead resolution bias, or the heptatonic orphan penalty — whichever the substrate
     *  folds into the pillar score before the argmax. */
    readonly lookAheadBonus?: readonly number[] | undefined;
    /** Per-candidate tie-break value, in `scored` order (heptatonic recency/vertical tie-break). */
    readonly tieBreak?: readonly (number | undefined)[] | undefined;
    /** The recency tie-break buffer at decision time (most-recent-first), for display. */
    readonly recentBuffer?: readonly PitchClass[] | undefined;
    /** The inferred frame slots, LETTERS order. */
    readonly inferredFrame?: readonly PitchClass[] | undefined;
    /** Relative-major pc of the held collection. */
    readonly frameRelMajorPc?: number | undefined;
    /** SPIRAL mode: the SIGNED line-of-fifths tonic that renders the frame (D♭=−5 vs C♯=+7 are
     *  distinct positions the mod-12 `frameRelMajorPc` cannot tell apart). Undefined when spiral off. */
    readonly frameLofTonic?: number | undefined;
    /** LOCAL-KEY layer estimate (mode-aware, short window), decoupled from the spelling frame — for the
     *  viz key band. `[tonicPc, minor]`; undefined unless the local-key tracker is running. */
    readonly localKey?: readonly [number, boolean] | undefined;
    /** K-S correlation of the local-key estimate (confidence). */
    readonly localKeyR?: number | undefined;
    /** The windowed raw pitch classes feeding the frame inference. */
    readonly recentPcs?: readonly number[] | undefined;
    /** Windowed pcs outside the best-fitting collection (the argmin). */
    readonly outsideCount?: number | undefined;
    /** Sticky (keep-alive) overlay spellings, LETTERS order among held letters. */
    readonly stickySlots?: readonly PitchClass[] | undefined;
    /** Windowed pcs outside the HELD collection (frame-stability read-out). */
    readonly heldOutside?: number | undefined;
    /** Windowed pcs outside the nearest rival collection. */
    readonly rivalOutside?: number | undefined;
    /** Relative-major pc of that nearest rival. */
    readonly rivalPc?: number | undefined;
    /** Current surface (frame + overlays), LETTERS order — for the between-notes snapshot. */
    readonly resolvedScale?: readonly PitchClass[] | undefined;
    /** Midis currently sounding — for the between-notes snapshot. */
    readonly activeMidis?: readonly number[] | undefined;
    /** Sounding notes with their held spelling — for the between-notes snapshot. */
    readonly sounding?: readonly { readonly midi: number; readonly spelling: PitchClass }[] | undefined;
}

/** One per-`noteOn` trace record, delivered to an attached {@link TraceSink}. Read-only. */
export interface NoteTrace {
    readonly midi: number;
    readonly ctx: NoteContext;
    /** The 7 slots this note's candidates were scored against (pre-commit). */
    readonly frame: Map<Letter, PitchClass>;
    /** Candidates with their BASE frame scores, `enharmonicCandidatesFor` order. */
    readonly scored: readonly ScoredCandidate[];
    /** The spelling committed for this note (read back after commit), else null. */
    readonly chosen: PitchClass | null;
    /** Substrate internals from this commit (box frame/sticky, look-ahead bonus), if it reports any. */
    readonly detail?: SubstrateTrace | undefined;
}

/** A read-only observer of each `noteOn` decision. Attach via {@link SpellerKernel.setTraceSink}. */
export type TraceSink = (trace: NoteTrace) => void;

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
    /** Optional instrumentation: internals from the most recent {@link commit}, for a trace sink.
     *  A substrate with no extra state (Core/persistent) omits this — the kernel-level trace suffices. */
    lastTrace?(): SubstrateTrace;
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
    private sink: TraceSink | null = null;

    constructor(
        private readonly substrate: Substrate,
        private readonly scoring: ScoringPolicy = intervalScoring,
    ) {}

    /** Attach (or clear, with null) a read-only per-noteOn observer. Off by default; the shipped
     *  path stays byte-identical when no sink is set. Used to instrument the debugger viz so it
     *  READS this kernel instead of reimplementing it. */
    setTraceSink(fn: TraceSink | null): void {
        this.sink = fn;
    }

    noteOn(midi: number, ctx: NoteContext = {}): void {
        const frame = this.substrate.frameFor(midi, ctx);
        const candidates = enharmonicCandidatesFor(midi);
        const scored = candidates.map(c => ({ c, score: this.scoring.score(c, frame) }));
        // Snapshot the pre-commit frame for the trace: `frame` may be the substrate's live surface
        // Map, which `commit` mutates in place — so the sink (fired after commit) would otherwise see
        // the post-commit state and the candidate breakdowns would no longer match their base scores.
        // Only copied when a sink is attached; the shipped path is untouched.
        const frameSnapshot = this.sink ? new Map(frame) : null;
        this.substrate.commit(midi, scored, ctx);
        if (this.sink) {
            this.sink({
                midi,
                ctx,
                frame: frameSnapshot!,
                scored,
                chosen: this.substrate.readBack(midi),
                detail: this.substrate.lastTrace?.(),
            });
        }
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
