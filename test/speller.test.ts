/**
 * Product smoke + curated fixture replay.
 * Confirms Speller / look-ahead / two-pass run and commit one spelling per onset.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assert, assertEq, suite, test } from './framework.js';
import { Speller, spellTwoPass, type Pitch } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface RawEvent { t_ms: number; type: string; midi: number; }
interface BatchEv { t: number; type: 'on' | 'off'; midi: number; }

const tok = (sp: Pitch | null): string =>
    sp ? sp.step + (sp.alter > 0 ? '#'.repeat(sp.alter) : sp.alter < 0 ? 'b'.repeat(-sp.alter) : '') : '·';

function loadEvents(id: string): BatchEv[] {
    const raw = JSON.parse(readFileSync(join(root, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[];
    return raw.filter(e => e.type === 'on' || e.type === 'off')
        .map(e => ({ t: e.t_ms, type: e.type as 'on' | 'off', midi: e.midi }));
}

function drive(s: Speller, events: BatchEv[], horizon = 16): string[] {
    const out: string[] = [];
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
            const idx = out.length;
            out.push('?');
            (pending.get(e.midi) ?? pending.set(e.midi, []).get(e.midi)!).push(idx);
        } else {
            const q = pending.get(e.midi);
            if (q && q.length) out[q.shift()!] = tok(s.getSpelling(e.midi));
            s.noteOff(e.midi);
        }
    }
    return out;
}

function onNotes(events: BatchEv[]): { midi: number; tOn: number; tOff: number }[] {
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

suite('Speller smoke', () => {
    test('C major triad spells C E G', () => {
        const s = new Speller();
        s.noteOn(60, { t: 0 });
        s.noteOn(64, { t: 0 });
        s.noteOn(67, { t: 0 });
        assertEq(tok(s.getSpelling(60)), 'C');
        assertEq(tok(s.getSpelling(64)), 'E');
        assertEq(tok(s.getSpelling(67)), 'G');
    });
});

const FIXTURES = [
    'bach_wtc1_prelude1_c',
    'mozart_k545',
    'chopin_prelude_op28_no4',
    'grieg_death_of_ase',
    'bach_jesu_meine_freude',
] as const;

suite('curated fixtures', () => {
    for (const id of FIXTURES) {
        test(`${id}: real-time commits one spelling per onset`, () => {
            const ev = loadEvents(id);
            const out = drive(new Speller(), ev);
            assert(out.length > 0);
            assert(out.every(t => t !== '?' && t !== '·'), `${id}: abstain/unread`);
        });

        test(`${id}: look-ahead commits one spelling per onset`, () => {
            const ev = loadEvents(id);
            const out = drive(new Speller({ lookAhead: true }), ev);
            assert(out.every(t => t !== '?' && t !== '·'), `${id}: LA abstain/unread`);
        });

        test(`${id}: two-pass length matches onsets`, () => {
            const ev = loadEvents(id);
            const notes = onNotes(ev);
            const spelled = spellTwoPass(notes);
            assertEq(spelled.length, notes.length);
            assert(spelled.every(p => p !== null), `${id}: two-pass null`);
        });
    }
});
