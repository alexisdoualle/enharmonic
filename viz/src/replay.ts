/**
 * Replay: drive the REAL shipped speller over a fixture and capture one snapshot per onset.
 *
 * Zero drift by construction — the streaming rungs build the exact kernel the public `Speller` builds
 * (via the internal `createDiatonicAnchor*` preset builders), and the batch rung calls the shipped
 * `spellTwoPass`. The viz never re-implements a spelling decision; it only reads what the kernel holds
 * (`kernel.snapshot()` → resolved surface + signed line-of-fifths tonic) plus each note's own committed
 * spelling (`getSpelling`). Key signatures in the fixture (`respell` events) are IGNORED, matching the
 * shipped no-keys presets the benchmark scores.
 */
import type { Pitch, PitchClass } from '../../src/index.js';
import { spellTwoPass } from '../../src/index.js';
import { SpellerKernel } from '../../src/kernel.js';
import { DiatonicBaseSubstrate, type DecisionTrace } from '../../src/base.js';
import { DIATONIC_ANCHOR_OPTS, DIATONIC_ANCHOR_LA_OPTS } from '../../src/speller.js';
import { classifyOnsets } from '../../test/eval/score.js';

export type Mode = 'rt' | 'la' | 'tp';
export type Tier = 'correct' | 'flipped' | 'wrong' | 'unread';

/** A raw fixture event (events.json); `respell` carries the key signature for ground-truth engraving. */
export interface RawEvent {
    t_ms: number;
    type: 'on' | 'off' | 'respell';
    midi?: number;
    scale?: { letter: string; accidental: number }[];
}
/** A respell event with timing, for the staff's key-signature rendering. */
export interface RespellEvent { t_ms: number; scale: { letter: string; accidental: number }[]; }
export interface Expected { step: string; alter: number; measure?: number; beat?: number; }

export interface Sounding { midi: number; pitch: Pitch; }

/** The captured state at one onset — everything the panels render. */
export interface Snapshot {
    onIndex: number;                 // index into the onset stream (== expected[] index)
    midi: number;
    t: number;
    committed: Pitch | null;         // this note's own committed spelling
    expected: Pitch | null;
    resolvedScale: PitchClass[] | null;   // the 7-letter surface (frame + keep-alive + sounding)
    frame: PitchClass[] | null;           // the bare diatonic base collection, before keep-alive/sounding overlays
    frameLofTonic: number | undefined;    // signed line-of-fifths tonic (spiral); distinguishes C♯ from D♭
    sounding: Sounding[];            // notes ringing at this onset (incl. this one)
    decision: DecisionTrace | null;  // per-candidate scores + deltas + override (streaming rungs; null in batch)
    tier: Tier;
}

/** A note as a time span, for the piano roll (time→x, pitch→y) and the staff (grouped by measure/beat).
 *  `expected` carries the ground-truth measure/beat the staff engraves against. */
export interface ReplayNote {
    onIndex: number;
    midi: number;
    onT: number;
    offT: number;
    committed: Pitch | null;
    expected: (Expected & { octave: number }) | null;
    tier: Tier;
}

export interface Replay {
    mode: Mode;
    snapshots: Snapshot[];
    notes: ReplayNote[];             // one per onset, in onset order (== snapshots), with on/off spans
    respells: RespellEvent[];        // key-signature changes for ground-truth staff engraving
    durationMs: number;
    minMidi: number;
    maxMidi: number;
    tally: { correct: number; flipped: number; wrong: number; unread: number; total: number };
    spiralRange: number;             // effective spiral depth this replay ran with (the wheel draws this)
    spiralCenter: number;            // effective spiral centre this replay ran with
}

/** What-if overrides for the streaming substrate's spiral frame (rt/la only; the batch two-pass ignores
 *  them). Defaults reproduce the shipped preset (range 6, centre +1). */
export interface SpiralOpts { spiralRange?: number; spiralCenter?: number; }

