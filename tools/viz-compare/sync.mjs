/**
 * Copy other spellers' per-note predictions into the viz's LOCAL-ONLY compare overlay.
 *
 *   node tools/viz-compare/sync.mjs                # lab at ../enharmonic-lab
 *   ENHARMONIC_LAB=/path/to/lab node tools/viz-compare/sync.mjs
 *
 * Reads the lab's stored third-party predictions (`test/parity/baselines/<algo>/<fixture>.json`,
 * plus the Meredith per-movement ones under `test/parity/meredith-baselines/clean/<algo>/`) and writes
 * `viz-local/compare/<fixture>/<algo>.json` and `viz-local/compare/index.json`. A lab fixture the viz
 * does not have (not in `fixtures/` or `local-fixtures/`) is copied to `viz-local/fixtures/<id>/`.
 *
 * `viz-local/` is gitignored, and viz/build.mjs copies it only when CI is unset, so third-party outputs
 * never reach the public build. Nothing here is committed except this script.
 *
 * ALIGNMENT: predictions are positional with the fixture's on-events in bass-first order. Every pair is
 * checked against the events the viz will actually load: the on-event count must match, and every
 * non-null prediction's pitch class must equal its note's MIDI pitch class. A pair that fails either
 * check is skipped and listed in index.json `skipped`.
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAB = resolve(process.env.ENHARMONIC_LAB ?? join(REPO, '..', 'enharmonic-lab'));
const OUT = join(REPO, 'viz-local');
const COMPARE = join(OUT, 'compare');
const EXTRA_FIXTURES = join(OUT, 'fixtures');

/** Speller id → menu label. Order is menu order. `fixed_lof` and `music21_midi` are byte-identical to
 *  `music21` (the default MIDI spelling, which the viz already has as its ⊘ control), so they are left out. */
const ALGOS = {
    pkspell_heldout: 'PKSpell',
    pkspell: 'PKSpell (trained on this piece)',
    ps13: 'ps13',
    temperley: 'Temperley',
    chew_chen: 'Chew & Chen',
    cambouropoulos: 'Cambouropoulos',
    longuet_higgins: 'Longuet-Higgins',
    pse: 'PSE',
    musescore: 'MuseScore 4',
    music21: 'music21 (default)',
    music21_ks: 'music21 + Krumhansl-Schmuckler key',
    music21_tkp: 'music21 + Temperley-Kostka-Payne key',
    music21_ae: 'music21 + Aarden-Essen key',
    music21_bb: 'music21 + Bellman-Budge key',
};
/** Meredith's PKSpell outputs are fully held out (PKSpell trained on ASAP), so they file as pkspell_heldout. */
const MEREDITH_ALGO = { pkspell: 'pkspell_heldout' };

const LETTER_FIFTHS = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const pcOf = p => (((LETTER_FIFTHS[p.step] + 7 * p.alter) * 7) % 12 + 12) % 12;
const exists = async p => { try { await stat(p); return true; } catch { return false; } };
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));

/** The events the viz loads for `id`: local-fixtures overrides fixtures (build.mjs order). */
async function vizFixtureDir(id) {
    for (const root of [join(REPO, 'local-fixtures'), join(REPO, 'fixtures')]) {
        if (await exists(join(root, id, 'expected.json'))) return join(root, id);
    }
    return null;
}

const onMidis = events => events.filter(e => e.type === 'on').map(e => e.midi);

/** Check a prediction list against the on-event MIDIs; returns null if aligned, else a reason. */
function misalignment(preds, midis) {
    if (preds.length !== midis.length) return `count ${preds.length} vs ${midis.length} on-events`;
    let bad = 0, first = -1;
    preds.forEach((p, i) => {
        if (p && pcOf(p) !== midis[i] % 12) { bad++; if (first < 0) first = i; }
    });
    return bad ? `${bad} pitch-class mismatches (first at on-index ${first})` : null;
}

