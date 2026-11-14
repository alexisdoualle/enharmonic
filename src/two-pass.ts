/**
 * Two-pass batch speller: the offline, highest-accuracy entry point (whole piece in hand).
 *
 * A streaming speller switches enharmonic side LATE at a modulation boundary (it sees only the past),
 * so a section's opening lags on the previous side. With the whole piece available we do better: run the
 * engine FORWARD and again over the time-REVERSED note stream (so it lags the OTHER way, early not late),
 * then reconcile the two:
 *
 *   - where forward and backward AGREE, keep it (the reliable majority);
 *   - each pass is COLD at its entry end (forward at the start, backward at the end): before the first
 *     agreement trust the backward (warm) pass, after the last trust the forward;
 *   - each contiguous DISAGREEMENT run is one boundary lag → place a single change-point (forward before
 *     it, backward after) minimising local WOLF-cost (|ΔLoF| ≥ 6 intervals, a dim4/aug2 misspelling
 *     tell; pairs inside a diminished seventh are skipped). A COHERENT flip makes no wolves, so every
 *     change-point ties at 0; break that tie toward the side nearer the piece's committed line-of-fifths
 *     CENTRE (an emergent statistic, never a detected key). An augmented sixth whose tones move outward
 *     is the chord's point, not a wolf.
 *
 * Both passes are the shipped engine at its two-pass preset (letter look-ahead plus vertical guard, over
 * the accidental-economy fold). Both read each note's local key (the theory table on ±12 onsets centred on
 * the note, {@link localKeys}) for the leading-tone gate, and the key-degree gate's key (the same table on ±12
 * notes, {@link degreeKeys}). The reconciliation is pure array logic. This is the
 * highest-accuracy tier; see the README for benchmark figures.
 */

import type { PitchClass } from './pitch.js';
import { resolveStep } from './kernel.js';
import { outwardPairs } from './aug6.js';
import { degreeKeys, localKeys, type LocalKey } from './key.js';
import { SpellingEngine, TP_PASS_PRESET, type Decision } from './engine.js';
import { lofOf, spellingOf } from './lof.js';
import { centredSideKeys } from './key-side.js';

export interface TwoPassNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

