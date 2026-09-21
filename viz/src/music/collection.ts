/**
 * Structural COLLECTION reader: DISPLAY ONLY (never touches spelling).
 *
 * A collection is a key-signature region taken as ONE unit: a major key AND its relative minor together
 * (C major / A minor share a collection). We report the COLLECTION, not the mode; mode is only a hint
 * toward the collection. What identifies a collection is its STRUCTURAL tones: the tonic/3rd/5th of both
 * centres, i.e. the two tonic triads combined = {tonic, 3rd, 5th, 6th} of the major. The 2nd/4th/7th are
 * OPTIONAL (a real surface is uneven, degrees go missing), and chromatic notes (a passing dim7, a
 * secondary dominant) are NORMAL: they carry almost no weight against a collection, and a chromatic that
 * happens to be a STRUCTURAL tone of a neighbour is a gentle clue toward it.
 *
 * Scored over a recency-DECAYED pitch-class window. TWO instances give the two lanes the ear wants:
 *   - LOCAL (short half-life): chases tonicizations, the most informative moment-to-moment tonal centre.
 *   - STABLE (long half-life + more hysteresis): the home key that only a SUSTAINED shift can move.
 * The line between them is not fixed; a local tonic that persists eventually migrates the stable lane
 * (a real modulation), which the two window lengths express for free.
 *
 * Cf the lab's local-key work: [[frame-vs-surface-key-inference]], [[handoff-local-key-signals]]: the
 * "local vs global key, the truth is between them" two-band conclusion, here rebuilt structurally so an
 * uneven surface and normal chromaticism don't derail it.
 */

// weight of a pitch class at scale-degree `d` (semitones above the major tonic) within a collection
function degreeWeight(d: number): number {
    if (d === 0 || d === 4 || d === 7 || d === 9) return 3;   // tonic, 3rd, 5th, 6th (= both tonic triads)
    if (d === 2 || d === 5 || d === 11) return 1;             // 2nd, 4th, 7th: optional
    return 0;                                                  // chromatic: normal, a clue only if structural elsewhere
}

export interface Collection {
    relMajorPc: number;   // 0..11: the collection's relative-MAJOR tonic pitch class (C major / A minor → 0)
    score: number;        // structural fit of the winner
    margin: number;       // winner − runner-up (confidence that it's THIS collection, not a neighbour)
}

const MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11];

export class CollectionReader {
    private win: { pc: number; t: number }[] = [];
    private prev: number | null = null;
    /** @param halfLifeMs recency half-life; @param hysteresis stickiness bonus for holding the previous
     *  collection; @param altThreshold minimum decayed weight of an OUT-OF-COLLECTION pitch class required
     *  to leave the current collection: the "new alteration" gate (a plain diatonic chord, e.g. the ii7,
     *  carries no alteration, so it can never steal the key; a real tonicization brings its accidental and
     *  passes). 0 disables the gate. */
    constructor(private readonly halfLifeMs = 4000, private readonly hysteresis = 1.0, private readonly altThreshold = 1.0) {}

    observe(midi: number, t: number): void {
        this.win.push({ pc: ((midi % 12) + 12) % 12, t });
        const cutoff = t - this.halfLifeMs * 8;   // 8 half-lives back is <0.4% weight: drop it
        while (this.win.length && this.win[0]!.t < cutoff) this.win.shift();
    }

    read(now: number): Collection | null {
        if (!this.win.length) return null;
        const hist = new Array(12).fill(0);
        for (const e of this.win) hist[e.pc] += Math.pow(0.5, (now - e.t) / this.halfLifeMs);
        let best = 0, bs = -Infinity, second = -Infinity;
        for (let c = 0; c < 12; c++) {
            let s = 0;
            for (let pc = 0; pc < 12; pc++) if (hist[pc]) s += hist[pc] * degreeWeight(((pc - c) % 12 + 12) % 12);
            if (this.prev !== null && c === this.prev) s += this.hysteresis;   // hold across a tie
            if (s > bs) { second = bs; bs = s; best = c; }
            else if (s > second) { second = s; }
        }
        // NEW-ALTERATION gate: only leave the current collection when a note OUTSIDE it is actually
        // present. A diatonic chord (ii7, IV, V7) is fully inside → no question, hold the collection.
        if (this.prev !== null && best !== this.prev && this.altThreshold > 0) {
            let hasAlteration = false;
            for (let d = 1; d < 12; d++) {
                const pc = (this.prev + d) % 12;
                if (!MAJOR_DEGREES.includes(d) && hist[pc] >= this.altThreshold) { hasAlteration = true; break; }
            }
            if (!hasAlteration) { best = this.prev; /* recompute margin against prev below */ }
        }
        // margin = winner over the best OTHER collection (confidence it's this one, not a neighbour)
        let bestScore = -Infinity, other = -Infinity;
        for (let c = 0; c < 12; c++) {
            let s = 0;
            for (let pc = 0; pc < 12; pc++) if (hist[pc]) s += hist[pc] * degreeWeight(((pc - c) % 12 + 12) % 12);
            if (c === best) bestScore = s; else if (s > other) other = s;
        }
        this.prev = best;
        return { relMajorPc: best, score: bestScore, margin: bestScore - other };
    }
}

// ── Side-aware naming ─────────────────────────────────────────────────────────
const LOF_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
function lofName(lof: number): string {
    const idx = ((lof + 1) % 7 + 7) % 7;
    const alt = Math.floor((lof + 1) / 7);
    return LOF_ORDER[idx]! + (alt > 0 ? '♯'.repeat(alt) : alt < 0 ? '♭'.repeat(-alt) : '');
}
/** Signed LoF spelling of a pitch class nearest a reference side (the frame's LoF tonic). */
function pcToLofNear(pc: number, sideLof: number): number {
    const base = (((pc * 7) % 12) + 12) % 12;
    let best = base, bd = Infinity;
    for (let k = -2; k <= 2; k++) { const c = base + 12 * k; const d = Math.abs(c - sideLof); if (d < bd) { bd = d; best = c; } }
    return best;
}
/** "E / C♯m": the collection as major/relative-minor, spelled on the frame's enharmonic side. */
export function collectionName(relMajorPc: number, sideLof: number | undefined): string {
    const side = sideLof ?? 0;
    return `${lofName(pcToLofNear(relMajorPc, side))} / ${lofName(pcToLofNear((relMajorPc + 9) % 12, side))}m`;
}
