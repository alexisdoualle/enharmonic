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
const OUT = join(REPO, 'viz-dist');
const FIXTURES = join(REPO, 'fixtures');

const buildOpts = {
    entryPoints: [join(here, 'src/main.ts')],
    outfile: join(OUT, 'app.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
};
const liveBuildOpts = {
    entryPoints: [join(here, 'src/livePage.ts')],
    outfile: join(OUT, 'live.js'),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'info',
};

/** Copy the static shell (index.html, styles.css) and the fixture corpus into viz-dist/. */
async function copyAssets() {
    await cp(join(here, 'public'), OUT, { recursive: true });
    const ids = [];
    for (const e of await readdir(FIXTURES, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try {
            await stat(join(FIXTURES, e.name, 'expected.json'));
            await cp(join(FIXTURES, e.name), join(OUT, 'fixtures', e.name), { recursive: true });
            ids.push(e.name);
        } catch { /* not a fixture dir */ }
    }
    ids.sort();
    await writeFile(join(OUT, 'fixtures', 'manifest.json'), JSON.stringify(ids, null, 2));
    console.log(`[viz] copied ${ids.length} fixtures + shell → viz-dist/`);
}

export async function build({ watch = false } = {}) {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
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
