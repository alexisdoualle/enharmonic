import { LiveSpeller, connectLiveInput, type LiveState } from '../live.js';
import { PitchClass } from '../tonnetz3d/core/PitchClass.js';
import { classifyTriad } from '../tonnetz3d/LatticeGeometry.js';

const LETTER_COLOR: Record<string, string> = {
    C: '#cb6a62', G: '#e0975a', D: '#cdb45c', A: '#6fb389',
    E: '#5aa79b', B: '#6f95c4', F: '#9c78bd',
};
const LOF: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const LOF_LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pcOf = (midi: number) => ((midi % 12) + 12) % 12;
const glyph = (alter: number) => alter === 0 ? '' : alter === 1 ? '♯' : alter === -1 ? '♭' : alter === 2 ? '𝄪' : '𝄫';
const textOn = (hex: string) => {
    const n = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * n[0]! + 0.587 * n[1]! + 0.114 * n[2]! > 150 ? '#222' : '#fff';
};

function pitchAt(n: number): { step: string; alter: number } {
    const step = LOF_LETTERS[((n % 7) + 7) % 7]!;
    return { step, alter: Math.round((n - LOF[step]!) / 7) };
}
function labelAt(n: number): string { const p = pitchAt(n); return p.step + glyph(p.alter); }

const W = 940, H = 700, CX = 470, CY = 350, XLO = -8, XHI = 10;
function raw(x: number, y: number, z: number): [number, number] {
    const angle = (-90 + 30 * x + 15 * y) * Math.PI / 180;
    const radius = 104 + 8 * (x - XLO) + 26 * y;
    const za = angle + Math.PI / 6;
    return [CX + radius * Math.cos(angle) + z * 18 * Math.cos(za),
        CY + radius * Math.sin(angle) + z * 18 * Math.sin(za)];
}
function pos(x: number, y: number, z: number): [number, number] { return raw(x, y, z); }
function pcPoint(k: number, radius: number): [number, number] {
    const a = (-90 + 30 * k) * Math.PI / 180;
    return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}
function line(a: [number, number], b: [number, number], attrs: string): string {
    return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" ${attrs}/>`;
}
function pointsForRow(y: number): string {
    return Array.from({ length: XHI - XLO + 1 }, (_, i) => {
        const [x, yy] = pos(XLO + i, y, 0); return `${x.toFixed(1)},${yy.toFixed(1)}`;
    }).join(' ');
}

const TRIAD_FALLBACK: Record<string, string> = {
    major: '#ffcc80', minor: '#abcefb', diminished: '#f8bbd9', augmented: '#c8e6c9',
    flat5: '#f295c4', aug6: '#f5be9e', aug3: '#b39ddb', dim3: '#80cbc4',
};
const MAJOR_HUE_LOW = 65, MAJOR_HUE_HIGH = 10;
const MINOR_HUE_LOW = 197, MINOR_HUE_HIGH = 236;
function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function triangleColor(type: string, notes: { step: string; alter: number }[], filled: Set<string>): string {
    if ((type === 'major' || type === 'minor') && notes.length === 3) {
        const scale = [...filled].map(k => k.split(':').map(Number))
            .filter(([, y, z]) => y === 0 && z === 0).map(([x]) => x!);
        const min = Math.min(...scale), max = Math.max(...scale);
        if (scale.length > 1 && max > min) {
            const mean = notes.reduce((sum, n) => sum + (LOF[n.step]! + 7 * n.alter), 0) / 3;
            const t = Math.max(0, Math.min(1, (mean - min) / (max - min)));
            return type === 'major'
                ? hslToHex(MAJOR_HUE_LOW + t * (MAJOR_HUE_HIGH - MAJOR_HUE_LOW), 100, 75)
                : hslToHex(MINOR_HUE_LOW + t * (MINOR_HUE_HIGH - MINOR_HUE_LOW), 90, 80);
        }
    }
    return TRIAD_FALLBACK[type] ?? '#abcefb';
}

