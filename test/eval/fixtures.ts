/**
 * Shared fixture loading + driving helpers for smoke tests and the parity bench.
 *
 * A fixture is `fixtures/<id>/{events.json,expected.json}`. `events.json` is the raw
 * MIDI stream (`on`/`off`/`respell`); `expected.json` is the curated ground-truth
 * spelling, one entry per `on` event in onset order (positional pairing — the i-th
 * `on` pairs with the i-th expected entry, preserving the bass-first invariant).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pitch } from '../../src/index.js';
import { Speller, spellTwoPass } from '../../src/index.js';
import type { NoteContext } from '../../src/kernel.js';
import { CoreSpeller } from '../../src/core.js';

/** The streaming surface `drive` needs — satisfied by both the shipped `Speller` and the
 *  package-private rung-1 `CoreSpeller` (which ignores the look-ahead `ctx` and has no `lookAhead`). */
export interface StreamingSpeller {
    readonly lookAhead?: boolean;
    noteOn(midi: number, ctx?: NoteContext): void;
    noteOff(midi: number): void;
    getSpelling(midi: number): Pitch | null;
}

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The curated fixtures, in a stable order. */
export const FIXTURES = [
    'bach_wtc1_prelude1_c',
    'mozart_k545',
    'chopin_prelude_op28_no4',
    'chopin_prelude_op28_no15',
    'grieg_death_of_ase',
    'bach_jesu_meine_freude',
] as const;

export type FixtureId = typeof FIXTURES[number];

interface RawEvent { t_ms: number; type: string; midi: number; }
export interface BatchEv { t: number; type: 'on' | 'off'; midi: number; }
export interface Expected { step: string; alter: number; }

export function loadEvents(id: string): BatchEv[] {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[];
    return raw.filter(e => e.type === 'on' || e.type === 'off')
        .map(e => ({ t: e.t_ms, type: e.type as 'on' | 'off', midi: e.midi }));
}

export function loadExpected(id: string): Expected[] {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'expected.json'), 'utf8')) as Expected[];
}

/**
 * Drive a streaming Speller over an event list, returning one spelling per `on`
 * event in onset order. Read-back happens at `noteOff` (a note's final committed
 * spelling). For look-ahead mode, `resolveDir` is derived from the next ±1-semitone
 * onset within `horizon` upcoming onsets — the small forward buffer a real caller feeds.
 */
export function drive(s: StreamingSpeller, events: BatchEv[], horizon = 16): (Pitch | null)[] {
    const out: (Pitch | null)[] = [];
    const pending = new Map<number, number[]>();
    for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.type === 'on') {
            let dir = 0, seen = 0;
            if (s.lookAhead) {
                for (let j = i + 1; j < events.length && seen < horizon; j++) {
                    const fwd = events[j]!;
                    if (fwd.type !== 'on') continue;
                    seen++;
                    if (fwd.midi === e.midi + 1) { dir = 1; break; }
                    if (fwd.midi === e.midi - 1) { dir = -1; break; }
                }
            }
            s.noteOn(e.midi, { t: e.t, resolveDir: dir });
            const idx = out.length; out.push(null);
            (pending.get(e.midi) ?? pending.set(e.midi, []).get(e.midi)!).push(idx);
        } else {
            const q = pending.get(e.midi);
            if (q && q.length) out[q.shift()!] = s.getSpelling(e.midi);
            s.noteOff(e.midi);
        }
    }
    return out;
}

/** Collapse an event list to offline notes (`{midi,tOn,tOff}`) in onset order for two-pass. */
export function onNotes(events: BatchEv[]): { midi: number; tOn: number; tOff: number }[] {
    const notes: { midi: number; tOn: number; tOff: number }[] = [];
    const open = new Map<number, number[]>();
    for (const e of events) {
        if (e.type === 'on') {
            const i = notes.length;
            notes.push({ midi: e.midi, tOn: e.t, tOff: e.t });
            (open.get(e.midi) ?? open.set(e.midi, []).get(e.midi)!).push(i);
        } else {
            const q = open.get(e.midi);
            if (q && q.length) notes[q.shift()!]!.tOff = e.t;
        }
    }
    return notes;
}

/** `core` = rung 1 (frameless baseline); `rt`/`la` = rungs 2/3 (Speller); `tp` = rung 4 (two-pass). */
export type Mode = 'core' | 'rt' | 'la' | 'tp';

/** Produce predictions for a fixture in the given rung/latency mode, paired 1:1 with expected. */
export function predict(mode: Mode, events: BatchEv[]): (Pitch | null)[] {
    if (mode === 'tp') return spellTwoPass(onNotes(events)) as (Pitch | null)[];
    if (mode === 'core') return drive(new CoreSpeller(), events);
    return drive(new Speller(mode === 'la' ? { lookAhead: true } : {}), events);
}
