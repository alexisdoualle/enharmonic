/**
 * RealtimeSpeller: the demo real-time speller, in one file, ~210 loc.
 *
 * CoreSpeller (core-speller.ts) plus three mechanisms; same style, zero imports.
 *
 * Core's three principles (7-letter limit + interval scoring + recency guard) solve
 * COHERENCE but drift on the SIDE. The three additions fix both:
 *
 *   1. DIATONIC FRAME (side). The 7 slots ARE a diatonic collection, not the drifting
 *      surface: every onset it is re-chosen by COVERAGE over the recent RAW pitch classes
 *      (recency-weighted, half-life H), so it tracks the key without lag or self-poison.
 *      The collection is placed on the spiral of fifths at the comma nearest the held frame
 *      (continuity), clamped to a writable band [center ± radius] (past the flat edge it
 *      folds sharp, and vice versa), and held by a coverage hysteresis so one raised degree
 *      cannot flip it. A committed chromatic is KEPT ALIVE in its slot until the collection
 *      moves. A soft leash also penalises a spelling stranded more than sideRadius fifths
 *      from the frame centre. This replaces the old mean-fold + median leash with one frame.
 *
 *   2. VERTICAL GUARD (coherence). Inside a PERFECT triad (a P5 is sounding), penalise a
 *      candidate that forms a misspelled third: a diminished 4th (should be a major 3rd,
 *      C–F♭ ⇒ C–E) or an augmented 2nd (should be a minor 3rd, C–D♯ ⇒ C–E♭). This breaks
 *      the F♯/G♭ side tie by chord consonance where a P5 is co-sounding. A dim7 / aug6 has
 *      no P5, so it is left alone.
 *
 *   3. CHROMATIC SHARP-LEAN (side). For a note OUTSIDE the frame collection (a true
 *      chromatic) with no co-sounding P5 for the vertical guard, reward the SHARPER of its
 *      two single-accidental spellings (F♯ over G♭, E♯ over F, B over C♭): the leading-tone
 *      / raised-degree asymmetry (a chromatic is far more often a raise). A line-of-fifths
 *      DIRECTION preference, not accidental economy: F♯/G♭ have equal accidental count and
 *      it still picks F♯. Gated to out-of-collection pitch classes, so a diatonic flat
 *      (D♭ in D♭ major) is never touched.
 *
 * Frameless, no key detection: the frame is a coverage statistic of the raw notes heard,
 * never a named key. Defaults: guard G=2, K=3; frame half-life 64, window 128, margin 1,
 * band center +3 / radius 7; leash sideWeight=1, sideRadius=6; verticalWeight=1;
 * chromaticSharpLean=1. Set any to 0 to ablate that mechanism.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
/** Double-flat through double-sharp. */
type Accidental = -2 | -1 | 0 | 1 | 2;
interface PitchClass { readonly step: Letter; readonly alter: Accidental; }
interface Pitch { readonly step: Letter; readonly alter: Accidental; readonly octave: number; }
/** Viz-only scoring record (see {@link RealtimeSpeller.decision}). Each delta is the penalty/reward this
 *  mechanism applied to the candidate; the winner maximises `base` + the sum of the deltas. */
interface DecisionCandidate {
    readonly c: PitchClass;
    readonly base: number;
    readonly guardDelta: number;
    readonly vertDelta: number;
    readonly sideDelta: number;
    readonly leanDelta: number;
}
interface Decision { readonly scale: PitchClass[]; readonly candidates: DecisionCandidate[]; readonly chosen: PitchClass; }

// ── The line of fifths ───────────────────────────────────────────────────────

/*
 * As in core-speller.ts, every spelling inside the speller is one integer n: its position on the
 * line of fifths (C=0). +1 is a fifth, +7 the same letter one accidental sharper, +12 the comma (the
 * same sounding note one turn round the spiral). A scale is 7 of them indexed by letter slot.
 * {step, alter} only appears at the public API and in the viz trace.
 */

/** The seven letters in fifths order, indexed by letter slot. */
const FIFTHS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
/** Letter slots in note-name order C D E F G A B, for output and read-back. */
const LETTER_ORDER = [1, 3, 5, 0, 2, 4, 6] as const;
/** The enharmonic comma: ±12 fifths renotate the same pitch one turn round the spiral (C↔B♯, D♭↔C♯). */
const COMMA = 12;

/** Letter slot of n, 0..6 in fifths order (F C G D A E B). */
function letter(n: number): number {
    return ((n + 1) % 7 + 7) % 7;
}