function trianglePoints(cells: [number, number, number][]): string {
    return cells.map(c => { const [x, y] = pos(...c); return `${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
}

function renderSvg(s: LiveState): string {
    const filled = new Set(s.filledCells);
    const held = new Set(s.heldPCs);
    const p: string[] = [`<svg class="live-tonnetz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="live coiled Tonnetz">`,
        `<rect width="${W}" height="${H}" fill="#fff"/>`];
    for (let k = 0; k < 12; k++) {
        const a = pcPoint(k, 45), b = pcPoint(k, 290);
        p.push(line(a, b, `stroke="${held.has((7 * k) % 12) ? '#6ea8fe' : '#383e49'}" stroke-width="${held.has((7 * k) % 12) ? 1.8 : 0.7}"`));
    }
    for (const y of [-1, 0, 1]) p.push(`<polyline points="${pointsForRow(y)}" fill="none" stroke="${y === 0 ? '#747c89' : '#424955'}" stroke-width="${y === 0 ? 1.2 : 0.75}"/>`);
    for (let x = XLO; x <= XHI; x++) for (const y of [-1, 0]) {
        p.push(line(pos(x, y, 0), pos(x, y + 1, 0), 'stroke="#343a45" stroke-width="0.55"'));
        p.push(line(pos(x, y + 1, 0), pos(x + 1, y, 0), 'stroke="#343a45" stroke-width="0.55"'));
    }
    // The same triangular tiling as the Tonnetz: two flat triangles per cell, plus the two
    // cross-layer forms that become diminished/augmented (and later aug6/dim5) when z cells activate.
    const triangles: [string, [number, number, number][], boolean][] = [];
    for (let x = XLO; x < XHI; x++) for (const y of [-1, 0]) {
        triangles.push(['flat', [[x, y, 0], [x + 1, y, 0], [x, y + 1, 0]], true]);
        triangles.push(['flat', [[x + 1, y, 0], [x, y + 1, 0], [x + 1, y + 1, 0]], true]);
    }
    for (let x = XLO; x < XHI; x++) {
        triangles.push(['cross', [[x, 0, 0], [x + 1, -1, 0], [x + 1, 0, -1]], true]);
        triangles.push(['cross', [[x, 0, 0], [x, 1, 0], [x + 1, 0, 1]], true]);
    }
    for (const [, cells] of triangles) {
        if (!cells.every(c => filled.has(`${c[0]}:${c[1]}:${c[2]}`))) continue;
        const notes = cells.map(([x, y, z]) => pitchAt(x + 4 * y + 7 * z));
        const pcs = notes.map(n => new PitchClass(n.step as any, n.alter));
        const type = classifyTriad(pcs[0]!, pcs[1]!, pcs[2]!);
        if (type === 'unknown') continue;
        const color = triangleColor(type, notes, filled);
        p.push(`<polygon points="${trianglePoints(cells)}" fill="${color}" fill-opacity="0.42" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>`);
    }
    // The five coiled layers: three z=0 rows and the flat/sharp twins of the central row.
    const cells: [number, number, number][] = [];
    for (let x = XLO; x <= XHI; x++) for (const y of [-1, 0, 1]) cells.push([x, y, 0]);
    for (let x = XLO; x <= XHI; x++) { cells.push([x, 0, -1], [x, 0, 1]); }
    for (const [x, y, z] of cells) {
        const [nx, ny] = pos(x, y, z); const note = pitchAt(x + 4 * y + 7 * z);
        const col = LETTER_COLOR[note.step]!; const isFilled = filled.has(`${x}:${y}:${z}`);
        const r = z === 0 && y === 0 ? 10 : z === 0 ? 8 : 6;
        const active = isFilled ? `fill="${col}" stroke="${textOn(col)}" stroke-width="0.9"` : `fill="#fff" stroke="${col}" stroke-width="${z === -1 ? 0.45 : z === 0 && y === -1 ? 0.45 : 0.8}"`;
        p.push(`<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${r}" ${active} ${z !== 0 ? 'stroke-dasharray="2 1.6"' : ''}/>`);
        p.push(`<text x="${nx.toFixed(1)}" y="${(ny + (z === 0 ? 2.3 : 1.8)).toFixed(1)}" text-anchor="middle" font-size="${z === 0 && y === 0 ? 7.2 : z === 0 ? 6.1 : 4.8}" fill="${isFilled ? textOn(col) : col}">${esc(labelAt(x + 4 * y + 7 * z))}</text>`);
    }
    p.push(`<circle cx="${CX}" cy="${CY}" r="39" fill="none" stroke="#4a515e" stroke-width="0.8"/>`);
    for (let k = 0; k < 12; k++) {
        const [x, y] = pcPoint(k, 39), pc = (7 * k) % 12, active = held.has(pc);
        const fill = WHITE_PC.has(pc) ? '#f7f7f4' : '#24262b';
        p.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${active ? 7.5 : 6}" fill="${fill}" stroke="${active ? '#6ea8fe' : '#555b66'}" stroke-width="${active ? 2 : 0.7}"/>`);
        p.push(`<text x="${x.toFixed(1)}" y="${(y + 2.3).toFixed(1)}" text-anchor="middle" font-size="7" fill="${WHITE_PC.has(pc) ? '#222' : '#fff'}">${pc}</text>`);
    }
    p.push(`<text x="${CX}" y="${CY + 3}" text-anchor="middle" font-size="7" fill="#939ba8">12 pc</text>`);
    p.push('</svg>'); return p.join('');
}

export function initLiveTonnetz(host: HTMLElement): void {
    const model = new LiveSpeller();
    host.innerHTML = `<div class="panel-title">live coiled Tonnetz <span class="live-help">MIDI / QWERTY keyboard · fills persist as the current scale</span></div><div class="live-toolbar"><span class="live-status"></span><span class="live-last"></span><button type="button" class="live-fullscreen">fullscreen</button><button type="button" class="live-reset">reset surface</button></div><div class="live-svg-host"></div>`;
    const svgHost = host.querySelector('.live-svg-host') as HTMLElement;
    const status = host.querySelector('.live-status') as HTMLElement;
    const last = host.querySelector('.live-last') as HTMLElement;
    const fullscreen = host.querySelector('.live-fullscreen') as HTMLButtonElement;
    (host.querySelector('.live-reset') as HTMLButtonElement).addEventListener('click', () => model.reset());
    const syncFullscreenLabel = () => {
        const active = document.fullscreenElement === host;
        fullscreen.textContent = active ? 'exit fullscreen' : 'fullscreen';
        fullscreen.setAttribute('aria-label', active ? 'exit fullscreen' : 'enter fullscreen');
    };
    fullscreen.addEventListener('click', () => {
        if (document.fullscreenElement === host) void document.exitFullscreen();
        else void host.requestFullscreen();
    });
    document.addEventListener('fullscreenchange', syncFullscreenLabel);
    syncFullscreenLabel();
    model.subscribe(s => {
        svgHost.innerHTML = renderSvg(s);
        status.textContent = s.midiStatus;
        last.textContent = s.lastSpelling ? `last: ${s.lastSpelling.step}${glyph(s.lastSpelling.alter)} · pc ${pcOf(s.lastMidi!)}` : 'strike a note';
    });
    connectLiveInput(model);
}
