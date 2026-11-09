/**
 * LOCAL-ONLY comparison with other spellers: their stored per-note predictions, scored by the same
 * three-tier classifier the viz uses for ours (`test/eval/score.ts`), against the same ground truth.
 *
 * The data is never part of the public build: `tools/viz-compare/sync.mjs` writes it to the gitignored
 * `viz-local/`, and `viz/build.mjs` copies it to `compare/` only outside CI. When `compare/index.json`
 * is missing (the deployed site), every compare control stays hidden and the viz behaves as before.
 */
import type { Pitch, PitchClass, Letter, Accidental } from '../../src/index.js';
import { classifyOnsets } from '../../test/eval/score.js';
import type { Expected, Replay, Tier } from './replay.js';
import type { Mode } from './replay.js';

export interface CompareIndex {
    algos: Record<string, string>;        // speller id → menu label (menu order)
    fixtures: Record<string, string[]>;   // fixture id → speller ids with aligned predictions
}

/** A curated one-click jump: a fixture, an onset (1-based, as in the URL), our speller, and theirs. */
export interface Moment {
    title: string;
    fixture: string;
    step: number;
    mode: Exclude<Mode, 'la'>;
    lookAhead?: boolean;
    compare: string;
    text: string;
}

export interface Tally { correct: number; flipped: number; wrong: number; unread: number; total: number }

export interface Comparison {
    algo: string;
    label: string;
    theirs: (Pitch | null)[];   // per onset (== replay.snapshots index), with octave
    tiers: Tier[];              // their tier per onset, same scorer and onset grouping as ours
    differ: boolean[];          // they spelled this note differently from ours (both present)
    nDiffer: number;
    tally: Tally;               // their whole-piece tally
    differTheirsWrong: number;  // among the differing notes: theirs wrong
    differOursWrong: number;    // among the differing notes: ours wrong
}

const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C#", "Eb", "F##", "Bbb" → a pitch class; null stays null. */
export function parseSpelling(s: string | null): PitchClass | null {
    if (!s) return null;
    const step = s[0] as Letter;
    if (!(step in NATURAL_PC)) return null;
    let alter = 0;
    for (const c of s.slice(1)) alter += c === '#' ? 1 : c === 'b' ? -1 : 0;
    return { step, alter: alter as Accidental };
}

/** The octave that makes `pc` sound at `midi` (B♯3 is MIDI 60, C♭5 is MIDI 71). */
export function withOctave(pc: PitchClass, midi: number): Pitch {
    return { step: pc.step, alter: pc.alter, octave: Math.round((midi - pc.alter - NATURAL_PC[pc.step]!) / 12) - 1 };
}

export const sameSpelling = (a: PitchClass | null, b: PitchClass | null) =>
    !!a && !!b && a.step === b.step && a.alter === b.alter;

/** Score their predictions against the fixture exactly as the replay scores ours. */
export function buildComparison(replay: Replay, preds: readonly (PitchClass | null)[], expected: readonly Expected[], algo: string, label: string): Comparison {
    const snaps = replay.snapshots;
    const theirs = snaps.map(s => { const p = preds[s.onIndex] ?? null; return p ? withOctave(p, s.midi) : null; });
    const tiers = classifyOnsets(theirs, snaps.map(s => expected[s.onIndex] ?? null), snaps.map(s => s.t));
    snaps.forEach((s, k) => { if (!s.expected) tiers[k] = 'unread'; });
    const tally: Tally = { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 };
    const differ = snaps.map((s, k) => !!theirs[k] && !!s.committed && !sameSpelling(theirs[k]!, s.committed));
    let nDiffer = 0, differTheirsWrong = 0, differOursWrong = 0;
    snaps.forEach((s, k) => {
        if (s.expected) { tally.total++; tally[tiers[k]!]++; }
        if (!differ[k]) return;
        nDiffer++;
        if (tiers[k] === 'wrong') differTheirsWrong++;
        if (s.tier === 'wrong') differOursWrong++;
    });
    return { algo, label, theirs, tiers, differ, nDiffer, tally, differTheirsWrong, differOursWrong };
}

export async function fetchCompareIndex(): Promise<CompareIndex | null> {
    try {
        const r = await fetch('compare/index.json');
        if (!r.ok) return null;
        const j = await r.json() as CompareIndex;
        return j && j.algos && j.fixtures ? j : null;
    } catch { return null; }
}

export async function fetchPredictions(fixture: string, algo: string): Promise<(PitchClass | null)[] | null> {
    try {
        const r = await fetch(`compare/${encodeURIComponent(fixture)}/${encodeURIComponent(algo)}.json`);
        if (!r.ok) return null;
        const j = await r.json() as { predictions: (string | null)[] };
        return j.predictions.map(parseSpelling);
    } catch { return null; }
}

export async function fetchMoments(): Promise<Moment[]> {
    try {
        const r = await fetch('compare/moments.json');
        if (!r.ok) return [];
        return ((await r.json()) as { moments: Moment[] }).moments ?? [];
    } catch { return []; }
}
