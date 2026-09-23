/**
 * SpellingEngine: the shipped speller. One engine; the latency modes are presets over it
 * ({@link RT_PRESET}, {@link LA_PRESET}, {@link TP_PASS_PRESET}). No key detection anywhere.
 *
 * Two principles do the base work:
 *   1. 7-LETTER LIMIT. A resolved scale holds one spelling per letter A–G. A note is spelled by
 *      choosing which letter to claim; that overwrites the letter's slot.
 *   2. INTERVAL SCORING. Among a pitch's candidates, pick the one most consonant with the rest of the
 *      scale. This alone drifts the scale into key.
 *
 * Named-option mechanisms sit on top; each is documented on its {@link EngineOptions} field:
 *   RECENCY GUARD: penalise a same-letter clash within K onsets (coherence, the `wrong` tier).
 *   SPIRAL FOLD: when the frame drifts too far to one side, fold it one comma back (side, the `flipped`
 *     tier). `'clamp'` folds past a deadzone edge; `'economy'` folds by accidental count.
 *   DIATONIC-ANCHOR LEASH: penalise a candidate far outside the recent collection's centre. Resists side
 *     drift continuously, where the fold only reacts after it.
 *   LOOK-AHEAD: given a note's resolution direction, spell the step toward it (an F♯-bound note spells E♯, not F).
 *   DOUBLE-ACC PENALTY, VERTICAL GUARD, COLLISION REPAIR: smaller correctness levers.
 *
 * Frameless: every centre is a statistic of committed notes, never a detected key. Shares only the
 * library's pitch primitives. Read-back returns a sounding note's own committed spelling, else the
 * scale's current spelling of its pitch class.
 */

import { LETTER_BASE, type Accidental, type Letter, type Pitch, type PitchClass } from './pitch.js';
import { enharmonicCandidatesFor } from './candidates.js';
import { lineOfFifths, rawIntervalBetween } from './interval.js';
import { intervalScore } from './scoring.js';

// ── Constant tables ──────────────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly Letter[];
/** Line-of-fifths position of each natural, F=−1 … B=+5. */
const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Line-of-fifths position of a spelling (C=0). One accidental = 7 steps, one fifth = 1 step. */
const lofOf = lineOfFifths;

/** The enharmonic comma on the line of fifths: shifting a spelling by ±12 renotates the SAME sounding
 *  note one turn around the spiral (C↔B♯, D♭↔C♯, …). Folding a comma is the fold's one and only move. */
const ENHARMONIC_COMMA = 12;

// ── Interval scoring (principle 2) ────────────────────────────────────────────────
// consonance + intervalScore live in src/scoring.ts (one source, shared with CoreSpeller).

/**
 * Is the pair {a, b} a MISSPELLED THIRD: a diminished fourth (should be a major third, C–F♭ ⇒ C–E) or
 * an augmented second (should be a minor third, C–D♯ ⇒ C–E♭), in either direction? This is the exact
 * vertical tell: a note off the sheet where an in-sheet third neighbour was available. It deliberately
 * does NOT flag an augmented sixth or a diminished seventh, legitimate chromatic sonorities the
 * resolution decides, not the vertical.
 */
function isMisspelledThird(a: PitchClass, b: PitchClass): boolean {
    for (const [f, t] of [[a, b], [b, a]] as const) {
        const { quality, number } = rawIntervalBetween(f, t);
        if (number === 4 && quality === -2) return true;   // diminished fourth  (a misspelled major third)
        if (number === 2 && quality === 2) return true;    // augmented second   (a misspelled minor third)
    }
    return false;
}

// ── Line-of-fifths helpers for the fold ────────────────────────────────────────

/** The [−2, +2] spelling of pitch class `pcv` whose LoF sits nearest centre `c` (letter free). */
function spellNearest(pcv: number, c: number): PitchClass {
    let best: PitchClass | null = null, bestD = Infinity;
    for (const step of LETTERS) {
        const raw = ((pcv - LETTER_BASE[step]) % 12 + 12) % 12;
        const alter = raw > 6 ? raw - 12 : raw;
        if (Math.abs(alter) > 2) continue;
        const d = Math.abs((LETTER_CHROMA[step] + 7 * alter) - c);
        if (d < bestD) { bestD = d; best = { step, alter: alter as Accidental }; }
    }
    return best!;
}

/** Spell a FIXED letter `L` with the accidental that lands it nearest LoF centre `c` (clamped to
 *  [−2, +2]): the letter-locked twin of {@link spellNearest}, used to re-anchor the 7 slots after a fold. */
function spellLetterAt(L: Letter, c: number): PitchClass {
    const alter = Math.max(-2, Math.min(2, Math.round((c - LETTER_CHROMA[L]) / 7)));
    return { step: L, alter: alter as Accidental };
}

/** The 7-letter diatonic collection whose line-of-fifths centre is `c`, e.g. `collectionAt(2)` is C
 *  major (a major key's centre = tonic + 2), `collectionAt(−3)` is D♭ major. A supplied-key seed. */
export function collectionAt(c: number): PitchClass[] { return LETTERS.map(L => spellLetterAt(L, c)); }

// ── Options + presets ──────────────────────────────────────────────────────────

/** Which spiral fold-back the engine runs (see the class doc): a range-CLAMP on how far the frame has
 *  drifted, an accidental-ECONOMY vote over recent raw pitch classes, or none. */
export type FoldMode = 'clamp' | 'economy' | 'off';

/**
 * The full mechanism switchboard. Every field is optional; the defaults reproduce the shipped
 * real-time tier ({@link RT_PRESET}). A note on units: G/K/W/D/windows count ONSETS (co-struck notes
 * share one onset); the fold centre/radius and the leash anchor/radius are line-of-fifths distances.
 */
