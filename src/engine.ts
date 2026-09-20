/**
 * SpellingEngine: the shipped speller. One engine; the latency modes are presets over it
 * ({@link RT_PRESET}, {@link LA_PRESET}, {@link TP_PASS_PRESET}). No key detection anywhere.
 *
 * Two pillars do the base work:
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

// ── Constant tables ──────────────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly Letter[];
/** Line-of-fifths position of each natural, F=−1 … B=+5. */
const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

/** Line-of-fifths position of a spelling (C=0). One accidental = 7 steps, one fifth = 1 step. */
const lofOf = lineOfFifths;

/** The enharmonic comma on the line of fifths: shifting a spelling by ±12 renotates the SAME sounding
 *  note one turn around the spiral (C↔B♯, D♭↔C♯, …). Folding a comma is the fold's one and only move. */
const ENHARMONIC_COMMA = 12;

// ── Interval scoring (pillar 2) ────────────────────────────────────────────────

/**
 * Consonance of the interval between two spellings, read straight off their line-of-fifths distance:
 *   d = 1        P5 / P4                 → +1     d = 3, 4   3rds / 6ths            → +1
 *   d = 0, 2, 5  unison / 2nds / 7ths    →  0     d = 6..12  augmented / diminished → −1
 *   d ≥ 13       doubly aug / dim        → −2
 * The interval NUMBER is never computed — the line of fifths already encodes quality and number.
 */
function consonance(a: PitchClass, b: PitchClass): number {
    const d = Math.abs(lofOf(a) - lofOf(b));
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** Sum of a candidate's consonance against the rest of the resolved scale (its own slot excluded, since
 *  the candidate replaces it). Higher = better fit. */
function intervalScore(candidate: PitchClass, resolved: ReadonlyMap<Letter, PitchClass>): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue;
        total += consonance(candidate, pc);
    }
    return total;
}

/**
 * Is the pair {a, b} a MISSPELLED THIRD — a diminished fourth (should be a major third, C–F♭ ⇒ C–E) or
 * an augmented second (should be a minor third, C–D♯ ⇒ C–E♭), in either direction? This is the exact
 * vertical tell: a note off the sheet where an in-sheet third neighbour was available. It deliberately
 * does NOT flag an augmented sixth or a diminished seventh — legitimate chromatic sonorities the
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
 *  [−2, +2]) — the letter-locked twin of {@link spellNearest}, used to re-anchor the 7 slots after a fold. */
function spellLetterAt(L: Letter, c: number): PitchClass {
    const alter = Math.max(-2, Math.min(2, Math.round((c - LETTER_CHROMA[L]) / 7)));
    return { step: L, alter: alter as Accidental };
}

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
    /** DRIFT LEASH: penalty for a double-accidental (|alter| ≥ 2) spelling (0 = off). */
    doubleAccPenalty?: number;
    /** VERTICAL GUARD weight: penalty per misspelled third (dim4/aug2) a candidate forms with a
     *  co-sounding note, but only inside a PERFECT (major/minor) triad — a P5 in the sonority (0 = off). */
    verticalWeight?: number;
    /** COLLISION REPAIR: after a commit, move a non-sounding letter that now spells the same pitch class
     *  as the committed note back to a distinct spelling, keeping 7 distinct pitch classes. */
    collisionRepair?: boolean;
}

/** REAL-TIME tier (`new Speller()`): recency guard + spiral-CLAMP fold + diatonic-anchor leash. */
export const RT_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 3,
    fold: 'clamp', foldCenter: 3, foldRadius: 7, foldDebounce: 8,
    sideWeight: 1, sideRadius: 6, anchorWindow: 32,
};

/** LOOK-AHEAD tier (`new Speller({ lookAhead: true })`): a wider guard window + letter-aware look-ahead
 *  + the double-accidental leash + the vertical guard + collision repair, over the spiral-CLAMP fold. */
export const LA_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    fold: 'clamp', foldCenter: 3, foldRadius: 7, foldDebounce: 8,
    lookAhead: true, lookAheadWeight: 2,
    doubleAccPenalty: 2, verticalWeight: 1, collisionRepair: true,
};

