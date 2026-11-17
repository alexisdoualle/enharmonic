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
 * Both passes are the look-ahead speller (`LA_PRESET`) with its full context ({@link lookAheadContext}, read in
 * forward time; the backward pass reads it reversed), a side key read on the onsets centred on each note, and
 * `keySignature` at each notated key change. Two readings in opposite directions, merged, beat either one: each
 * pass alone has more wrong notes than the streaming look-ahead, the merge fewer. The reconciliation is pure array
 * logic. This is the highest-accuracy tier; see the README for benchmark figures.
 */

import type { PitchClass } from './pitch.js';
import { groupOnsets } from './onsets.js';
import { SpellingEngine, LA_PRESET, type Decision } from './engine.js';
import { lookAheadContext } from './look-ahead.js';
import type { NoteContext } from './kernel.js';
import { lofOf, spellingOf } from './lof.js';
import { anchoredSideKeys, centredKeys, CENTRED_SIDE_RADIUS, deepenCentredKeys } from './key-side.js';

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
    /** Feed both passes the aug6 outward pairs (`outwardPairs`, as the look-ahead reads them), so the engine's
     *  `aug6Outward` rule spells a converging augmented sixth's rising tone as the ♯4. Default `true`. */
    aug6Outward?: boolean;
    /** NO PASSAGE BOUNDARY INSIDE A REPEATED RUN. Where the passes disagree, the merge may not place its side
     *  change between two strikes of a repeated run (three or more strikes of one pitch, at most 16 onsets
     *  apart, over one bass pitch class) that lies inside the disagreement: the cut moves to the run's start or
     *  end. Confutatis m28: the bass repeats E♭ four times under C♭ and B♭; the forward pass reads the bar
     *  sharp, the backward pass flat, and the cut may no longer fall between the strikes (D♯ ×6 then E♭).
     *  Default `true`. */
    runBoundary?: boolean;
    /** A HAMMERED NOTE KEEPS ITS NAME WHEN THE HARMONY GIVES NO REASON TO CHANGE IT. After the merge, a repeated
     *  run (three or more onsets striking one MIDI pitch, consecutive strikes at most 4 onsets apart) whose
     *  strikes carry two names gives a block of minority strikes the run's majority name, if (a) one name holds a
     *  strict majority, (b) no other pitch class carries two names inside the run's span, and (c) the harmony did
     *  not change under the block: every pitch class SOUNDING (struck, or still held) from the block's first
     *  strike to the next run strike also sounds in the neighbouring majority strikes' spans. Only the run's own
     *  strikes change. A respell in time costs a diminished second in every voice that carries the note across,
     *  so with no new harmony to pay for it the name stays: a hammered E♭ over a held chord does not turn D♯ for
     *  two strikes. A composer's respell over a moving chord is kept (Liszt, Bruckner, Shostakovich Op. 110
     *  m59); the known miss is a pivot over an unchanged chord (Beethoven Op. 7/ii m50). Mid-run respells −19%
     *  on DCML, −28% on sealed fresh19 with wrong neutral; Meredith clean wrong 145 → 131. Default `true`. */
    runRepair?: boolean;
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
    /** Feed both passes each note's local key (`localKeys`, as the look-ahead reads it), so the engine's
     *  `leadingToneGate` keeps a falling leading tone of the key (C♯→C in D minor) instead of the look-ahead's
     *  letter step. Default `true`. */
    leadingToneGate?: boolean;
    /** Feed both passes each note's key-degree key (`degreeKeys`), so the engine's `keyDegreeGate` keeps a note's
     *  letter on a semitone move into a pitch outside the key. Default `true`. */
    keyDegreeGate?: boolean;
    /** KEY → SIDE. Both passes get each note's side key read offline on ±48 onsets centred on it
     *  ({@link centredSideKeys}, deepened along the spiral), in place of the look-ahead's own side key. A key past
     *  five accidentals gives none and the previous side holds: going round the spiral from A♭ major (−4), C♭ major
     *  (−7) is nearer than B major (+5), so a sharp-key passage reads as its flat twin (the E-major pages of
     *  Chopin's Prelude Op. 28 No. 17 as F♭; the Pathétique Adagio goes from 10 wrong / 0 flipped to 66 / 77
     *  without the limit). Default `true`; off, the passes read no side key. */
    keySide?: boolean;
    /** A KEY KEEPS ITS SIDE ON RETURN (`keySide`'s key reader). A key written on the near side only because its far
     *  reading is past the ±7 deepening limit is a readability respell; when the music returns to the key it came
     *  from, that key keeps its prior side. A parallel, or the parallel of the relative, of the forced key or of the
     *  key just before is never a return, and such a candidate disarms the pending return. Pathétique ii: A♭ minor
     *  (−7) → F♭ major, forced to E major (+4) → A♭ minor at m48, read −7 again instead of G♯ minor (+5), so the
     *  passes read no side key there and m48–52 come back to A♭ and C♭ instead of a late boundary. Counter-case: an
     *  over-deepened prior key (Troschel *Walec oryginalny*: D♭ already read as C♯ at +7, then A♭ folded back) is
     *  restored on the far side. Default `true`; inert when `keySide` is off. */
    keyReturn?: boolean;
    /** A STRUCK TRIAD SPELLS ITS THIRD MEMBER. After the merge, where the three pitch classes of a major or minor
     *  triad are attacked together at a note's onset and the other two members are spelled coherently with each
     *  other (one spelling each), a note a comma off the triad (a diminished fourth or augmented second inside it)
     *  takes the spelling that completes it, but only toward the local merged centre (median of the ±16 notes
     *  around it), and not when the note is a third that moves a semitone onto the other third of the same root
     *  (an appoggiatura: G♯→A over F–C). One shot: nothing it writes feeds another decision. Mozart K. 459/iii,
     *  F minor, A♭–C–F struck together: the merge wrote G♯ (G♯–C, a dim4), the rule writes Mozart's A♭.
     *  Counter-case: a chromatic line tone the composer writes inside a struck triad (Joplin *Chrysanthemum*
     *  m18, C♯ rising to D against G♭–B♭) is respelt D♭. Default `true`. */
    struckTriadThird?: boolean;
    /** Each input note's NOTATED key signature, in the caller's order: signed sharps − flats (0 = none, −6 = six
     *  flats; the relative major's tonic on the line of fifths), null where unknown. Optional. Each pass calls
     *  `keySignature` where it changes (in its own direction), and `keySignatureAnchor` reads it. Must have one
     *  entry per note. */
    keySignatures?: readonly (number | null)[];
    /** THE SIGNATURE ANCHORS THE SIDE (`keySide`, with `keySignatures`). A passage is notated on the side of its key
     *  signature while its local key stays within one fifth of it (on the line of fifths, past seven accidentals
     *  too: G♯ major under seven sharps): there the passes' side key is the notated signature; farther, it is the
     *  inferred key, as without signatures ({@link anchoredSideKeys}). Without it a centred key read across a
     *  join between pieces overrides the notation (WTC I No. 18, G♯ minor after No. 17 in A♭ major, came out in A♭
     *  minor). Chopin Sonata 2/ii (E♭ minor, six flats): the signature settles the F♯/G♭ tie
     *  the inferred key cannot, and m114–179 keep Chopin's D♭, C♭, G♭ instead of C♯, B, F♯. Counter-case
     *  guarded: *Pathétique* ii m42–49 (E major under four flats) is four fifths away and keeps the inferred
     *  sharps. Default `true`; inert without `keySignatures` or when `keySide` is off. */
    keySignatureAnchor?: boolean;
    /** A SHORT RESPELLED SECTION TAKES THE SURROUNDING SIDE. A composer respells a passage for a section, never for a
     *  few beats: in the merge, a disagreement region of at most {@link SHORT_FLIP_MAX_ONSETS} onsets and at least
     *  {@link SHORT_FLIP_MIN_PCS} pitch classes, whose merged spelling contradicts the spelling of the same pitch
     *  classes just before and just after it (the two contexts agreeing with each other), takes whole the pass whose
     *  spelling the surroundings use, when that pass contradicts them less than the merge does. Meredith clean (216
     *  movements): the two-pass merge left short off-side islands inside agreeing context (46 flipped notes), all
     *  undone. Counter-case: a composer's own short respell is undone too (Chopin *Barcarolle* m23–24). Default
     *  `true`. */
    shortFlip?: boolean;
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