/** Accidental of n: -1 flat, 0 natural, +1 sharp. */
function acc(n: number): number {
    return Math.floor((n + 1) / 7);
}

/** Pitch class of n (0-11): n sounds 7n mod 12. */
function pitchClass(n: number): number {
    return ((7 * n) % 12 + 12) % 12;
}

/** Tie-break: true if `a` is plainer than `b` (fewer accidentals, then sharp over flat). */
function plainer(a: number, b: number): boolean {
    return Math.abs(acc(a)) < Math.abs(acc(b)) || (Math.abs(acc(a)) === Math.abs(acc(b)) && acc(a) > acc(b));
}

/** n of letter slot `s` with the accidental landing nearest centre `c` (clamped to ±2). */
function letterAt(s: number, c: number): number {
    return s - 1 + 7 * Math.max(-2, Math.min(2, Math.round((c - (s - 1)) / 7)));
}

/** {step, alter} of n, for the public API. */
function spellingOf(n: number): PitchClass {
    return { step: FIFTHS[letter(n)]!, alter: acc(n) as Accidental };
}

// ── Enharmonic candidates ────────────────────────────────────────────────────

/** Every spelling of `midi`'s pitch class within a double accidental, plainest first. Spellings of one
 *  pitch class sit 12 apart; n0 = 7·pc mod 12 is the one in 0..11 (C to E♯).
 *  0 → [C, B♯, D♭♭]   1 → [C♯, D♭, B♯♯]   8 → [G♯, A♭] */
function candidates(midi: number): number[] {
    const n0 = (7 * (midi % 12)) % 12;
    const out: number[] = [];
    for (let n = n0 - 24; n <= n0 + 12; n += 12) if (n >= -15 && n <= 19) out.push(n);
    return out.sort((a, b) => (plainer(a, b) ? -1 : plainer(b, a) ? 1 : 0));
}

// ── Interval scoring (principle 2) ────────────────────────────────────────────────

/** Consonance read straight off the fifth-distance d: fifth/third (d 1,3,4) +1; unison/2nd/7th (d 0,2,5)
 *  0; aug/dim (d 6..12) −1; doubly aug/dim (d ≥ 13) −2. No interval-naming needed. */
