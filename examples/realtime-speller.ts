/**
 * RealtimeSpeller: the shipped real-time speller, in one file.
 *
 * CoreSpeller (core-speller.ts) plus three mechanisms; same style, zero imports.
 * Meredith clean: 99.52% exact, up from Core's 92.94%.
 *
 * Core's two pillars (7-letter limit + interval scoring) solve COHERENCE but drift
 * on the SIDE. The three additions fix both:
 *
 *   1. RECENCY GUARD (coherence). Core scores a candidate against the OTHER letters,
 *      so it misses a same-letter clash (A♭ right after A♮). The guard penalises a
 *      candidate whose letter was committed at a different accidental within K onsets.
 *      Bounded on purpose: it blocks flicker, not real modulation.
 *
 *   2. SPIRAL FOLD (side, reactive). With no key prior, drift ratchets deeper into one
 *      side (D♭ minor sinks into double-flats). Keep a deadzone [center ± radius] on the
 *      7-slot mean line-of-fifths; when the frame drifts past an edge, fold one comma
 *      back (past the flat edge, fold sharp). Debounced over D onsets so a passing
 *      tonicization does not trip it.
 *
 *   3. DIATONIC-ANCHOR LEASH (side, proactive). The fold reacts after the drift; the
 *      leash resists it continuously. Track the collection's line-of-fifths centre
 *      (median of recent commits, alterations dropped) and penalise a candidate more
 *      than sideRadius fifths outside it. Interval scoring is comma-symmetric and cannot
 *      pick a side; this absolute-position term can.
 *
 * Frameless, no key detection: every centre is a statistic of committed notes.
 * Defaults: guard G=2, K=3; fold center +3, radius 7, debounce 8; leash sideWeight=1,
 * sideRadius=6. Set G, radius, or sideWeight to 0 to ablate that mechanism.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
/** Double-flat through double-sharp. */
type Accidental = -2 | -1 | 0 | 1 | 2;
interface PitchClass { readonly step: Letter; readonly alter: Accidental; }
interface Pitch { readonly step: Letter; readonly alter: Accidental; readonly octave: number; }
/** Viz-only scoring record (see {@link RealtimeSpeller.decision}). `guardDelta` is 0 or −G. */
interface DecisionCandidate { readonly c: PitchClass; readonly base: number; readonly guardDelta: number; }
interface Decision { readonly scale: PitchClass[]; readonly candidates: DecisionCandidate[]; readonly chosen: PitchClass; }

// ── Constant tables ──────────────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
/** Natural pitch class of each letter (C = 0). */
const LETTER_BASE: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Line-of-fifths position of each natural, F=−1 … B=+5. */
const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

// ── Enharmonic candidates ────────────────────────────────────────────────────

/** Every spelling of `midi`'s pitch class with |accidental| ≤ 2, plainest first.
 *  0 → [C, B♯, D♭♭]   1 → [C♯, D♭, B♯♯]   8 → [G♯, A♭] */
function enharmonicCandidatesFor(midi: number): PitchClass[] {
    const pc = ((midi % 12) + 12) % 12;
    const found: { step: Letter; alter: Accidental; order: number }[] = [];
    for (let i = 0; i < LETTERS.length; i++) {
        const step = LETTERS[i]!;
        const raw = ((pc - LETTER_BASE[step]) % 12 + 12) % 12;   // required accidental, 0..11
        const alter = raw > 6 ? raw - 12 : raw;                  // fold into −6..+5
        if (Math.abs(alter) <= 2) found.push({ step, alter: alter as Accidental, order: i });
    }
    found.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || a.order - b.order);
    return found.map(({ step, alter }) => ({ step, alter }));
}

// ── Interval scoring (pillar 2) ────────────────────────────────────────────────

/** Line-of-fifths position of a spelling (C=0): the natural (F=−1) + 7·accidental. */
function lofOf(pc: PitchClass): number { return LETTER_CHROMA[pc.step] + 7 * pc.alter; }

