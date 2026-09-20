/**
 * Three-tier (correct / flipped / wrong) Meredith scoreboard — rendered as a self-contained SVG,
 * styled to match the original matplotlib figure (DejaVu Sans, latency bands, blue "Enharmonic"
 * brackets on our rungs, bottom-left legend).
 *
 * Sourced entirely from THIS repo: our four shipped rungs are scored live by
 * `test/eval/meredith.ts --json` (the real speller), and the third-party baselines come from the
 * committed snapshot `test/eval/meredith-baselines.json` (frozen external-tool scores — they can't
 * run in this zero-dep repo; see that file's _provenance). No dependency on the legacy lab.
 *
 * Usage (normally via `npm run scoreboard`, which scores first):
 *   node tools/figures/three-tier.mjs <ours.json> <variant> <out.svg>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const [, , oursPath, variant = 'clean', outPath] = process.argv;
if (!oursPath || !outPath) {
    console.error('usage: node tools/figures/three-tier.mjs <ours.json> <clean|noisy> <out.svg>');
    process.exit(1);
}

const ours = JSON.parse(readFileSync(oursPath, 'utf8'));
const baseSnap = JSON.parse(readFileSync(join(REPO, 'test', 'eval', 'meredith-baselines.json'), 'utf8'));
const baselines = baseSnap.variants[variant];
if (!baselines) { console.error(`no baseline snapshot for variant '${variant}'`); process.exit(1); }

// Column order, grouped by LATENCY (causal → bounded → offline → control) — the original design.
const COLUMNS = [
    { src: ['ours', 'core'], latency: 'causal', ours: true, label: ['CoreSpeller', '(~100 lines)'] },
    { src: ['ours', 'rt'], latency: 'causal', ours: true, label: ['real-time', '(guard + fold + leash)'] },
    { src: ['base', 'chew_chen'], latency: 'causal', label: ['Chew & Chen', '(spiral array)'] },
    { src: ['ours', 'la'], latency: 'bounded', ours: true, label: ['real-time +LA', '(letter look-ahead)'] },
    { src: ['ours', 'tp'], latency: 'offline', ours: true, label: ['+2-pass', '(offline, batch)'] },
    { src: ['base', 'pkspell'], latency: 'offline', label: ['PKSpell', "(ISMIR'21 neural)"] },
    { src: ['base', 'ps13'], latency: 'offline', label: ['ps13', '(Meredith)'] },
    { src: ['base', 'temperley'], latency: 'offline', label: ['Temperley', '(Melisma 2003)'] },
    { src: ['base', 'fixed_lof'], latency: 'control', label: ['fixed LoF window', '(E♭–G♯ = music21 default)'] },
];

// matplotlib palette (exact) + latency accents.
const C_CORRECT = '#2f6f3b', C_FLIP = '#bd7a1a', C_WRONG = '#8c2f2c', C_OURS = '#1f5fb0';
const LAT = {
    causal: { title: 'CAUSAL — 0 look-ahead (strict real-time)', c: '#2f6f3b' },
    bounded: { title: 'BOUNDED look-ahead (≈16-note buffer)', c: '#b8860b' },
    offline: { title: 'OFFLINE — whole-piece look-ahead', c: '#5a3f8f' },
    control: { title: 'CONTROL', c: '#6b6b6b' },
};
const FONT = "'DejaVu Sans','Bitstream Vera Sans','Verdana',sans-serif";

function tiersOf(col) {
    const [src, key] = col.src;
    const t = src === 'ours' ? ours.rungs[key] : baselines[key];
    if (!t) throw new Error(`missing tiers for ${src}:${key}`);
    const d = t.committed;
    return { exact: 100 * t.correct / d, coherent: 100 * (t.correct + t.flipped) / d, wrong: 100 * t.wrong / d, cov: 100 * d / t.total };
}
const cols = COLUMNS.map(c => ({ ...c, t: tiersOf(c) }));

// --- geometry (17:9, matching figsize=(17,9)) ---------------------------------------------
const W = 1700, H = 900;
const M = { top: 134, right: 30, bottom: 132, left: 86 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom;
const Y0 = 90, Y1 = 100;
const y = v => M.top + plotH * (1 - (v - Y0) / (Y1 - Y0));
const plotBottom = M.top + plotH;
const n = cols.length, slot = plotW / n, barW = slot * 0.52;
const cx = i => M.left + slot * (i + 0.5);
const FS = pt => (pt * W / (17 * 72)).toFixed(1);      // matplotlib points → px in this SVG
const ROW = { title1: 34, title2: 58, zone: 88, exact: 110, coh: 125 };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = [];
const push = s => svg.push(s);
const text = (x, yy, s, { size = 8, fill = '#222', anchor = 'middle', weight = 'normal', italic = false } = {}) =>
    push(`<text x="${(+x).toFixed(1)}" y="${(+yy).toFixed(1)}" text-anchor="${anchor}" font-size="${FS(size)}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''} fill="${fill}">${esc(s)}</text>`);

push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

// latency bands (alpha 0.06) + zone titles + dashed separators
let i = 0;
while (i < n) {
    const lat = cols[i].latency; let j = i;
    while (j < n && cols[j].latency === lat) j++;
    const x0 = M.left + slot * i, x1 = M.left + slot * j;
    push(`<rect x="${x0.toFixed(1)}" y="${M.top}" width="${(x1 - x0).toFixed(1)}" height="${plotH}" fill="${LAT[lat].c}" fill-opacity="0.06"/>`);
    text((x0 + x1) / 2, ROW.zone, LAT[lat].title, { size: 8, fill: LAT[lat].c, italic: true });
    if (j < n) push(`<line x1="${x1.toFixed(1)}" y1="${M.top}" x2="${x1.toFixed(1)}" y2="${plotBottom}" stroke="#444" stroke-width="1.4" stroke-opacity="0.7" stroke-dasharray="6 4"/>`);
    i = j;
}

// y grid + ticks (every 2)
for (let v = Y0; v <= Y1; v += 2) {
    push(`<line x1="${M.left}" y1="${y(v).toFixed(1)}" x2="${W - M.right}" y2="${y(v).toFixed(1)}" stroke="#000" stroke-opacity="0.14" stroke-width="1"/>`);
    text(M.left - 11, y(v) + 4, String(v), { size: 8.5, fill: '#333', anchor: 'end' });
}
// left spine + broken-axis marks near the floor
push(`<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${plotBottom}" stroke="#333" stroke-width="1"/>`);
const span = plotH;
push(`<line x1="${M.left}" y1="${(plotBottom - span * 0.006).toFixed(1)}" x2="${M.left}" y2="${(plotBottom - span * 0.020).toFixed(1)}" stroke="#000" stroke-width="1.4"/>`);
for (const f of [0.010, 0.016]) push(`<line x1="${(M.left - 6).toFixed(1)}" y1="${(plotBottom - span * (f - 0.003)).toFixed(1)}" x2="${(M.left + 6).toFixed(1)}" y2="${(plotBottom - span * (f + 0.003)).toFixed(1)}" stroke="#000" stroke-width="1.4"/>`);
push(`<text transform="translate(26 ${(M.top + plotH / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="${FS(9.5)}" fill="#222">Share of committed notes (%) — y-axis starts at 90%</text>`);

// bars + annotations + x labels
cols.forEach((c, k) => {
    const { exact, coherent, wrong, cov } = c.t;
    const x = cx(k) - barW / 2, ax = cx(k);
    const yE = y(exact), yC = y(coherent), yTop = y(100), yBot = y(Y0);
    push(`<rect x="${x.toFixed(1)}" y="${yE.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yBot - yE).toFixed(1)}" fill="${C_CORRECT}"/>`);
    if (coherent - exact > 0.001) push(`<rect x="${x.toFixed(1)}" y="${yC.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yE - yC).toFixed(1)}" fill="${C_FLIP}"/>`);
    if (wrong > 0.001) push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yC - yTop).toFixed(1)}" fill="${C_WRONG}"/>`);

    text(ax, ROW.exact, `${exact.toFixed(2)} exact`, { size: 8.5, fill: C_CORRECT, weight: 'bold' });
    text(ax, ROW.coh, `${coherent.toFixed(2)} coherent · ${wrong.toFixed(2)} wrong`, { size: 7.2, fill: '#444' });

    // x-axis labels; our rungs get a blue box
    const boxY = plotBottom + 22;
    if (c.ours) {
        const bw = slot * 0.9, bx = ax - bw / 2;
        push(`<rect x="${bx.toFixed(1)}" y="${boxY.toFixed(1)}" width="${bw.toFixed(1)}" height="52" rx="3" fill="none" stroke="${C_OURS}" stroke-width="1.1"/>`);
    }
    text(ax, boxY + 16, c.label[0], { size: 8, fill: '#111', weight: c.ours ? 'bold' : 'normal' });
    text(ax, boxY + 30, c.label[1], { size: 7.5, fill: '#444' });
    text(ax, boxY + 44, `cov ${cov.toFixed(0)}%` + (cov < 66 ? '  ⚠' : ''), { size: 7.5, fill: cov < 66 ? C_WRONG : '#666' });
});

// ps13 published reference line (drawn over the bars)
const PS13 = 99.31;
push(`<line x1="${M.left}" y1="${y(PS13).toFixed(1)}" x2="${W - M.right}" y2="${y(PS13).toFixed(1)}" stroke="#222" stroke-width="1.3" stroke-dasharray="1.5 3"/>`);
text(W - M.right - 4, y(PS13) - 5, `ps13 published (Meredith 2006) — ${PS13.toFixed(2)}% exact`, { size: 8, fill: '#222', anchor: 'end', italic: true });

// title (two lines, matplotlib set_title style)
text(W / 2, ROW.title1, `Meredith 8×25000 corpus (${variant === 'clean' ? 'clean' : 'noisy (human-performance timing)'}) — this repo's spellers vs published baselines, split three ways`, { size: 12, fill: '#111', weight: 'bold' });
text(W / 2, ROW.title2, '(above each bar: exact = correct only; coherent = correct + flipped)', { size: 11, fill: '#222' });

// legend — lower-left inside the plot, vertical stack, white box (framealpha 0.95)
const lg = [[C_CORRECT, 'correct (exact composer spelling)'], [C_FLIP, 'flipped (coherent enharmonic side)'], [C_WRONG, 'wrong (genuine spelling error)']];
const lgX = M.left + 12, lgY = plotBottom - 14 - lg.length * 22, lgW = 320;
push(`<rect x="${(lgX - 8).toFixed(1)}" y="${(lgY - 16).toFixed(1)}" width="${lgW}" height="${lg.length * 22 + 14}" rx="3" fill="#ffffff" fill-opacity="0.95" stroke="#cccccc" stroke-width="1"/>`);
lg.forEach(([col, txt], r) => {
    const ry = lgY + r * 22;
    push(`<rect x="${lgX}" y="${(ry - 11).toFixed(1)}" width="15" height="15" fill="${col}"/>`);
    text(lgX + 22, ry + 1, txt, { size: 9, fill: '#222', anchor: 'start' });
});

push('</svg>');
writeFileSync(outPath, svg.join('\n'));
console.log(`  → wrote ${outPath} (${cols.length} columns, ${variant})`);
