/**
 * Augmented-sixth head-to-head on grieg_death_of_ase: this repo's four rungs against
 * the third-party baselines, three-tier scored, plus how many of the piece's 19
 * augmented-sixth ♯4 tones (E♯/B♯) each speller recovers.
 *
 *   npm run aug6-baselines                 # reads $ENHARMONIC_LAB (else ../enharmonic-lab)
 *   ENHARMONIC_LAB=/path npm run aug6-baselines
 *
 * The ♯4 (E♯ vs F, B♯ vs C) is the one note that separates an augmented sixth from a
 * dominant seventh. A speller that spells it as the natural has read every aug6 as a
 * dom7. Our rungs run live here; the third-party baselines (ps13, Chew & Chen, PKSpell,
 * Temperley, music21, PSE) are Python/neural and cannot run in this zero-dep repo, so we
 * read their FROZEN per-fixture predictions cached at $ENHARMONIC_LAB and score them with
 * THIS repo's three-tier scorer. Ground truth is byte-identical across the two sources
 * (checked), so the comparison is apples-to-apples.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEvents, loadExpected, onsetKeys, predict, type Mode } from './fixtures.js';
import { scoreTiers } from './score.js';
import type { Pitch } from '../../src/index.js';

const FIX = 'grieg_death_of_ase';
const LAB = process.env.ENHARMONIC_LAB || join(process.cwd(), '..', 'enharmonic-lab');
const BASELINES = join(LAB, 'test', 'parity', 'baselines');

const events = loadEvents(FIX);
const expected = loadExpected(FIX);
const keys = onsetKeys(events);

// The aug6 ♯4 tones are the E♯ / B♯ of the ground truth: recovery = an exact-spelling match
// (anything else is the dom7 reading, the natural a semitone below).
const aug6 = expected
    .map((x, i) => ({ i, x }))
    .filter(({ x }) => (x.step === 'E' && x.alter === 1) || (x.step === 'B' && x.alter === 1));

function aug6Recovered(pred: readonly (Pitch | null)[]): number {
    let n = 0;
    for (const { i, x } of aug6) {
        const p = pred[i];
        if (p && p.step === x.step && p.alter === x.alter) n++;
    }
    return n;
}

interface Row { name: string; correct: number; flipped: number; wrong: number; unread: number; aug6: number; }
const rows: Row[] = [];

const RUNG_LABEL: Record<Mode, string> = {
    core: 'Core (ours)', rt: 'rt (ours)', la: 'la (ours)', tp: 'two-pass (ours)',
};
for (const m of ['core', 'rt', 'la', 'tp'] as Mode[]) {
    const pred = predict(m, events);
    const t = scoreTiers(pred, expected, keys);
    rows.push({ name: RUNG_LABEL[m], ...t, aug6: aug6Recovered(pred) });
}

let labSeen = 0;
try {
    for (const dir of readdirSync(BASELINES).sort()) {
        let raw: string;
        try { raw = readFileSync(join(BASELINES, dir, `${FIX}.json`), 'utf8'); } catch { continue; }
        const data = JSON.parse(raw) as { predictions: ({ step: string; alter: number } | null)[] };
        const pred = data.predictions.map(p => (p ? { step: p.step, alter: p.alter } as Pitch : null));
        if (pred.length !== expected.length) { console.error(`skip ${dir}: length ${pred.length} != ${expected.length}`); continue; }
        const t = scoreTiers(pred, expected, keys);
        rows.push({ name: dir, ...t, aug6: aug6Recovered(pred) });
        labSeen++;
    }
} catch {
    // Lab absent: still print our rungs.
}
if (labSeen === 0) {
    console.error(`\nNo cached baselines found under ${BASELINES}`);
    console.error('Set $ENHARMONIC_LAB to the legacy repo (or place it at ../enharmonic-lab) for the third-party rows.\n');
}

rows.sort((a, b) => a.wrong - b.wrong);
const N = expected.length;
const L = (s: string, n: number) => s.padEnd(n);
const R = (s: string, n: number) => s.padStart(n);
console.log(`\n${FIX} — ${N} notes, ${aug6.length} aug6 ♯4 tones (E♯/B♯)\n`);
console.log(L('speller', 22), R('correct', 8), R('flip', 6), R('wrong', 6), R('unread', 7), R('coherent%', 10), R('aug6 ♯4', 9));
console.log('-'.repeat(74));
for (const r of rows) {
    const coherent = ((r.correct + r.flipped) / N * 100).toFixed(2);
    console.log(
        L(r.name, 22), R(String(r.correct), 8), R(String(r.flipped), 6), R(String(r.wrong), 6),
        R(String(r.unread), 7), R(coherent, 10), R(`${r.aug6}/${aug6.length}`, 9),
    );
}
console.log();