export interface EngineOptions {
    /** RECENCY GUARD penalty G for a same-letter/different-accidental clash within the guard window (0 = off). */
    recencyGuard?: number;
    /** RECENCY GUARD window K, in onsets. */
    guardWindow?: number;
    /** Which spiral {@link FoldMode} to run (default `'clamp'`). */
    fold?: FoldMode;
    /** CLAMP fold centre on the 7-slot mean LoF (a major key sits at tonic + 2, so +3 = G-centred, the
     *  conventional sharp bias). Also the economy fold ignores this. */
    foldCenter?: number;
    /** CLAMP fold radius: fold only when the frame drifts more than this past the centre. */
    foldRadius?: number;
    /** ECONOMY fold window W, in onsets (how much recent raw material the economy sees). */
    foldWindow?: number;
    /** ECONOMY fold margin M: fold only when a comma-neighbour is cheaper by more than this. */
    foldMargin?: number;
    /** ECONOMY fold chromaticity gate: skip the fold when the window spans more than this many distinct
     *  pitch classes (0 = no gate). A near-chromatic window has no trustworthy key to prefer. */
    foldMaxChroma?: number;
    /** Fold DEBOUNCE D: a direction must be favoured this many consecutive onsets before it fires. */
    foldDebounce?: number;
    /** DIATONIC-ANCHOR LEASH weight: penalty per fifth a candidate sits beyond the anchor deadzone (0 = off). */
    sideWeight?: number;
    /** LEASH deadzone radius, in fifths, around the anchor. */
    sideRadius?: number;
    /** LEASH memory: how many recent commits feed the anchor's collection median. */
    anchorWindow?: number;
    /** LOOK-AHEAD: when a note's resolution direction is supplied, reward the diatonic-step letter toward
     *  its semitone resolution and penalise the target's own letter. */
    lookAhead?: boolean;
    /** LOOK-AHEAD reward/penalty magnitude. */
    lookAheadWeight?: number;
    /** LEADING-TONE BOOST: extra look-ahead magnitude applied ONLY to an UP-resolution into a NATURAL
     *  (diatonic) target: the genuine leading tone (A♯→B), where the frame slot the note resolves to is
     *  unaltered. Leaves up-into-chromatic (C→C♯) and all down-resolutions at the base weight, so it flips
     *  margin-1 leading tones without over-sharpening same-letter chromatic inflections (0 = off). */
    leadingToneBoost?: number;
    /** DRIFT LEASH: penalty for a double-accidental (|alter| ≥ 2) spelling (0 = off). */
    doubleAccPenalty?: number;
    /** VERTICAL GUARD weight: penalty per misspelled third (dim4/aug2) a candidate forms with a
     *  co-sounding note, but only inside a PERFECT (major/minor) triad, a P5 in the sonority (0 = off). */
    verticalWeight?: number;
    /** COLLISION REPAIR: after a commit, move a non-sounding letter that now spells the same pitch class
     *  as the committed note back to a distinct spelling, keeping 7 distinct pitch classes. */
    collisionRepair?: boolean;
    /** Drop STALE slots from the CLAMP fold's centre mean: a letter not committed within this many onsets
     *  holds an outdated spelling (a degree the music has not used for a while) that should not anchor the
     *  key centre. Averaging only the recently-sounded letters keeps the fold centre on the live key.
     *  0 = off (all 7 slots). */
    foldSlotRecency?: number;
    /** REPAIR the scale before the clamp centre mean: fit the best contiguous 7-fifth window to the slots
     *  and snap any outlier (>3 off the window centre, a chromatic alteration) to its diatonic member, so
     *  the centre reads the underlying key rather than the drifted surface. Off by default. */
    foldRepairScale?: boolean;
    /** Gate the CLAMP fold by accidental economy: once the frame has drifted past a deadzone edge, only
     *  actually fold if the target comma-side spells the recent raw pitch classes no dearer than the current
     *  side. Clamp picks WHEN, economy picks WHETHER. Off by default. */
    foldEconomyGate?: boolean;
    /** FRAME MODE (default 'mean'). 'mean' = the shipped drift-and-fold (the frame is the committed slots'
     *  mean, corrected past a deadzone edge). 'diatonic' = a principled explicit frame: every onset the
     *  collection is chosen by COVERAGE over the recent RAW pitch classes (anti-poison, mode-blind), placed
     *  on the spiral at the comma nearest the held frame (continuity + range fold), and held by hysteresis;
     *  the 7 slots ARE that collection, so a chromatic is a raised/lowered degree of a slot, never drift.
     *  Replaces the mean AND the committed anchor with one moving diatonic frame. No functional/mode logic.
     *  This flag picks between the two side-substrates described on the SpellingEngine class doc: 'diatonic'
     *  for the streaming tiers, 'mean' for the offline two-pass. */
    frameMode?: 'mean' | 'diatonic';
    /** 'diatonic' frame: recency half-life (onsets) of the raw-pc coverage window. Default 64. */
    frameHalfLife?: number;
    /** 'diatonic' frame: hysteresis: hold the current collection unless a rival's coverage beats it by more
     *  than this (in decayed pc weight). Default 1. */
    frameMargin?: number;
    /** 'diatonic' frame: KEEP-ALIVE. A committed chromatic (a spelling that differs from its collection slot,
     *  e.g. a raised leading tone A♯ over a collection whose A-slot is A♮) stays in its slot on the surface
     *  until the collection MOVES (which pulls it back) or a different accidental of that letter is committed.
     *  Without it every onset re-derives the pure collection, so a recurring chromatic re-flattens to the
     *  nearest rep (A♯→B♭), the frame's biggest coherence loss vs the mean's drift. Default true. */
    frameKeepAlive?: boolean;
    /** 'diatonic' frame: how the spiral places the collection's SIDE (comma). 'continuity' (default) = the
     *  comma nearest the held frame; 'drift' = nearest the recent committed notes' median LoF (the notated
     *  side). A/B lever; continuity is the clean default. */
    frameSide?: 'continuity' | 'drift';
    /** 'diatonic' frame: raw-pc coverage window in onsets (the memory length that defines the collection).
     *  Too short churns the collection on dense music; this is the frame's one real tuning, the equivalent
     *  of the mean fold's. Default 128. */
    frameWindow?: number;
    /** CHROMATIC SHARP-LEAN: for a note whose pitch class is OUTSIDE the frame collection (a true
     *  chromatic), reward the SHARPER of its two single-accidental enharmonic spellings (F♯ over G♭,
     *  E♯ over F, B over C♭) by this many points. The leading-tone / raised-degree asymmetry (a chromatic is
     *  far more often a raise than a lowering) means the ambiguous melodic/isolated chromatic (no
     *  co-sounding P5 for the vertical guard to break the F♯/G♭ tie) leans to the raise. A LoF-DIRECTION
     *  preference (higher LoF), NOT accidental economy: F♯/G♭ have equal accidental count and it still
     *  picks F♯. Gated to out-of-collection pcs, so a diatonic flat (D♭ in D♭ major) is never touched.
     *  Risk: worsens a chromatic already side-locked sharp (D♭→C♯). 0 = off. */
    chromaticSharpLean?: number;
}

