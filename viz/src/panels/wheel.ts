/**
 * The line of fifths drawn as a true SPIRAL — a seamless circle-of-fifths ribbon that, instead of
 * closing, spirals so the two ends stack at the seam: a key and its enharmonic 12 fifths away share an
 * angle but sit one turn apart radially (G♭ inner, F♯ outer at the tritone). That is the exact
 * distinction the spiral frame reasons about — C♯(+7) and D♭(−5) are DIFFERENT positions, not one
 * wheel node. The live key (the kernel's signed line-of-fifths tonic) lights up; its collection is the
 * 7-fifth run around it. The band spans the shipped speller's reachable range [center−depth …
 * center+depth] = [−5 … +7], so the active turn is always on-screen. The two END cells are dashed —
 * the fold-back cap past which continuity would respell rather than dig deeper.
 *
 * Ported from the lab viz (`music/wheel.ts` renderSpiral), stripped of the research local-key overlay.
 * depth/center are pinned to the shipped BoxWindowSubstrate defaults (spiralRange 6, spiralCenter +1).
 */
import type { Snapshot } from '../replay.js';
import { fifths } from '../replay.js';
import {
    SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, SPIRAL_RANGE_MIN, SPIRAL_RANGE_MAX,
    SPIRAL_CENTER_MIN, SPIRAL_CENTER_MAX,
} from '../state.js';
import { label } from '../format.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Controls + drawing params for the spiral panel. `range`/`center` are the values the replay actually
 *  ran with (shipped default 6 / +1); `onChange` reconfigures the substrate and rebuilds. `streaming`
 *  is false in batch two-pass, where the spiral is inert and the controls are disabled. */
export interface WheelOpts {
    range: number;
    center: number;
    streaming: boolean;
    onChange: (range: number, center: number) => void;
}

// Spelling of a key at signed line-of-fifths position `lof` (…F=−1, C=0, G=1…, F♯=+6, C♯=+7…).
const LOF_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
function keyName(lof: number): string {
    const idx = ((lof + 1) % 7 + 7) % 7;
    const alt = Math.floor((lof + 1) / 7);
    return LOF_ORDER[idx]! + (alt > 0 ? '♯'.repeat(alt) : alt < 0 ? '♭'.repeat(-alt) : '');
}
// Hue by circle-of-fifths position, so neighbouring fifths are 30° apart on the colour wheel.
const colorForFifth = (fifth: number, light = 40) => `hsl(${(((fifth % 12) + 12) % 12) * 30}, 42%, ${light}%)`;

function svgEl(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
    const n = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n as SVGElement;
}

export function renderWheel(host: HTMLElement, snap: Snapshot | null, opts: WheelOpts): void {
    host.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'spiral of fifths';
    host.appendChild(title);

    const DEPTH = opts.range;    // effective spiralRange the replay ran with (floor 6)
    const CENTER = opts.center;  // effective spiralCenter (+1 = mild sharp nudge)
    const W = 256, CC = W / 2;
    const lo = CENTER - DEPTH, hi = CENTER + DEPTH;                 // e.g. [−5 … +7] = D♭ … C♯ at 6/+1
    const active = snap?.frameLofTonic ?? null;                     // signed live tonic (null in batch mode)
    // The committed note's own line-of-fifths position, marked on its cell when it lands in range.
    const noteLof = snap?.committed ? fifths(snap.committed) : null;
    const collection = active != null ? new Set(range(active - 1, active + 5)) : new Set<number>();

    const R_IN = 34, R_OUT = 118;
    // Radial gain per fifth; a full 12-fifth turn adds one band-thickness (TH) so turns nest flush like
    // tree rings, and the whole spiral keeps the same footprint regardless of depth.
    const delta = (R_OUT - R_IN) / (2 * DEPTH + 12);
    const TH = 12 * delta;
    const ang = (t: number) => (-90 + t * 30) * Math.PI / 180;     // cell-centre angle
    const rad = (t: number) => R_IN + TH / 2 + (t - lo) * delta;   // cell centreline radius (continuous in t)
    const pt = (a: number, r: number) => [CC + r * Math.cos(a), CC + r * Math.sin(a)] as const;
    // A ribbon segment for the cell spanning params t0..t1: out along the spiral, back along the inner
    // edge. Edges follow the continuous spiral so adjacent cells share boundary points exactly (seamless).
    const ribbon = (t0: number, t1: number): string => {
        const N = Math.max(4, Math.round((t1 - t0) * 14));
        let d = '';
        for (let i = 0; i <= N; i++) { const t = t0 + (t1 - t0) * i / N; const [x, y] = pt(ang(t), rad(t) + TH / 2); d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2); }
        for (let i = N; i >= 0; i--) { const t = t0 + (t1 - t0) * i / N; const [x, y] = pt(ang(t), rad(t) - TH / 2); d += 'L' + x.toFixed(2) + ' ' + y.toFixed(2); }
        return d + 'Z';
    };

    const svg = svgEl('svg', { xmlns: SVGNS, viewBox: `0 0 ${W} ${W}`, width: '100%', height: 'auto', class: 'spiral' });
    const fs = Math.max(7, Math.min(11, TH * 0.3));

    for (let t = lo; t <= hi; t++) {
        const isActive = active != null && t === active;
        const inColl = collection.has(t);
        const isEnd = t === lo || t === hi;
        const fill = isActive ? colorForFifth(t, 42) : inColl ? '#28324a' : (((t % 2) + 2) % 2 ? '#212630' : '#1b212b');
        const stroke = isActive ? '#fff' : isEnd ? '#6b7280' : '#2b313c';
        const path = svgEl('path', { d: ribbon(t - 0.5, t + 0.5), fill, stroke, 'stroke-width': isActive ? 2 : 0.8 });
        if (isEnd && !isActive) path.setAttribute('stroke-dasharray', '3 2.5');
        svg.appendChild(path);
        const [lx, ly] = pt(ang(t), rad(t));
        svg.appendChild(svgEl('text', {
            x: lx.toFixed(1), y: ly.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central',
            'font-size': fs.toFixed(1), 'font-weight': isActive ? 700 : 400,
            fill: isActive ? '#fff' : isEnd ? '#9aa3af' : '#cfd6e0',
        }, keyName(t)));
        // Mark the committed note's own fifth-position with a dot on its cell (when in the drawn range).
        if (noteLof === t) svg.appendChild(svgEl('circle', { cx: lx.toFixed(1), cy: (ly + TH / 2 - 3).toFixed(1), r: 2.6, class: 'note-dot' }));
    }

    // Hub: the live key + the reachable-range readout.
    svg.appendChild(svgEl('circle', { cx: CC, cy: CC, r: R_IN - 2, fill: '#171b22', stroke: '#323845' }));
    svg.appendChild(svgEl('text', { x: CC, y: CC - 8, 'text-anchor': 'middle', 'font-size': 8.5, fill: '#7d8694' }, 'spiral'));
    svg.appendChild(svgEl('text', { x: CC, y: CC + 6, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#e6e8ec' },
        active != null ? keyName(active) : '—'));
    svg.appendChild(svgEl('text', { x: CC, y: CC + 18, 'text-anchor': 'middle', 'font-size': 7.5, fill: '#7d8694' },
        active != null ? `LoF ${active >= 0 ? '+' : ''}${active}` : 'batch'));
    host.appendChild(svg);

    if (snap) {
        const leg = document.createElement('div');
        leg.className = 'wheel-legend';
        if (active != null) {
            leg.innerHTML = `live key <b>${keyName(active)} major</b> · collection ${keyName(active - 1)}…${keyName(active + 5)}`
                + (noteLof != null && noteLof >= lo && noteLof <= hi ? ` · <span class="note-dot-key"></span> ${label(snap.committed)}` : '');
        } else {
            leg.textContent = 'batch two-pass — whole-piece decision, no streaming frame';
        }
        host.appendChild(leg);
    }

    host.appendChild(renderControls(opts));
}

