/**
 * Replay: drive the REAL shipped speller over a fixture and capture one snapshot per onset.
 *
 * Zero drift by construction — the streaming rungs drive the exact `SpellingEngine` the public `Speller`
 * builds, at its `RT_PRESET`/`LA_PRESET` (rt/la), and the batch rung calls the shipped `spellTwoPass`.
 * The viz never re-implements a spelling decision; it only reads what the engine holds
 * (`getResolvedScale()`/`getAnchor()`/`getCollection()` → resolved surface, signed line-of-fifths tonic,
 * diatonic collection) plus each note's own committed spelling (`getSpelling`) and the record-only
 * decision trace (`decision()`). Key signatures in the fixture (`respell` events) are IGNORED, matching
 * the shipped no-keys presets the benchmark scores.
 */
import type { Pitch, PitchClass } from '../../src/index.js';
import { CoreSpeller } from '../../src/core.js';
import { spellTwoPassTraced, type TwoPassTrace, type TwoPassNoteTrace } from '../../src/two-pass.js';
import { resolveStep } from '../../src/kernel.js';
import { SpellingEngine, RT_PRESET, LA_PRESET } from '../../src/engine.js';
import type { DecisionTrace } from './decision.js';
import { classifyOnsets } from '../../test/eval/score.js';

/** Editorial enharmonic side marker (viz-local; the shipped two-pass no longer consumes these — they
 *  remain a viz-session convenience for the auto-reset helper and the URL state). */
export interface TwoPassSideOverride { readonly from: number; readonly comma: number; }
import { CollectionReader, collectionName } from './music/collection.js';

/** The two display-only collection lanes (see music/collection.ts): LOCAL chases tonicizations (short
 *  half-life), STABLE holds the home key (long half-life + more hysteresis). Independent of the spelling
 *  frame's window; a persistent local shift migrates the stable lane on its own (a real modulation). */
const LOCAL_HALF_LIFE_MS = 2500, LOCAL_HYSTERESIS = 1.0;
const STABLE_HALF_LIFE_MS = 12000, STABLE_HYSTERESIS = 4.0;

/** One collection lane's reading at an onset: the collection (relative-major pc), a side-aware label,
 *  and the winner's margin over the runner-up (confidence it's this collection, not a neighbour). */
export interface CollectionRead { relMajorPc: number; name: string; margin: number; }
import { enharmonicCandidatesFor } from '../../src/candidates.js';
import { intervalScore } from '../../src/scoring.js';

export type Mode = 'core' | 'rt' | 'la' | 'tp' | 'control';

/** The rung-1 CoreSpeller's structural shape. CoreSpeller's 1-arg noteOn is assignable to this
 *  2-arg signature (the extra onset time is ignored). */
interface CoreLike {
    noteOn(midi: number, t?: number): void;
    noteOff(midi: number): void;
    getSpelling(midi: number): Pitch | null;
    getResolvedScale(): PitchClass[];
}

/** Build a viz decision trace for a rung-1 note: re-score the candidates against the pre-commit
 *  scale. Frame = the 7-letter scale the candidates were scored against. */
function coreDecision(before: PitchClass[], midi: number, committed: Pitch | null): DecisionTrace | null {
    const frameMap = new Map(before.map(p => [p.step, p] as const));
    const candidates = enharmonicCandidatesFor(midi).map(c => ({ c, base: intervalScore(c, frameMap), laDelta: 0, nsDelta: 0 }));
    const chosen = committed ? { step: committed.step, alter: committed.alter } : candidates[0]!.c;
    return { frame: before, candidates, chosen, override: 'none' };
}

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
    durMs: number;                   // this note's sounding duration (offT − onT), backfilled after note-off
    committed: Pitch | null;         // this note's own committed spelling
    expected: Pitch | null;
    resolvedScale: PitchClass[] | null;   // the 7-letter surface (the diatonic collection plus its live alterations)
    frame: PitchClass[] | null;           // the bare diatonic collection, before its live alterations
    frameLofTonic: number | undefined;    // signed line-of-fifths tonic (spiral); distinguishes C♯ from D♭
    frameKeyLof: number | undefined;      // canonical frame-key spelling when the spiral is off
    sounding: Sounding[];            // notes ringing at this onset (incl. this one)
    decision: DecisionTrace | null;  // per-candidate scores + deltas + override (streaming rungs; null in batch)
    twoPass: TwoPassNoteTrace | null; // forward/backward evidence + offline reconciliation (batch only)
    localColl: CollectionRead | null;  // LOCAL collection lane (chases tonicizations); display-only
    stableColl: CollectionRead | null; // STABLE collection lane (home key); display-only
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