async function main() {
    if (!(await exists(join(LAB, 'test', 'parity', 'baselines')))) {
        console.error(`[compare] no lab baselines under ${LAB} (set ENHARMONIC_LAB)`);
        process.exit(1);
    }
    await rm(OUT, { recursive: true, force: true });
    await mkdir(COMPARE, { recursive: true });

    const index = { generated: new Date().toISOString(), lab: LAB, algos: ALGOS, fixtures: {}, skipped: [], copiedFixtures: [] };
    const midiCache = new Map();
    const midisFor = async (id, dir) => {
        if (!midiCache.has(id)) midiCache.set(id, onMidis(await readJson(join(dir, 'events.json'))));
        return midiCache.get(id);
    };

    // Each source: [algo id as filed, directory, fixture-id mapper].
    const sources = [];
    const base = join(LAB, 'test', 'parity', 'baselines');
    for (const algo of await readdir(base)) if (algo in ALGOS) sources.push([algo, join(base, algo), f => f]);
    const mer = join(LAB, 'test', 'parity', 'meredith-baselines', 'clean');
    if (await exists(mer)) for (const algo of await readdir(mer)) {
        const id = MEREDITH_ALGO[algo] ?? algo;
        if (id in ALGOS) sources.push([id, join(mer, algo), f => `meredith_${f}`]);
    }

    for (const [algo, dir, mapId] of sources) {
        for (const file of (await readdir(dir)).filter(f => f.endsWith('.json'))) {
            const id = mapId(file.replace(/\.json$/, ''));
            let fdir = await vizFixtureDir(id);
            if (!fdir && !id.startsWith('meredith_')) {
                // A lab fixture the viz lacks: overlay it locally (only if the lab has it).
                const lab = join(LAB, 'fixtures', id);
                if (await exists(join(lab, 'expected.json'))) {
                    fdir = join(EXTRA_FIXTURES, id);
                    if (!(await exists(fdir))) {
                        await mkdir(fdir, { recursive: true });
                        await cp(join(lab, 'events.json'), join(fdir, 'events.json'));
                        await cp(join(lab, 'expected.json'), join(fdir, 'expected.json'));
                        index.copiedFixtures.push(id);
                    }
                }
            }
            // Most Meredith movements have no viz fixture: not a failure, just nothing to compare against.
            if (!fdir) { if (!id.startsWith('meredith_')) index.skipped.push({ fixture: id, algo, reason: 'no such fixture in the viz or the lab' }); continue; }
            const src = await readJson(join(dir, file));
            const preds = src.predictions ?? [];
            const why = misalignment(preds, await midisFor(id, fdir));
            if (why) { index.skipped.push({ fixture: id, algo, reason: why }); continue; }
            // pkspell (not held out) only where no held-out run exists: elsewhere it is the same model.
            if (algo === 'pkspell' && await exists(join(base, 'pkspell_heldout', file))) continue;
            await mkdir(join(COMPARE, id), { recursive: true });
            // Compact: one ASCII spelling per on-event ("C#", "Eb", "F##"), null where the speller gave none.
            const compact = preds.map(p => p ? p.step + (p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter)) : null);
            await writeFile(join(COMPARE, id, `${algo}.json`), JSON.stringify({ algorithm: algo, fixture: id, predictions: compact }));
            (index.fixtures[id] ??= []).push(algo);
        }
    }
    const order = Object.keys(ALGOS);
    for (const id of Object.keys(index.fixtures)) index.fixtures[id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    await writeFile(join(COMPARE, 'index.json'), JSON.stringify(index, null, 1));
    const pairs = Object.values(index.fixtures).reduce((n, a) => n + a.length, 0);
    console.log(`[compare] ${pairs} speller×fixture files for ${Object.keys(index.fixtures).length} fixtures → viz-local/compare/`);
    console.log(`[compare] ${index.copiedFixtures.length} lab fixtures overlaid locally → viz-local/fixtures/`);
    if (index.skipped.length) {
        console.log(`[compare] skipped ${index.skipped.length} (see index.json):`);
        const byReason = new Map();
        for (const s of index.skipped) byReason.set(`${s.fixture}: ${s.reason}`, [...(byReason.get(`${s.fixture}: ${s.reason}`) ?? []), s.algo]);
        for (const [k, v] of byReason) console.log(`   ${k} [${v.join(', ')}]`);
    }
}

await main();
