/**
 * Two-pass batch speller — the offline, highest-accuracy entry point (whole piece in hand).
 *
 * A streaming speller switches enharmonic side LATE at a modulation boundary (it sees only the past),
 * so a section's opening lags on the previous side. With the whole piece available we do better: run the
 * engine FORWARD and again over the time-REVERSED note stream (so it lags the OTHER way, early not late),
 * then reconcile the two:
 *
 *   - where forward and backward AGREE, keep it (the reliable majority);
 *   - each pass is COLD at its entry end (forward at the start, backward at the end) — before the first
 *     agreement trust the backward (warm) pass, after the last trust the forward;
 *   - each contiguous DISAGREEMENT run is one boundary lag → place a single change-point (forward before
 *     it, backward after) minimising local WOLF-cost (|ΔLoF| ≥ 6 intervals — a dim4/aug2 misspelling
 *     tell). A COHERENT flip makes no wolves, so every change-point ties at 0; break that tie toward the
 *     side nearer the piece's committed line-of-fifths CENTRE (an emergent statistic, never a detected key).
 *
 * Both passes are the shipped engine at its two-pass preset (letter look-ahead + vertical guard, over the
 * accidental-economy fold). The reconciliation is pure array logic. On David Meredith's held-out 8×25000
 * corpus this scores 99.86% exact clean.
 */

import type { Letter, Pitch, PitchClass } from './pitch.js';
import { resolveStep } from './kernel.js';
import { SpellingEngine, TP_PASS_PRESET } from './engine.js';

export interface TwoPassNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

export interface TwoPassOptions {
    /**
     * How the backward pass handles look-ahead:
     *   `'forward'` (default) — feed FORWARD-time resolution to the backward pass. Processing in reverse,
     *     the resolution target is already committed, so a leading tone is spelled from its real resolution.
     *   `'off'` — no look-ahead in the backward pass.
     */
    backwardLookAhead?: 'forward' | 'off';
    /**
     * Break a wolf-cost tie (a coherent flip makes no wolves, so every change-point ties) toward the side
     * nearer the piece's committed line-of-fifths centre, instead of by warmth. Default `true`. This is the
     * single biggest lever in the merge; a frameless side prior (median LoF of the agreed notes), not a key.
     */
    centreTiebreak?: boolean;
    /**
     * Wolf-cost slack within which the centre prior decides: treat any change-point within this many wolves
     * of the minimum as tied and let the LoF-centre pick. Default `0` (opt-in). Helps single-region offline
     * material under timing noise; on modulating material the local wolf-cost is the better guide, so keep 0.
     */
    centreMargin?: number;
    /**
     * After the merge, keep the forward pass's spelling where it found a real exact-midi UP-resolution (a
     * sharp leading tone) the merge flattened, guarded by the sounding chord (and overridden inside a full
     * diminished seventh). Default `false`; a near-wash on top of the merge, kept for future noisy work.
     */
    honorResolution?: boolean;
}

/** One note's per-pass reconciliation trace (introspection / visualiser only). */
export interface TwoPassNoteTrace {
    readonly forward: PitchClass | null;
    readonly backward: PitchClass | null;
    readonly selected: PitchClass | null;
    readonly agrees: boolean;
}
/** Full two-pass trace: the final spellings plus each note's forward/backward/selected reconciliation. */
export interface TwoPassTrace {
    readonly spellings: (PitchClass | null)[];
    readonly notes: TwoPassNoteTrace[];
    readonly firstStable: number | null;
    readonly lastStable: number | null;
}

// ── Line-of-fifths + direction helpers ─────────────────────────────────────────

const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const lof = (s: { step: Letter; alter: number }) => LETTER_CHROMA[s.step] + 7 * s.alter;

/** Nearest-semitone-resolution direction for each note, scanning up to `horizon` following onsets. */
function resolveDirs(notes: readonly TwoPassNote[], horizon = 16): number[] {
    const d = new Array<number>(notes.length).fill(0);
    for (let a = 0; a < notes.length; a++) {
        let seen = 0;
        for (let b = a + 1; b < notes.length && seen < horizon; b++) {
            seen++;
            d[a] = resolveStep(notes[a]!.midi, notes[b]!.midi);
            if (d[a] !== 0) break;
        }
    }
    return d;
}