/** `triangleFreeContext`: notes read on each side of a disagreement run for the context spellings. */
const CONTEXT_NOTES = 32;
/** `shortFlip`: the longest region (in onsets) that counts as short — the scorer's flip window is ±16 onsets, so a
 *  respell shorter than 32 onsets is never a section; and the fewest pitch classes it must hold — with one or two
 *  (a held or repeated note) the rule becomes a memory rule on held notes and loses. */
const SHORT_FLIP_MAX_ONSETS = 32, SHORT_FLIP_MIN_PCS = 3;
/** `keySide`: the most accidentals a centred key may have and still give the side. */
const KEY_SIDE_MAX_ACCIDENTALS = 5;
/** `struckTriadThird`: notes read on each side for the co-sounding members, the merged centre, and onsets scanned
 *  for an appoggiatura's resolution. */
const TRIAD_SCAN = 64, TRIAD_CENTRE_RADIUS = 16, TRIAD_APP_ONSETS = 8;
/** `struckTriadThird`: major and minor triads as [semitones, fifths] above the root. */
const TRIADS: readonly (readonly [number, number])[][] = [[[0, 0], [4, 4], [7, 1]], [[0, 0], [3, -3], [7, 1]]];

/** `struckTriadThird`: the [note, spelling] repairs over the merged spellings `out` (sorted order). */
function struckTriadRepairs(N: readonly TwoPassNote[], out: readonly (number | undefined)[], sounding: readonly Set<number>[]): [number, number][] {
    const n = N.length;
    const pcOf = (t: number) => ((N[t]!.midi % 12) + 12) % 12;
    const fix: [number, number][] = [];
    for (let t = 0; t < n; t++) {
        const o = out[t]; if (o === undefined) continue;
        const pc = pcOf(t), S = sounding[t]!, lo = Math.max(0, t - TRIAD_SCAN), hi = Math.min(n, t + TRIAD_SCAN);
        // The spellings of each pitch class among the notes overlapping this one.
        const co = new Map<number, Set<number>>();
        for (let k = lo; k < hi; k++) {
            if (k === t || out[k] === undefined || !(N[k]!.tOn < N[t]!.tOff && N[k]!.tOff > N[t]!.tOn)) continue;
            const q = pcOf(k); (co.get(q) ?? co.set(q, new Set()).get(q)!).add(out[k]!);
        }
        const struck = (q: number) => { for (let k = lo; k < hi; k++) if (k !== t && N[k]!.tOn === N[t]!.tOn && pcOf(k) === q) return true; return false; };
        let want: number | null = null, clash = false;
        for (const tpl of TRIADS) for (const [ms, mf] of tpl) {
            const r = (pc - ms + 12) % 12;
            const others = tpl.filter(([s2]) => s2 !== ms);
            if (!others.every(([s2]) => S.has((r + s2) % 12) && co.get((r + s2) % 12)?.size === 1)) continue;
            if (!others.every(([s2]) => struck((r + s2) % 12))) continue;
            // An appoggiatura: a third moving a semitone onto the OTHER third of the same root (G♯→A over F–C).
            if (ms === 3 || ms === 4) {
                const alt = (r + (ms === 3 ? 4 : 3)) % 12, dm = ms === 3 ? 1 : -1;
                let seen = 0, lastOn = N[t]!.tOn, hit = false;
                for (let k = t + 1; k < n && seen < TRIAD_APP_ONSETS; k++) {
                    if (N[k]!.tOn !== lastOn) { seen++; lastOn = N[k]!.tOn; }
                    if (N[k]!.tOn > N[t]!.tOn && N[k]!.midi === N[t]!.midi + dm && pcOf(k) === alt) { hit = true; break; }
                }
                if (hit) continue;
            }
            const roots = others.map(([s2, f2]) => [...co.get((r + s2) % 12)!][0]! - f2);
            if (roots[0] !== roots[1]) continue;              // the other two members are not coherent
            const w = roots[0]! + mf;
            if (want !== null && want !== w) clash = true; else want = w;
        }
        if (clash || want === null || want === o || Math.abs(want - o) !== 12) continue;
        // Only toward the local merged centre.
        const loc: number[] = [];
        for (let k = Math.max(0, t - TRIAD_CENTRE_RADIUS); k <= Math.min(n - 1, t + TRIAD_CENTRE_RADIUS); k++) if (k !== t && out[k] !== undefined) loc.push(out[k]!);
        loc.sort((a, b) => a - b);
        const cen = loc.length ? loc[loc.length >> 1]! : 0;
        if (Math.abs(want - cen) >= Math.abs(o - cen)) continue;
        fix.push([t, want]);
    }
    return fix;
}