const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const LOF_TO_LETTER = ['C', 'G', 'D', 'A', 'E', 'B', 'F'] as const;   // by ((p % 7)+7)%7
/** Signed line-of-fifths index of a spelling (C=0, G=1, F=−1, F♯=6, C♯=7, B♭=−2 …). */
export function fifths(p: { step: string; alter: number }): number {
    return (LETTER_FIFTHS[p.step] ?? 0) + 7 * p.alter;
}
/** Inverse of {@link fifths}: the spelling at signed line-of-fifths position `p`. */
export function spellFromLof(p: number): PitchClass {
    const step = LOF_TO_LETTER[((p % 7) + 7) % 7]!;
    return { step, alter: Math.round((p - LETTER_FIFTHS[step]!) / 7) as PitchClass['alter'] };
}
/** Pitch class (0..11, C=0) of a spelling. */
export function pcOf(p: { step: string; alter: number }): number {
    return ((fifths(p) * 7) % 12 + 12) % 12;
}

/** Onsets in event order, each with a resolution direction for look-ahead (next ±1 semitone within
 *  `horizon` upcoming onsets) — the small forward buffer a near-real-time caller feeds. */
function onsetDirs(events: RawEvent[], horizon = 16): Map<number, number> {
    const dir = new Map<number, number>();
    const ons = events.map((e, i) => ({ e, i })).filter(x => x.e.type === 'on');
    for (let k = 0; k < ons.length; k++) {
        const midi = ons[k]!.e.midi!;
        let d = 0;
        for (let j = k + 1; j < ons.length && j - k <= horizon; j++) {
            if (ons[j]!.e.midi === midi + 1) { d = 1; break; }
            if (ons[j]!.e.midi === midi - 1) { d = -1; break; }
        }
        dir.set(ons[k]!.i, d);
    }
    return dir;
}


/** Build a replay for one fixture in the given latency mode. `spiral` overrides the streaming
 *  substrate's spiral depth/centre (rt/la); the shipped default is range 6, centre +1. */
