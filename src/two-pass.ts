/**
 * Two-pass batch speller — the opt-in NON-streaming entry point (CLAUDE.md "optional look-ahead for
 * non-live music"). Streaming anchor spellers switch enharmonic side LATE at modulation boundaries (they
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
 * On the 65-fixture corpus this lifts diatonic anchor+LA from tonal 97.69% to ~98.3% (wrong −25%),
 * reducing flips AND genuine errors. Batch/offline only — the streaming path is unaffected.
 */
import { pitchClassValue, type Letter, type PitchClass } from './pitch.js';
import { SpellerKernel } from './kernel.js';
import { DiatonicBaseSubstrate, type DecisionTrace } from './base.js';
import { LocalKeyReader, readableKeyLof, spelledKeyLof, type LocalKey } from './local-key.js';

export interface TwoPassNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

/** An explicit editorial enharmonic orientation from this global onset index onward.
 * `comma` is relative: +1 favors one comma sharper, −1 flatter, 0 returns to automatic spelling. */
export interface TwoPassSideOverride { readonly from: number; readonly comma: number; }

export interface TwoPassOptions {
    /** Base streaming speller to run in both directions (default: diatonic anchor + letter look-ahead). */
    make?: () => SpellerKernel;
    /** Coherence-window radius (onsets) for the wolf-cost. Default 16. */
    hw?: number;
    /** Min agreement-run length that counts as "stable" (bounds each pass's cold region). Default 4. */
    rstab?: number;
    /** SECTION-FLIP (default off): after the resolve, flip whole coherent SECTIONS to their more-writable
     *  enharmonic (see {@link sectionFlipPass}). Requires a SPIRAL base (needs the frame LoF-tonic trace),
     *  so enabling this forces the base speller to `createDiatonicAnchorLA({ spiral: true })` unless `make`
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
    /** Use persistent local-side evidence for section handoffs and readability-limit sections. Default true;
     * pass `false` to reproduce the original forward/backward-only resolver. Offline only. */
    sideMemory?: boolean;
    /** Explicit editorial side markers. They are applied inside both directional passes, never as a
     * post-hoc rewrite; callers may place a `comma: 0` marker to release back to automatic spelling. */
    sideOverrides?: readonly TwoPassSideOverride[];
}

/** Read-only diagnostics for one directional streaming pass.  This is intentionally separate from
 * the public two-pass output: production callers receive only spellings from {@link spellTwoPass}. */
export interface TwoPassPassTrace {
    spelling: PitchClass | null;
    /** Editorial side marker active when this onset entered this directional pass. */
    forcedSide: number;
    frame: PitchClass[] | null;
    resolvedScale: PitchClass[] | null;
    frameLofTonic: number | undefined;
    frameKeyLof: number | undefined;
    localKey: LocalKey | null;
    decision: DecisionTrace | null;
}

/** How the offline resolver chose a spelling after comparing its forward and backward passes. */
export interface TwoPassNoteTrace {
    forward: TwoPassPassTrace;
    backward: TwoPassPassTrace;
    agrees: boolean;
    selected: 'forward' | 'backward';
    phase: 'agreement' | 'cold-start' | 'interior' | 'trailing' | 'never-converged';
    forwardWolf: number | undefined;
    backwardWolf: number | undefined;
}

