/**
 * Regenerate the two-rung LBD scoreboard figures (column-width), on demand.
 *   npm run scoreboard:guarded
 * Scores the two shipped tiers (real-time `Speller` + offline `spellTwoPass`) on Meredith
 * clean + noisy via test/eval/guarded-tiers.ts, then renders the column-width three-tier SVGs via
 * three-tier-guarded.mjs. Baselines come from the frozen test/eval/meredith-baselines.json.
 * Outputs: results/data/guarded-tiers-{clean,noisy}.json and results/figures/scoreboard_meredith_{clean,noisy}.svg.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA = join(REPO, 'results', 'data');
const FIG = join(REPO, 'results', 'figures');
mkdirSync(DATA, { recursive: true });
mkdirSync(FIG, { recursive: true });

const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: REPO, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`✗ ${cmd} ${args.join(' ')} (exit ${r.status})`); process.exit(r.status ?? 1); }
};

for (const variant of ['clean', 'noisy']) {
    const jsonOut = join(DATA, `guarded-tiers-${variant}.json`);
    run('npx', ['tsx', 'test/eval/guarded-tiers.ts', variant, jsonOut]);
    run('node', ['tools/figures/three-tier-guarded.mjs', variant, join(FIG, `scoreboard_meredith_${variant}.svg`)]);
}
console.log('\n✓ guarded scoreboard → results/figures/scoreboard_meredith_{clean,noisy}.svg');