/** What-if overrides for the streaming engine's spiral frame (rt/la only; the batch two-pass ignores
 *  them). Defaults reproduce the shipped preset (range 6, centre +1). */
export interface SpiralOpts { spiralRange?: number; spiralCenter?: number; spiralEven?: boolean; frameCarryComma?: number; spiralOff?: boolean; leash?: boolean; }

/** Add `auto` releases where a stitched fixture's measure number restarts. These are a viz-session
 * convenience, not hidden production policy: library callers supply their own releases. */
export function withSectionAutoResets(expected: readonly Expected[], overrides: readonly TwoPassSideOverride[]): TwoPassSideOverride[] {
    const byFrom = new Map(overrides.map(o => [o.from, o.comma]));
    for (let i = 1; i < expected.length; i++) {
        const prev = expected[i - 1], cur = expected[i];
        if (typeof prev?.measure === 'number' && typeof cur?.measure === 'number' && cur.measure < prev.measure && !byFrom.has(i)) byFrom.set(i, 0);
    }
    return [...byFrom.entries()].sort((a, b) => a[0] - b[0]).map(([from, comma]) => ({ from, comma }));
}

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

/**
 * The fixed line-of-fifths CONTROL — Meredith's chance-level window: 12 consecutive fifths, so exactly
 * one spelling per pitch class, applied with NO context (every occurrence of a pc gets the same letter
 * forever, regardless of key or neighbours). It never drifts, flips, or looks — which is exactly why
 * it's worth seeing beside the rungs.
 *
 * The window is a fixed 12-slot (EVEN) window — one degree of freedom, its position — so the spiral
 * panel's `center` (offset) alone slides it: its low (flattest) fifth is `controlWindowLo(center)`.
 * The default (center +1) lands on `l_min = −3..+8` = E♭..G♯ = byte-for-byte music21's default MIDI
 * spelling (C C♯ D E♭ E F F♯ G G♯ A B♭ B) — the canonical control. (Parity/skew is a property of the
 * venturing SPIRAL, not of this frozen window, so it plays no part here.)
 */
export function controlWindowLo(center: number): number {
    return center - 4;   // center +1 → lo −3 (E♭…G♯ = music21 default); each +1 slides one fifth sharp
}
/** The control's pitch-class → spelling table for a given window position (12 consecutive fifths). */
export function controlTable(center: number): Map<number, PitchClass> {
    const lo = controlWindowLo(center);
    const m = new Map<number, PitchClass>();
    for (let n = lo; n <= lo + 11; n++) m.set(pcOf(spellFromLof(n)), spellFromLof(n));
    return m;
}
/** Spell a MIDI note with a fixed-LoF control table (context-free). */
export function controlSpell(midi: number, table: Map<number, PitchClass>): Pitch {
    const sp = table.get(((midi % 12) + 12) % 12)!;
    return { step: sp.step, alter: sp.alter, octave: Math.floor(midi / 12) - 1 };
}

/** Onsets in event order, each with a resolution direction for look-ahead (next onset a semitone away
 *  in any octave, within `horizon` upcoming onsets) — the forward buffer a near-real-time caller feeds. */