/** Diagnostic result from {@link spellTwoPassTraced}; never returned by the production API. */
export interface TwoPassTrace {
    spellings: (PitchClass | null)[];
    notes: TwoPassNoteTrace[];
    firstStable: number | null;
    lastStable: number | null;
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
type CapturedPass = { pred: (PitchClass | null)[]; ft: (number | undefined)[]; keys?: (LocalKey | null)[]; trace?: TwoPassPassTrace[] };
type TraceKernel = { kernel: SpellerKernel; decision: () => DecisionTrace | null | undefined };

function streamPass(
    notes: readonly TwoPassNote[], reverse: boolean, make: () => SpellerKernel, captureFrame = false,
    makeTraceKernel?: () => TraceKernel, captureKeys = false, sideAt?: readonly number[],
): CapturedPass {
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
    const traceKernel = makeTraceKernel?.();
    const k = traceKernel?.kernel ?? make();
    const pred: (PitchClass | null)[] = new Array(n).fill(null);
    const ft: (number | undefined)[] = new Array(n).fill(undefined);
    const trace = traceKernel ? new Array<TwoPassPassTrace>(n) : undefined;
    const keys = captureKeys ? new Array<LocalKey | null>(n).fill(null) : undefined;
    const keyReader = captureKeys ? new LocalKeyReader() : null;
    const pend = new Map<number, number[]>();
    for (const e of evs) {
        if (e.on) {
            if (sideAt) k.setForcedSide(sideAt[e.idx] ?? 0);
            k.noteOn(e.midi, { t: e.t, resolveDir: dirs[e.idx] ?? 0 });
            if (!pend.has(e.midi)) pend.set(e.midi, []);
            pend.get(e.midi)!.push(e.idx);
        } else {
            const sp = k.getSpelling(e.midi);
            const q = pend.get(e.midi);
            if (q && q.length) {
                const idx = q.shift()!;
                pred[idx] = sp ? { step: sp.step, alter: sp.alter } : null;
                const snap = (captureFrame || trace || keyReader) ? k.snapshot?.() : undefined;
                const localKey = keyReader?.observe(snap?.resolvedScale ?? []) ?? null;
                if (keys) keys[idx] = localKey;
                if (captureFrame) ft[idx] = snap?.frameLofTonic;
                if (trace) {
                    trace[idx] = {
                        spelling: pred[idx]!,
                        forcedSide: sideAt?.[idx] ?? 0,
                        frame: snap?.frame?.map(p => ({ ...p })) ?? null,
                        resolvedScale: snap?.resolvedScale?.map(p => ({ ...p })) ?? null,
                        frameLofTonic: snap?.frameLofTonic,
                        frameKeyLof: snap?.frameKeyLof,
                        localKey,
                        decision: traceKernel!.decision() ?? null,
                    };
                }
            }
            k.noteOff(e.midi);
        }
    }
    return trace ? (keys ? { pred, ft, keys, trace } : { pred, ft, trace }) : (keys ? { pred, ft, keys } : { pred, ft });
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
 * A deliberately narrow extension of the disagreement resolver for the case
 * where both passes make the *same* over-the-limit choice.  A C♯-major region,
 * for example, can be internally flawless in both directions even when the
 * surrounding notation has established the D♭ side.  There is then no change
 * point for the ordinary resolver to move.
 *
 * We treat only a long run whose local mean LoF is beyond the readable ±6
 * boundary as eligible.  The alternate spelling must lower accidental load,
 * and recent altered-note evidence must not already have established the same
 * side.  That last condition is the memory: an honestly prepared C♯ major is
 * retained; an isolated, expensive C♯-major spelling after neutral/flat
 * notation may return to D♭.  This remains opt-in and intentionally does not
 * try to infer a key from a single chromatic chord.  Within an accepted
 * region, a pitch already carrying the target scale's spelling is retained;
 * this lets a real C♮ survive inside D♭ major without making double
 * accidentals globally illegal.
 */
function sideMemoryLimitPass(spellings: (PitchClass | null)[], localKeys: readonly (LocalKey | null)[]): (PitchClass | null)[] {
    const n = spellings.length;
    const out = spellings.slice();
    const radius = 12, limit = 6, minLen = 64, memory = 192;
    const meanLof = (i: number): number => {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
            const p = spellings[j]; if (!p) continue;
            sum += lof(p); count++;
        }
        return count ? sum / count : 0;
    };
    const atLimit = spellings.map((_p, i) => meanLof(i));
    const neutralKey = (i: number): boolean => {
        const key = localKeys[i];
        // A confidently named local key is stronger evidence than raw
        // accidental economy.  Its absence (or a C/A-minor collection) leaves
        // this specific "at the limit" decision open to the remembered side.
        return !key || key.confidence === 'hold' || key.confidence === 'weak' || spelledKeyLof(key) === 0;
    };
    for (let i = 0; i < n;) {
        if (Math.abs(atLimit[i]!) < limit || !neutralKey(i)) { i++; continue; }
        let e = i + 1;
        const sign = Math.sign(atLimit[i]!);
        while (e < n && Math.sign(atLimit[e]!) === sign && Math.abs(atLimit[e]!) >= limit && neutralKey(e)) e++;
        if (e - i >= minLen) {
            // Decayed evidence from *altered* notes only. Naturals say nothing
            // about an enharmonic side; old sharps/flats progressively forget.
            let held = 0;
            for (let j = Math.max(0, i - memory); j < i; j++) {
                const p = out[j]; if (!p || p.alter === 0) continue;
                held += Math.sign(p.alter) * (j - (i - memory) + 1) / memory;
            }
            const shift = sign > 0 ? -12 : 12;
            // Infer the target scale spelling per pitch class from the
            // prospective, shifted region.  A dominant spelling is enough:
            // these are long coherent sections, not a single chord.  This is
            // a scale-slot mask, not an accidental-count veto.
            const targetVotes = new Map<number, Map<string, { pitch: PitchClass; count: number }>>();
            for (let j = i; j < e; j++) {
                const p = out[j]; if (!p) continue;
                const alt = spellFromLof(lof(p) + shift);
                const pc = pitchClassValue(alt), name = `${alt.step}/${alt.alter}`;
                const byName = targetVotes.get(pc) ?? new Map<string, { pitch: PitchClass; count: number }>();
                const vote = byName.get(name);
                if (vote) vote.count++; else byName.set(name, { pitch: alt, count: 1 });
                targetVotes.set(pc, byName);
            }
            const targetFor = (p: PitchClass): PitchClass | null => {
                const votes = targetVotes.get(pitchClassValue(p));
                if (!votes) return null;
                let best: { pitch: PitchClass; count: number } | null = null;
                for (const vote of votes.values()) if (!best || vote.count > best.count) best = vote;
                return best?.pitch ?? null;
            };
            const alreadyTarget = (p: PitchClass) => same(p, targetFor(p));
            let current = 0, alternate = 0;
            for (let j = i; j < e; j++) {
                const p = out[j]; if (!p) continue;
                current += Math.abs(p.alter);
                alternate += Math.abs(alreadyTarget(p) ? p.alter : spellFromLof(lof(p) + shift).alter);
            }
            // A positive held value means an established sharp side (and vice
            // versa).  Do not overwrite it merely because its key is costly.
            const alreadyHeld = Math.sign(held) === sign && Math.abs(held) >= 1;
            if (!alreadyHeld && alternate + 1 < current)
                for (let j = i; j < e; j++) {
                    const p = out[j]; if (p && !alreadyTarget(p)) out[j] = spellFromLof(lof(p) + shift);
                }
        }
        i = e;
    }
    return out;
}

function defaultBase(opts: TwoPassOptions): DiatonicBaseSubstrate {
    return new DiatonicBaseSubstrate({
        neighbourStep: true, neighbourRunGate: 2, neighbourStepWeight: 2, neighbourVerticalGate: true,
        lookAheadVerticalGate: true, parallelThirdGate: true, baseWindowMs: 16000,
        spiral: opts.sectionFlip ?? false, preferRelMinorLT: false, lookAheadCoherenceGate: false,
        keepAlive: true, lookAhead: true, lookAheadMode: 'letter', keepAliveEvict: 'oldest',
    });
}

function defaultTraceKernel(opts: TwoPassOptions): TraceKernel {
    const base = defaultBase(opts);
    return { kernel: new SpellerKernel(base), decision: () => base.decision() };
}

/**
 * Spell a whole piece with the two-pass batch resolver. `notes` are in playing order (bass-first within
 * a chord, as the fixtures store them). Returns one spelling per note, in the same order.
 */
function spellTwoPassCore(notes: readonly TwoPassNote[], opts: TwoPassOptions, traced: boolean): TwoPassTrace {
    // Section-flip needs the spiral frame's LoF-tonic trace, so it forces a spiral base by default.
    // Rung 4 (default, no section-flip) stays spiral-OFF: the two-pass's own forward+backward+resolve is a
    // better offline side-fixer than the spiral (measured wash-to-worse). `preferRelMinorLT` and
    // `lookAheadCoherenceGate` are pinned OFF for the same reason: they're streaming helpers that regress
    // on the two-pass (the backward pass already fixes these).
    const make = opts.make ?? (() => new SpellerKernel(defaultBase(opts)));
    // A caller-supplied kernel has no standard way to expose the substrate's private decision record;
    // retain its snapshots but leave that field null rather than guessing at a score explanation.
    const makeTraceKernel = traced
        ? (opts.make ? () => ({ kernel: opts.make!(), decision: () => null }) : () => defaultTraceKernel(opts))
        : undefined;
    const hw = opts.hw ?? 16;
    const rstab = opts.rstab ?? 4;
    const n = notes.length;
    // This is now the normal offline resolver.  Retain an explicit false for
    // regression/audit work and callers that require the historical output.
    const sideMemory = opts.sideMemory !== false;
    const sideAt = new Array<number>(n).fill(0);
    // Sweep once: markers are a small sorted map, never a post-hoc respelling pass.
    const markers = [...(opts.sideOverrides ?? [])]
        .filter(ov => Number.isInteger(ov.from) && ov.from >= 0 && ov.from < n && Number.isFinite(ov.comma))
        .sort((a, b) => a.from - b.from);
    let marker = 0, forced = 0;
    for (let i = 0; i < n; i++) {
        while (marker < markers.length && markers[marker]!.from === i) forced = Math.trunc(markers[marker++]!.comma);
        sideAt[i] = forced;
    }
    if (n === 0) return { spellings: [], notes: [], firstStable: null, lastStable: null };

    const captureKeys = traced || sideMemory;
    const fp = streamPass(notes, false, make, opts.sectionFlip, makeTraceKernel, captureKeys, sideAt);
    const fwd = fp.pred;
    const bp = streamPass(notes, true, make, false, makeTraceKernel, captureKeys, sideAt);
    const bwd = bp.pred;

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
    const finish = (result: (PitchClass | null)[]): (PitchClass | null)[] => {
        const sectioned = opts.sectionFlip ? sectionFlipPass(result, fp.ft, notes, { jump: 4, minLen: 24, margin: 0 }) : result;
        return sideMemory && fp.keys ? sideMemoryLimitPass(sectioned, fp.keys) : sectioned;
    };

    const out: (PitchClass | null)[] = fwd.slice();
    // The production wrapper never creates the diagnostic arrays. Its resolver work and output remain
    // the same; only the traced entry point pays to retain reconciliation evidence.
    const selected = traced ? new Array<'forward' | 'backward'>(n).fill('forward') : undefined;
    const phase = traced ? agree.map<TwoPassNoteTrace['phase']>(x => x ? 'agreement' : 'trailing') : undefined;
    const forwardWolf = traced ? new Array<number | undefined>(n).fill(undefined) : undefined;
    const backwardWolf = traced ? new Array<number | undefined>(n).fill(undefined) : undefined;
    const result = (spellings: (PitchClass | null)[]): TwoPassTrace => traced
        ? tracedResult(spellings, fp.trace, bp.trace, agree, selected!, phase!, forwardWolf!, backwardWolf!, firstStable, lastStable)
        : { spellings, notes: [], firstStable: null, lastStable: null };
    if (lastStable < 0) {
        if (traced) phase!.fill('never-converged'); // never converged → trust the forward (streaming) pass
        return result(finish(out));
    }
    // forward COLD before the first stable agreement → use backward (warm).
    for (let i = 0; i < firstStable; i++) if (!agree[i]) {
        out[i] = bwd[i]!;
        if (traced) { selected![i] = 'backward'; phase![i] = 'cold-start'; }
    }
    // warm interior → monotonic change-point per disagreement zone.
    for (let i = firstStable; i <= lastStable;) {
        if (agree[i]) { i++; continue; }
        let e = i; while (e <= lastStable && !agree[e]) e++;
        let bestK = i, bestCost = Number.POSITIVE_INFINITY;
        const costs: number[] = [];
        for (let k = i; k <= e; k++) {
            let c = 0;
            for (let j = i; j < k; j++) c += wolf(fwd[j]!, j);
            for (let j = k; j < e; j++) c += wolf(bwd[j]!, j);
            costs[k - i] = c;
            if (c < bestCost - 1e-9) { bestCost = c; bestK = k; }
        }
        let chosenK = bestK;
        // Memory is for a section-scale ambiguity, not a short chromatic
        // excursion.  The minimum also keeps stitched-book seam blips from
        // acquiring a retrospective side preference.
        if (sideMemory && e - i >= 128 && fp.keys && bp.keys) {
            // Recover the established side from the preceding reliable run. A local key's MODE may change
            // freely inside that side (C♯m → C♯), but only an opposite readable collection can authorise
            // a section flip. Equal wolf-cost plateaus are the only places this experiment may intervene.
            let held = 0;
            for (let p = i - 1; p >= 0; p--) if (agree[p] && fp.keys[p]) { held = Math.sign(readableKeyLof(fp.keys[p]!)); break; }
            if (held !== 0) {
                const preferred: 'forward' | 'backward' = held < 0 ? 'forward' : 'backward';
                const candidates = (side: 'forward' | 'backward') => {
                    const keys = side === 'forward' ? fp.keys! : bp.keys!;
                    const out: number[] = [];
                    for (let k = i; k < e; k++) {
                        const key = keys[k];
                        if (key && Math.sign(readableKeyLof(key)) === -held && costs[k - i]! <= bestCost + 1e-9) out.push(k);
                    }
                    return out;
                };
                chosenK = candidates(preferred)[0] ?? candidates(preferred === 'forward' ? 'backward' : 'forward')[0] ?? bestK;
            }
        }
        for (let j = i; j < e; j++) {
            out[j] = j < chosenK ? fwd[j]! : bwd[j]!;
            if (traced) {
                forwardWolf![j] = wolf(fwd[j]!, j);
                backwardWolf![j] = wolf(bwd[j]!, j);
                selected![j] = j < chosenK ? 'forward' : 'backward';
                phase![j] = 'interior';
            }
        }
        i = e;
    }
    // trailing (after the last stable agreement): backward COLD → keep forward (already in `out`).
    return result(finish(out));
}

function tracedResult(
    spellings: (PitchClass | null)[], forward: TwoPassPassTrace[] | undefined, backward: TwoPassPassTrace[] | undefined,
    agrees: boolean[], selected: ('forward' | 'backward')[], phase: TwoPassNoteTrace['phase'][],
    forwardWolf: (number | undefined)[], backwardWolf: (number | undefined)[], firstStable: number, lastStable: number,
): TwoPassTrace {
    const blank = (): TwoPassPassTrace => ({ spelling: null, forcedSide: 0, frame: null, resolvedScale: null, frameLofTonic: undefined, frameKeyLof: undefined, localKey: null, decision: null });
    return {
        spellings,
        notes: spellings.map((_, i) => ({
            forward: forward?.[i] ?? blank(), backward: backward?.[i] ?? blank(), agrees: agrees[i]!,
            selected: selected[i]!, phase: phase[i]!, forwardWolf: forwardWolf[i], backwardWolf: backwardWolf[i],
        })),
        firstStable: firstStable < spellings.length ? firstStable : null,
        lastStable: lastStable >= 0 ? lastStable : null,
    };
}

/** Production entry point: returns only final spellings, with no diagnostic API or trace allocation. */
export function spellTwoPass(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): (PitchClass | null)[] {
    return spellTwoPassCore(notes, opts, false).spellings;
}

/** Diagnostic-only entry point for the visualiser. It shares the exact production resolver. */
export function spellTwoPassTraced(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): TwoPassTrace {
    return spellTwoPassCore(notes, opts, true);
}