/** REAL-TIME tier (`new Speller()`): recency guard, spiral-CLAMP fold, and diatonic-anchor leash. The fold
 *  centre averages only recently-sounded letters (foldSlotRecency), so a stale degree's spelling does not
 *  drag the side. */
export const RT_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 3,
    fold: 'clamp', foldCenter: 3, foldRadius: 7,
    sideWeight: 1, sideRadius: 6, anchorWindow: 32,
    // The diatonic frame: the 7 slots are the coverage collection (recency-weighted raw pcs), placed on the
    // spiral (continuity plus range fold) and held by hysteresis, with keep-alive for chromatics. Replaces
    // the mean drift-and-fold. verticalWeight breaks the F♯/G♭ side ties by chord consonance;
    // chromaticSharpLean handles the melodic/isolated leading tones the vertical guard cannot (no
    // co-sounding P5), leaning a chromatic to its raise. Not used in look-ahead, which resolves these by
    // direction, so the lean would fight it.
    frameMode: 'diatonic', verticalWeight: 1, chromaticSharpLean: 1,
};

/** LOOK-AHEAD tier (`new Speller({ lookAhead: true })`): a wider guard window + letter-aware look-ahead
 *  + the double-accidental leash + the vertical guard + collision repair, over the spiral-CLAMP fold. */
export const LA_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    fold: 'clamp', foldCenter: 3, foldRadius: 7, foldDebounce: 8,
    // lookAheadWeight stays 2; the extra pull comes from leadingToneBoost, GATED to up-resolutions into a
    // natural target (a genuine leading tone A♯→B), so it does not over-sharpen same-letter chromatic
    // inflections (C→C♯, C♯→C). A blunt weight bump cannot make that distinction and over-sharpens diatonic
    // passing tones; the gate keeps those clean while still recovering true leading tones. One residual:
    // E♭→E, a lowered borrowed degree rising to the natural 3rd, is inseparable from a leading tone without
    // harmonic context.
    lookAhead: true, lookAheadWeight: 2, leadingToneBoost: 1,
    doubleAccPenalty: 2, verticalWeight: 1, collisionRepair: true,
    frameMode: 'diatonic',
};

/** TWO-PASS per-direction pass ({@link spellTwoPass}): the look-ahead tier's mechanisms but over the
 *  accidental-ECONOMY fold (the two-pass's offline forward/backward reconciliation is the better SIDE
 *  fixer, and the laggier economy fold keeps the pass disagreement the reconciliation needs). */
export const TP_PASS_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    fold: 'economy', foldWindow: 24, foldMargin: 7, foldMaxChroma: 0, foldDebounce: 8,
    // lookAheadWeight stays 2 here (not stronger): a stronger per-pass look-ahead makes both passes commit a
    // side harder, shrinking the forward/backward disagreement the reconciliation needs, which nets worse.
    // Same reason the passes use the economy fold, not the clamp: the two-pass's own reconciliation is the
    // better side fixer.
    lookAhead: true, lookAheadWeight: 2,
    doubleAccPenalty: 2, verticalWeight: 1, collisionRepair: true,
    // Two-pass keeps the mean/economy fold: its forward+backward reconciliation is the side-fixer here, and
    // it is tuned to that fold. The diatonic frame commits a side too hard and breaks the reconciliation, so
    // the streaming tiers use the diatonic frame and the offline tier keeps its own mechanism.
};

// ── Decision trace (introspection only) ────────────────────────────────────────

/** One candidate's scoring breakdown for a note (introspection / visualiser only). The argmax is
 *  `base + guardDelta + laDelta + daDelta + vertDelta + sideDelta + leanDelta`. */
export interface DecisionCandidate {
    readonly c: PitchClass;
    readonly base: number;
    readonly guardDelta: number;
    readonly laDelta: number;
    readonly daDelta: number;
    readonly vertDelta: number;
    readonly sideDelta: number;
    readonly leanDelta: number;
}
/** The most recent note's full scoring trace (introspection / visualiser only). */
export interface Decision {
    readonly scale: PitchClass[];
    readonly candidates: DecisionCandidate[];
    readonly chosen: PitchClass;
}

// ── The engine ─────────────────────────────────────────────────────────────────