/** EXACT-midi up/down resolution (not octave-agnostic), the discriminating signal honor-resolution wants:
 *  a confirmed exact-midi UP-resolver is a sharp leading tone. */
function resolveDirsExact(notes: readonly TwoPassNote[], horizon = 16): number[] {
    const d = new Array<number>(notes.length).fill(0);
    for (let a = 0; a < notes.length; a++) {
        let seen = 0;
        for (let b = a + 1; b < notes.length && seen < horizon; b++) {
            seen++;
            if (notes[b]!.midi === notes[a]!.midi + 1) { d[a] = 1; break; }
            if (notes[b]!.midi === notes[a]!.midi - 1) { d[a] = -1; break; }
        }
    }
    return d;
}

/** Drive one engine pass over notes in the given order; return one spelling per note (same order).
 *  Notes must be pre-sorted (onset asc, bass-first). Look-ahead uses `dirs` when supplied. */
function drivePass(notes: readonly TwoPassNote[], dirs: number[] | null): Pitch[] {
    const s = new SpellingEngine(TP_PASS_PRESET);
    // Event stream: releases before strikes at equal t; strikes bass-first.
    const evs: { t: number; on: boolean; i: number }[] = [];
    notes.forEach((n, i) => { evs.push({ t: n.tOn, on: true, i }); evs.push({ t: n.tOff, on: false, i }); });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || notes[a.i]!.midi - notes[b.i]!.midi);
    const out: Pitch[] = new Array(notes.length);
    const pend = new Map<number, number[]>();   // midi → FIFO of note indices awaiting read-back at note-off
    for (const e of evs) {
        const midi = notes[e.i]!.midi;
        if (e.on) { s.noteOn(midi, e.t, dirs ? dirs[e.i]! : 0); (pend.get(midi) ?? pend.set(midi, []).get(midi)!).push(e.i); }
        // Read the note's committed spelling (before release); release the midi only once its LAST overlapping
        // voice ends, so read-back never falls through and the vertical guard's ringing set stays correct.
        else { const q = pend.get(midi); if (q?.length) { out[q.shift()!] = s.getSpelling(midi) as Pitch; if (q.length === 0) s.noteOff(midi); } }
    }
    return out;
}

/** Sort helper: notes bass-first (onset asc, midi asc), with a mapping back to the caller's order. */
function order(notes: readonly TwoPassNote[]) {
    const idx = notes.map((_, i) => i).sort((a, b) => notes[a]!.tOn - notes[b]!.tOn || notes[a]!.midi - notes[b]!.midi);
    const sorted = idx.map(i => notes[i]!);
    return {
        notes: sorted,
        restore<T>(spelled: T[]): T[] {
            const out: T[] = new Array(notes.length);
            idx.forEach((orig, pos) => { out[orig] = spelled[pos]!; });
            return out;
        },
    };
}

interface CoreResult {
    spellings: Pitch[];               // in the SORTED (bass-first) order
    forward: Pitch[];
    backward: Pitch[];
    agrees: boolean[];
    firstStable: number;
    lastStable: number;
}

/**
 * The forward + time-reversed backward passes and their wolf-cost reconciliation, in the SORTED order.
 * Shared by {@link spellTwoPass} and {@link spellTwoPassTraced}; the public functions restore the caller's
 * note order around it.
 */
