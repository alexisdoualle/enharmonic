/**
 * Two-pass batch speller — the opt-in NON-streaming entry point (CLAUDE.md "optional look-ahead for
 * non-live music"). Streaming box spellers switch enharmonic side LATE at modulation boundaries (they
 * see only past evidence), so a section's opening lags on the previous side. With the whole piece in
 * hand we can do better: run the base speller FORWARD and again on the time-REVERSED note stream (so it
 * lags the OTHER way, early not late), then resolve the two:
 *
 *   - where forward and backward AGREE, keep it (the reliable majority);
 *   - each pass is COLD at its entry end (forward at the start, backward at the END) — bound those by
 *     the first/last STABLE agreement run and trust the WARM pass there (backward at the opening,
 *     forward at the close);
 *   - in the warm interior, each contiguous DISAGREEMENT zone is one boundary lag → place a single
 *     change-point minimising Σ wolf-cost(forward) before + Σ wolf-cost(backward) after, where
 *     wolf-cost counts |ΔLoF| ≥ 7 intervals (dim4/aug2 — a misspelling tell) against the reliable
 *     bracketing agreement notes (±hw, 1/distance weighted).
 *
 * On the 65-fixture corpus this lifts diatonic-sticky+LA from tonal 97.69% to ~98.3% (wrong −25%),
 * reducing flips AND genuine errors. Batch/offline only — the streaming path is unaffected.
 */
import type { Letter, PitchClass } from './pitch.js';
import { SpellerKernel } from './kernel.js';
import { BoxWindowSubstrate } from './box.js';

export interface TwoPassNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

export interface TwoPassOptions {
    /** Base streaming speller to run in both directions (default: diatonic-sticky + letter look-ahead). */
    make?: () => SpellerKernel;
    /** Coherence-window radius (onsets) for the wolf-cost. Default 16. */
    hw?: number;
    /** Min agreement-run length that counts as "stable" (bounds each pass's cold region). Default 4. */
    rstab?: number;
    /** SECTION-FLIP (default off): after the resolve, flip whole coherent SECTIONS to their more-writable
     *  enharmonic (see {@link sectionFlipPass}). Requires a SPIRAL base (needs the frame LoF-tonic trace),
     *  so enabling this forces the base speller to `createDiatonicStickyLA({ spiral: true })` unless `make`
     *  is given explicitly. Offline only.
     *
     *  MEASURED, DEFAULT-OFF (does not earn a ladder slot; `tools/probe/_tp3way.ts`). It is a clean win
     *  OVER THE SPIRAL base (isolated on the two-pass: flip −1410, wrong +3), BUT the whole spiral branch
     *  loses to the shipped non-spiral two-pass on BOTH axes — full corpus wrong 1.046% vs 1.026%, flip
     *  23198 vs 10526. The two-pass's own forward+backward+change-point resolve is a better offline
     *  side-fixer than spiral+section-flip; and the spiral's real (coherence) win is on the STREAMING rungs
     *  2/3, which are real-time and cannot host this offline post-pass. So section-flip falls in the gap —
     *  kept as an opt-in that validates the theory ("dug too deep in one direction → flip the section"),
     *  not a shipped mechanism. See memory `spiral-is-central-frame-model`. */
    sectionFlip?: boolean;
}

