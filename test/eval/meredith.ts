/**
 * Held-out benchmark: score the shipped spellers over David Meredith's "8x25000"
 * pitch-spelling corpus (216 movements, 195,972 notes) — the literature-standard
 * benchmark ps13 / Temperley / Cambouropoulos / Chew report on. Ground truth we did
 * NOT author, so it is an independent check on the curated fixtures.
 *
 *   scripts/fetch-meredith.sh          # download the corpus first (gitignored)
 *   npm run meredith                   # score the clean corpus
 *   npm run meredith -- --noisy        # score the noisy (human-MIDI-like) corpus
 *   npm run meredith -- --check        # also assert exact% >= the published thresholds
 *
 * `exact` = strict composer-spelling match (ps13's metric, comparable to their 99.31%);
 * `tonal` = exact + coherent enharmonic flip (the three-tier scorer, ±16 consensus).
 *
 * OPNDV format: one S-expression per movement, each note `(onset "PitchName" dur voice)`;
 * PitchName = letter + accidental(s) + octave, accidental n=natural s=sharp f=flat (doubles
 * like Fss/Bff occur). onset/dur are integer tatums. Parsed bass-first (onset asc, midi asc).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Speller, spellTwoPass, type Pitch } from '../../src/index.js';
import { CoreSpeller } from '../../src/core.js';
import type { StreamingSpeller } from './fixtures.js';
import { scoreTiers } from './score.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const noisy = process.argv.includes('--noisy');
const check = process.argv.includes('--check');

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
interface Note { onset: number; dur: number; step: string; alter: number; midi: number; }

/** Parse one OPNDV movement into notes, sorted bass-first (onset asc, then midi asc). */
function parseOpndv(text: string): Note[] {
    const notes: Note[] = [];
    const re = /\(\s*(\d+)\s+"([A-G])([nsf]+)(\d+)"\s+(\d+)\s+(\d+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const onset = Number(m[1]), letter = m[2]!, acc = m[3]!, octave = Number(m[4]), dur = Number(m[5]);
        const alter = acc === 'n' ? 0 : [...acc].reduce((a, c) => a + (c === 's' ? 1 : c === 'f' ? -1 : 0), 0);
        notes.push({ onset, dur, step: letter, alter, midi: (octave + 1) * 12 + STEP[letter]! + alter });
    }
    notes.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
    return notes;
}

/** Look-ahead resolveDir per note index: nearest ±1-semitone onset within horizon 16. */
function resolveDirs(notes: Note[]): number[] {
    const d = new Array<number>(notes.length).fill(0);
    for (let a = 0; a < notes.length; a++) {
        let seen = 0;
        for (let b = a + 1; b < notes.length && seen < 16; b++) {
            seen++;
            if (notes[b]!.midi === notes[a]!.midi + 1) { d[a] = 1; break; }
            if (notes[b]!.midi === notes[a]!.midi - 1) { d[a] = -1; break; }
        }
    }
    return d;
}

/** Time-ordered events: at equal t, releases before strikes; strikes bass-first (midi asc). */
function events(notes: Note[]): { t: number; on: boolean; midi: number; i: number }[] {
    const evs: { t: number; on: boolean; midi: number; i: number }[] = [];
    notes.forEach((n, i) => {
        evs.push({ t: n.onset, on: true, midi: n.midi, i });
        evs.push({ t: n.onset + n.dur, on: false, midi: n.midi, i });
    });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || a.midi - b.midi);
    return evs;
}

type Mode = 'core' | 'rt' | 'la' | 'tp';

function predict(mode: Mode, notes: Note[]): (Pitch | null)[] {
    if (mode === 'tp') {
        return spellTwoPass(notes.map(n => ({ midi: n.midi, tOn: n.onset, tOff: n.onset + n.dur }))) as (Pitch | null)[];
    }
    const s: StreamingSpeller = mode === 'core' ? new CoreSpeller() : new Speller(mode === 'la' ? { lookAhead: true } : {});
    const dirs = mode === 'la' ? resolveDirs(notes) : null;
    const pred: (Pitch | null)[] = new Array(notes.length).fill(null);
    const pend = new Map<number, number[]>();
    for (const e of events(notes)) {
        if (e.on) {
            s.noteOn(e.midi, { t: e.t, resolveDir: dirs ? dirs[e.i]! : 0 });
            (pend.get(e.midi) ?? pend.set(e.midi, []).get(e.midi)!).push(e.i);
        } else {
            const q = pend.get(e.midi);
            if (q && q.length) pred[q.shift()!] = s.getSpelling(e.midi);
            s.noteOff(e.midi);
        }
    }
    return pred;
}