/**
 * TWO SIDE-SUBSTRATES COEXIST in this class, chosen by `frameMode`. The interval scoring, the six
 * per-candidate deltas, and read-back are shared; only the way the SIDE (the enharmonic orientation) is
 * held differs. Knowing which one is live explains why half the methods and options never run in a given
 * tier.
 *
 *   'diatonic' (the streaming tiers, RT_PRESET and LA_PRESET). The 7 slots ARE a detected collection:
 *   every onset recomputes the frame centre by coverage over recent RAW pitch classes
 *   (computeFrameCentre), re-spells the slots from it, and holds it with hysteresis plus keep-alive for
 *   chromatics. The comma (side) is the spiral folded INSIDE computeFrameCentre, at the writable band
 *   [foldCenter ± foldRadius]. noteOn RETURNS at the diatonic commit, so maybeFold, repairCollision,
 *   updateCollection and the leash anchor are never reached here.
 *
 *   'mean' (the offline per-pass tier, TP_PASS_PRESET / spellTwoPass). The 7 slots DRIFT: a commit
 *   overwrites its letter's slot, and the side is corrected AFTER the fact by maybeFold (fold the frame
 *   one comma back once its 7-slot MEAN line-of-fifths drifts past the deadzone, by range clamp or
 *   accidental economy), with updateCollection and diatonicAnchor feeding the continuous leash.
 *
 * Both exist because the two tiers want different substrates. The two-pass forward/backward
 * reconciliation is tuned to the drifting mean fold and needs the per-pass disagreement it produces; the
 * stable diatonic frame commits a side too hard and breaks that reconciliation. The streaming tiers went
 * the other way: the diatonic frame beats the mean across modulations. If the diatonic frame is ever made
 * to reconcile in two pass, the whole 'mean' path (maybeFold, updateCollection, diatonicAnchor,
 * repairCollision, spellNearest, and their options) can be deleted; see maybeFold's TODO.
 */
export class SpellingEngine {
    private readonly recencyGuard: number;
    private readonly guardWindow: number;
    private readonly fold: FoldMode;
    private foldCenter: number;   // mutable: a supplied key can re-centre the fold basin mid-stream (setKey)
    private readonly foldRadius: number;
    private readonly foldWindow: number;
    private readonly foldMargin: number;
    private readonly foldMaxChroma: number;
    private readonly foldDebounce: number;
    private readonly sideWeight: number;
    private readonly sideRadius: number;
    private readonly anchorWindow: number;
    private readonly lookAheadOn: boolean;
    private readonly lookAheadWeight: number;
    private readonly leadingToneBoost: number;
    private readonly doubleAccPenalty: number;
    private readonly verticalWeight: number;
    private readonly collisionRepair: boolean;
    private readonly foldSlotRecency: number;
    private readonly foldRepairScale: boolean;
    private readonly foldEconomyGate: boolean;
    private readonly frameMode: 'mean' | 'diatonic';
    private readonly frameHalfLife: number;
    private readonly frameMargin: number;
    private readonly frameKeepAlive: boolean;
    private readonly frameSide: 'continuity' | 'drift';
    private readonly frameWindow: number;
    private readonly chromaticSharpLean: number;
    /** 'diatonic' keep-alive: letters currently holding a committed chromatic alteration over the collection. */
    private kept = new Map<Letter, PitchClass>();

    /** One spelling per letter A–G: the drifting scale. Starts at C major. */
    private resolved = new Map<Letter, PitchClass>();
    /** midi → the spelling committed while that note is sounding, so read-back at note-off returns the
     *  note's OWN spelling even if a later same-letter note has since overwritten the slot. */
    private active = new Map<number, PitchClass>();
    /** letter → the onset and accidental last committed to that letter, the recency guard's memory. */
    private lastByLetter = new Map<Letter, { onset: number; alter: Accidental }>();
    /** Running onset counter (co-struck notes share one onset); −1 before the first note. */
    private onset = -1;
    /** The `t` of the current onset, so co-struck notes (same `t`) don't each bump `onset`. */
    private lastT = NaN;
    /** Sliding window of recent onsets' RAW pitch classes (one entry per onset), the economy fold's evidence. */
    private pcWindow: number[][] = [];
    /** The current onset's raw pcs, flushed into pcWindow when the onset advances. */
    private curOnsetPcs: number[] = [];
    /** Fold DEBOUNCE state: the direction (±12) currently favoured, and for how many consecutive onsets. */
    private pendingDir = 0;
    private pendingCount = 0;
    /** LEASH memory: the line-of-fifths of recently committed notes, for the diatonic anchor. */
    private committedLof: number[] = [];
    /** LEASH penalty centre: the running median-of-core line-of-fifths. */
    private anchor = 1;
    /** LEASH display: the diatonic COLLECTION's centre: the best-fit contiguous 7-fifth window over
     *  recent commits, moved only when a rival window strictly covers more (hysteresis). +2 = C major. */
    private collectionCentre = 2;
    /** The line-of-fifths centre the clamp fold last tested (recency + repair applied), a viz read-out. */
    private foldCentre = 2;
    /** 'diatonic' frame: the current collection's segment CENTRE on the line of fifths (tonic + 2). */
    private frameCentre = 2;
    /** Introspection only: the most recent note's per-candidate scoring. */
    private lastDecision: Decision | null = null;