/** `keySignatures` in sorted order (undefined when not given). */
function notatedSignatures(sorted: { permute<T>(xs: readonly T[]): T[] }, n: number, opts: TwoPassOptions): (number | null)[] | undefined {
    const ks = opts.keySignatures;
    if (!ks) return undefined;
    if (ks.length !== n) throw new RangeError(`keySignatures has ${ks.length} entries for ${n} notes`);
    return sorted.permute(ks);
}

/** Drive one look-ahead pass over notes in the given order; return one spelling (line-of-fifths position) per
 *  note (same order). Notes must be pre-sorted (onset asc, bass-first). `ctx` is each note's context, `keyed` each
 *  note's notated signature: the pass calls `keySignature` where it changes, in pass order. With `frames`, also
 *  record the engine state right after each note-on (read-only, no effect on spellings). */
function drivePass(notes: readonly TwoPassNote[], ctx: readonly NoteContext[], onsetTolerance = 0, frames?: TwoPassFrame[], keyed?: readonly (number | null)[]): number[] {
    const s = new SpellingEngine(onsetTolerance ? { ...LA_PRESET, onsetTolerance } : LA_PRESET);
    // Event stream: releases before strikes at equal t; strikes bass-first.
    const evs: { t: number; on: boolean; i: number }[] = [];
    notes.forEach((n, i) => { evs.push({ t: n.tOn, on: true, i }); evs.push({ t: n.tOff, on: false, i }); });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || notes[a.i]!.midi - notes[b.i]!.midi);
    const out: number[] = new Array(notes.length);
    const pend = new Map<number, number[]>();   // midi → FIFO of note indices awaiting read-back at note-off
    let key: number | null = null;
    for (const e of evs) {
        const midi = notes[e.i]!.midi;
        if (e.on) {
            const k = keyed?.[e.i] ?? null;
            if (k !== null && k !== key) { s.keySignature(k); key = k; }
            s.noteOn(midi, { ...ctx[e.i], t: e.t });
            (pend.get(midi) ?? pend.set(midi, []).get(midi)!).push(e.i);
            if (frames) frames[e.i] = { surface: s.getResolvedScale(), foldCentre: s.getFoldCentre(), decision: s.decision() };
        }
        // Read the note's committed spelling (before release); the engine counts note-ons per pitch and drops it only once its LAST overlapping
        // voice ends, so read-back never falls through and the vertical guard's ringing set stays correct.
        else { const q = pend.get(midi); if (q?.length) { out[q.shift()!] = lofOf(s.getSpelling(midi)!); } s.noteOff(midi, e.t); }
    }
    return out;
}