function twoPassCore(sortedNotes: readonly TwoPassNote[], opts: TwoPassOptions): CoreResult {
    const backwardLA = opts.backwardLookAhead ?? 'forward';
    const centreTiebreak = opts.centreTiebreak ?? true;
    const centreMargin = opts.centreMargin ?? 0;
    const N = sortedNotes;
    const n = N.length;
    if (n === 0) return { spellings: [], forward: [], backward: [], agrees: [], firstStable: 0, lastStable: -1 };

    const dirsF = resolveDirs(N);
    const fwd = drivePass(N, dirsF);
    // Backward: TIME-REVERSE the stream so the engine genuinely processes latest-first. Flip each note's
    // [tOn,tOff] about the piece end T, and reverse the note order so it stays pre-sorted (onset asc).
    const T = Math.max(...N.map(x => x.tOff));
    const bNotes: TwoPassNote[] = N.map(x => ({ midi: x.midi, tOn: T - x.tOff, tOff: T - x.tOn })).reverse();
    // Backward look-ahead uses the note's FORWARD resolveDir: processing in reverse, the resolution target
    // is already committed. bNotes[k] = original n-1-k.
    const bDirs = backwardLA === 'off' ? null : dirsF.slice().reverse();
    const bOut = drivePass(bNotes, backwardLA !== 'off' ? bDirs : null);
    const bwd: Pitch[] = new Array(n);
    for (let k = 0; k < n; k++) bwd[n - 1 - k] = bOut[k]!;

    const out: Pitch[] = new Array(n);
    const agree = (i: number) => lof(fwd[i]!) === lof(bwd[i]!);
    // Cold-end handling: before the first agreement trust the backward (warm) pass; after the last, forward.
    let firstAgree = 0; while (firstAgree < n && !agree(firstAgree)) firstAgree++;
    let lastAgree = n - 1; while (lastAgree >= 0 && !agree(lastAgree)) lastAgree--;
    for (let i = 0; i < firstAgree; i++) out[i] = bwd[i]!;
    for (let i = lastAgree + 1; i < n; i++) out[i] = fwd[i]!;

    // A frameless SIDE PRIOR for breaking wolf-cost ties: the median LoF of the passes' AGREED notes — the
    // reliable majority — an emergent statistic, not a detected key. Whole-piece median (deliberately not
    // windowed: a local centre is dragged by nearby agreed-but-wrong runs).
    const agreedLofs: number[] = [];
    for (let t = 0; t < n; t++) if (agree(t)) agreedLofs.push(lof(fwd[t]!));
    agreedLofs.sort((a, b) => a - b);
    const centre = agreedLofs.length ? agreedLofs[agreedLofs.length >> 1]! : 0;

    let i = Math.max(0, firstAgree);
    while (i <= lastAgree) {
        if (agree(i)) { out[i] = fwd[i]!; i++; continue; }
        let j = i; while (j <= lastAgree && !agree(j)) j++;      // disagreement run [i, j)
        // Try every change-point k in [i, j]: forward for [i,k), backward for [k,j). Score by wolves in the
        // bracketed window [i-1, j]. Wolf-cost LOCATES an incoherent lag boundary; a COHERENT flip makes no
        // wolves so every k ties, broken by the SIDE-CENTRE, then by WARMTH (forward late, backward early).
        const late = (i + j) / 2 >= n / 2;
        const pickFor = (k: number) => (t: number): Pitch => t < i ? out[t]! : t >= j ? fwd[t]! : (t < k ? fwd[t]! : bwd[t]!);
        const costOf = (k: number): number => {
            const pick = pickFor(k); let cost = 0;
            for (let t = Math.max(1, i); t <= Math.min(n - 1, j); t++) {
                const a = pick(t - 1), b = pick(t);
                if (a && b && Math.abs(lof(a) - lof(b)) >= 6) cost++;
            }
            return cost;
        };
        const cost: number[] = []; let minCost = Infinity;
        for (let k = i; k <= j; k++) { cost[k - i] = costOf(k); if (cost[k - i]! < minCost) minCost = cost[k - i]!; }
        let bestK = i, bestPref = -Infinity, bestWarm = -Infinity;
        for (let k = i; k <= j; k++) {
            if (cost[k - i]! > minCost + centreMargin) continue;
            const pick = pickFor(k);
            let dist = 0; for (let t = i; t < j; t++) dist += Math.abs(lof(pick(t)) - centre);
            const pref = centreTiebreak ? -(dist + cost[k - i]!) : -cost[k - i]!;
            const warm = late ? k : -k;
            if (pref > bestPref || (pref === bestPref && warm > bestWarm)) { bestK = k; bestPref = pref; bestWarm = warm; }
        }
        for (let t = i; t < j; t++) out[t] = t < bestK ? fwd[t]! : bwd[t]!;
        i = j;
    }

    // HONOR-RESOLUTION. The wolf-cost merge reconciles the SIDE and can discard a note the forward pass
    // spelled from a real resolution (a sharp leading tone the merge flattened). A confirmed exact-midi
    // UP-resolver is dispositive: keep the forward pick where it is SHARPER than the merged pick — guarded
    // by the sounding chord (honored only when it forms no more vertical wolves than the merged pick), with
    // a full sounding dim7 overriding the guard, and same-pc co-onset partners (octave doublings) skipped.
    if (opts.honorResolution ?? false) {
        const dirsX = resolveDirsExact(N);
        const pc = (k: number) => ((N[k]!.midi % 12) + 12) % 12;
        const sameOnset = new Map<number, number[]>();
        for (let idx = 0; idx < n; idx++) { const t = N[idx]!.tOn; (sameOnset.get(t) ?? sameOnset.set(t, []).get(t)!).push(idx); }
        const onsetPcs = new Map<number, Set<number>>();
        for (const [t, idxs] of sameOnset) onsetPcs.set(t, new Set(idxs.map(k => pc(k))));
        const inFullDim7 = (k: number): boolean => {
            const pcs = onsetPcs.get(N[k]!.tOn)!, L = pc(k);
            return pcs.has(L) && pcs.has((L + 3) % 12) && pcs.has((L + 6) % 12) && pcs.has((L + 9) % 12);
        };
        const vWolf = (cand: Pitch, k: number): number => {
            let w = 0;
            for (const jj of sameOnset.get(N[k]!.tOn)!) {
                const p = out[jj]; if (jj === k || !p) continue;
                if (pc(jj) === pc(k)) continue;               // octave doubling: one sounding pc, not a clash
                if (Math.abs(lof(cand) - lof(p)) >= 7) w++;
            }
            return w;
        };
        for (let idx = 0; idx < n; idx++) {
            const cur = out[idx], f = fwd[idx]!;
            if (dirsX[idx] === 1 && cur && lof(f) > lof(cur) && (vWolf(f, idx) <= vWolf(cur, idx) || inFullDim7(idx)))
                out[idx] = f;
        }
    }

    const agrees = new Array<boolean>(n);
    for (let t = 0; t < n; t++) agrees[t] = agree(t);
    return {
        spellings: out, forward: fwd, backward: bwd, agrees,
        firstStable: firstAgree < n ? firstAgree : n,
        lastStable: lastAgree,
    };
}