function consonance(a: number, b: number): number {
    const d = Math.abs(a - b);
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** A candidate's total consonance against the rest of the scale (its own slot excluded). Higher = fitter. */
function intervalScore(n: number, scale: readonly number[]): number {
    let total = 0;
    for (let slot = 0; slot < 7; slot++) {
        if (slot === letter(n)) continue;
        total += consonance(n, scale[slot]!);
    }
    return total;
}

/** A misspelled third: a diminished 4th (d = 8, a major 3rd notated C–F♭) or an augmented 2nd (d = 9, a
 *  minor 3rd notated C–D♯). The vertical guard's tell inside a perfect triad; an aug6 (d = 10) is left
 *  alone, and a dim7 chord has no P5, so the guard never runs on it. */
function isMisspelledThird(a: number, b: number): boolean {
    const d = Math.abs(a - b);
    return d === 8 || d === 9;
}

// ── The speller ──────────────────────────────────────────────────────────────

export class RealtimeSpeller {
    /** One spelling per letter slot, the frame surface. Starts at C major. */
    //                          F   C  G  D  A  E  B
    private scale: number[] = [-1, 0, 1, 2, 3, 4, 5];
    /** midi → the spelling committed while it sounds, so read-back survives a later same-letter note. */
    private active = new Map<number, number>();
    /** letter slot → onset + spelling last committed there (the recency guard's memory). */
    private lastByLetter: ({ onset: number; n: number } | undefined)[] = [];
    /** Onset counter (co-struck notes share one onset); −1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;
    /** Recent onsets' RAW pitch classes (one entry per onset), the frame's coverage evidence. */
    private pcWindow: number[][] = [];
    /** The current onset's raw pcs, flushed into pcWindow when the onset advances. */
    private curOnsetPcs: number[] = [];
    /** The frame collection's line-of-fifths centre (tonic + 2). +2 = C major, −3 = D♭ major. */
    private frameCentre = 2;
    /** Keep-alive: letter slot → a committed chromatic held over the collection, until the collection moves. */
    private kept = new Map<number, number>();
    /** Viz-only: the last note's per-candidate scoring. Recording never changes a spelling. */
    private lastDecision: Decision | null = null;

    /**
     * @param recencyGuard       G, penalty for a same-letter/different-accidental clash within K onsets (0 = off).
     * @param guardWindow        K, guard window in onsets.
     * @param frameHalfLife      H, recency half-life (onsets) of the raw-pc coverage window.
     * @param frameWindow        onsets of raw pcs kept as the frame's coverage evidence.
     * @param frameMargin        coverage hysteresis: hold the collection unless a rival covers more than this.
     * @param foldCenter         spiral band centre (+3 = G-centred, the conventional sharp bias).
     * @param foldRadius         spiral band radius; the collection's comma is clamped to center ± this (0 = off).
     * @param sideWeight         leash penalty per fifth outside the frame-centre deadzone (0 = off).
     * @param sideRadius         leash deadzone radius, in fifths.
     * @param verticalWeight     penalty per misspelled third inside a perfect triad (0 = off).
     * @param chromaticSharpLean reward for the sharper spelling of an out-of-collection chromatic (0 = off).
     */
    constructor(
        private readonly recencyGuard = 2,
        private readonly guardWindow = 3,
        private readonly frameHalfLife = 64,
        private readonly frameWindow = 128,
        private readonly frameMargin = 1,
        private readonly foldCenter = 3,
        private readonly foldRadius = 7,
        private readonly sideWeight = 1,
        private readonly sideRadius = 6,
        private readonly verticalWeight = 1,
        private readonly chromaticSharpLean = 1,
    ) {}

    /**
     * Commit a spelling for `midi`: first refresh the diatonic frame from the raw pcs heard, then pick the
     * candidate best fitting it, less the guard / vertical / leash penalties and plus the sharp-lean. `t`
     * groups co-struck notes (same `t`) into one onset; omit it to treat every call as its own onset.
     */
    noteOn(midi: number, t?: number): void {
        // Advance the onset at each new `t`, flushing the finished onset's raw pcs into the coverage window.
        if (t === undefined || t !== this.lastT) {
            if (this.curOnsetPcs.length) {
                this.pcWindow.push(this.curOnsetPcs);
                if (this.pcWindow.length > this.frameWindow) this.pcWindow.shift();
                this.curOnsetPcs = [];
            }
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        this.curOnsetPcs.push(((midi % 12) + 12) % 12);

        // FRAME: the 7 slots ARE the coverage collection, re-chosen and spiral-placed before scoring. A
        // committed note never drifts the slots; only the raw-pc window moves the frame.
        const prevCentre = this.frameCentre;
        this.frameCentre = this.computeFrameCentre();
        if (this.frameCentre !== prevCentre) this.kept.clear();   // a moved collection pulls back its alterations
        for (let slot = 0; slot < 7; slot++) this.scale[slot] = letterAt(slot, this.frameCentre);
        for (const [slot, n] of this.kept) {                      // keep-alive overlay
            if (this.scale[slot] !== n) this.scale[slot] = n;
            else this.kept.delete(slot);
        }

        // The frame collection's pitch classes, for the sharp-lean gate (is this note a true chromatic?).
        const collectionPcs = new Set(LETTER_ORDER.map(slot => pitchClass(letterAt(slot, this.frameCentre))));
        // Sharp-lean target: the sharpest single-accidental spelling of an out-of-collection pitch class.
        let leanTarget: number | null = null;
        if (this.chromaticSharpLean > 0 && !collectionPcs.has(((midi % 12) + 12) % 12)) {
            let m = -Infinity;
            for (const n of candidates(midi)) if (Math.abs(acc(n)) <= 1) m = Math.max(m, n);
            if (m !== -Infinity) leanTarget = m;
        }
        // Vertical-guard context: the co-sounding notes, and whether a P5 among them makes a perfect triad.
        const coSounding = this.verticalWeight > 0 ? [...this.active.values()] : [];
        const inPerfectTriad = coSounding.some((p, i) => coSounding.some((q, j) => j > i && Math.abs(p - q) === 1));

        const scale = LETTER_ORDER.map(slot => spellingOf(this.scale[slot]!));   // the surface scored against
        const cands: DecisionCandidate[] = [];
        let best: number | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const n of candidates(midi)) {
            const base = intervalScore(n, this.scale);
            const last = this.lastByLetter[letter(n)];
            const guarded = this.recencyGuard && last && last.n !== n && this.onset - last.onset <= this.guardWindow;
            const guardDelta = guarded ? -this.recencyGuard : 0;
            // Vertical guard: −weight per misspelled third the candidate forms with a co-sounding note.
            let misThirds = 0;
            if (this.verticalWeight > 0 && inPerfectTriad) for (const x of coSounding) if (isMisspelledThird(n, x)) misThirds++;
            const vertDelta = -this.verticalWeight * misThirds;
            // Leash: one point per fifth beyond the frame-centre deadzone [center ± R]. Zero inside, so
            // ordinary chromatic colour is free; it only bites a spelling stranded far from the frame.
            const sideDelta = this.sideWeight > 0
                ? -this.sideWeight * Math.max(0, Math.abs(n - this.frameCentre) - this.sideRadius)
                : 0;
            // Sharp-lean: reward the sharper single-accidental spelling of a true chromatic.
            const leanDelta = (leanTarget !== null && Math.abs(acc(n)) <= 1 && n === leanTarget) ? this.chromaticSharpLean : 0;
            const s = base + guardDelta + vertDelta + sideDelta + leanDelta;
            cands.push({ c: spellingOf(n), base, guardDelta, vertDelta, sideDelta, leanDelta });
            if (s > bestScore) { bestScore = s; best = n; }
        }
        if (best === null) return;
        this.lastDecision = { scale, candidates: cands, chosen: spellingOf(best) };
        this.active.set(midi, best);
        this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
        // Keep a committed chromatic alive in its slot; drop the record once the collection spells it that way.
        if (best !== letterAt(letter(best), this.frameCentre)) this.kept.set(letter(best), best);
        else this.kept.delete(letter(best));
    }

    /**
     * The principled frame centre: the diatonic COLLECTION as one contiguous 7-fifth segment, centred at the
     * returned line-of-fifths position (tonic + 2). Chosen by recency-weighted COVERAGE over the recent RAW
     * pitch classes (anti-poison, never the speller's own spellings). The comma (SIDE) is the spiral: among
     * equal-coverage commas take the one nearest the held frame (continuity), clamped to the writable band
     * [foldCenter ± foldRadius] (a hard barrier = the fold). Hysteresis holds the collection unless a rival
     * covers more than frameMargin. One number, no drift.
     */
    private computeFrameCentre(): number {
        // Recency-weighted raw-pc histogram: the current onset weighs 1, each older onset × decay^age.
        const decay = Math.pow(0.5, 1 / this.frameHalfLife);
        const counts = new Array(12).fill(0);
        let w = 1;
        for (const pc of this.curOnsetPcs) counts[pc] += w;
        for (let j = this.pcWindow.length - 1; j >= 0; j--) { w *= decay; for (const pc of this.pcWindow[j]!) counts[pc] += w; }
        let total = 0; for (const c of counts) total += c;
        if (total === 0) return this.frameCentre;
        // Coverage of the 7-fifth collection centred at c (recency-weighted mass of its pitch classes).
        const coverage = (c: number): number => { let s = 0; for (let i = -3; i <= 3; i++) s += counts[pitchClass(c + i)]!; return s; };
        const prev = this.frameCentre;
        // Place the comma nearest the held frame (continuity), barred outside the writable band (the fold).
        const sideCost = (c: number) => Math.abs(c - prev) + 1000 * Math.max(0, Math.abs(c - this.foldCenter) - this.foldRadius);
        let bestC = prev, bestCov = -1, bestSide = Infinity;
        for (let c = prev - COMMA; c <= prev + COMMA; c++) {
            const cov = coverage(c), sc = sideCost(c);
            if (cov > bestCov || (cov === bestCov && sc < bestSide)) { bestCov = cov; bestC = c; bestSide = sc; }
        }
        if (coverage(prev) >= bestCov - this.frameMargin && sideCost(prev) <= bestSide) return prev;
        return bestC;
    }

    /** Viz: the collection's LoF centre (implied major tonic = this − 2). */
    getAnchor(): number { return this.frameCentre; }

    /** Viz: the 7-letter diatonic collection, C to B, the stable frame under the altered surface. */
    getCollection(): PitchClass[] { return LETTER_ORDER.map(slot => spellingOf(letterAt(slot, this.frameCentre))); }

    /** Viz: the last note's scoring trace, or null before the first note. Read-only. */
    decision(): Decision | null {
        return this.lastDecision;
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The spelling of a sounding note (its committed one), else the frame's spelling of its pitch class,
     *  searching the letters C to B. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const n = this.active.get(midi)
            ?? LETTER_ORDER.map(slot => this.scale[slot]!).find(m => pitchClass(m) === ((midi % 12) + 12) % 12);
        return n === undefined ? null : { ...spellingOf(n), octave };
    }

    /** Read-only snapshot of the current 7-letter scale, C to B (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTER_ORDER.map(slot => spellingOf(this.scale[slot]!));
    }
}