/** `keySide`: each note's side key for both passes (sorted order). The key read on the onsets centred on the note
 *  ({@link centredKeys}), deepened along the spiral forward and backward in time. Where the two readings differ, a key
 *  on the piece's opening tonic takes the reading nearer the opening side (the tonic keeps its name: Pathétique ii's
 *  A♭ minor, Chopin Op. 28/15's return to D♭), any other key the reading with fewer accidentals (Op. 109's B-major
 *  section, not C♭); equal, none. Past ±5 accidentals, none (the previous side holds). With `keySignatureAnchor` and
 *  notated signatures, a note under a signature keeps the forward reading and is anchored to the signature where
 *  its local key is within one fifth of it ({@link anchoredSideKeys}): the notation decides. */
function passSideKeys(notes: readonly TwoPassNote[], opts: TwoPassOptions, notated?: readonly (number | null)[]): (number | null)[] {
    const keys = centredKeys(notes, CENTRED_SIDE_RADIUS), keyReturn = opts.keyReturn ?? true;
    const fwd = deepenCentredKeys(keys, keyReturn), bwd = deepenCentredKeys(keys.slice().reverse(), keyReturn).reverse();
    const known = (x: number | null | undefined): x is number => x !== null && x !== undefined && !Number.isNaN(x);
    const h = fwd.findIndex(known);
    const home = h >= 0 ? { x: fwd[h]!, tonic: keys[h]!.tonic } : null;
    const side = fwd.map((f, i) => {
        const b = bwd[i];
        let x: number | null = f;
        if (!(notated && notated[i] !== null) && known(f) && known(b) && f !== b) {
            if (home && keys[i]!.tonic === home.tonic) x = Math.abs(f - home.x) <= Math.abs(b - home.x) ? f : b;
            else x = Math.abs(f) < Math.abs(b) ? f : Math.abs(b) < Math.abs(f) ? b : null;
        } else if (!known(f) && known(b) && !(notated && notated[i] !== null)) x = b;
        return x === null || Number.isNaN(x) || Math.abs(x) > KEY_SIDE_MAX_ACCIDENTALS ? null : x;
    });
    return notated && (opts.keySignatureAnchor ?? true) ? anchoredSideKeys(notes, notated, side, CENTRED_SIDE_RADIUS, keys) : side;
}

