/**
 * Column-width three-tier scoreboard for the LBD: the FRAMELESS GUARDED family (two modes: real-time +
 * offline two-pass) vs the kept baselines. Terser than tools/figures/three-tier.mjs and sized to survive
 * scaling to one paper column (fonts are a large fraction of the figure width).
 *
 * Our two modes come from results/data/guarded-tiers-<variant>.json (emit with test/eval/guarded-tiers.ts);
 * the baselines from the frozen test/eval/meredith-baselines.json. Kept: real-time, Chew&Chen, offline(2-pass),
 * PKSpell, ps13, Temperley, music21(control). Dropped from the old figure: our core/la modes.
 *
 *   node tools/figures/three-tier-guarded.mjs <clean|noisy> <out.svg>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const [, , variant = 'clean', outPath] = process.argv;
if (!outPath) { console.error('usage: three-tier-guarded.mjs <clean|noisy> <out.svg>'); process.exit(1); }

const ours = JSON.parse(readFileSync(join(REPO, 'results', 'data', `guarded-tiers-${variant}.json`), 'utf8'));
const baselines = JSON.parse(readFileSync(join(REPO, 'test', 'eval', 'meredith-baselines.json'), 'utf8')).variants[variant];

// 7 columns, grouped by latency (causal → offline → control).
const COLUMNS = [
    { src: ['ours', 'rt'], zone: 'real-time', ours: true, label: 'ours real-time' },
    { src: ['base', 'chew_chen'], zone: 'real-time', label: 'Chew & Chen' },
    { src: ['ours', 'tp'], zone: 'offline', ours: true, label: 'ours 2-pass' },
    { src: ['base', 'pkspell'], zone: 'offline', label: 'PKSpell*' },
    { src: ['base', 'ps13'], zone: 'offline', label: 'ps13' },
    { src: ['base', 'temperley'], zone: 'offline', label: 'Temperley' },
    { src: ['base', 'fixed_lof'], zone: 'control', label: 'music21' },
];
const ZONES = { 'real-time': 'real-time', offline: 'offline', control: 'control' };

const C_CORRECT = '#2f6f3b', C_FLIP = '#bd7a1a', C_WRONG = '#8c2f2c', C_OURS = '#1f5fb0';
const FONT = "'DejaVu Sans','Verdana',sans-serif";
const tiersOf = (col) => { const [s, k] = col.src; const t = s === 'ours' ? ours.modes[k] : baselines[k]; const d = t.committed;
    return { exact: 100 * t.correct / d, coherent: 100 * (t.correct + t.flipped) / d, wrong: 100 * t.wrong / d, cov: 100 * d / t.total }; };
const cols = COLUMNS.map(c => ({ ...c, t: tiersOf(c) }));

// Geometry: near-square, sized so text is a large fraction of width (survives \columnwidth scaling).
const W = 1000, H = 820;
const M = { top: 150, right: 26, bottom: 168, left: 96 };
const plotW = W - M.left - M.right, plotH = H - M.top - M.bottom, plotBottom = M.top + plotH;
const Y0 = 90, Y1 = 100;               // broken y-axis: 90–100 %
const y = v => M.top + plotH * (1 - (v - Y0) / (Y1 - Y0));
const n = cols.length, slot = plotW / n, barW = slot * 0.58, cx = i => M.left + slot * (i + 0.5);

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" font-family="' + FONT + '">'];
const push = s => svg.push(s);
const text = (x, yy, s, { size = 22, fill = '#222', anchor = 'middle', weight = 'normal', italic = false } = {}) =>
    push(`<text x="${(+x).toFixed(1)}" y="${(+yy).toFixed(1)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''} fill="${fill}">${esc(s)}</text>`);

push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

// Title (one terse line) + subtitle.
text(W / 2, 44, `Meredith corpus${variant === 'noisy' ? ' (noisy)' : ''}: three-tier accuracy`, { size: 33, weight: 'bold', fill: '#111' });
text(W / 2, 78, 'share of committed notes; y-axis from 90%', { size: 22, fill: '#555' });

// Latency zone bands + labels.
let i = 0;
while (i < n) { const z = cols[i].zone; let j = i; while (j < n && cols[j].zone === z) j++;
    const x0 = M.left + slot * i, x1 = M.left + slot * j;
    push(`<rect x="${x0.toFixed(1)}" y="${M.top}" width="${(x1 - x0).toFixed(1)}" height="${plotH}" fill="#000" fill-opacity="0.04"/>`);
    text((x0 + x1) / 2, M.top - 12, ZONES[z], { size: 21, fill: '#666', italic: true });
    if (j < n) push(`<line x1="${x1.toFixed(1)}" y1="${M.top}" x2="${x1.toFixed(1)}" y2="${plotBottom}" stroke="#555" stroke-width="1.4" stroke-dasharray="6 4"/>`);
    i = j;
}

// y grid + ticks (every 2).
for (let v = Y0; v <= Y1; v += 2) {
    push(`<line x1="${M.left}" y1="${y(v).toFixed(1)}" x2="${W - M.right}" y2="${y(v).toFixed(1)}" stroke="#000" stroke-opacity="0.13"/>`);
    text(M.left - 12, y(v) + 8, String(v), { size: 21, fill: '#444', anchor: 'end' });
}
push(`<line x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${plotBottom}" stroke="#333"/>`);

// Bars + per-bar exact% + x labels.
cols.forEach((c, k) => {
    const { exact, coherent, wrong, cov } = c.t;
    const x = cx(k) - barW / 2, ax = cx(k), yE = y(exact), yC = y(coherent), yTop = y(100), yBot = y(Y0);
    push(`<rect x="${x.toFixed(1)}" y="${yE.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yBot - yE).toFixed(1)}" fill="${C_CORRECT}"/>`);
    if (coherent - exact > 0.001) push(`<rect x="${x.toFixed(1)}" y="${yC.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yE - yC).toFixed(1)}" fill="${C_FLIP}"/>`);
    if (wrong > 0.001) push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${(yC - yTop).toFixed(1)}" fill="${C_WRONG}"/>`);
    // exact% inside the green, near the bar top (white): avoids the crowded top strip.
    text(ax, yE + 28, exact.toFixed(2), { size: 20, weight: 'bold', fill: '#ffffff' });

    // x label; our modes boxed + bold blue.
    const boxY = plotBottom + 14;
    if (c.ours) push(`<rect x="${(ax - slot * 0.46).toFixed(1)}" y="${boxY.toFixed(1)}" width="${(slot * 0.92).toFixed(1)}" height="58" rx="4" fill="none" stroke="${C_OURS}" stroke-width="1.6"/>`);
    // wrap the label onto up to two lines at the space nearest the middle.
    const parts = c.label.split(' ');
    const l1 = parts.length > 1 ? parts.slice(0, Math.ceil(parts.length / 2)).join(' ') : c.label;
    const l2 = parts.length > 1 ? parts.slice(Math.ceil(parts.length / 2)).join(' ') : '';
    text(ax, boxY + 26, l1, { size: 20, weight: c.ours ? 'bold' : 'normal', fill: c.ours ? C_OURS : '#111' });
    if (l2) text(ax, boxY + 49, l2, { size: 20, weight: c.ours ? 'bold' : 'normal', fill: c.ours ? C_OURS : '#111' });
    if (cov < 99.5) text(ax, boxY + (l2 ? 50 : 26) + 22, `cov ${cov.toFixed(0)}%`, { size: 18, fill: C_WRONG });
});

// Legend (one horizontal row along the bottom) + PKSpell note.
const lg = [[C_CORRECT, 'correct', M.left + 4], [C_FLIP, 'flipped = coherent transposition', M.left + 190], [C_WRONG, 'wrong', M.left + 700]];
const legY = H - 42;
lg.forEach(([col, txt, lx]) => {
    push(`<rect x="${lx}" y="${(legY - 18).toFixed(1)}" width="22" height="22" fill="${col}"/>`);
    text(lx + 30, legY, txt, { size: 21, fill: '#222', anchor: 'start' }); });
text(W - M.right, H - 10, '*PKSpell: ISMIR’21 neural', { size: 18, fill: '#666', anchor: 'end', italic: true });

push('</svg>');
writeFileSync(outPath, svg.join('\n'));
console.log(`  → wrote ${outPath} (${cols.length} columns, ${variant})`);