export interface TwoPassOptions {
    /**
     * How the backward pass handles look-ahead:
     *   `'forward'` (default): feed FORWARD-time resolution to the backward pass. Processing in reverse,
     *     the resolution target is already committed, so a leading tone is spelled from its real resolution.
     *   `'off'`: no look-ahead in the backward pass.
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
    /** Group notes starting within this many `t` units of an onset's first note into that onset, in both
     *  passes (the backward pass sees reversed note-offs as its onsets). Default 0 (exact `t`). */
    onsetTolerance?: number;
    /** Feed both passes the aug6 outward pairs ({@link outwardPairs}), so the engine's `aug6Outward` rule
     *  spells a converging augmented sixth's rising tone as the ♯4. Default `true`. */
    aug6Outward?: boolean;
    /** The aug6 pairs also meet when the two tones' first moves land on one onset (`outwardPairs`'s
     *  `firstMoveMeet`: a held or repeated German sixth resolving past the 8-onset window). Default `true`. */
    aug6FirstMoveMeet?: boolean;
    /** `outwardPairs`'s `chordMeet` for the passes: a unison meet pairs only if the meeting onset strikes at
     *  least this many notes. Default 0 (off): the look-ahead tier ships it at 3, but on two-pass its fixes
     *  were mostly wrong → flipped and it did not confirm on the fresh15 set. */
    aug6ChordMeet?: number;
    /** NO PASSAGE BOUNDARY INSIDE A REPEATED RUN. Where the passes disagree, the merge may not place its side
     *  change between two strikes of a repeated run (three or more strikes of one pitch, at most 16 onsets
     *  apart, over one bass pitch class) that lies inside the disagreement: the cut moves to the run's start or
     *  end. Confutatis m28: the bass repeats E♭ four times under C♭ and B♭; the forward pass reads the bar
     *  sharp, the backward pass flat, and the cut may no longer fall between the strikes (D♯ ×6 then E♭).
     *  Default `true`. */
    runBoundary?: boolean;
    /** NO TRIANGLE, NO SIDE BOUNDARY. A sonority with no major or minor triad in it (a diminished seventh, an
     *  augmented triad, a bare dyad, any other triangle-free set of two or more pitch classes) names its tones only
     *  relative to each other, so it cannot say where a passage changes side. Where the passes disagree over a run
     *  made at least half of such notes, the merge does not place a side boundary by them: each pitch class takes
     *  the spelling the surrounding notes give it (the last merged spelling before the run, the first agreed one
     *  after it, within 32 notes each way), and the wolf count decides only among change-points that keep them.
     *  If the context before and after the run spells some pitch class two ways, the rule abstains. A single pitch
     *  class is not a sonority (an arpeggiated triad is single notes) and does not trigger it. WTC II m68: B♯, F♯,
     *  A♯, G♯ in dyads and triangle-free three-note sets, the passes disagree, the notes around are sharp; the
     *  merge took the backward pass's C, G♭, B♭, A♭, the rule writes Bach's sharps. Default `true`. */
    triangleFreeContext?: boolean;
    /** In the merge's wolf-cost, an augmented sixth (ten fifths) whose sharper tone rises a semitone and whose
     *  flatter tone falls one (exact pitch) is not a wolf: the wedge is the chord's point, a resolution onto
     *  one pitch class, not a misspelling. Default `true`. */
    aug6Wedge?: boolean;
    /** Feed both passes each note's local key, so the engine's `leadingToneGate` keeps a falling leading tone
     *  of the key (C♯→C in D minor) instead of the look-ahead's letter step. The key is read with the
     *  `'tonic-triad'` table (a key is its tonic triad inside its seven-note collection; no fitted numbers) on
     *  ±12 onsets centred on the note ({@link localKeys}); the backward pass reads the same keys. Default
     *  `true`. */
    leadingToneGate?: boolean;
    /** Feed both passes each note's key-degree key ({@link degreeKeys}: the tonic-triad table on ±12 notes), so
     *  the engine's `keyDegreeGate` keeps a note's letter on a semitone move into a pitch outside the key.
     *  Default `true`. */
    keyDegreeGate?: boolean;
    /** KEY → SIDE. A passage is written on the side of its local key's conventional signature, so both passes
     *  count accidentals from that signature, not from C: each note's key is read offline on ±48 onsets centred
     *  on it ({@link centredSideKeys}, deepened along the spiral up to seven accidentals), and the passes'
     *  accidental-economy fold counts from its signature. A key with six or seven accidentals (the F♯/G♭ tie or
     *  a deepened key) is written either way and cannot choose: the pass counts from C there. Clair de lune
     *  m44–47 (D♭ major): the key reads A♭ / D♭ major, and the passes keep Debussy's G♭, D♭, E♭, A♭ instead of
     *  F♯, C♯, D♯, G♯. Counter-case for the six-accidental limit: Chopin Sonata 2/ii (E♭ minor, six flats)
     *  would come out in D♯ minor if its key chose the side. Default `true`. */
    keySide?: boolean;
}

/** One pass's engine state right after it committed a note (introspection / visualiser only). */
export interface TwoPassFrame {
    /** The 7-letter surface (`SpellingEngine.getResolvedScale`). */
    readonly surface: PitchClass[];
    /** The line-of-fifths centre the fold tests (`SpellingEngine.getFoldCentre`). */
    readonly foldCentre: number;
    /** The note's scoring trace (`SpellingEngine.decision`). */
    readonly decision: Decision | null;
}
/** One note's per-pass reconciliation trace (introspection / visualiser only). */
export interface TwoPassNoteTrace {
    readonly forward: PitchClass | null;
    readonly backward: PitchClass | null;
    readonly selected: PitchClass | null;
    readonly agrees: boolean;
    /** The pass the merge took this note from (forward where the passes agree). */
    readonly source: 'forward' | 'backward';
    /** That pass's engine state at this note. The backward pass ran on the time-reversed piece. */
    readonly frame: TwoPassFrame | null;
}
/** Full two-pass trace: the final spellings plus each note's forward/backward/selected reconciliation. */
export interface TwoPassTrace {
    readonly spellings: (PitchClass | null)[];
    readonly notes: TwoPassNoteTrace[];
    readonly firstStable: number | null;
    readonly lastStable: number | null;
}