    constructor(opts: EngineOptions = {}) {
        this.recencyGuard = opts.recencyGuard ?? 2;
        this.guardWindow = opts.guardWindow ?? 3;
        this.fold = opts.fold ?? 'clamp';
        this.foldCenter = opts.foldCenter ?? 3;
        this.foldRadius = opts.foldRadius ?? 7;
        this.foldWindow = opts.foldWindow ?? 24;
        this.foldMargin = opts.foldMargin ?? 7;
        this.foldMaxChroma = opts.foldMaxChroma ?? 0;
        this.foldDebounce = opts.foldDebounce ?? 8;
        this.sideWeight = opts.sideWeight ?? 0;
        this.sideRadius = opts.sideRadius ?? 6;
        this.anchorWindow = opts.anchorWindow ?? 32;
        this.lookAheadOn = opts.lookAhead ?? false;
        this.lookAheadWeight = opts.lookAheadWeight ?? 2;
        this.leadingToneBoost = opts.leadingToneBoost ?? 0;
        this.doubleAccPenalty = opts.doubleAccPenalty ?? 0;
        this.verticalWeight = opts.verticalWeight ?? 0;
        this.collisionRepair = opts.collisionRepair ?? false;
        this.foldSlotRecency = opts.foldSlotRecency ?? 0;
        this.foldRepairScale = opts.foldRepairScale ?? false;
        this.foldEconomyGate = opts.foldEconomyGate ?? false;
        this.frameMode = opts.frameMode ?? 'mean';
        this.frameHalfLife = opts.frameHalfLife ?? 64;
        this.frameMargin = opts.frameMargin ?? 1;
        this.frameKeepAlive = opts.frameKeepAlive ?? true;
        this.frameSide = opts.frameSide ?? 'continuity';
        this.frameWindow = opts.frameWindow ?? 128;
        this.chromaticSharpLean = opts.chromaticSharpLean ?? 0;
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
    }

    /**
     * Commit a spelling for `midi`: the candidate whose combined score (interval fit plus every enabled
     * mechanism's delta) is highest; then run the fold check. `t`, when given, groups co-struck notes
     * (same `t`) into one onset; omit it to treat every call as its own onset. `resolveDir` (+1/−1/0)
     * feeds the look-ahead when enabled.
     */
    noteOn(midi: number, t?: number, resolveDir = 0): void {
        // Advance the onset (and flush the previous onset's raw pcs into the fold window) at each new `t`.
        if (t === undefined || t !== this.lastT) {
            if (this.curOnsetPcs.length) {
                this.pcWindow.push(this.curOnsetPcs);
                // Keep enough onsets for whichever consumer needs the most: the economy fold (foldWindow) or
                // the diatonic frame's coverage (frameWindow). Recency weighting inside handles the rest.
                const cap = this.frameMode === 'diatonic' ? Math.max(this.foldWindow, this.frameWindow) : this.foldWindow;
                if (this.pcWindow.length > cap) this.pcWindow.shift();
                this.curOnsetPcs = [];
            }
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        this.curOnsetPcs.push(((midi % 12) + 12) % 12);

        // PRINCIPLED FRAME: the 7 slots ARE the coverage collection (raw-pc, spiral-placed, sticky), set
        // before scoring. A committed note never drifts the frame (see the commit tail); only the raw-pc
        // window moves it. This replaces the mean drift-and-fold AND the committed anchor.
        if (this.frameMode === 'diatonic') {
            const prevCentre = this.frameCentre;
            this.frameCentre = this.computeFrameCentre();
            this.foldCentre = this.frameCentre;         // viz read-outs track the live frame
            this.collectionCentre = this.frameCentre;
            this.anchor = this.frameCentre;
            // The collection moving PULLS BACK the held alterations (they belonged to the old collection).
            if (this.frameKeepAlive && this.frameCentre !== prevCentre) this.kept.clear();
            for (const L of LETTERS) this.resolved.set(L, spellLetterAt(L, this.frameCentre));
            // KEEP-ALIVE overlay: a committed chromatic rides its slot until the collection pulls it back.
            if (this.frameKeepAlive) {
                for (const [L, sp] of this.kept) {
                    if (this.resolved.get(L)!.alter !== sp.alter) this.resolved.set(L, sp);
                    else this.kept.delete(L);   // the collection now spells this letter the same way; drop it
                }
            }
        }

        // LEASH: refresh the diatonic anchor from recent commits, so a candidate far from the local
        // collection can be penalised. Off (weight 0) leaves the anchor un-consulted. Skipped in the
        // diatonic frame (the collection IS the frame; nothing to leash toward).
        if (this.sideWeight > 0 && this.frameMode !== 'diatonic') this.anchor = this.diatonicAnchor();

        // LOOK-AHEAD: if this note resolves a semitone to a target the scale already spells, reward the
        // diatonic-STEP letter toward it and penalise the target's own letter.
        const laOn = this.lookAheadOn && resolveDir !== 0;
        let laStep: Letter | null = null, laTarget: Letter | null = null, laWeight = this.lookAheadWeight;
        if (laOn) {
            const targetPc = (((midi + resolveDir) % 12) + 12) % 12;
            for (const L of LETTERS) {
                const p = this.resolved.get(L)!;
                if (((LETTER_BASE[p.step] + p.alter) % 12 + 12) % 12 === targetPc) { laTarget = L; break; }
            }
            if (laTarget) laStep = LETTERS[(LETTERS.indexOf(laTarget) - resolveDir + 7) % 7]!;
            // LEADING-TONE BOOST: only for an UP-resolution into a NATURAL (unaltered) target: a genuine
            // leading tone (A♯→B). Up-into-chromatic (C→C♯) and down-resolutions keep the base weight, so
            // the boost never over-sharpens a same-letter chromatic inflection of a degree.
            if (laTarget && resolveDir === 1 && this.resolved.get(laTarget)!.alter === 0) laWeight += this.leadingToneBoost;
        }

        const scale = LETTERS.map(L => ({ ...this.resolved.get(L)! }));   // the surface scored against
        // VERTICAL GUARD context: the notes still ringing. The guard only fires inside a PERFECT triad:
        // a dim4/aug2 is a valid interval elsewhere. The triad's tell is a P5 (LoF distance 1); a dim7 /
        // aug6 has no P5, so they don't qualify.
        const coSounding = this.verticalWeight > 0 ? [...this.active.values()] : [];
        const inPerfectTriad = coSounding.some((p, i) => coSounding.some((q, j) => j > i && Math.abs(lofOf(p) - lofOf(q)) === 1));
        // CHROMATIC SHARP-LEAN: if this note's pc is outside the frame collection, reward the sharper
        // (higher-LoF) of its single-accidental spellings, the raised leading tone / raised degree.
        let leanTarget: number | null = null;
        if (this.chromaticSharpLean > 0) {
            const centre = this.frameMode === 'diatonic' ? this.frameCentre : this.collectionCentre;
            const collectionPcs = new Set(LETTERS.map(L => { const s = spellLetterAt(L, centre); return ((LETTER_BASE[s.step] + s.alter) % 12 + 12) % 12; }));
            const pc = ((midi % 12) + 12) % 12;
            if (!collectionPcs.has(pc)) {
                let m = -Infinity;
                for (const c of enharmonicCandidatesFor(midi)) if (Math.abs(c.alter) <= 1) m = Math.max(m, lofOf(c));
                if (m !== -Infinity) leanTarget = m;
            }
        }
        const cands: DecisionCandidate[] = [];
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of enharmonicCandidatesFor(midi)) {
            const base = intervalScore(c, this.resolved);
            const last = this.lastByLetter.get(c.step);
            const guarded = this.recencyGuard && last && last.alter !== c.alter && this.onset - last.onset <= this.guardWindow;
            const guardDelta = guarded ? -this.recencyGuard : 0;
            const laDelta = laOn ? (c.step === laStep ? laWeight : c.step === laTarget ? -laWeight : 0) : 0;
            const daDelta = Math.abs(c.alter) >= 2 ? -this.doubleAccPenalty : 0;
            let misThirds = 0;
            if (this.verticalWeight > 0 && inPerfectTriad) for (const x of coSounding) if (isMisspelledThird(c, x)) misThirds++;
            const vertDelta = -this.verticalWeight * misThirds;
            // LEASH: one point per fifth the candidate sits BEYOND the anchor's deadzone. Zero inside, so
            // ordinary chromatic colour is free; it only bites a spelling that would strand the note far
            // from where the last bar of music has sat.
            const sideDelta = this.sideWeight > 0
                ? -this.sideWeight * Math.max(0, Math.abs(lofOf(c) - this.anchor) - this.sideRadius)
                : 0;
            const leanDelta = (leanTarget !== null && Math.abs(c.alter) <= 1 && lofOf(c) === leanTarget) ? this.chromaticSharpLean : 0;
            const s = base + guardDelta + laDelta + daDelta + vertDelta + sideDelta + leanDelta;
            cands.push({ c, base, guardDelta, laDelta, daDelta, vertDelta, sideDelta, leanDelta });
            if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best === null) return;
        this.lastDecision = { scale, candidates: cands, chosen: best };
        this.active.set(midi, best);
        this.lastByLetter.set(best.step, { onset: this.onset, alter: best.alter });
        if (this.frameMode === 'diatonic') {
            // The frame is the collection; a commit never drifts the SLOTS. But it does record the committed
            // line-of-fifths (the 'drift' side anchor reads its recent median) and keeps a chromatic alive.
            this.committedLof.push(lofOf(best));
            if (this.committedLof.length > this.anchorWindow) this.committedLof.shift();
            if (this.frameKeepAlive) {
                if (best.alter !== spellLetterAt(best.step, this.frameCentre).alter) this.kept.set(best.step, best);
                else this.kept.delete(best.step);
            }
            return;
        }

        this.resolved.set(best.step, best);
        if (this.sideWeight > 0) {
            this.committedLof.push(lofOf(best));
            if (this.committedLof.length > this.anchorWindow) this.committedLof.shift();
            this.updateCollection();
        }
        if (this.collisionRepair) this.repairCollision(best);

        if (this.fold !== 'off') this.maybeFold();
    }

