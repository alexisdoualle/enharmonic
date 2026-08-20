/**
 * Parity bench + regression gate for the curated fixtures.
 *
 *   npm run bench           print the per-fixture/per-mode table and compare to the
 *                           golden baseline; exit non-zero on ANY drift.
 *   npm run bench:update    re-bless the baseline (test/eval/baseline.json) after an
 *                           intended change. Review the diff before committing.
 *
 * The baseline snapshots exact {correct,flipped,wrong} counts per fixture per mode, so
 * an improvement fails just as loudly as a regression — you must acknowledge it with
 * --update. Counts (not percentages) are the gate: integer, unambiguous, ungameble.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FIXTURES, loadEvents, loadExpected, predict, type Mode } from './fixtures.js';
import { scoreTiers, type Tiers } from './score.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'baseline.json');
const MODES: Mode[] = ['rt', 'la', 'tp'];
const MODE_LABEL: Record<Mode, string> = { rt: 'real-time', la: 'look-ahead', tp: 'two-pass' };

type Cell = Pick<Tiers, 'correct' | 'flipped' | 'wrong' | 'total'>;
type Snapshot = Record<string, Record<Mode, Cell>>;

function measure(): Snapshot {
    const snap: Snapshot = {};
    for (const id of FIXTURES) {
        const events = loadEvents(id);
        const expected = loadExpected(id);
        snap[id] = {} as Record<Mode, Cell>;
        for (const mode of MODES) {
            const t = scoreTiers(predict(mode, events), expected);
            if (t.unread) throw new Error(`${id}/${mode}: ${t.unread} unread onset(s)`);
            snap[id]![mode] = { correct: t.correct, flipped: t.flipped, wrong: t.wrong, total: t.total };
        }
    }
    return snap;
}

const pct = (n: number, d: number) => (100 * n / d).toFixed(2).padStart(6);

function printTable(snap: Snapshot): void {
    for (const mode of MODES) {
        console.log(`\n  ${MODE_LABEL[mode]}`);
        let C = 0, F = 0, W = 0, T = 0;
        for (const id of FIXTURES) {
            const c = snap[id]![mode];
            C += c.correct; F += c.flipped; W += c.wrong; T += c.total;
            console.log(`    ${id.padEnd(26)} exact ${pct(c.correct, c.total)}%  flip ${pct(c.flipped, c.total)}%  wrong ${pct(c.wrong, c.total)}%  (n=${c.total})`);
        }
        console.log(`    ${'TOTAL'.padEnd(26)} exact ${pct(C, T)}%  flip ${pct(F, T)}%  wrong ${pct(W, T)}%  (n=${T})`);
    }
}

function diff(current: Snapshot, baseline: Snapshot): string[] {
    const msgs: string[] = [];
    for (const id of FIXTURES) {
        for (const mode of MODES) {
            const a = current[id]?.[mode], b = baseline[id]?.[mode];
            if (!b) { msgs.push(`+ ${id}/${mode}: new (not in baseline)`); continue; }
            if (a!.correct !== b.correct || a!.flipped !== b.flipped || a!.wrong !== b.wrong || a!.total !== b.total) {
                msgs.push(`~ ${id}/${mode}: correct ${b.correct}→${a!.correct}, flip ${b.flipped}→${a!.flipped}, wrong ${b.wrong}→${a!.wrong}, n ${b.total}→${a!.total}`);
            }
        }
    }
    return msgs;
}

const update = process.argv.includes('--update');
const current = measure();
console.log('enharmonic — curated fixture parity');
printTable(current);

if (update) {
    writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log(`\n✓ baseline written to ${BASELINE_PATH}`);
    process.exit(0);
}

let baseline: Snapshot;
try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Snapshot;
} catch {
    console.error(`\n✗ no baseline at ${BASELINE_PATH}. Run \`npm run bench:update\` to create it.`);
    process.exit(1);
}

const drift = diff(current, baseline);
if (drift.length) {
    console.error('\n✗ parity drift vs baseline:');
    for (const m of drift) console.error(`    ${m}`);
    console.error('\n  If intended, re-bless with `npm run bench:update`.');
    process.exit(1);
}
console.log('\n✓ parity matches baseline.');