// ── Direction helpers ─────────────────────────────────────────────────────────
// Spellings below are line-of-fifths positions (see lof.ts); {step, alter} only at the output.

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

/** Aug6 outward context per note, in a pass's note order: the partner's midi (undefined: none) and role. */
interface Outward { partner: (number | undefined)[]; role: number[] }

/** The leading-tone gate's key table and window in the two-pass tier. */
const TP_KEY_TABLE = 'tonic-triad', TP_KEY_RADIUS = 12;
/** `triangleFreeContext`: notes read on each side of a disagreement run for the context spellings. */
const CONTEXT_NOTES = 32;
/** `keySide`: the most accidentals a key signature may have and still choose the side. */
const KEY_SIDE_MAX_ACCIDENTALS = 5;

/** `keySide`: each note's signature for the passes (0 = count from C), null before any key is read. */
function sideSignatures(notes: readonly TwoPassNote[]): (number | null)[] {
    return centredSideKeys(notes).map(x => x === null ? null : Number.isNaN(x) || Math.abs(x) > KEY_SIDE_MAX_ACCIDENTALS ? 0 : x);
}

/** Drive one engine pass over notes in the given order; return one spelling (line-of-fifths position) per
 *  note (same order). Notes must be pre-sorted (onset asc, bass-first). Look-ahead uses `dirs` when supplied.
 *  With `frames`, also record the engine state right after each note-on (read-only, no effect on spellings). */
function drivePass(notes: readonly TwoPassNote[], dirs: number[] | null, exact: number[] | null, onsetTolerance = 0, frames?: TwoPassFrame[], outward?: Outward, keys?: (LocalKey | null)[], degKeys?: (LocalKey | null)[], signatures?: (number | null)[]): number[] {
    const s = new SpellingEngine(onsetTolerance ? { ...TP_PASS_PRESET, onsetTolerance } : TP_PASS_PRESET);
    // Event stream: releases before strikes at equal t; strikes bass-first.
    const evs: { t: number; on: boolean; i: number }[] = [];
    notes.forEach((n, i) => { evs.push({ t: n.tOn, on: true, i }); evs.push({ t: n.tOff, on: false, i }); });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || notes[a.i]!.midi - notes[b.i]!.midi);
    const out: number[] = new Array(notes.length);
    const pend = new Map<number, number[]>();   // midi → FIFO of note indices awaiting read-back at note-off
    for (const e of evs) {
        const midi = notes[e.i]!.midi;
        if (e.on) {
            const sig = signatures?.[e.i];
            if (sig !== undefined && sig !== null) s.setSignature(sig);
            s.noteOn(midi, e.t, dirs ? dirs[e.i]! : 0, exact ? exact[e.i]! : 0, outward?.partner[e.i], outward?.role[e.i] ?? 0, keys?.[e.i], degKeys?.[e.i]);
            (pend.get(midi) ?? pend.set(midi, []).get(midi)!).push(e.i);
            if (frames) frames[e.i] = { surface: s.getResolvedScale(), foldCentre: s.getFoldCentre(), decision: s.decision() };
        }
        // Read the note's committed spelling (before release); the engine counts note-ons per pitch and drops it only once its LAST overlapping
        // voice ends, so read-back never falls through and the vertical guard's ringing set stays correct.
        else { const q = pend.get(midi); if (q?.length) { out[q.shift()!] = lofOf(s.getSpelling(midi)!); } s.noteOff(midi, e.t); }
    }
    return out;
}

/**
 * Repeated runs, for the merge's no-boundary rule: three or more strikes of one MIDI pitch, consecutive strikes at
 * most 16 onsets apart, over one bass pitch class (the lowest note sounding at each strike). Returns every pair of
 * consecutive strikes [a, b] (indices into the sorted notes), sorted by a. A re-struck pitch is read as one voice.
 */