    /**
     * Collision repair: after committing `just`, if another (non-sounding) letter now spells the SAME
     * pitch class, move it to its nearest sensible spelling so the scale keeps 7 distinct pitch classes.
     * A letter whose note is currently sounding is left alone: a genuine enharmonic doubling, not drift.
     */
    private repairCollision(just: PitchClass): void {
        const pc = ((LETTER_BASE[just.step] + just.alter) % 12 + 12) % 12;
        const sounding = new Set<Letter>(); for (const p of this.active.values()) sounding.add(p.step);
        for (const L of LETTERS) {
            if (L === just.step || sounding.has(L)) continue;
            const slot = this.resolved.get(L)!;
            if (((LETTER_BASE[L] + slot.alter) % 12 + 12) % 12 !== pc) continue;   // no collision on this letter
            for (const alt of [0, -1, 1, -2, 2] as Accidental[]) {                 // nearest natural first
                if (((LETTER_BASE[L] + alt) % 12 + 12) % 12 !== pc) { this.resolved.set(L, { step: L, alter: alt }); break; }
            }
        }
    }

    /**
     * The spiral fold-back. Measure the frame's side as the mean line-of-fifths of its 7 slots, decide a
     * fold direction (by the range clamp or the accidental economy), debounce it, and (once it fires)
     * re-anchor the 7 slots one comma toward the cheaper side. Sounding notes keep their committed spelling.
     */
    private maybeFold(): void {
        // TODO: the fold centre is the INSTANTANEOUS 7-slot MEAN, the wrong substrate for the flip on
        // modulating pieces: the mean is yanked by every chromatic note and mis-fires at modulation seams.
        // The intended replacement is an evidence-based frame (a detected key-signature or diatonic
        // collection that holds until new evidence overturns it, laggier but robust across modulation) as
        // the side substrate, replacing or gating this mean.
        // Centre entries [letter, lof] for the 7 slots.
        let entries = [...this.resolved.entries()].map(([L, pc]) => [L, lofOf(pc)] as [Letter, number]);
        // Drop STALE slots (letters not committed within N onsets): a degree the music has not used for a
        // while holds an outdated spelling that should not anchor the fold centre. Fall back to all 7.
        if (this.foldSlotRecency > 0) {
            const fresh = entries.filter(([L]) => { const last = this.lastByLetter.get(L); return last != null && this.onset - last.onset <= this.foldSlotRecency; });
            if (fresh.length) entries = fresh;
        }
        if (this.foldRepairScale) {
            const vals = entries.map(([, v]) => v); const med = this.median(vals);
            let bestK = med, bestCov = -1;
            for (let k = med - 6; k <= med + 6; k++) { const cov = vals.reduce((n, v) => n + (Math.abs(v - k) <= 3 ? 1 : 0), 0); if (cov > bestCov || (cov === bestCov && Math.abs(k - med) < Math.abs(bestK - med))) { bestCov = cov; bestK = k; } }
            entries = entries.map(([L, v]) => [L, Math.abs(v - bestK) <= 3 ? v : lofOf(spellLetterAt(L, bestK))] as [Letter, number]);
        }
        const cFrame = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
        this.foldCentre = cFrame;   // the actual quantity the clamp tests (recency + repair applied), for the viz

        let favoured = 0;
        if (this.fold === 'clamp') {
            // Fold only when the frame drifts PAST an edge of the deadzone: far-sharp to flat, far-flat to
            // sharp, never touching central keys.
            if (cFrame > this.foldCenter + this.foldRadius) favoured = -ENHARMONIC_COMMA;
            else if (cFrame < this.foldCenter - this.foldRadius) favoured = +ENHARMONIC_COMMA;
            // Economy gate (foldEconomyGate, off by default): the clamp decides WHEN to fold (frame far out),
            // this decides WHETHER, folding only if the target comma-side spells the recent raw pitch classes
            // at least as cheaply. It vetoes over-folding a moderate flat while still confirming a deep one.
            // It only VETOES, though; it cannot fix UNDER-firing, where a fold that should happen never
            // triggers because the centre never reaches the edge.
            if (favoured !== 0 && this.foldEconomyGate) {
                const heard = [...this.pcWindow.flat(), ...this.curOnsetPcs];
                if (heard.length) {
                    const costAt = (c: number) => heard.reduce((s, pc) => s + Math.abs(spellNearest(pc, c).alter), 0);
                    if (costAt(cFrame + favoured) > costAt(cFrame)) favoured = 0;   // target dearer ⇒ veto
                }
            }
        } else {
            // Accidental economy over every raw pc heard across the window (repeats kept, so a
            // key-defining note pulls harder for free). Fold toward a comma-neighbour that notates it
            // cheaper, unless a near-chromatic window (no clear key) vetoes the vote.
            const heard = [...this.pcWindow.flat(), ...this.curOnsetPcs];
            if (heard.length === 0) return;
            const vetoed = this.foldMaxChroma > 0 && new Set(heard).size > this.foldMaxChroma;
            const costAt = (c: number) => heard.reduce((s, pc) => s + Math.abs(spellNearest(pc, c).alter), 0);
            const here = costAt(cFrame);
            const up = costAt(cFrame + ENHARMONIC_COMMA), dn = costAt(cFrame - ENHARMONIC_COMMA);
            if (up < here - this.foldMargin && up <= dn) favoured = +ENHARMONIC_COMMA;
            else if (dn < here - this.foldMargin) favoured = -ENHARMONIC_COMMA;
            if (vetoed) favoured = 0;
        }

        // Debounce: a direction must stay favoured for D consecutive onsets before it fires; resetting the
        // count after a fold also blocks an immediate fold-back (the ping-pong), so no cooldown is needed.
        if (favoured !== 0 && favoured === this.pendingDir) this.pendingCount++;
        else { this.pendingDir = favoured; this.pendingCount = favoured === 0 ? 0 : 1; }
        if (favoured === 0 || this.pendingCount < this.foldDebounce) return;
        this.pendingDir = 0; this.pendingCount = 0;

        const newCentre = cFrame + favoured;
        for (const L of LETTERS) this.resolved.set(L, spellLetterAt(L, newCentre));
    }