/**
 * Repeated runs, for the merge's no-boundary rule: three or more strikes of one MIDI pitch, consecutive strikes at
 * most 16 onsets apart, over one bass pitch class (the lowest note sounding at each strike). Returns every pair of
 * consecutive strikes [a, b] (indices into the sorted notes), sorted by a. A re-struck pitch is read as one voice.
 */
function runPairs(N: readonly TwoPassNote[]): [number, number][] {
    const n = N.length, onsetIdx = groupOnsets(N).of;
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

/** `runRepair` (see `TwoPassOptions.runRepair`): rename flickering strikes of a repeated run, in place. All
 *  judgements read the merged spellings as they stand before any repair. */
function runRepair(N: readonly TwoPassNote[], out: (number | undefined)[]): void {
    const n = N.length;
    const pcOf = (t: number) => ((N[t]!.midi % 12) + 12) % 12;
    const onsetIdx = groupOnsets(N).of;
    const byMidi = new Map<number, number[]>();
    N.forEach((x, k) => { (byMidi.get(x.midi) ?? byMidi.set(x.midi, []).get(x.midi)!).push(k); });
    const fixes: [number, number][] = [];

    // One run = strikes (each strike = its same-onset unisons) of one MIDI pitch.
    const judge = (run: number[][]): void => {
        if (run.length < 3) return;
        const pc0 = pcOf(run[0]![0]!);
        const notes = run.flat().filter(t => out[t] !== undefined);
        const cnt = new Map<number, number>();
        for (const t of notes) cnt.set(out[t]!, (cnt.get(out[t]!) ?? 0) + 1);
        if (cnt.size < 2) return;
        const srt = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
        if (srt[0]![1] <= srt[1]![1]) return;                         // no strict majority
        const maj = srt[0]![0];
        // Another pitch class renamed inside the span: the passage moves, the respell is not the run's own.
        const lo = run[0]![0]!, last = run[run.length - 1]!, hi = last[last.length - 1]!;
        const names = new Map<number, number>();
        for (let t = lo; t <= hi; t++) {
            if (pcOf(t) === pc0 || out[t] === undefined) continue;
            const v = names.get(pcOf(t));
            if (v === undefined) names.set(pcOf(t), out[t]!); else if (v !== out[t]) return;
        }
        const isMaj = (s: number) => run[s]!.every(t => out[t] === undefined || out[t] === maj);
        const tStart = (s: number) => N[run[s]![0]!]!.tOn;
        const tEnd = (s: number) => s + 1 < run.length ? tStart(s + 1) : Math.max(...run[s]!.map(t => N[t]!.tOff));
        // Pitch classes other than the run's sounding in [t0, t1): struck in it, or held into it (128 notes back).
        const sounding = (t0: number, t1: number) => {
            const set = new Set<number>();
            let k = lo; while (k > 0 && N[k - 1]!.tOn >= t0) k--;
            for (let m = Math.max(0, k - 128); m < k; m++) if (N[m]!.tOff > t0 && pcOf(m) !== pc0) set.add(pcOf(m));
            for (; k < n && N[k]!.tOn < t1; k++) if (N[k]!.tOff > t0 && pcOf(k) !== pc0) set.add(pcOf(k));
            return set;
        };
        for (let s = 0; s < run.length; s++) {
            if (isMaj(s)) continue;
            let e = s; while (e + 1 < run.length && !isMaj(e + 1)) e++;  // minority block [s, e]
            const M = sounding(tStart(s), tEnd(e));
            const A = new Set<number>();
            if (s > 0) for (const q of sounding(tStart(s - 1), tStart(s))) A.add(q);
            if (e + 1 < run.length) for (const q of sounding(tStart(e + 1), tEnd(e + 1))) A.add(q);
            if ([...M].every(q => A.has(q)))
                for (let b = s; b <= e; b++) for (const t of run[b]!) if (out[t] !== undefined && out[t] !== maj) fixes.push([t, maj]);
            s = e;
        }
    };

    for (const ks of byMidi.values()) {
        let run: number[][] = [];
        for (const k of ks) {
            const prev = run[run.length - 1];
            if (prev && N[prev[0]!]!.tOn === N[k]!.tOn) { prev.push(k); continue; }
            if (prev && onsetIdx[k]! - onsetIdx[prev[0]!]! > 4) { judge(run); run = []; }
            run.push([k]);
        }
        judge(run);
    }
    for (const [t, v] of fixes) out[t] = v;
}

/** Sort helper: notes bass-first (onset asc, midi asc), with a mapping back to the caller's order. */
function order(notes: readonly TwoPassNote[]) {
    const idx = notes.map((_, i) => i).sort((a, b) => notes[a]!.tOn - notes[b]!.tOn || notes[a]!.midi - notes[b]!.midi);
    const sorted = idx.map(i => notes[i]!);
    return {
        notes: sorted,
        permute<T>(xs: readonly T[]): T[] { return idx.map(i => xs[i]!); },
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
function twoPassCore(sortedNotes: readonly TwoPassNote[], opts: TwoPassOptions, traceFrames = false, notated?: readonly (number | null)[]): CoreResult {
    const backwardLA = opts.backwardLookAhead ?? 'forward';
    const centreTiebreak = opts.centreTiebreak ?? true;
    const centreMargin = opts.centreMargin ?? 0;
    const wedge = opts.aug6Wedge ?? true;
    const N = sortedNotes;
    const n = N.length;
    if (n === 0) return { spellings: [], forward: [], backward: [], agrees: [], firstStable: 0, lastStable: -1 };

    const fFrames: TwoPassFrame[] | undefined = traceFrames ? new Array(n) : undefined;
    const bFrames: TwoPassFrame[] | undefined = traceFrames ? new Array(n) : undefined;
    // Both passes read the look-ahead context in forward time (a resolution is what follows); the backward pass reads
    // it reversed. The side key is read centred on each note instead of the look-ahead's own.
    const exactF = resolveDirsExact(N);   // the merge's aug6 wedge
    const side = (opts.keySide ?? true) ? passSideKeys(N, opts, notated) : null;
    const aug6 = opts.aug6Outward ?? true, ltGate = opts.leadingToneGate ?? true, degGate = opts.keyDegreeGate ?? true;
    const ctxF: NoteContext[] = lookAheadContext(N).map(({ sideKey, outwardPartner, outwardRole, localKey, degreeKey, ...c }, i) => ({
        ...c,
        ...(aug6 && outwardPartner !== undefined ? { outwardPartner, outwardRole } : {}),
        ...(ltGate ? { localKey } : {}),
        ...(degGate ? { degreeKey } : {}),
        ...(side ? { sideKey: side[i]! } : {}),
    }));
    const fwd = drivePass(N, ctxF, opts.onsetTolerance ?? 0, fFrames, notated);
    // Backward: TIME-REVERSE the stream so the engine genuinely processes latest-first. Flip each note's
    // [tOn,tOff] about the piece end T, and reverse the note order so it stays pre-sorted (onset asc).
    const T = Math.max(...N.map(x => x.tOff));
    const bNotes: TwoPassNote[] = N.map(x => ({ midi: x.midi, tOn: T - x.tOff, tOff: T - x.tOn })).reverse();
    // Backward look-ahead uses the note's FORWARD resolution: processing in reverse, the resolution target is
    // already committed. bNotes[k] = original n-1-k.
    const ctxB = ctxF.slice().reverse().map(c => (backwardLA === 'off' ? { ...c, resolveDir: 0, resolveExact: 0 } : c));
    const bOut = drivePass(bNotes, ctxB, opts.onsetTolerance ?? 0, bFrames, notated?.slice().reverse());
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
    // A SHORT RESPELLED SECTION TAKES THE SURROUNDING SIDE (see `shortFlip`). Reads the context before [i, j) in the
    // merge and after it in the agreeing notes (the first spelling of each pitch class within CONTEXT_NOTES notes);
    // if no pitch class is spelled differently before and after, and the region is short and holds enough pitch
    // classes, the pass that contradicts the context less replaces the merge when the merge contradicts it more.
    const shortFlip = opts.shortFlip ?? true;
    const onsetOf = groupOnsets(N).of;
    const shortFlipRepair = (i: number, j: number): void => {
        const before = new Map<number, number>();
        for (let t = i - 1, c = 0; t >= 0 && c < CONTEXT_NOTES; t--) { if (out[t] === undefined) continue; c++; if (!before.has(pcOf(t))) before.set(pcOf(t), out[t]!); }
        const after = new Map<number, number>();
        for (let t = j, c = 0; t < n && c < CONTEXT_NOTES; t++) { if (!agree(t)) continue; c++; if (!after.has(pcOf(t))) after.set(pcOf(t), fwd[t]!); }
        for (const [pc, v] of after) { const b = before.get(pc); if (b !== undefined && b !== v) return; }
        const onsets = j > i ? onsetOf[j - 1]! - onsetOf[i]! + 1 : 0, pcs = new Set<number>();
        for (let t = i; t < j; t++) pcs.add(pcOf(t));
        if (onsets > SHORT_FLIP_MAX_ONSETS || pcs.size < SHORT_FLIP_MIN_PCS) return;
        const conflicts = (sp: (t: number) => number): number => {
            let c = 0;
            for (let t = i; t < j; t++) {
                const v = sp(t), b = before.get(pcOf(t)), a = after.get(pcOf(t));
                if (b !== undefined && b !== v) c++;
                if (a !== undefined && a !== v) c++;
            }
            return c;
        };
        const cF = conflicts(t => fwd[t]!), cB = conflicts(t => bwd[t]!), cO = conflicts(t => out[t]!);
        const pass = cF <= cB ? fwd : bwd;
        if (cO > Math.min(cF, cB)) for (let t = i; t < j; t++) out[t] = pass[t]!;
    };
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
        if (shortFlip) shortFlipRepair(i, j);
        i = j;
    }

    // A STRUCK TRIAD SPELLS ITS THIRD MEMBER (see `struckTriadThird`); all repairs read the merge, then apply.
    if (opts.struckTriadThird ?? true) for (const [t, w] of struckTriadRepairs(N, out, sounding)) out[t] = w;

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

    if (opts.runRepair ?? true) runRepair(N, out);

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
    const core = twoPassCore(sorted.notes, opts, false, notatedSignatures(sorted, notes.length, opts));
    return sorted.restore(core.spellings.map(toPc));
}

/** Diagnostic entry point for the visualiser. Shares the exact production resolver; adds per-note trace. */
export function spellTwoPassTraced(notes: readonly TwoPassNote[], opts: TwoPassOptions = {}): TwoPassTrace {
    if (notes.length === 0) return { spellings: [], notes: [], firstStable: null, lastStable: null };
    const sorted = order(notes);
    const core = twoPassCore(sorted.notes, opts, true, notatedSignatures(sorted, notes.length, opts));
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