export function buildReplay(mode: Mode, events: RawEvent[], expected: Expected[], spiral: SpiralOpts = {}): Replay {
    const snapshots: Snapshot[] = [];
    const respells: RespellEvent[] = [];
    // Effective spiral params: the substrate floors range at 6, so mirror that for the wheel drawing.
    const spiralRange = Math.max(6, spiral.spiralRange ?? 6);
    const spiralCenter = spiral.spiralCenter ?? 1;

    // Batch two-pass (rung 4): the shipped offline speller decides the whole piece at once.
    let tpOut: (Pitch | null)[] | null = null;
    if (mode === 'tp') {
        const notes: { midi: number; tOn: number; tOff: number }[] = [];
        const open = new Map<number, number[]>();
        for (const e of events) {
            if (e.type === 'on') {
                const i = notes.length; notes.push({ midi: e.midi!, tOn: e.t_ms, tOff: e.t_ms });
                (open.get(e.midi!) ?? open.set(e.midi!, []).get(e.midi!)!).push(i);
            } else if (e.type === 'off') {
                const q = open.get(e.midi!); if (q && q.length) notes[q.shift()!]!.tOff = e.t_ms;
            }
        }
        tpOut = spellTwoPass(notes) as (Pitch | null)[];
    }

    // Build the substrate directly from the shipped preset options + the record-only viz trace, keeping
    // the base reference so we can read its per-onset decision. Identical config to `Speller`, so zero drift.
    const base = new DiatonicBaseSubstrate({ ...(mode === 'la' ? DIATONIC_ANCHOR_LA_OPTS : DIATONIC_ANCHOR_OPTS), spiralRange, spiralCenter, trace: true });
    const kernel = new SpellerKernel(base);
    const dirs = onsetDirs(events);
    const sounding = new Map<number, Pitch>();   // midi → its committed spelling, while ringing
    const notes: ReplayNote[] = [];
    const open = new Map<number, number[]>();     // midi → queue of note indices awaiting note-off
    let onIndex = 0;

    for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.type === 'respell') {
            // Collect respell for ground-truth staff engraving (speller still ignores key sigs)
            if (e.scale) respells.push({ t_ms: e.t_ms, scale: e.scale });
            continue;
        }
        if (e.type === 'off') {
            // Read back the FINAL committed spelling at note-off — the shipped Speller's read-back
            // discipline (bench `drive()` reads at off, not on). A note respelled mid-sustain is thus
            // scored/coloured by its final spelling, and a doubled pitch-class the speller splits is
            // paired to onset slots the same FIFO way — so the viz tally matches the library's accuracy
            // metric exactly (caught by test/viz.test.ts on the chopin_15 m13 doubled C♭).
            const final = mode !== 'tp' ? kernel.getSpelling(e.midi!) : null;
            if (mode !== 'tp') kernel.noteOff(e.midi!);
            sounding.delete(e.midi!);
            const q = open.get(e.midi!);
            if (q && q.length) {
                const ni = q.shift()!;
                notes[ni]!.offT = e.t_ms;
                if (mode !== 'tp') { notes[ni]!.committed = final; snapshots[ni]!.committed = final; }
            }
            continue;
        }
        // on-event
        const idx = onIndex++;
        const exp = expected[idx] ?? null;
        let committed: Pitch | null;
        let resolvedScale: PitchClass[] | null = null;
        let frame: PitchClass[] | null = null;
        let frameLofTonic: number | undefined;
        let decision: DecisionTrace | null = null;
        if (mode === 'tp') {
            committed = tpOut![idx] ?? null;
        } else {
            kernel.noteOn(e.midi!, { t: e.t_ms, resolveDir: dirs.get(i) ?? 0 });
            committed = kernel.getSpelling(e.midi!);
            const snap = kernel.snapshot();
            resolvedScale = snap?.resolvedScale ? snap.resolvedScale.map(p => ({ ...p })) : null;
            frame = snap?.frame ? snap.frame.map(p => ({ ...p })) : null;
            frameLofTonic = snap?.frameLofTonic;
            decision = base.decision();
        }
        if (committed) sounding.set(e.midi!, committed);
        const octave = Math.floor(e.midi! / 12) - 1;
        snapshots.push({
            onIndex: idx, midi: e.midi!, t: e.t_ms, committed,
            expected: exp ? { step: exp.step as Pitch['step'], alter: exp.alter as Pitch['alter'], octave } : null,
            resolvedScale, frame, frameLofTonic, decision,
            sounding: [...sounding.entries()].map(([midi, pitch]) => ({ midi, pitch })).sort((a, b) => a.midi - b.midi),
            tier: 'unread',   // placeholder; the run-coherence gate assigns tiers in the post-pass below
        });
        const ni = notes.length;
        notes.push({ onIndex: idx, midi: e.midi!, onT: e.t_ms, offT: e.t_ms, committed, expected: exp ? { ...exp, octave } : null, tier: 'unread' });
        (open.get(e.midi!) ?? open.set(e.midi!, []).get(e.midi!)!).push(ni);
    }

    // Tier post-pass via the SHARED bench classifier (`test/eval/score.ts`), so the viz can never
    // diverge from the parity baseline. flip-vs-wrong needs the whole onset run in view (a lone
    // off-side note is `wrong`, not `flipped`), so it can't be decided inline; snapshots and notes are
    // both in onset order → positional.
    const tiers = classifyOnsets(
        snapshots.map(s => s.committed),
        snapshots.map(s => expected[s.onIndex] ?? null),
        snapshots.map(s => s.t), // onset time groups co-struck notes — same key the bench uses
    );
    snapshots.forEach((s, k) => { s.tier = tiers[k]!; });
    notes.forEach((n, k) => { n.tier = tiers[k]!; });

    const tally = { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 };
    for (const s of snapshots) {
        if (!s.expected) continue;
        tally.total++;
        tally[s.tier]++;
    }
    let durationMs = 0, minMidi = 127, maxMidi = 0;
    for (const n of notes) { durationMs = Math.max(durationMs, n.offT); minMidi = Math.min(minMidi, n.midi); maxMidi = Math.max(maxMidi, n.midi); }
    if (notes.length === 0) { minMidi = 60; maxMidi = 72; }
    return { mode, snapshots, notes, respells, durationMs, minMidi, maxMidi, tally, spiralRange, spiralCenter };
}