/** Reduce a Pitch to a PitchClass (the historic two-pass output shape). */
const toPc = (p: Pitch | undefined): PitchClass | null => p ? { step: p.step, alter: p.alter } : null;

/** Production entry point: returns only final spellings, one per input note (caller's order). */
export function spellTwoPass(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): (PitchClass | null)[] {
    if (notes.length === 0) return [];
    const sorted = order(notes);
    const core = twoPassCore(sorted.notes, opts);
    return sorted.restore(core.spellings.map(toPc));
}

/** Diagnostic entry point for the visualiser. Shares the exact production resolver; adds per-note trace. */
export function spellTwoPassTraced(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): TwoPassTrace {
    if (notes.length === 0) return { spellings: [], notes: [], firstStable: null, lastStable: null };
    const sorted = order(notes);
    const core = twoPassCore(sorted.notes, opts);
    const spellings = sorted.restore(core.spellings.map(toPc));
    const noteTraces: TwoPassNoteTrace[] = core.spellings.map((sp, k) => ({
        forward: toPc(core.forward[k]), backward: toPc(core.backward[k]),
        selected: toPc(sp), agrees: core.agrees[k]!,
    }));
    return {
        spellings,
        notes: sorted.restore(noteTraces),
        firstStable: core.firstStable < core.spellings.length ? core.firstStable : null,
        lastStable: core.lastStable >= 0 ? core.lastStable : null,
    };
}
