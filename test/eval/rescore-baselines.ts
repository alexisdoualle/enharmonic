/**
 * Rescore the third-party baselines on Meredith 8x25000 with THIS repo's scorer, from their stored predictions
 * (enharmonic-lab test/parity/meredith-baselines/{clean,noisy}/<algo>/<movement>.json, written by the lab's
 * tools/meredith/run-baselines.py; the tools themselves need Python and Lisp and do not run here).
 *
 *   npx tsx test/eval/rescore-baselines.ts           # print, compare with test/eval/meredith-baselines.json
 *   npx tsx test/eval/rescore-baselines.ts --write   # also update its tier counts
 *
 * Lab path: $ENHARMONIC_LAB, else ../enharmonic-lab.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pitch } from '../../src/index.js';
import { scoreTiers } from './score.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAB = process.env.ENHARMONIC_LAB || join(REPO, '..', 'enharmonic-lab');
const FROZEN = join(REPO, 'test', 'eval', 'meredith-baselines.json');
const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** One OPNDV movement, sorted bass-first (onset, then midi), as test/eval/meredith.ts reads it. */
function parse(text: string) {
    const notes: { onset: number; step: string; alter: number; midi: number }[] = [];
    const re = /\(\s*(\d+)\s+"([A-G])([nsf]+)(\d+)"\s+(\d+)\s+(\d+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const acc = m[3]!, alter = acc === 'n' ? 0 : [...acc].reduce((a, c) => a + (c === 's' ? 1 : c === 'f' ? -1 : 0), 0);
        notes.push({ onset: Number(m[1]), step: m[2]!, alter, midi: (Number(m[4]) + 1) * 12 + STEP[m[2]!]! + alter });
    }
    return notes.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
}

const frozen = JSON.parse(readFileSync(FROZEN, 'utf8')) as { variants: Record<string, Record<string, Record<string, number>>> };
let same = true;
for (const variant of ['clean', 'noisy']) {
    const stem = variant === 'clean' ? 'opnd-m' : 'opnd-m-noisy';
    const src = join(REPO, 'corpora', 'meredith', stem, stem), preds = join(LAB, 'test', 'parity', 'meredith-baselines', variant);
    if (!existsSync(src) || !existsSync(preds)) { console.log(`${variant}: corpus or lab predictions missing, skipped`); continue; }
    for (const algo of Object.keys(frozen.variants[variant]!)) {
        const t = { correct: 0, flipped: 0, wrong: 0, unread: 0, total: 0 };
        for (const f of readdirSync(src).sort()) {
            const p = join(preds, algo, f.replace(/\.opnd-m(-noisy)?$/, '') + '.json');
            if (!existsSync(p)) continue;
            const notes = parse(readFileSync(join(src, f), 'utf8'));
            const pr = (JSON.parse(readFileSync(p, 'utf8')) as { predictions: ({ step: string; alter: number } | null)[] }).predictions
                .map(x => (x ? { ...x, octave: 4 } as Pitch : null));
            const r = scoreTiers(pr, notes.map(n => ({ step: n.step, alter: n.alter })), notes.map(n => n.onset));
            t.correct += r.correct; t.flipped += r.flipped; t.wrong += r.wrong; t.unread += r.unread; t.total += r.total;
        }
        const old = frozen.variants[variant]![algo]!;
        const diff = old.correct !== t.correct || old.flipped !== t.flipped || old.wrong !== t.wrong;
        if (diff) same = false;
        console.log(`${variant} ${algo.padEnd(16)} correct ${old.correct} -> ${t.correct}  flipped ${old.flipped} -> ${t.flipped}  wrong ${old.wrong} -> ${t.wrong}${diff ? '' : '  (same)'}`);
        if (process.argv.includes('--write')) Object.assign(old, { correct: t.correct, flipped: t.flipped, wrong: t.wrong, committed: t.correct + t.flipped + t.wrong, total: t.total });
    }
}
if (process.argv.includes('--write')) { writeFileSync(FROZEN, JSON.stringify(frozen, null, 2) + '\n'); console.log(`wrote ${FROZEN}`); }
else console.log(same ? 'all identical to the frozen snapshot' : 'differs from the frozen snapshot');