/** The range / centre steppers, beside the spiral. Each rebuilds the speller on change; disabled in
 *  batch two-pass (the spiral is not the streaming frame there). `keyName` labels the window ends so the
 *  effect is legible — widening the range digs to deeper enharmonics, the centre biases sharp/flat. */
function renderControls(opts: WheelOpts): HTMLElement {
    const { range, center, streaming, onChange } = opts;
    const wrap = document.createElement('div');
    wrap.className = 'spiral-ctl' + (streaming ? '' : ' disabled');

    const stepper = (
        labelText: string, value: number, min: number, max: number,
        fmt: (n: number) => string, set: (n: number) => void,
    ): HTMLElement => {
        const rowEl = document.createElement('div');
        rowEl.className = 'ctl-row';
        const dec = document.createElement('button');
        dec.textContent = '−'; dec.disabled = !streaming || value <= min;
        dec.addEventListener('click', () => set(value - 1));
        const inc = document.createElement('button');
        inc.textContent = '+'; inc.disabled = !streaming || value >= max;
        inc.addEventListener('click', () => set(value + 1));
        const val = document.createElement('span');
        val.className = 'ctl-val'; val.textContent = fmt(value);
        rowEl.innerHTML = `<span class="ctl-label">${labelText}</span>`;
        rowEl.append(dec, val, inc);
        return rowEl;
    };

    wrap.appendChild(stepper(
        'range', range, SPIRAL_RANGE_MIN, SPIRAL_RANGE_MAX,
        n => `±${n} · ${keyName(center - n)}…${keyName(center + n)}`,
        n => onChange(n, center),
    ));
    wrap.appendChild(stepper(
        'centre', center, SPIRAL_CENTER_MIN, SPIRAL_CENTER_MAX,
        n => (n > 0 ? '+' : '') + n,
        n => onChange(range, n),
    ));

    const foot = document.createElement('div');
    foot.className = 'ctl-foot';
    if (!streaming) {
        foot.textContent = 'streaming rungs only';
    } else if (range !== SPIRAL_RANGE_DEFAULT || center !== SPIRAL_CENTER_DEFAULT) {
        const reset = document.createElement('button');
        reset.className = 'ctl-reset';
        reset.textContent = `reset to shipped (±${SPIRAL_RANGE_DEFAULT}, ${SPIRAL_CENTER_DEFAULT > 0 ? '+' : ''}${SPIRAL_CENTER_DEFAULT})`;
        reset.addEventListener('click', () => onChange(SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT));
        foot.appendChild(reset);
    } else {
        foot.textContent = 'shipped default';
    }
    wrap.appendChild(foot);
    return wrap;
}

function range(a: number, b: number): number[] {
    const out: number[] = [];
    for (let t = a; t <= b; t++) out.push(t);
    return out;
}
