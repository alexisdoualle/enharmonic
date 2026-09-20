/**
 * Second corpus — score THIS repo's shipped rungs against the legacy lab's curated fixtures,
 * IN PLACE, without hoisting them into this repo.
 *
 *   npm run lab-corpus                 # reads $ENHARMONIC_LAB/fixtures (else ../enharmonic-lab)
 *   ENHARMONIC_LAB=/path npm run lab-corpus
 *
 * The lab (`enharmonic-lab`) is the legacy experimental repo, to be retired; its curated corpus
 * (~59 hand-audited fixtures, broader than the 6 shipped here) is a useful independent check while
 * it lasts. Its fixtures use the SAME format as this repo (events.json on/off + positional
 * expected.json), so we drive them with the real speller and the shared three-tier scorer — no copy,
 * no lab code. If the lab is gone, this simply reports the path is missing.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { predict, onsetKeys, type BatchEv, type Expected, type Mode } from './fixtures.js';
import { scoreTiers } from './score.js';

const LAB = process.env.ENHARMONIC_LAB || join(process.cwd(), '..', 'enharmonic-lab');
const FIXTURES = join(LAB, 'fixtures');
if (!existsSync(FIXTURES)) {
    console.error(`✗ lab fixtures not found: ${FIXTURES}\n  Set $ENHARMONIC_LAB to the legacy repo, or place it at ../enharmonic-lab.`);
    process.exit(1);
}

const ids = readdirSync(FIXTURES)
    .filter(id => existsSync(join(FIXTURES, id, 'events.json')) && statSync(join(FIXTURES, id)).isDirectory())
    .sort();

const loadEvents = (id: string): BatchEv[] =>
    (JSON.parse(readFileSync(join(FIXTURES, id, 'events.json'), 'utf8')) as { t_ms: number; type: string; midi: number }[])
        .filter(e => e.type === 'on' || e.type === 'off')
        .map(e => ({ t: e.t_ms, type: e.type as 'on' | 'off', midi: e.midi }));
const loadExpected = (id: string): Expected[] =>
    (JSON.parse(readFileSync(join(FIXTURES, id, 'expected.json'), 'utf8')) as Expected[]).map(e => ({ step: e.step, alter: e.alter }));

const MODES: Mode[] = ['core', 'rt', 'la', 'tp'];
const LABELS: Record<Mode, string> = { core: 'core (rung 1)', rt: 'real-time', la: 'look-ahead', tp: 'two-pass' };
const pct = (n: number, d: number) => (100 * n / d).toFixed(2).padStart(6);

const agg: Record<Mode, { correct: number; flipped: number; wrong: number; total: number }> =
    { core: { correct: 0, flipped: 0, wrong: 0, total: 0 }, rt: { correct: 0, flipped: 0, wrong: 0, total: 0 }, la: { correct: 0, flipped: 0, wrong: 0, total: 0 }, tp: { correct: 0, flipped: 0, wrong: 0, total: 0 } };

for (const id of ids) {
    const events = loadEvents(id), expected = loadExpected(id), keys = onsetKeys(events);
    for (const mode of MODES) {
        const t = scoreTiers(predict(mode, events), expected, keys);
        agg[mode].correct += t.correct; agg[mode].flipped += t.flipped; agg[mode].wrong += t.wrong; agg[mode].total += t.total;
    }
}

console.log(`\nLab curated corpus (SECOND corpus, referenced in place) — ${ids.length} fixtures — ${LAB}`);
console.log(`  ${'mode'.padEnd(12)} ${'exact%'.padStart(7)} ${'coherent%'.padStart(9)} ${'flip%'.padStart(6)} ${'wrong%'.padStart(6)}`);
for (const mode of MODES) {
    const a = agg[mode], co = a.correct + a.flipped;
    console.log(`  ${LABELS[mode].padEnd(12)} ${pct(a.correct, a.total)}% ${pct(co, a.total)}% ${pct(a.flipped, a.total)}% ${pct(a.wrong, a.total)}%`);
}
console.log(`  exact = strict composer match; coherent = exact + contextually coherent flip.`);