function runPairs(N: readonly TwoPassNote[]): [number, number][] {
    const n = N.length; const onsetIdx: number[] = []; let g = -1, lastT = -Infinity;
    for (let k = 0; k < n; k++) { if (N[k]!.tOn !== lastT) { g++; lastT = N[k]!.tOn; } onsetIdx.push(g); }
    const bass = N.map((x, k) => {
        let b = x.midi;
        for (let m = k - 1; m >= Math.max(0, k - 64); m--) if (N[m]!.tOff > x.tOn && N[m]!.midi < b) b = N[m]!.midi;
        for (let m = k + 1; m < Math.min(n, k + 64) && N[m]!.tOn === x.tOn; m++) if (N[m]!.midi < b) b = N[m]!.midi;
        return b % 12;
    });
    const byMidi = new Map<number, number[]>();
    N.forEach((x, k) => { const a = byMidi.get(x.midi) ?? []; if (!a.length || N[a[a.length - 1]!]!.tOn !== x.tOn) a.push(k); byMidi.set(x.midi, a); });
    const pairs: [number, number][] = [];
    for (const ks of byMidi.values()) {
        let cur: number[] = [];
        const flush = () => { if (cur.length >= 3) for (let q = 1; q < cur.length; q++) pairs.push([cur[q - 1]!, cur[q]!]); cur = []; };
        for (const k of ks) { if (cur.length) { const p = cur[cur.length - 1]!; if (onsetIdx[k]! - onsetIdx[p]! > 16 || bass[k] !== bass[p]) flush(); } cur.push(k); }
        flush();
    }
    return pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
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
    spellings: number[];              // in the SORTED (bass-first) order
    forward: number[];
    backward: number[];
    agrees: boolean[];
    forwardFrames?: TwoPassFrame[];
    backwardFrames?: TwoPassFrame[];
    firstStable: number;
    lastStable: number;
}

/**
 * The forward + time-reversed backward passes and their wolf-cost reconciliation, in the SORTED order.
 * Shared by {@link spellTwoPass} and {@link spellTwoPassTraced}; the public functions restore the caller's
 * note order around it.
 */