function onsetDirs(events: RawEvent[], horizon = 16): Map<number, number> {
    const dir = new Map<number, number>();
    const ons = events.map((e, i) => ({ e, i })).filter(x => x.e.type === 'on');
    for (let k = 0; k < ons.length; k++) {
        const midi = ons[k]!.e.midi!;
        let d = 0;
        for (let j = k + 1; j < ons.length && j - k <= horizon; j++) {
            d = resolveStep(midi, ons[j]!.e.midi!);
            if (d !== 0) break;
        }
        dir.set(ons[k]!.i, d);
    }
    return dir;
}


/** Build a replay for one fixture in the given latency mode. `spiral` overrides the streaming
 *  engine's spiral depth/centre (rt/la); the shipped default is range 6, centre +1. */
export function buildReplay(mode: Mode, events: RawEvent[], expected: Expected[], spiral: SpiralOpts = {}, twoPassSideMemory = true, sideOverrides: readonly TwoPassSideOverride[] = []): Replay {
    const snapshots: Snapshot[] = [];
    const respells: RespellEvent[] = [];
    // Effective spiral params: the engine floors range at 6, so mirror that for the wheel drawing.
    const spiralRange = Math.max(6, spiral.spiralRange ?? 6);
    const spiralCenter = spiral.spiralCenter ?? 1;
    const spiralEven = spiral.spiralEven ?? false;         // false = symmetric odd window (shipped behaviour)
    const ctrlTable = controlTable(spiralCenter);          // the fixed-LoF control's window (control mode)

    // Batch two-pass (rung 4): the shipped offline speller decides the whole piece at once.
    let tpOut: (Pitch | null)[] | null = null;
    let tpTrace: TwoPassTrace | null = null;
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
        // The shipped offline resolver (forward + time-reversed backward, wolf-cost reconciled).
        void twoPassSideMemory; void sideOverrides;   // accepted for signature compatibility; not consumed
        tpTrace = spellTwoPassTraced(notes);
        tpOut = tpTrace.spellings as (Pitch | null)[];
    }

    // Core (rung 1) is a separate persistent, frameless speller. It has no spiral or decision trace,
    // but its seven-slot resolved scale is useful to show in the same surface panel as the shipped
    // streaming rungs.
    const core: CoreLike | null = mode === 'core' ? new CoreSpeller() : null;
    const isCore = mode === 'core';
    const isControl = mode === 'control';   // fixed-LoF window (music21 default): context-free, no state

    // The shipped streaming engine (rt = real-time preset, la = look-ahead preset). The wheel's what-if
    // steppers drive the spiral-fold clamp: the clamp centre sits on the 7-slot MEAN (a major key = tonic
    // + 2), so it is spiralCenter + 2, and its radius is spiralRange + 1. The defaults (centre +1, range 6)
    // land on the preset's own clamp (centre 3, radius 7), so at rest the viz is byte-identical to the
    // shipped `Speller`; widening the range or nudging the centre digs to deeper enharmonics live.
    const engine = (mode === 'rt' || mode === 'la')
        ? new SpellingEngine({
            ...(mode === 'la' ? LA_PRESET : RT_PRESET),
            foldCenter: spiralCenter + 2,
            foldRadius: spiralRange + 1,
        })
        : null;
    const dirs = onsetDirs(events);
    const sounding = new Map<number, Pitch>();   // midi → its committed spelling, while ringing
    // Two display-only collection lanes (local tonicizations + stable home key), independent of the frame.
    const localReader = new CollectionReader(LOCAL_HALF_LIFE_MS, LOCAL_HYSTERESIS);
    const stableReader = new CollectionReader(STABLE_HALF_LIFE_MS, STABLE_HYSTERESIS);
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
            const final = isCore ? core!.getSpelling(e.midi!)
                : isControl ? controlSpell(e.midi!, ctrlTable)
                : engine ? engine.getSpelling(e.midi!) : null;
            if (isCore) core!.noteOff(e.midi!);
            else if (engine) engine.noteOff(e.midi!);
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
        let frameKeyLof: number | undefined;
        let decision: DecisionTrace | null = null;
        const twoPass = mode === 'tp' ? tpTrace!.notes[idx]! : null;
        if (mode === 'tp') {
            // The offline two-pass has no per-note streaming frame; the forward/backward/selected evidence
            // is shown by the two-pass summary. Leave the streaming-frame fields empty (rendered as such).
            committed = tpOut![idx] ?? null;
        } else if (isCore) {
            const before = core!.getResolvedScale();               // the scale the candidates are scored against
            core!.noteOn(e.midi!, e.t_ms);
            committed = core!.getSpelling(e.midi!);
            resolvedScale = core!.getResolvedScale();
            frame = resolvedScale.map(p => ({ ...p }));
            decision = coreDecision(before, e.midi!, committed);
        } else if (isControl) {
            // Fixed-LoF window: a pure lookup, no state. No frame, no drift, no decision trace — the
            // panels (state table, spiral, tonnetz, scoring) render their empty/"no trace" states, which
            // is the honest picture of a context-free control. Only the committed spelling is meaningful.
            committed = controlSpell(e.midi!, ctrlTable);
        } else {
            // rt / la — the shipped streaming engine.
            const before = engine!.getResolvedScale();
            engine!.noteOn(e.midi!, e.t_ms, mode === 'la' ? (dirs.get(i) ?? 0) : 0);
            committed = engine!.getSpelling(e.midi!);
            resolvedScale = engine!.getResolvedScale();
            if (mode === 'rt') {
                // The leash's diatonic collection is the stable frame; the resolved surface carries the
                // live alterations. Major tonic = collection centre − 2.
                frame = engine!.getCollection();
                frameLofTonic = engine!.getAnchor() - 2;
            } else {
                // Look-ahead runs no leash, so read the frame side off the drifting resolved scale itself
                // (a major scale's mean line-of-fifths sits at tonic + 2).
                frame = resolvedScale.map(p => ({ ...p }));
                frameLofTonic = Math.round(resolvedScale.reduce((s, p) => s + fifths(p), 0) / resolvedScale.length) - 2;
            }
            const gd = engine!.decision();
            decision = gd
                ? {
                    frame: gd.scale,
                    candidates: gd.candidates.map(x => ({ c: x.c, base: x.base, laDelta: x.laDelta, nsDelta: x.daDelta + x.vertDelta, guardDelta: x.guardDelta, sideDelta: x.sideDelta })),
                    chosen: gd.chosen, override: 'none',
                }
                : coreDecision(before, e.midi!, committed);
        }
        if (committed) sounding.set(e.midi!, committed);
        // Display-only collection reads over the raw pitch-class stream; labels spelled on the frame's side.
        localReader.observe(e.midi!, e.t_ms);
        stableReader.observe(e.midi!, e.t_ms);
        const side = frameLofTonic ?? frameKeyLof;
        const lc = localReader.read(e.t_ms), sc = stableReader.read(e.t_ms);
        const localColl: CollectionRead | null = lc ? { relMajorPc: lc.relMajorPc, name: collectionName(lc.relMajorPc, side), margin: lc.margin } : null;
        const stableColl: CollectionRead | null = sc ? { relMajorPc: sc.relMajorPc, name: collectionName(sc.relMajorPc, side), margin: sc.margin } : null;
        const octave = Math.floor(e.midi! / 12) - 1;
        snapshots.push({
            onIndex: idx, midi: e.midi!, t: e.t_ms, durMs: 0, committed,
            expected: exp ? { step: exp.step as Pitch['step'], alter: exp.alter as Pitch['alter'], octave } : null,
            resolvedScale, frame, frameLofTonic, frameKeyLof, decision, twoPass,
            localColl, stableColl,
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
    snapshots.forEach((s, k) => { s.tier = tiers[k]!; s.durMs = notes[k]!.offT - notes[k]!.onT; });
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