    /**
     * The diatonic-collection anchor. Take the recent committed line-of-fifths, find its median, DROP the
     * alterations (anything more than 3 fifths off, the raised/lowered degrees), and re-take the median
     * of the remaining diatonic CORE. That "un-alter to reveal the diatonic" step stops a run of chromatic
     * raises (a leading tone, a tonicisation) from dragging the centre sharp. The result is the collection's
     * line-of-fifths centre: a frameless, emergent local key-centre (no key is ever detected).
     */
    /**
     * The principled frame centre ('diatonic' mode): the diatonic COLLECTION as one contiguous 7-fifth
     * segment centred at the returned line-of-fifths position (tonic + 2). Chosen by COVERAGE over the
     * recent RAW pitch classes, recency-weighted (half-life {@link frameHalfLife}), anti-poison (never the
     * speller's own spellings), so it fixes the collection without lag or drift. The comma (SIDE) is the
     * spiral: among the equal-best-coverage commas, take the one nearest the held frame (continuity), with a
     * hard barrier past the writable band [foldCenter ± foldRadius] (the fold). Hysteresis holds the current
     * collection unless a rival's coverage beats it by more than {@link frameMargin}. One number, no drift.
     */
    private computeFrameCentre(): number {
        // Recency-weighted raw-pc histogram over the frame window: the current onset weighs 1, each older
        // onset × decay^age (half-life {@link frameHalfLife}). Anti-poison: raw pcs, never our own spellings.
        const decay = Math.pow(0.5, 1 / this.frameHalfLife);
        const counts = new Array(12).fill(0);
        let w = 1;
        for (const pc of this.curOnsetPcs) counts[pc] += w;
        for (let j = this.pcWindow.length - 1; j >= 0; j--) { w *= decay; for (const pc of this.pcWindow[j]!) counts[pc] += w; }
        let total = 0; for (const c of counts) total += c;
        if (total === 0) return this.frameCentre;
        // Coverage of the 7-fifth collection centred at c (recency-weighted mass of its pitch classes).
        const coverage = (c: number): number => { let s = 0; for (let i = -3; i <= 3; i++) s += counts[(((7 * (c + i)) % 12) + 12) % 12]!; return s; };
        const prev = this.frameCentre;
        // SIDE anchor for the spiral: 'drift' follows the recent committed notes' median LoF (the side the
        // music has been notated on); 'continuity' (default) holds the previous comma.
        const anchor = (this.frameSide === 'drift' && this.committedLof.length) ? this.median(this.committedLof) : prev;
        // THE SPIRAL: pick the max-coverage collection, place its comma nearest the anchor (continuity),
        // clamped to the writable range [foldCenter ± foldRadius] (a hard barrier = the fold). A collection
        // hysteresis (frameMargin) holds the held comma unless a rival collection covers more than the margin.
        const sideCost = (c: number) => Math.abs(c - anchor) + 1000 * Math.max(0, Math.abs(c - this.foldCenter) - this.foldRadius);
        let bestC = prev, bestCov = -1, bestSide = Infinity;
        for (let c = prev - 12; c <= prev + 12; c++) {
            const cov = coverage(c), sc = sideCost(c);
            if (cov > bestCov || (cov === bestCov && sc < bestSide)) { bestCov = cov; bestC = c; bestSide = sc; }
        }
        if (coverage(prev) >= bestCov - this.frameMargin && sideCost(prev) <= bestSide) return prev;
        return bestC;
    }