/** Consonance read straight off the fifth-distance d: fifth/third (d 1,3,4) +1; unison/2nd/7th (d 0,2,5)
 *  0; aug/dim (d 6..12) −1; doubly aug/dim (d ≥ 13) −2. No interval-naming needed. */
function consonance(a: PitchClass, b: PitchClass): number {
    const d = Math.abs(lofOf(a) - lofOf(b));
    if (d === 1 || d === 3 || d === 4) return 1;
    if (d === 0 || d === 2 || d === 5) return 0;
    if (d <= 12) return -1;
    return -2;
}

/** A candidate's total consonance against the rest of the scale (its own slot excluded). Higher = fitter. */
function intervalScore(candidate: PitchClass, resolved: ReadonlyMap<Letter, PitchClass>): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue;
        total += consonance(candidate, pc);
    }
    return total;
}

// ── Line-of-fifths helpers for the fold ────────────────────────────────────────

/** The enharmonic comma: ±12 fifths renotate the same pitch one turn round the spiral (C↔B♯, D♭↔C♯). */
const ENHARMONIC_COMMA = 12;

/** Spell letter `L` with the accidental landing nearest LoF centre `c` (clamped to ±2). */
function spellLetterAt(L: Letter, c: number): PitchClass {
    const alter = Math.max(-2, Math.min(2, Math.round((c - LETTER_CHROMA[L]) / 7)));
    return { step: L, alter: alter as Accidental };
}

// ── The speller ──────────────────────────────────────────────────────────────

export class RealtimeSpeller {
    /** One spelling per letter A–G, the drifting scale. Starts at C major. */
    private resolved = new Map<Letter, PitchClass>();
    /** midi → the spelling committed while it sounds, so read-back survives a later same-letter note. */
    private active = new Map<number, PitchClass>();
    /** letter → onset + accidental last committed there (the recency guard's memory). */
    private lastByLetter = new Map<Letter, { onset: number; alter: Accidental }>();
    /** Onset counter (co-struck notes share one onset); −1 before the first note. */
    private onset = -1;
    /** `t` of the current onset, so co-struck notes don't each bump `onset`. */
    private lastT = NaN;
    /** Fold debounce: the direction (±12) currently favoured, and for how many consecutive onsets. */
    private pendingDir = 0;
    private pendingCount = 0;
    /** Leash memory: line-of-fifths of recent commits. */
    private committedLof: number[] = [];
    /** Leash penalty centre: the running median-of-core line-of-fifths. */
    private anchor = 1;
    /** Leash display: the collection's centre (best-fit 7-fifth window, hysteresis so one alteration can't
     *  flip it). +2 = C major. A robust MODE, distinct from the frequency-weighted median the penalty uses. */
    private collectionCentre = 2;
    /** Viz-only: the last note's per-candidate scoring. Recording never changes a spelling. */
    private lastDecision: Decision | null = null;

    /**
     * @param recencyGuard  G, penalty for a same-letter/different-accidental clash within K onsets (0 = off).
     * @param guardWindow   K, guard window in onsets.
     * @param foldDebounce  D, onsets the frame must sit past a spiral edge before the fold fires.
     * @param foldCenter    spiral centre on the 7-slot mean LoF (+3 = G-centred, the conventional sharp bias).
     * @param foldRadius    spiral radius; fold only when the frame drifts past this (0 = fold off).
     * @param sideWeight    leash penalty per fifth outside the anchor deadzone (0 = off).
     * @param sideRadius    leash deadzone radius, in fifths.
     * @param anchorWindow  recent commits kept for the anchor median.
     */
    constructor(
        private readonly recencyGuard = 2,
        private readonly guardWindow = 3,
        private readonly foldDebounce = 8,
        private readonly foldCenter = 3,
        private readonly foldRadius = 7,
        private readonly sideWeight = 1,
        private readonly sideRadius = 6,
        private readonly anchorWindow = 32,
    ) {
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
    }

