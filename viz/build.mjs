/**
 * Build the viz into a self-contained, host-agnostic `viz-dist/` (static — no backend).
 *
 *   node viz/build.mjs           one-shot build
 *   node viz/build.mjs --watch   rebuild on change (used by serve.mjs)
 *
 * esbuild bundles `viz/src/main.ts` (which imports the REAL shipped kernel from `src/` by path, so
 * the viz shows exactly what the library does — zero drift). The library itself is never modified and
 * stays zero-dependency: esbuild is a dev-only tool, and `viz/` sits outside npm's `files` allowlist.
 *
 * Fixtures are copied in and a `fixtures/manifest.json` is written, so the built page fetches its data
 * with plain relative requests and needs no directory API — it drops onto GitHub Pages (or any static
 * host) as-is.
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const OUT = join(REPO, 'viz-dist');    // the deployed site root (landing page + CNAME live here)
const VIZ = join(OUT, 'viz');          // the interactive app, served under /viz/
const SITE = join(here, 'site');       // static landing page + CNAME, copied to the site root
const FIXTURES = join(REPO, 'fixtures');
const LOCAL_FIXTURES = join(REPO, 'local-fixtures');

const buildOpts = {
    entryPoints: [join(here, 'src/main.ts')],
    // Code-splitting (outdir + splitting) so the 3D tonnetz panel's three.js only downloads as a
    // separate chunk when the user opens that view — it stays out of the app.js everyone loads. The
    // entry still emits as app.js (index.html references it); lazy chunks land under chunks/.
    outdir: VIZ,
    entryNames: 'app',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
};
const liveBuildOpts = {
    entryPoints: [join(here, 'src/livePage.ts')],
    outfile: join(VIZ, 'live.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
};

/** Assemble the site: the landing page + CNAME at the root, the app shell + fixture corpus under /viz/. */
async function copyAssets() {
    await cp(SITE, OUT, { recursive: true });        // landing index.html + CNAME → site root
    await cp(join(here, 'public'), VIZ, { recursive: true });   // app shell (index.html, styles.css) → /viz/
    const ids = [];
    const copyFixtureRoot = async (root) => {
        let entries;
        try { entries = await readdir(root, { withFileTypes: true }); }
        catch { return; } // optional local overlay may not exist
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            try {
                await stat(join(root, e.name, 'expected.json'));
                await cp(join(root, e.name), join(VIZ, 'fixtures', e.name), { recursive: true });
                ids.push(e.name);
            } catch { /* not a fixture dir */ }
        }
    }
    await copyFixtureRoot(FIXTURES);
    // Developer-only fixtures override a committed fixture with the same id. This keeps the
    // overlay useful for trying revised ground truth without changing the shipped corpus.
    await copyFixtureRoot(LOCAL_FIXTURES);
    ids.sort();
    await writeFile(join(VIZ, 'fixtures', 'manifest.json'), JSON.stringify([...new Set(ids)], null, 2));
    console.log(`[viz] site → viz-dist/ (landing + CNAME); app + ${new Set(ids).size} fixtures → viz-dist/viz/`);
}

export async function build({ watch = false } = {}) {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(VIZ, { recursive: true });
    await copyAssets();
    if (watch) {
        const ctx = await esbuild.context(buildOpts);
        const liveCtx = await esbuild.context(liveBuildOpts);
        await Promise.all([ctx.watch(), liveCtx.watch()]);
        console.log('[viz] esbuild watching — saves rebuild app.js and live.js (hard-refresh the browser).');
    } else {
        await esbuild.build(buildOpts);
        await esbuild.build(liveBuildOpts);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await build({ watch: process.argv.includes('--watch') });
}