const LETTER_LOF: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const LOF_TO_LETTER: Record<number, Letter> = { 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F' };
const lof = (p: PitchClass): number => LETTER_LOF[p.step] + 7 * p.alter;
/** Inverse of `lof`: the pitch spelled at signed line-of-fifths position `p` (may be a double accidental). */
const spellFromLof = (p: number): PitchClass => {
    const L = LOF_TO_LETTER[((p % 7) + 7) % 7]!;
    return { step: L, alter: Math.round((p - LETTER_LOF[L]) / 7) as PitchClass['alter'] };
};
const same = (a: PitchClass | null, b: PitchClass | null): boolean =>
    a !== null && b !== null && a.step === b.step && a.alter === b.alter;

/** Look-ahead resolveDir (±1 semitone within horizon 16) over a playing-order midi sequence. */
function dirsFor(order: { midi: number; idx: number }[], n: number): number[] {
    const out = new Array<number>(n).fill(0);
    for (let a = 0; a < order.length; a++) {
        let seen = 0;
        for (let b = a + 1; b < order.length && seen < 16; b++) {
            seen++;
            if (order[b]!.midi === order[a]!.midi + 1) { out[order[a]!.idx] = 1; break; }
            if (order[b]!.midi === order[a]!.midi - 1) { out[order[a]!.idx] = -1; break; }
        }
    }
    return out;
}

/** Stream the notes through a fresh base speller, reading each note's spelling at its note-OFF.
 *  `reverse` mirrors every interval about the timeline, so the speller runs back-to-front. When
 *  `captureFrame` is set, also records each note's frame LoF-tonic (spiral bases only) for section-flip. */
function streamPass(notes: readonly TwoPassNote[], reverse: boolean, make: () => SpellerKernel, captureFrame = false): { pred: (PitchClass | null)[]; ft: (number | undefined)[] } {
    const n = notes.length;
    let T = 0; for (const no of notes) if (no.tOff > T) T = no.tOff;
    const evs: { t: number; on: boolean; midi: number; idx: number }[] = [];
    notes.forEach((no, idx) => {
        const on = reverse ? T - no.tOff : no.tOn;
        const off = reverse ? T - no.tOn : no.tOff;
        evs.push({ t: on, on: true, midi: no.midi, idx });
        evs.push({ t: off, on: false, midi: no.midi, idx });
    });
    evs.sort((a, b) => a.t - b.t || (a.on === b.on ? 0 : a.on ? -1 : 1) || a.midi - b.midi);
    const dirs = dirsFor(evs.filter(e => e.on).map(e => ({ midi: e.midi, idx: e.idx })), n);
    const k = make();
    const pred: (PitchClass | null)[] = new Array(n).fill(null);
    const ft: (number | undefined)[] = new Array(n).fill(undefined);
    const pend = new Map<number, number[]>();
    for (const e of evs) {
        if (e.on) {
            k.noteOn(e.midi, { t: e.t, resolveDir: dirs[e.idx] ?? 0 });
            if (!pend.has(e.midi)) pend.set(e.midi, []);
            pend.get(e.midi)!.push(e.idx);
        } else {
            const sp = k.getSpelling(e.midi);
            const q = pend.get(e.midi);
            if (q && q.length) { const idx = q.shift()!; pred[idx] = sp ? { step: sp.step, alter: sp.alter } : null; if (captureFrame) ft[idx] = k.snapshot?.()?.frameLofTonic; }
            k.noteOff(e.midi);
        }
    }
    return { pred, ft };
}

/**
 * SECTION-FLIP (offline, spiral bases only). The spiral frame makes each section COHERENT (one enharmonic
 * side), so a wrong-side section is a single uniform comma-shift from a more conventional one. Segment the
 * piece by the frame's own LoF-tonic jumps (NO measure/boundary signal), and for each long-enough section
 * respell the WHOLE section to its ±12 enharmonic IF that lowers the section's total accidental load by
 * > `margin` (writability = the composer's readability convention; digging preferred, so the margin keeps
 * moderate digs). Shifting every note by the same ±12 preserves all INTERNAL intervals → coherence is
 * untouched; only the SIDE moves. A SEAM GUARD rejects a flip that would raise a boundary pair (co-onset,
 * or a melodic step) to a |ΔLoF|≥7 dim/aug wolf it wasn't before, which kills false in-piece splits.
 * Validated on the spiral streaming base (`tools/probe/_sectionflip.ts`): full-corpus wrong −3, flip −2674
 * (coherence-positive AND fidelity-positive). Writability captures "dug too deep in one direction" better
 * than double-accidental counting (which recovers less and misfires on debussy).
 */
interface SectionFlipOpts { jump: number; minLen: number; margin: number; }
function sectionFlipPass(spellings: (PitchClass | null)[], ft: (number | undefined)[], notes: readonly TwoPassNote[], o: SectionFlipOpts): (PitchClass | null)[] {
    const n = spellings.length;
    const out = spellings.slice();
    // Carry frame tonics forward across abstentions so segmentation is stable.
    const tonic: number[] = new Array(n).fill(0);
    { let cur = 0; for (let i = 0; i < n; i++) { if (ft[i] != null) cur = ft[i]!; tonic[i] = cur; } }
    const bounds: number[] = [0];
    for (let i = 1; i < n; i++) if (Math.abs(tonic[i]! - tonic[i - 1]!) >= o.jump) bounds.push(i);
    bounds.push(n);
    for (let s = 0; s + 1 < bounds.length; s++) {
        const lo = bounds[s]!, hi = bounds[s + 1]!;
        if (hi - lo < o.minLen) continue;
        const ts = tonic.slice(lo, hi).sort((a, b) => a - b);
        const t = ts[ts.length >> 1]!;
        if (t === 0) continue;
        const shift = t > 0 ? -12 : 12;
        let cur = 0, alt = 0, cnt = 0;
        for (let i = lo; i < hi; i++) { const sp = out[i]; if (!sp) continue; cnt++; cur += Math.abs(sp.alter); alt += Math.abs(spellFromLof(lof(sp) + shift).alter); }
        if (cnt === 0 || cur - alt <= o.margin) continue;
        // Seam guard: a boundary pair (co-onset or melodic step) must not become a |ΔLoF|≥7 wolf.
        const wolfAt = (outIdx: number, inIdx: number): boolean => {
            const oSp = out[outIdx], iSp = out[inIdx]; if (!oSp || !iSp) return false;
            const co = notes[outIdx]!.tOn === notes[inIdx]!.tOn;
            const step = Math.abs(notes[outIdx]!.midi - notes[inIdx]!.midi) <= 2;
            if (!co && !step) return false;
            const before = Math.abs(lof(oSp) - lof(iSp));
            const after = Math.abs(lof(oSp) - lof(spellFromLof(lof(iSp) + shift)));
            return after >= 7 && after > before;
        };
        let seamBad = false;
        if (lo > 0 && (wolfAt(lo - 1, lo) || (lo + 1 < hi && wolfAt(lo - 1, lo + 1)))) seamBad = true;
        if (hi < n && (wolfAt(hi, hi - 1) || (hi - 2 >= lo && wolfAt(hi, hi - 2)))) seamBad = true;
        if (seamBad) continue;
        for (let i = lo; i < hi; i++) { const sp = out[i]; if (sp) out[i] = spellFromLof(lof(sp) + shift); }
    }
    return out;
}

/**
 * Spell a whole piece with the two-pass batch resolver. `notes` are in playing order (bass-first within
 * a chord, as the fixtures store them). Returns one spelling per note, in the same order.
 */
export function spellTwoPass(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): (PitchClass | null)[] {
    // Section-flip needs the spiral frame's LoF-tonic trace, so it forces a spiral base by default.
    // Rung 4 (default, no section-flip) stays spiral-OFF: the two-pass's own forward+backward+resolve is a
    // better offline side-fixer than the spiral (measured wash-to-worse). `preferRelMinorLT` and
    // `lookAheadCoherenceGate` are pinned OFF for the same reason: they're streaming helpers that regress
    // on the two-pass (the backward pass already fixes these).
    const make = opts.make ?? (() => new SpellerKernel(new BoxWindowSubstrate({
        neighbourStep: true, neighbourRunGate: 2, neighbourStepWeight: 2, neighbourVerticalGate: true,
        lookAheadVerticalGate: true, parallelThirdGate: true, frameWindowMs: 16000,
        spiral: opts.sectionFlip ?? false, preferRelMinorLT: false, lookAheadCoherenceGate: false,
        keepAlive: true, lookAhead: true, lookAheadMode: 'letter', stickyEvict: 'oldest',
    })));
    const hw = opts.hw ?? 16;
    const rstab = opts.rstab ?? 4;
    const n = notes.length;
    if (n === 0) return [];

    const fp = streamPass(notes, false, make, opts.sectionFlip);
    const fwd = fp.pred;
    const bwd = streamPass(notes, true, make).pred;

    const agree = fwd.map((f, i) => same(f, bwd[i]!));
    // contiguous disagreement-run length, and agreement-run length (the latter bounds the cold regions).
    const runLen = new Array<number>(n).fill(0);
    for (let i = 0; i < n;) { if (agree[i]) { i++; continue; } let j = i; while (j < n && !agree[j]) j++; for (let t = i; t < j; t++) runLen[t] = j - i; i = j; }
    const agRun = new Array<number>(n).fill(0);
    for (let i = 0; i < n;) { if (!agree[i]) { i++; continue; } let j = i; while (j < n && agree[j]) j++; for (let t = i; t < j; t++) agRun[t] = j - i; i = j; }
    let firstStable = n, lastStable = -1;
    for (let i = 0; i < n; i++) if (agree[i] && agRun[i]! >= rstab) { firstStable = i; break; }
    for (let i = n - 1; i >= 0; i--) if (agree[i] && agRun[i]! >= rstab) { lastStable = i; break; }

    const wolf = (cand: PitchClass | null, i: number): number => {
        if (cand === null) return Number.POSITIVE_INFINITY;
        const cl = lof(cand); let w = 0;
        for (let j = Math.max(0, i - hw); j <= Math.min(n - 1, i + hw); j++) {
            if (j === i || !agree[j] || fwd[j] === null) continue;
            if (Math.abs(cl - lof(fwd[j]!)) >= 7) w += 1 / Math.abs(j - i);
        }
        return w;
    };

    // Apply the optional section-flip post-pass (spiral base only) at whichever exit we take.
    const finish = (result: (PitchClass | null)[]): (PitchClass | null)[] =>
        opts.sectionFlip ? sectionFlipPass(result, fp.ft, notes, { jump: 4, minLen: 24, margin: 0 }) : result;

    const out: (PitchClass | null)[] = fwd.slice();
    if (lastStable < 0) return finish(out);   // never converged → trust the forward (streaming) pass
    // forward COLD before the first stable agreement → use backward (warm).
    for (let i = 0; i < firstStable; i++) if (!agree[i]) out[i] = bwd[i]!;
    // warm interior → monotonic change-point per disagreement zone.
    for (let i = firstStable; i <= lastStable;) {
        if (agree[i]) { i++; continue; }
        let e = i; while (e <= lastStable && !agree[e]) e++;
        let bestK = i, bestCost = Number.POSITIVE_INFINITY;
        for (let k = i; k <= e; k++) {
            let c = 0;
            for (let j = i; j < k; j++) c += wolf(fwd[j]!, j);
            for (let j = k; j < e; j++) c += wolf(bwd[j]!, j);
            if (c < bestCost - 1e-9) { bestCost = c; bestK = k; }
        }
        for (let j = i; j < e; j++) out[j] = j < bestK ? fwd[j]! : bwd[j]!;
        i = e;
    }
    // trailing (after the last stable agreement): backward COLD → keep forward (already in `out`).
    return finish(out);
}