    private diatonicAnchor(): number {
        const w = this.committedLof;
        if (w.length === 0) return this.anchor;
        const m0 = this.median(w);
        const core = w.filter(v => Math.abs(v - m0) <= 3);   // within a diatonic span of the centre
        return core.length ? this.median(core) : m0;
    }

    private median(v: number[]): number {
        const s = v.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)]!;
    }

    /** Re-fit the diatonic collection (display) to recent commits: a contiguous 7-fifth window [k−3, k+3]
     *  whose centre covers the most recent commits, moved only when a rival strictly covers more (hysteresis). */
    private updateCollection(): void {
        const w = this.committedLof;
        if (w.length === 0) return;
        const lo = Math.min(...w), hi = Math.max(...w);
        const cover = (k: number) => w.reduce((n, v) => n + (v >= k - 3 && v <= k + 3 ? 1 : 0), 0);
        let bestK = this.collectionCentre, bestCov = cover(this.collectionCentre);
        for (let k = lo + 3; k <= hi + 3; k++) {
            const cov = cover(k);
            if (cov > bestCov || (cov === bestCov && Math.abs(k - this.collectionCentre) < Math.abs(bestK - this.collectionCentre))) { bestK = k; bestCov = cov; }
        }
        if (bestCov > cover(this.collectionCentre)) this.collectionCentre = bestK;
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

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /**
     * Re-seed the frame. No-arg / empty-scale clears all state to a cold C-major start. A scale of
     * pitch classes seeds the matching letter slots (a soft key-signature hint); other letters keep
     * their natural. The engine has no hard pin (the frame is always free to drift), so `hard` is
     * accepted for API compatibility but treated the same as a soft seed.
     */
    reset(scale: readonly PitchClass[] = [], _hard = false): void {
        this.resolved = new Map<Letter, PitchClass>();
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
        for (const pc of scale) this.resolved.set(pc.step, { step: pc.step, alter: pc.alter });
        this.active.clear();
        this.lastByLetter.clear();
        this.onset = -1;
        this.lastT = NaN;
        this.pcWindow = [];
        this.curOnsetPcs = [];
        this.pendingDir = 0;
        this.pendingCount = 0;
        this.committedLof = [];
        this.anchor = 1;
        this.collectionCentre = 2;
        this.foldCentre = 2;
        this.frameCentre = 2;
        this.kept.clear();
        this.lastDecision = null;
    }

    /**
     * Re-centre the spiral CLAMP fold basin on a supplied key mid-stream, WITHOUT wiping the running
     * memory, for a notated key-signature change (a modulation, or a new piece in a concatenation). The
     * clamp deadzone moves to the key's diatonic mean (foldCenter = keyTonic + 2), so the next few onsets
     * fold the frame onto the new side instead of clinging to the old one. `keyTonic` is the signed
     * line-of-fifths of the MAJOR tonic (minor: its relative major; C=0, G=+1, F=−1, D♭=−5, …). Only the
     * CLAMP fold reads foldCenter, so this is inert under the economy fold / fold `'off'`. Call `reset`
     * instead when the boundary is a hard restart that should also clear the frame and side memory.
     */
    setKey(keyTonic: number): void { this.foldCenter = keyTonic + 2; }

    /** Read-only snapshot of the current 7-letter scale (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }

    /** The diatonic collection's line-of-fifths centre (leash display; a major collection is centred at
     *  tonic + 2, so the implied major tonic = this − 2). Meaningful only when the leash is enabled. */
    getAnchor(): number { return this.collectionCentre; }

    /** The line-of-fifths centre the clamp fold actually tests (the slot mean after recency + repair). The
     *  fold's tonic is this − 2. Reflects the shipped default unless recency drops slots or repair is on. */
    getFoldCentre(): number { return this.foldCentre; }

    /** The 7-letter diatonic COLLECTION: the un-altered substrate, each letter spelled within the current
     *  collection window. The stable "frame" against the altered surface (leash display). */
    getCollection(): PitchClass[] { return LETTERS.map(L => spellLetterAt(L, this.collectionCentre)); }

    /** The most recent note's scoring trace (introspection / visualiser), or null before the first note.
     *  Read-only; recording it never changes a spelling. */
    decision(): Decision | null { return this.lastDecision; }
}
