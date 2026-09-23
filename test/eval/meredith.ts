/**
 * Held-out benchmark: score the shipped spellers over David Meredith's "8x25000"
 * pitch-spelling corpus (216 movements, 195,972 notes): the standard pitch-spelling
 * benchmark; the third-party baselines (ps13 / Temperley / Chew & Chen / PKSpell) are
 * scored on the same notes in test/eval/meredith-baselines.json. Ground truth we did
 * NOT author, so it is an independent check on the curated fixtures.
 *
 *   scripts/fetch-meredith.sh          # download the corpus first (gitignored)
 *   npm run meredith                   # score the clean corpus
 *   npm run meredith -- --noisy        # score the noisy (human-MIDI-like) corpus
 *   npm run meredith -- --check        # also assert exact% >= the published thresholds
 *
 * `exact` = strict composer-spelling match (ps13's metric, comparable to their 99.31%);
 * `coherent` = exact + contextually coherent enharmonic flip (the three-tier scorer, ±16 consensus).
 *
 * OPNDV format: one S-expression per movement, each note `(onset "PitchName" dur voice)`;
 * PitchName = letter + accidental(s) + octave, accidental n=natural s=sharp f=flat (doubles
 * like Fss/Bff occur). onset/dur are integer tatums. Parsed bass-first (onset asc, midi asc).
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Speller, spellTwoPass, type Pitch } from '../../src/index.js';
import { CoreSpeller } from '../../src/core.js';
import { resolveStep } from '../../src/kernel.js';
import type { StreamingSpeller } from './fixtures.js';
import { scoreTiers } from './score.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const noisy = process.argv.includes('--noisy');
const check = process.argv.includes('--check');
const counts = process.argv.includes('--counts');
// `--json <path>` also writes the aggregate tiers as machine-readable JSON (consumed by the
// scoreboard figure generator, tools/figures/three-tier.mjs), so the scoreboard is sourced from
// THIS repo's shipped modes.
const jsonArg = process.argv.indexOf('--json');
const jsonPath = jsonArg >= 0 ? process.argv[jsonArg + 1] : null;

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

/** Look-ahead resolveDir per note index: nearest onset a semitone away (any octave) within horizon 16. */
function resolveDirs(notes: Note[]): number[] {
    const d = new Array<number>(notes.length).fill(0);
    for (let a = 0; a < notes.length; a++) {
        let seen = 0;
        for (let b = a + 1; b < notes.length && seen < 16; b++) {
            seen++;
            d[a] = resolveStep(notes[a]!.midi, notes[b]!.midi);
            if (d[a] !== 0) break;
        }
    }
    return d;
}

// The engine is onset-based, so there is no memory window to configure: the streaming modes stay fully
// causal (never see the future), and the real distinction is the look-ahead depth (the `la` mode) and
// the backward pass (the two-pass mode). We map each tatum to a fixed musical clock (1 tatum = a 16th at 120 BPM)
// only so co-struck notes (same onset) group into one chord via the `t` they share.
const TATUM_MS = 125;

/** Time-ordered events: at equal t, releases before strikes; strikes bass-first (midi asc). */
function events(notes: Note[]): { t: number; on: boolean; midi: number; i: number }[] {
    const evs: { t: number; on: boolean; midi: number; i: number }[] = [];
    notes.forEach((n, i) => {
        evs.push({ t: n.onset * TATUM_MS, on: true, midi: n.midi, i });
        evs.push({ t: (n.onset + n.dur) * TATUM_MS, on: false, midi: n.midi, i });
    });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || a.midi - b.midi);
    return evs;
}

type Mode = 'core' | 'rt' | 'la' | 'tp';

function predict(mode: Mode, notes: Note[]): (Pitch | null)[] {
    if (mode === 'tp') {
        return spellTwoPass(notes.map(n => ({ midi: n.midi, tOn: n.onset * TATUM_MS, tOff: (n.onset + n.dur) * TATUM_MS }))) as (Pitch | null)[];
    }
    const s: StreamingSpeller = mode === 'core' ? new CoreSpeller()
        : new Speller({ lookAhead: mode === 'la' });
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
    { key: 'core', label: 'core' },
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
// note (no read-back, the jittered noisy corpus produces a few) is excluded, not counted as wrong.
const committedOf = (a: { correct: number; flipped: number; wrong: number }) => a.correct + a.flipped + a.wrong;
const pct = (n: number, d: number) => (100 * n / d).toFixed(2).padStart(6);
const absTotal = MODES.reduce((s, { key }) => s + agg[key].unread, 0);
console.log(`\nMeredith 8x25000: ${noisy ? 'NOISY (human-MIDI-like)' : 'CLEAN'}, ${files.length} movements, ${agg.rt.total} notes${absTotal ? ` (some abstained; % over committed)` : ''}`);
console.log(`  ${'mode'.padEnd(12)} ${'exact%'.padStart(7)} ${'coherent%'.padStart(9)} ${'flip%'.padStart(6)} ${'wrong%'.padStart(6)}`);
for (const { key, label } of MODES) {
    const a = agg[key];
    const n = committedOf(a);
    console.log(`  ${label.padEnd(12)} ${pct(a.correct, n)}% ${pct(a.correct + a.flipped, n)}% ${pct(a.flipped, n)}% ${pct(a.wrong, n)}%`);
}
if (counts) {
    const a = agg.tp;
    console.log(`  two-pass counts: exact ${a.correct}, flipped ${a.flipped}, wrong ${a.wrong}, unread ${a.unread}`);
}
console.log(`  exact = strict composer match (ps13 metric); coherent = exact + contextually coherent flip.`);

// --- machine-readable emit for the scoreboard figure ---------------------------------------
if (jsonPath) {
    const payload = {
        corpus: 'meredith-8x25000',
        variant: noisy ? 'noisy' : 'clean',
        notes: agg.rt.total,
        generated: new Date().toISOString(),
        // Each mode: raw tier counts. Percentages are derived by the consumer over `committed`
        // (correct+flipped+wrong), matching the console output and the baseline snapshot.
        modes: Object.fromEntries(MODES.map(({ key }) => {
            const a = agg[key];
            return [key, { correct: a.correct, flipped: a.flipped, wrong: a.wrong, unread: a.unread, total: a.total, committed: committedOf(a) }];
        })),
    };
    writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    console.log(`  → wrote ${jsonPath}`);
}

// --- optional regression check (clean corpus published thresholds) -------------------------
if (check && !noisy) {
    const laExact = 100 * agg.la.correct / committedOf(agg.la);
    const tpExact = 100 * agg.tp.correct / committedOf(agg.tp);
    const fails: string[] = [];
    // Regression floors for the shipped engine on the clean corpus (measured look-ahead 99.70, two-pass
    // 99.86), set a small margin below so a real regression trips but run-to-run noise does not.
    if (laExact < 99.66) fails.push(`look-ahead exact ${laExact.toFixed(2)}% < 99.66%`);
    if (tpExact < 99.83) fails.push(`two-pass exact ${tpExact.toFixed(2)}% < 99.83%`);
    if (fails.length) { console.error('\n✗ ' + fails.join('\n✗ ')); process.exit(1); }
    console.log('\n✓ exact% at or above published thresholds.');
}
