/**
 * Scoreboard — the clean, self-contained benchmark process for THIS repo.
 *
 * Scores this repo's four shipped rungs against the held-out Meredith 8×25000 corpus (the real
 * `Speller` / `spellTwoPass`, via test/eval/meredith.ts --json), renders the three-tier figures,
 * and writes results/RESULTS.md. Third-party baselines come from the committed snapshot
 * test/eval/meredith-baselines.json (frozen external-tool scores; see its _provenance).
 *
 * This REPLACES the old results/refresh.mjs lab-mirror: the numbers are now produced by the code
 * that ships here, not copied from the legacy enharmonic-lab. Everything lands in gitignored
 * results/ — copy a chosen figure out to a committed path (e.g. docs/assets/) to use it publicly.
 *
 *   npm run scoreboard          # clean + noisy (whichever corpora are fetched)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA = join(REPO, 'results', 'data');
const FIG = join(REPO, 'results', 'figures');
mkdirSync(DATA, { recursive: true });
mkdirSync(FIG, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
const corpus = variant => join(REPO, 'corpora', 'meredith', variant === 'noisy' ? 'opnd-m-noisy' : 'opnd-m', variant === 'noisy' ? 'opnd-m-noisy' : 'opnd-m');

const done = [];
for (const variant of ['clean', 'noisy']) {
    if (!existsSync(corpus(variant))) { console.log(`\n(skipping ${variant}: corpus not fetched — run scripts/fetch-meredith.sh)`); continue; }
    const jsonOut = join(DATA, `meredith-${variant}.json`);
    console.log(`\n=== scoring ${variant} ===`);
    run('npx', ['tsx', 'test/eval/meredith.ts', ...(variant === 'noisy' ? ['--noisy'] : []), '--json', jsonOut]);
    run('node', ['tools/figures/three-tier.mjs', jsonOut, variant, join(FIG, `scoreboard_meredith_${variant}.svg`)]);
    done.push(variant);
}
if (!done.length) { console.error('\n✗ no corpora fetched; nothing to score.'); process.exit(1); }

// --- write results/RESULTS.md --------------------------------------------------------------
const baseSnap = JSON.parse(readFileSync(join(REPO, 'test', 'eval', 'meredith-baselines.json'), 'utf8'));
const RUNGS = [['core', 'Core (~100 lines)', 'real-time'], ['rt', 'real-time speller', 'real-time'], ['la', 'real-time + look-ahead', 'near-real-time'], ['tp', 'two-pass speller', 'offline']];
const BASE = [['chew_chen', 'Chew & Chen (spiral array)', 'causal'], ['pkspell', 'PKSpell (ISMIR’21 neural)', 'offline'], ['ps13', 'ps13 (Meredith)', 'offline'], ['temperley', 'Temperley (Melisma 2003)', 'offline'], ['fixed_lof', 'fixed LoF window (= music21 default)', 'control']];
const pct = (num, den) => (100 * num / den).toFixed(2);
const ex = t => pct(t.correct, t.committed), co = t => pct(t.correct + t.flipped, t.committed), wr = t => pct(t.wrong, t.committed);

const md = [];
md.push('# Results — Meredith scoreboard (this repo)\n');
md.push('> **AUTO-GENERATED** by `npm run scoreboard` from THIS repo\'s shipped speller — not mirrored');
md.push('> from the legacy `enharmonic-lab`. Third-party baselines are a frozen snapshot');
md.push('> (`test/eval/meredith-baselines.json`); everything else is scored live here.');
md.push(`> Generated ${new Date().toISOString().slice(0, 10)}. Held-out corpus: Meredith 8×25000 (195,972 notes).\n`);

for (const variant of done) {
    const d = JSON.parse(readFileSync(join(DATA, `meredith-${variant}.json`), 'utf8'));
    const base = baseSnap.variants[variant];
    md.push(`## Meredith — ${variant}\n`);
    md.push('### The four-rung ladder (our shipped spellers)\n');
    md.push('| Rung | Latency | exact % | coherent % | wrong % |');
    md.push('|---|---|--:|--:|--:|');
    for (const [key, label, lat] of RUNGS) { const t = d.rungs[key]; md.push(`| ${label} | ${lat} | ${ex(t)} | ${co(t)} | ${wr(t)} |`); }
    md.push('\n### Vs published baselines\n');
    md.push('| Algorithm | Latency | exact % | coherent % | wrong % | coverage % |');
    md.push('|---|---|--:|--:|--:|--:|');
    for (const [key, label, lat] of RUNGS) { const t = d.rungs[key]; md.push(`| **${label}** | ${lat} | ${ex(t)} | ${co(t)} | ${wr(t)} | ${pct(t.committed, t.total)} |`); }
    for (const [key, label, lat] of BASE) { const t = base[key]; md.push(`| ${label} | ${lat} | ${ex(t)} | ${co(t)} | ${wr(t)} | ${pct(t.committed, t.total)} |`); }
    md.push('');
    md.push(`![scoreboard ${variant}](figures/scoreboard_meredith_${variant}.svg)\n`);
}
md.push('_exact = strict composer-spelling match (ps13’s metric); coherent = exact + coherent enharmonic flip; wrong = 1 − coherent. ps13 published 99.31% exact on this corpus._\n');
md.push('> Second corpus: the lab’s curated set can be scored with the SAME rungs via `npm run lab-corpus` (reads `$ENHARMONIC_LAB` in place; never copied in). It is not part of this scoreboard.');

writeFileSync(join(REPO, 'results', 'RESULTS.md'), md.join('\n') + '\n');
console.log(`\n✓ scoreboard complete → results/RESULTS.md + results/figures/scoreboard_meredith_{${done.join(',')}}.svg`);