    /**
     * Commit a spelling for `midi`: the candidate best fitting the scale, less the recency-guard and leash
     * penalties; then run the fold. `t` groups co-struck notes (same `t`) into one onset; omit it to treat
     * every call as its own onset.
     */
    noteOn(midi: number, t?: number): void {
        // Advance the onset at each new `t` (co-struck notes share one; the fold debounce counts onsets).
        if (t === undefined || t !== this.lastT) {
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }

        const scale = LETTERS.map(L => ({ ...this.resolved.get(L)! }));   // the surface scored against
        const cands: DecisionCandidate[] = [];
        if (this.sideWeight > 0) this.anchor = this.diatonicAnchor();     // leash: refresh from recent commits
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of enharmonicCandidatesFor(midi)) {
            const base = intervalScore(c, this.resolved);
            const last = this.lastByLetter.get(c.step);
            const guarded = this.recencyGuard && last && last.alter !== c.alter && this.onset - last.onset <= this.guardWindow;
            const guardDelta = guarded ? -this.recencyGuard : 0;
            // Leash: one point per fifth beyond the anchor deadzone [anchor ± R]. Zero inside, so ordinary
            // chromatic colour is free; it only bites a spelling stranded far from the recent music.
            const sideDelta = this.sideWeight > 0
                ? -this.sideWeight * Math.max(0, Math.abs(lofOf(c) - this.anchor) - this.sideRadius)
                : 0;
            const s = base + guardDelta + sideDelta;
            cands.push({ c, base, guardDelta });
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

        if (this.foldRadius > 0) this.maybeFold();
    }

    /**
     * The spiral fold-back. Keep a deadzone [center ± radius] on the 7-slot mean LoF; when the frame drifts
     * past an edge (and stays there D onsets), re-anchor all 7 slots one comma back toward the range. A
     * D♭-minor drift past the flat edge folds to C♯ minor, the way composers respell it.
     */
    private maybeFold(): void {
        const slots = [...this.resolved.values()];
        const cFrame = slots.reduce((s, pc) => s + lofOf(pc), 0) / slots.length;

        // Past the sharp edge, fold flat; past the flat edge, fold sharp; inside, nothing. Distance decides,
        // not surface economy (a functional-sharp passage looks cheaper flat and would fold the wrong way).
        let favoured = 0;
        if (cFrame > this.foldCenter + this.foldRadius) favoured = -ENHARMONIC_COMMA;
        else if (cFrame < this.foldCenter - this.foldRadius) favoured = +ENHARMONIC_COMMA;

        // Debounce; the post-fire reset also blocks an immediate fold-back, so no cooldown is needed.
        if (favoured !== 0 && favoured === this.pendingDir) this.pendingCount++;
        else { this.pendingDir = favoured; this.pendingCount = favoured === 0 ? 0 : 1; }
        if (favoured === 0 || this.pendingCount < this.foldDebounce) return;
        this.pendingDir = 0; this.pendingCount = 0;

        const newCentre = cFrame + favoured;   // sounding notes keep their committed spelling
        for (const L of LETTERS) this.resolved.set(L, spellLetterAt(L, newCentre));
    }

    /**
     * The diatonic-collection anchor. Median of recent commits, then drop the alterations (more than 3
     * fifths off) and re-median the diatonic core. That "un-alter" step keeps a run of chromatic raises (a
     * leading tone, a tonicisation) from dragging the centre sharp. An emergent local centre, no key detected.
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

    /** Display: re-fit the collection to recent commits, a 7-fifth window [k−3, k+3] covering the most,
     *  moved only when a rival strictly covers more (hysteresis, so one raised degree can't flip it). */
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

    /** Viz: the collection's LoF centre (implied major tonic = this − 2). */
    getAnchor(): number { return this.collectionCentre; }

    /** Viz: the 7-letter diatonic collection, the stable frame under the altered surface. */
    getCollection(): PitchClass[] { return LETTERS.map(L => spellLetterAt(L, this.collectionCentre)); }

    /** Viz: the last note's scoring trace, or null before the first note. Read-only. */
    decision(): Decision | null {
        return this.lastDecision;
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
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

    /** Read-only snapshot of the current 7-letter scale (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }
}