/** TWO-PASS per-direction pass ({@link spellTwoPass}): the look-ahead tier's mechanisms but over the
 *  accidental-ECONOMY fold (the two-pass's offline forward/backward reconciliation is the better SIDE
 *  fixer, and the laggier economy fold keeps the pass disagreement the reconciliation needs). */
export const TP_PASS_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    fold: 'economy', foldWindow: 24, foldMargin: 7, foldMaxChroma: 0, foldDebounce: 8,
    lookAhead: true, lookAheadWeight: 2,
    doubleAccPenalty: 2, verticalWeight: 1, collisionRepair: true,
};

// ── Decision trace (introspection only) ────────────────────────────────────────

/** One candidate's scoring breakdown for a note (introspection / visualiser only). The argmax is
 *  `base + guardDelta + laDelta + daDelta + vertDelta + sideDelta`. */
export interface DecisionCandidate {
    readonly c: PitchClass;
    readonly base: number;
    readonly guardDelta: number;
    readonly laDelta: number;
    readonly daDelta: number;
    readonly vertDelta: number;
    readonly sideDelta: number;
}
/** The most recent note's full scoring trace (introspection / visualiser only). */
export interface Decision {
    readonly scale: PitchClass[];
    readonly candidates: DecisionCandidate[];
    readonly chosen: PitchClass;
}

// ── The engine ─────────────────────────────────────────────────────────────────

export class SpellingEngine {
    private readonly recencyGuard: number;
    private readonly guardWindow: number;
    private readonly fold: FoldMode;
    private readonly foldCenter: number;
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
    private readonly doubleAccPenalty: number;
    private readonly verticalWeight: number;
    private readonly collisionRepair: boolean;