// --- locate the corpus ---------------------------------------------------------------------
const stem = noisy ? 'opnd-m-noisy' : 'opnd-m';
const dir = join(REPO, 'corpora', 'meredith', stem, stem);          // double-nested (see fetch script)
if (!existsSync(dir)) {
    console.error(`✗ corpus not found: ${dir}\n  Run  scripts/fetch-meredith.sh  to download it.`);
    process.exit(1);
}
// Both variants use the .opnd-m extension; only the directory name carries the noisy/clean distinction.
const files = readdirSync(dir).filter(f => f.endsWith('.opnd-m')).sort();

// --- score ---------------------------------------------------------------------------------
const MODES: { key: Mode; label: string }[] = [
    { key: 'core', label: 'core (rung 1)' },
    { key: 'rt', label: 'real-time' },
    { key: 'la', label: 'look-ahead' },
    { key: 'tp', label: 'two-pass' },
];
const agg: Record<Mode, { correct: number; flipped: number; wrong: number; unread: number; total: number }> = {
    core: { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 },
    rt: { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 },
    la: { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 },
    tp: { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 },
};
for (const f of files) {
    const notes = parseOpndv(readFileSync(join(dir, f), 'utf8'));
    const expected = notes.map(n => ({ step: n.step, alter: n.alter }));
    const keys = notes.map(n => n.onset); // co-struck notes share an onset tatum
    for (const { key } of MODES) {
        const t = scoreTiers(predict(key, notes), expected, keys);
        agg[key].correct += t.correct; agg[key].flipped += t.flipped;
        agg[key].wrong += t.wrong; agg[key].unread += t.unread; agg[key].total += t.total;
    }
}

// Percentages are over COMMITTED notes (correct+flipped+wrong), matching the lab: an abstained/unread
// note (no read-back — the jittered noisy corpus produces a few) is excluded, not counted as wrong.
const committedOf = (a: { correct: number; flipped: number; wrong: number }) => a.correct + a.flipped + a.wrong;
const pct = (n: number, d: number) => (100 * n / d).toFixed(2).padStart(6);
const absTotal = MODES.reduce((s, { key }) => s + agg[key].unread, 0);
console.log(`\nMeredith 8x25000 — ${noisy ? 'NOISY (human-MIDI-like)' : 'CLEAN'} — ${files.length} movements, ${agg.rt.total} notes${absTotal ? ` (some abstained; % over committed)` : ''}`);
console.log(`  ${'mode'.padEnd(12)} ${'exact%'.padStart(7)} ${'tonal%'.padStart(7)} ${'flip%'.padStart(6)} ${'wrong%'.padStart(6)}`);
for (const { key, label } of MODES) {
    const a = agg[key];
    const n = committedOf(a);
    console.log(`  ${label.padEnd(12)} ${pct(a.correct, n)}% ${pct(a.correct + a.flipped, n)}% ${pct(a.flipped, n)}% ${pct(a.wrong, n)}%`);
}
console.log(`  exact = strict composer match (ps13 metric); tonal = exact + coherent flip.`);

// --- optional regression check (clean corpus published thresholds) -------------------------
if (check && !noisy) {
    const laExact = 100 * agg.la.correct / committedOf(agg.la);
    const tpExact = 100 * agg.tp.correct / committedOf(agg.tp);
    const fails: string[] = [];
    if (laExact < 99.50) fails.push(`look-ahead exact ${laExact.toFixed(2)}% < 99.50%`);
    if (tpExact < 99.70) fails.push(`two-pass exact ${tpExact.toFixed(2)}% < 99.70%`);
    if (fails.length) { console.error('\n✗ ' + fails.join('\n✗ ')); process.exit(1); }
    console.log('\n✓ exact% at or above published thresholds.');
}