function twoPassCore(sortedNotes: readonly TwoPassNote[], opts: TwoPassOptions, traceFrames = false): CoreResult {
    const backwardLA = opts.backwardLookAhead ?? 'forward';
    const centreTiebreak = opts.centreTiebreak ?? true;
    const centreMargin = opts.centreMargin ?? 0;
    const wedge = opts.aug6Wedge ?? true;
    const N = sortedNotes;
    const n = N.length;
    if (n === 0) return { spellings: [], forward: [], backward: [], agrees: [], firstStable: 0, lastStable: -1 };

    const dirsF = resolveDirs(N);
    const exactF = resolveDirsExact(N);
    const fFrames: TwoPassFrame[] | undefined = traceFrames ? new Array(n) : undefined;
    const bFrames: TwoPassFrame[] | undefined = traceFrames ? new Array(n) : undefined;
    let outF: Outward | undefined;
    if (opts.aug6Outward ?? true) {
        const op = outwardPairs(N, undefined, { firstMoveMeet: opts.aug6FirstMoveMeet ?? true, chordMeet: opts.aug6ChordMeet ?? 0 });
        outF = { partner: op.partner.map(y => (y >= 0 ? N[y]!.midi : undefined)), role: op.role };
    }
    // The local keys are read in forward time on onsets centred on each note; the backward pass reads them too.
    const keysF = (opts.leadingToneGate ?? true) ? localKeys(N, { table: TP_KEY_TABLE, radius: TP_KEY_RADIUS }) : undefined;
    const degF = (opts.keyDegreeGate ?? true) ? degreeKeys(N) : undefined;
    const sigF = (opts.keySide ?? true) ? sideSignatures(N) : undefined;
    const fwd = drivePass(N, dirsF, exactF, opts.onsetTolerance ?? 0, fFrames, outF, keysF, degF, sigF);
    // Backward: TIME-REVERSE the stream so the engine genuinely processes latest-first. Flip each note's
    // [tOn,tOff] about the piece end T, and reverse the note order so it stays pre-sorted (onset asc).
    const T = Math.max(...N.map(x => x.tOff));
    const bNotes: TwoPassNote[] = N.map(x => ({ midi: x.midi, tOn: T - x.tOff, tOff: T - x.tOn })).reverse();
    // Backward look-ahead uses the note's FORWARD resolveDir: processing in reverse, the resolution target
    // is already committed. bNotes[k] = original n-1-k.
    const bDirs = backwardLA === 'off' ? null : dirsF.slice().reverse();
    // The aug6 pairs are found in forward time (the resolution is what follows); the backward pass reads them too.
    const outB: Outward | undefined = outF && { partner: outF.partner.slice().reverse(), role: outF.role.slice().reverse() };
    const bOut = drivePass(bNotes, backwardLA !== 'off' ? bDirs : null, backwardLA !== 'off' ? exactF.slice().reverse() : null, opts.onsetTolerance ?? 0, bFrames, outB, keysF?.slice().reverse(), degF?.slice().reverse(), sigF?.slice().reverse());
    const bwd: number[] = new Array(n);
    for (let k = 0; k < n; k++) bwd[n - 1 - k] = bOut[k]!;
    if (bFrames) bFrames.reverse();

    const out: number[] = new Array(n);
    const agree = (i: number) => fwd[i] === bwd[i];
    // Cold-end handling: before the first agreement trust the backward (warm) pass; after the last, forward.
    let firstAgree = 0; while (firstAgree < n && !agree(firstAgree)) firstAgree++;
    let lastAgree = n - 1; while (lastAgree >= 0 && !agree(lastAgree)) lastAgree--;
    for (let i = 0; i < firstAgree; i++) out[i] = bwd[i]!;
    for (let i = lastAgree + 1; i < n; i++) out[i] = fwd[i]!;

    // A frameless SIDE PRIOR for breaking wolf-cost ties: the median LoF of the passes' AGREED notes (the
    // reliable majority), an emergent statistic, not a detected key. Whole-piece median (deliberately not
    // windowed: a local centre is dragged by nearby agreed-but-wrong runs).
    const agreedLofs: number[] = [];
    for (let t = 0; t < n; t++) if (agree(t)) agreedLofs.push(fwd[t]!);
    agreedLofs.sort((a, b) => a - b);
    const centre = agreedLofs.length ? agreedLofs[agreedLofs.length >> 1]! : 0;

    // A diminished seventh has a wolf in every spelling, so its pairs say nothing about the side. Skip a
    // neighbour pair when both notes sit in a full dim7 of the pitch classes sounding during either note,
    // or in three of its four when nothing else sounds (an arpeggiated dim7 between its bass notes).
    const sounding: Set<number>[] = N.map((x, k) => {
        const s = new Set<number>([x.midi % 12]);
        for (let m = k - 1; m >= Math.max(0, k - 64); m--) if (N[m]!.tOff > x.tOn) s.add(N[m]!.midi % 12);
        for (let m = k + 1; m < Math.min(n, k + 64) && N[m]!.tOn < x.tOff; m++) s.add(N[m]!.midi % 12);
        return s;
    });
    const inDim7 = (a: number, b: number): boolean => {
        const pa = N[a]!.midi % 12, pb = N[b]!.midi % 12;
        if (pa === pb || (pb - pa + 12) % 3 !== 0) return false;
        const has = (pc: number) => sounding[a]!.has(pc) || sounding[b]!.has(pc);
        const held = [3, 6, 9].filter(d => has((pa + d) % 12)).length;
        if (held === 3) return true;
        if (held < 2) return false;
        for (const q of sounding[a]!) if ((q - pa + 12) % 3 !== 0) return false;
        for (const q of sounding[b]!) if ((q - pa + 12) % 3 !== 0) return false;
        return true;
    };

    // NO TRIANGLE, NO SIDE BOUNDARY (see `triangleFreeContext`). A note is triangle-free when the pitch classes
    // sounding during it hold no major or minor triad and it is not a lone pitch class (a single pc inside a dim7
    // pair still counts: the dim7 is the sonority).
    const pcOf = (t: number) => ((N[t]!.midi % 12) + 12) % 12;
    const hasTriad = (s: Set<number>) => { for (const r of s) if (s.has((r + 7) % 12) && (s.has((r + 4) % 12) || s.has((r + 3) % 12))) return true; return false; };
    const dim7Note = (t: number) => (t > 0 && inDim7(t - 1, t)) || (t + 1 < n && inDim7(t, t + 1));
    const triFree: boolean[] = (opts.triangleFreeContext ?? true)
        ? N.map((_, t) => !hasTriad(sounding[t]!) && (sounding[t]!.size >= 2 || dim7Note(t))) : [];
    const runs = (opts.runBoundary ?? true) ? runPairs(N) : [];
    let runAt = 0;   // runs[] sorted by first strike; disagreement runs only move forward
    let i = Math.max(0, firstAgree);
    while (i <= lastAgree) {
        if (agree(i)) { out[i] = fwd[i]!; i++; continue; }
        let j = i; while (j <= lastAgree && !agree(j)) j++;      // disagreement run [i, j)
        // Try every change-point k in [i, j]: forward for [i,k), backward for [k,j). Score by wolves in the
        // bracketed window [i-1, j]. Wolf-cost LOCATES an incoherent lag boundary; a COHERENT flip makes no
        // wolves so every k ties, broken by the SIDE-CENTRE, then by WARMTH (forward late, backward early).
        const late = (i + j) / 2 >= n / 2;
        const pickFor = (k: number) => (t: number): number | undefined => t < i ? out[t] : t >= j ? fwd[t] : (t < k ? fwd[t] : bwd[t]);
        const costOf = (k: number): number => {
            const pick = pickFor(k); let cost = 0;
            for (let t = Math.max(1, i); t <= Math.min(n - 1, j); t++) {
                if (inDim7(t - 1, t)) continue;
                const a = pick(t - 1), b = pick(t);
                if (a !== undefined && b !== undefined && Math.abs(a - b) >= 6) {
                    // The aug6 WEDGE: ten fifths, the sharper tone rising and the flatter falling a semitone.
                    if (wedge && Math.abs(a - b) === 10) {
                        const hi = a > b ? t - 1 : t, lo = a > b ? t : t - 1;
                        if (exactF[hi] === 1 && exactF[lo] === -1) continue;
                    }
                    cost++;
                }
            }
            return cost;
        };
        // NO BOUNDARY INSIDE A REPEATED RUN: the run pairs with both strikes in [i, j). A change-point that splits
        // one costs more than any wolf count in the window, so the cut lands before or after the run.
        while (runAt < runs.length && runs[runAt]![0] < i) runAt++;
        const inner: [number, number][] = [];
        for (let r = runAt; r < runs.length && runs[r]![0] < j; r++) if (runs[r]![1] < j) inner.push(runs[r]!);
        const breaksOf = (k: number): number => { const pick = pickFor(k); let c = 0; for (const [a, b] of inner) if (pick(a) !== pick(b)) c++; return c; };
        const W = j - i + 2;
        const cost: number[] = []; let minCost = Infinity;
        for (let k = i; k <= j; k++) { cost[k - i] = (inner.length ? breaksOf(k) * W : 0) + costOf(k); if (cost[k - i]! < minCost) minCost = cost[k - i]!; }
        // A run made mostly of triangle-free notes: each context spelling (before, after) that a change-point
        // contradicts costs more than any wolf count.
        let free = 0; if (triFree.length) for (let t = i; t < j; t++) if (triFree[t]) free++;
        if (triFree.length && free >= (j - i) / 2) {
            const ctx = new Map<number, number[]>();
            for (let t = i - 1, c = 0; t >= 0 && c < CONTEXT_NOTES; t--) {
                if (out[t] === undefined) continue;
                c++; if (!ctx.has(pcOf(t))) ctx.set(pcOf(t), [out[t]!]);
            }
            const after = new Map<number, number>();
            for (let t = j, c = 0; t < n && c < CONTEXT_NOTES; t++) {
                if (!agree(t)) continue;
                c++; if (!after.has(pcOf(t))) after.set(pcOf(t), fwd[t]!);
            }
            let split = false;
            for (const [pc, v] of after) { const a = ctx.get(pc); if (a) { if (a[0] !== v) split = true; a.push(v); } else ctx.set(pc, [v]); }
            if (split) ctx.clear();
            if (ctx.size) {
                minCost = Infinity;
                for (let k = i; k <= j; k++) {
                    const pick = pickFor(k); let conflicts = 0;
                    for (let t = i; t < j; t++) for (const v of ctx.get(pcOf(t)) ?? []) if (v !== pick(t)) conflicts++;
                    cost[k - i] = cost[k - i]! + conflicts * 1e6; if (cost[k - i]! < minCost) minCost = cost[k - i]!;
                }
            }
        }
        let bestK = i, bestPref = -Infinity, bestWarm = -Infinity;
        for (let k = i; k <= j; k++) {
            if (cost[k - i]! > minCost + centreMargin) continue;
            const pick = pickFor(k);
            let dist = 0; for (let t = i; t < j; t++) dist += Math.abs(pick(t)! - centre);
            const pref = centreTiebreak ? -(dist + cost[k - i]!) : -cost[k - i]!;
            const warm = late ? k : -k;
            if (pref > bestPref || (pref === bestPref && warm > bestWarm)) { bestK = k; bestPref = pref; bestWarm = warm; }
        }
        for (let t = i; t < j; t++) out[t] = t < bestK ? fwd[t]! : bwd[t]!;
        i = j;
    }

    // HONOR-RESOLUTION. The wolf-cost merge reconciles the SIDE and can discard a note the forward pass
    // spelled from a real resolution (a sharp leading tone the merge flattened). A confirmed exact-midi
    // UP-resolver is dispositive: keep the forward pick where it is SHARPER than the merged pick, guarded
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
        const vWolf = (cand: number, k: number): number => {
            let w = 0;
            for (const jj of sameOnset.get(N[k]!.tOn)!) {
                const p = out[jj]; if (jj === k || p === undefined) continue;
                if (pc(jj) === pc(k)) continue;               // octave doubling: one sounding pc, not a clash
                if (Math.abs(cand - p) >= 7) w++;
            }
            return w;
        };
        for (let idx = 0; idx < n; idx++) {
            const cur = out[idx], f = fwd[idx]!;
            if (dirsX[idx] === 1 && cur !== undefined && f > cur && (vWolf(f, idx) <= vWolf(cur, idx) || inFullDim7(idx)))
                out[idx] = f;
        }
    }

    const agrees = new Array<boolean>(n);
    for (let t = 0; t < n; t++) agrees[t] = agree(t);
    return {
        spellings: out, forward: fwd, backward: bwd, agrees,
        ...(fFrames && bFrames ? { forwardFrames: fFrames, backwardFrames: bFrames } : {}),
        firstStable: firstAgree < n ? firstAgree : n,
        lastStable: lastAgree,
    };
}

/** A line-of-fifths position as a PitchClass (the two-pass output shape). */
const toPc = (n: number | undefined): PitchClass | null => n === undefined ? null : spellingOf(n);

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
    const core = twoPassCore(sorted.notes, opts, true);
    const spellings = sorted.restore(core.spellings.map(toPc));
    const noteTraces: TwoPassNoteTrace[] = core.spellings.map((sp, k) => {
        const source = sp === core.forward[k] ? 'forward' : 'backward';
        return {
            forward: toPc(core.forward[k]), backward: toPc(core.backward[k]),
            selected: toPc(sp), agrees: core.agrees[k]!, source,
            frame: (source === 'forward' ? core.forwardFrames : core.backwardFrames)?.[k] ?? null,
        };
    });
    return {
        spellings,
        notes: sorted.restore(noteTraces),
        firstStable: core.firstStable < core.spellings.length ? core.firstStable : null,
        lastStable: core.lastStable >= 0 ? core.lastStable : null,
    };
}