    /** One spelling per letter A–G — the drifting scale. Starts at C major. */
    private resolved = new Map<Letter, PitchClass>();
    /** midi → the spelling committed while that note is sounding, so read-back at note-off returns the
     *  note's OWN spelling even if a later same-letter note has since overwritten the slot. */
    private active = new Map<number, PitchClass>();
    /** letter → the onset and accidental last committed to that letter — the recency guard's memory. */
    private lastByLetter = new Map<Letter, { onset: number; alter: Accidental }>();
    /** Running onset counter (co-struck notes share one onset); −1 before the first note. */
    private onset = -1;
    /** The `t` of the current onset, so co-struck notes (same `t`) don't each bump `onset`. */
    private lastT = NaN;
    /** Sliding window of recent onsets' RAW pitch classes (one entry per onset) — the economy fold's evidence. */
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
    /** LEASH display: the diatonic COLLECTION's centre — the best-fit contiguous 7-fifth window over
     *  recent commits, moved only when a rival window strictly covers more (hysteresis). +2 = C major. */
    private collectionCentre = 2;
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
        this.doubleAccPenalty = opts.doubleAccPenalty ?? 0;
        this.verticalWeight = opts.verticalWeight ?? 0;
        this.collisionRepair = opts.collisionRepair ?? false;
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
                if (this.pcWindow.length > this.foldWindow) this.pcWindow.shift();
                this.curOnsetPcs = [];
            }
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        this.curOnsetPcs.push(((midi % 12) + 12) % 12);

        // LEASH: refresh the diatonic anchor from recent commits, so a candidate far from the local
        // collection can be penalised. Off (weight 0) leaves the anchor un-consulted.
        if (this.sideWeight > 0) this.anchor = this.diatonicAnchor();

        // LOOK-AHEAD: if this note resolves a semitone to a target the scale already spells, reward the
        // diatonic-STEP letter toward it and penalise the target's own letter.
        const laOn = this.lookAheadOn && resolveDir !== 0;
        let laStep: Letter | null = null, laTarget: Letter | null = null;
        if (laOn) {
            const targetPc = (((midi + resolveDir) % 12) + 12) % 12;
            for (const L of LETTERS) {
                const p = this.resolved.get(L)!;
                if (((LETTER_BASE[p.step] + p.alter) % 12 + 12) % 12 === targetPc) { laTarget = L; break; }
            }
            if (laTarget) laStep = LETTERS[(LETTERS.indexOf(laTarget) - resolveDir + 7) % 7]!;
        }

        const scale = LETTERS.map(L => ({ ...this.resolved.get(L)! }));   // the surface scored against
        // VERTICAL GUARD context: the notes still ringing. The guard only fires inside a PERFECT triad —
        // a dim4/aug2 is a valid interval elsewhere. The triad's tell is a P5 (LoF distance 1); a dim7 /
        // aug6 has no P5, so they don't qualify.
        const coSounding = this.verticalWeight > 0 ? [...this.active.values()] : [];
        const inPerfectTriad = coSounding.some((p, i) => coSounding.some((q, j) => j > i && Math.abs(lofOf(p) - lofOf(q)) === 1));
        const cands: DecisionCandidate[] = [];
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of enharmonicCandidatesFor(midi)) {
            const base = intervalScore(c, this.resolved);
            const last = this.lastByLetter.get(c.step);
            const guarded = this.recencyGuard && last && last.alter !== c.alter && this.onset - last.onset <= this.guardWindow;
            const guardDelta = guarded ? -this.recencyGuard : 0;
            const laDelta = laOn ? (c.step === laStep ? this.lookAheadWeight : c.step === laTarget ? -this.lookAheadWeight : 0) : 0;
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
            const s = base + guardDelta + laDelta + daDelta + vertDelta + sideDelta;
            cands.push({ c, base, guardDelta, laDelta, daDelta, vertDelta, sideDelta });
            if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best === null) return;
        this.lastDecision = { scale, candidates: cands, chosen: best };
        this.resolved.set(best.step, best);
        this.active.set(midi, best);
        this.lastByLetter.set(best.step, { onset: this.onset, alter: best.alter });
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
     * A letter whose note is currently sounding is left alone — a genuine enharmonic doubling, not drift.
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
     * fold direction (by the range clamp or the accidental economy), debounce it, and — once it fires —
     * re-anchor the 7 slots one comma toward the cheaper side. Sounding notes keep their committed spelling.
     */
    private maybeFold(): void {
        const slots = [...this.resolved.values()];
        const cFrame = slots.reduce((s, pc) => s + lofOf(pc), 0) / slots.length;

        let favoured = 0;
        if (this.fold === 'clamp') {
            // Fold only when the frame drifts PAST an edge of the deadzone — far-sharp ⇒ flat, far-flat ⇒
            // sharp — never touching central keys. The surface economy is deliberately not consulted.
            if (cFrame > this.foldCenter + this.foldRadius) favoured = -ENHARMONIC_COMMA;
            else if (cFrame < this.foldCenter - this.foldRadius) favoured = +ENHARMONIC_COMMA;
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
     * alterations (anything more than 3 fifths off — the raised/lowered degrees), and re-take the median
     * of the remaining diatonic CORE. That "un-alter to reveal the diatonic" step stops a run of chromatic
     * raises (a leading tone, a tonicisation) from dragging the centre sharp. The result is the collection's
     * line-of-fifths centre — a frameless, emergent local key-centre (no key is ever detected).
     */
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
     * their natural. The engine has no hard pin — the frame is always free to drift — so `hard` is
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
        this.lastDecision = null;
    }

    /** Read-only snapshot of the current 7-letter scale (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }

    /** The diatonic collection's line-of-fifths centre (leash display; a major collection is centred at
     *  tonic + 2, so the implied major tonic = this − 2). Meaningful only when the leash is enabled. */
    getAnchor(): number { return this.collectionCentre; }

    /** The 7-letter diatonic COLLECTION — the un-altered substrate, each letter spelled within the current
     *  collection window. The stable "frame" against the altered surface (leash display). */
    getCollection(): PitchClass[] { return LETTERS.map(L => spellLetterAt(L, this.collectionCentre)); }

    /** The most recent note's scoring trace (introspection / visualiser), or null before the first note.
     *  Read-only; recording it never changes a spelling. */
    decision(): Decision | null { return this.lastDecision; }
}
