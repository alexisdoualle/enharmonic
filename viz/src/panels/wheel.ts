/**
 * The line of fifths drawn as a true SPIRAL: a seamless circle-of-fifths ribbon that, instead of
 * closing, spirals so the two ends stack at the seam: a key and its enharmonic 12 fifths away share an
 * angle but sit one turn apart radially (G♭ inner, F♯ outer at the tritone). That is the exact
 * distinction the spiral frame reasons about: C♯(+7) and D♭(−5) are DIFFERENT positions, not one
 * wheel node. The live key lights up at the frame's MEAN line-of-fifths minus 2 (a major scale's mean
 * sits at tonic + 2), which is exactly the quantity the spiral fold clamps, so the lit key tracks what
 * range/offset control. `range` IS the clamp radius, so the band spans exactly the tonics the fold ALLOWS,
 * [center−range … center+range]; the dashed red cell immediately beyond each end (±(range+1)) is the FIRST
 * folded tonic: the frame folds the moment the lit key reaches a red cell. Default range 7 = the shipped
 * fold; dial it to 6 for a tighter 13-key fold.
 *
 * A simplified spiral view, without the local-key overlay.
 * The default range 7 / centre +1 map to the shipped `RT_PRESET` clamp (foldRadius 7, foldCenter 3).
 */
import type { Snapshot } from '../replay.js';
import { fifths, controlWindowLo } from '../replay.js';
import {
    SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, SPIRAL_EVEN_DEFAULT, SPIRAL_RANGE_MIN, SPIRAL_RANGE_MAX,
    SPIRAL_CENTER_MIN, SPIRAL_CENTER_MAX,
} from '../state.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Controls + drawing params for the spiral panel. `range`/`center` are the values the replay actually
 *  ran with (shipped default 6 / +1); `onChange` reconfigures the engine and rebuilds. `streaming`
 *  is false in batch two-pass, where the spiral is inert and the controls are disabled. */
export interface WheelOpts {
    range: number;
    center: number;
    even: boolean;           // window parity: false = odd/symmetric spiral; true = drop one slot → even
    streaming: boolean;
    control: boolean;        // fixed-LoF control mode: the panel becomes the control's window editor
    showKeyLanes: boolean;   // EXPERIMENTAL: also show the local/stable collection reads in the legend
    onChange: (range: number, center: number, even: boolean) => void;
    repair: boolean;         // PROBE: repair the fold-centre scale (snap outliers to the diatonic window)
    onRepair: (v: boolean) => void;
    meanFrame: boolean;      // A/B: run rt/la on the old 'mean' drift-and-fold instead of the diatonic frame
    onMeanFrame: (v: boolean) => void;
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
    host.appendChild(renderControls(opts));

    const DEPTH = opts.range;    // effective spiralRange the replay ran with (floor 6)
    const CENTER = opts.center;  // effective spiralCenter (+1 = mild sharp nudge)
    const W = 256, CC = W / 2;
    // The reachable band = the tonics the fold ALLOWS: [center−range, center+range]. `range` now maps
    // straight to the clamp radius (foldRadius = spiralRange), so the band width IS the fold width and the
    // dashed red cell immediately beyond each end (±(range+1)) is the FIRST folded tonic. `even` drops one
    // flat slot. Control: the fixed 12-slot window positioned by centre.
    const lo = opts.control ? controlWindowLo(CENTER) : CENTER - DEPTH + (opts.even ? 1 : 0);
    const hi = opts.control ? lo + 11 : CENTER + DEPTH;
    const limitSlots = opts.control ? 0 : 1;                        // one fold-trigger (red) cell each side
    const drawLo = lo - limitSlots, drawHi = hi + limitSlots;
    // Non-spiral two-pass frames use their canonical key spelling; it is a display position, not a
    // continuity anchor like the streaming spiral's signed tonic. The control has no key at all.
    const active = opts.control ? null : (snap?.frameLofTonic ?? snap?.frameKeyLof ?? null);
    // The committed note's own line-of-fifths position, marked on its cell when it lands in range.
    const noteLof = snap?.committed ? fifths(snap.committed) : null;
    // Control: the whole 12-slot window is the "collection". Streaming: the 7-fifth run around the live key.
    const collection = opts.control ? new Set(range(lo, hi))
        : active != null ? new Set(range(active - 1, active + 5)) : new Set<number>();

    const R_IN = 34, R_OUT = 118;
    // Radial gain per fifth; a full 12-fifth turn adds one band-thickness (TH) so turns nest flush like
    // tree rings, and the whole spiral keeps the same footprint regardless of depth.
    // Include the limit slots at either end in the footprint too, so they remain visible rather
    // than spilling past the outer rim at shallow ranges.
    const delta = (R_OUT - R_IN) / (2 * DEPTH + 15);
    const TH = 12 * delta;
    const ang = (t: number) => (-90 + t * 30) * Math.PI / 180;     // cell-centre angle
    const rad = (t: number) => R_IN + TH / 2 + (t - drawLo) * delta; // cell centreline radius (continuous in t)
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

    const svg = svgEl('svg', { xmlns: SVGNS, viewBox: `0 0 ${W} ${W}`, width: '100%', class: 'spiral' });
    const fs = Math.max(7, Math.min(11, TH * 0.3));

    for (let t = drawLo; t <= drawHi; t++) {
        const isActive = active != null && t === active;
        const inColl = collection.has(t);
        const isLimit = t < lo || t > hi;
        const fill = isLimit ? '#25191d' : isActive ? colorForFifth(t, 42) : inColl ? '#28324a' : (((t % 2) + 2) % 2 ? '#212630' : '#1b212b');
        const stroke = isLimit ? '#e05252' : isActive ? '#fff' : '#2b313c';
        const path = svgEl('path', { d: ribbon(t - 0.5, t + 0.5), fill, stroke, 'stroke-width': isActive ? 2 : 0.8 });
        if (isLimit) path.setAttribute('stroke-dasharray', '3 2.5');
        svg.appendChild(path);
        const [lx, ly] = pt(ang(t), rad(t));
        svg.appendChild(svgEl('text', {
            x: lx.toFixed(1), y: ly.toFixed(1), 'text-anchor': 'middle', 'dominant-baseline': 'central',
            'font-size': fs.toFixed(1), 'font-weight': isActive ? 700 : 400,
            fill: isActive ? '#fff' : isLimit ? '#ef8a8a' : '#cfd6e0',
        }, keyName(t)));
        // Mark the committed note's own fifth-position with a dot on its cell (when in the drawn range).
        if (noteLof === t) svg.appendChild(svgEl('circle', { cx: lx.toFixed(1), cy: (ly + TH / 2 - 3).toFixed(1), r: 2.6, class: 'note-dot' }));
    }

    // Fractional-mean dot: the fold clamps the frame MEAN, which is often BETWEEN cells (e.g. 8.4). The lit
    // key rounds it, so a small yellow dot at the exact mean shows how close it really is to the fold edge.
    // Only when it is not on an integer (otherwise the lit cell already says it) and inside the drawn range.
    if (!opts.control && snap?.frameMeanTonic != null) {
        const m = snap.frameMeanTonic;
        if (Math.abs(m - Math.round(m)) > 0.12 && m >= drawLo - 0.5 && m <= drawHi + 0.5) {
            const [dx, dy] = pt(ang(m), rad(m));
            svg.appendChild(svgEl('circle', { cx: dx.toFixed(1), cy: dy.toFixed(1), r: 3.2, fill: '#f2c14e', stroke: '#171b22', 'stroke-width': 1.2 }));
        }
    }

    // TODO: out-of-range note dot. When a sounding note's line-of-fifths position (`noteLof`) falls
    // OUTSIDE the drawn window [drawLo, drawHi] (e.g. D𝄪 (+16) when the spiral only reaches ~+8), it
    // currently gets no dot at all, so it looks like nothing played. Instead, extrapolate its position:
    // keep drawing at `ang(noteLof)` / `rad(noteLof)` (both are continuous in t, so they still give a
    // sensible angle + radius just past the rim) and render a faint dot there, nudged a little further
    // out (or ghosted) so it reads as "off the edge, near where D𝄪 would be" rather than a real cell.
    // Clamp the radius so a very distant note doesn't fly off the SVG. Purely a display cue.

    // Hub: the live key + the reachable-range readout.
    svg.appendChild(svgEl('circle', { cx: CC, cy: CC, r: R_IN - 2, fill: '#171b22', stroke: '#323845' }));
    svg.appendChild(svgEl('text', { x: CC, y: CC - 8, 'text-anchor': 'middle', 'font-size': 8.5, fill: '#7d8694' }, opts.control ? 'window' : 'spiral'));
    svg.appendChild(svgEl('text', { x: CC, y: CC + 6, 'text-anchor': 'middle', 'font-size': opts.control ? 10 : 12, 'font-weight': 700, fill: '#e6e8ec' },
        opts.control ? `${keyName(lo)}…${keyName(hi)}` : active != null ? `${keyName(active)}/${keyName(active + 3)}m` : '—'));
    svg.appendChild(svgEl('text', { x: CC, y: CC + 18, 'text-anchor': 'middle', 'font-size': 7.5, fill: '#7d8694' },
        opts.control ? 'fixed LoF' : active != null ? `LoF ${active >= 0 ? '+' : ''}${active}` : 'batch'));
    host.appendChild(svg);

    if (snap) {
        // Collection reads (display-only): the axis the mode-blind frame can't express; collection =
        // major + relative minor. LOCAL chases tonicizations; STABLE is the home key.
        if (opts.showKeyLanes && (snap.localColl || snap.stableColl)) {
            const ck = document.createElement('div');
            ck.className = 'wheel-legend';
            const parts: string[] = [];
            if (snap.localColl) parts.push(`🎯 local <b>${snap.localColl.name}</b>`);
            if (snap.stableColl) parts.push(`🏠 stable <b>${snap.stableColl.name}</b>`);
            ck.innerHTML = parts.join(' · ');
            host.appendChild(ck);
        }
    }
}

/** Which stepper button was last pressed, so focus survives the panel rebuild each change triggers
 *  (otherwise repeated keyboard/click stepping drops back to the body). */
let lastPressed: string | null = null;

/** The range / centre steppers, on one line above the spiral. Each rebuilds the speller on change;
 *  disabled in batch two-pass (the spiral is not the streaming frame there). The window ends
 *  (e.g. G♭…G♯) sit in the tooltip; widening the range digs to deeper enharmonics, the centre biases
 *  sharp/flat. */
function renderControls(opts: WheelOpts): HTMLElement {
    const { range, center, even, streaming, control, onChange, meanFrame, onMeanFrame } = opts;
    const editable = streaming || control;   // control mode also drives its window from these steppers
    const wrap = document.createElement('div');
    wrap.className = 'spiral-ctl' + (editable ? '' : ' disabled');
    if (!editable) wrap.title = 'the streaming modes & control only: batch two-pass has no spiral frame';
    // The window the current params span (streaming: ±range, one flat slot dropped when even; control: 12).
    const wLo = control ? controlWindowLo(center) : center - range + (even ? 1 : 0);
    const wHi = control ? wLo + 11 : center + range;
    const slots = wHi - wLo + 1;

    const focusLater: HTMLButtonElement[] = [];
    const stepper = (
        labelText: string, value: number, min: number, max: number,
        fmt: (n: number) => string, tip: string, set: (n: number) => void, enabled: boolean,
    ) => {
        const group = document.createElement('div');
        group.className = 'ctl-group' + (enabled ? '' : ' off');
        const lab = document.createElement('span');
        lab.className = 'ctl-label'; lab.textContent = labelText;
        const val = document.createElement('span');
        val.className = 'ctl-val'; val.textContent = fmt(value); val.title = tip;
        const btn = (sign: -1 | 1) => {
            const b = document.createElement('button');
            b.textContent = sign < 0 ? '−' : '+';
            b.disabled = !enabled || (sign < 0 ? value <= min : value >= max);
            b.dataset.k = `${labelText}${sign}`;
            b.addEventListener('click', () => { lastPressed = b.dataset.k!; set(value + sign); });
            if (b.dataset.k === lastPressed) focusLater.push(b);
            return b;
        };
        group.append(lab, btn(-1), val, btn(1));
        wrap.appendChild(group);
    };

    // range = digging depth (streaming only; the control's window is always 12 slots wide).
    stepper(
        'range', range, SPIRAL_RANGE_MIN, SPIRAL_RANGE_MAX, n => `±${n}`,
        control ? 'fixed at 12 slots in control mode' : `${keyName(wLo)}…${keyName(wHi)} (${slots} slots)`,
        n => onChange(n, center, even), streaming,
    );
    // offset = the writability centre; in control mode it slides the whole fixed-LoF window.
    stepper(
        'offset', center, SPIRAL_CENTER_MIN, SPIRAL_CENTER_MAX, n => (n > 0 ? '+' : '') + n,
        control ? `slide the window (${keyName(wLo)}…${keyName(wHi)})` : 'line-of-fifths writability bias',
        n => onChange(range, n, even), editable,
    );
    // parity = odd (symmetric spiral, keeps the tritone doubling) ↔ even (drop one slot → 2·range).
    // A two-segment pill; streaming only (the control is inherently even, positioned by offset alone).
    if (!control) {
        const group = document.createElement('div');
        group.className = 'ctl-group' + (streaming ? '' : ' off');
        const lab = document.createElement('span');
        lab.className = 'ctl-label'; lab.textContent = 'parity';
        const seg = document.createElement('div');
        seg.className = 'ctl-seg';
        // 1 = even window (tritone seam collapsed to a single spelling); 2 = odd/symmetric spiral (the
        // seam pc kept both ways). Now: ${slots} slots.
        seg.title = `1 = even (${2 * range} slots, one spelling per pc) · 2 = odd spiral (${2 * range + 1} slots, tritone doubled)`;
        const segBtn = (isEven: boolean, text: string) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.className = even === isEven ? 'on' : '';
            b.disabled = !streaming;
            b.dataset.k = `parity${isEven ? 1 : 0}`;
            b.addEventListener('click', () => { lastPressed = b.dataset.k!; if (even !== isEven) onChange(range, center, isEven); });
            if (b.dataset.k === lastPressed) focusLater.push(b);
            return b;
        };
        seg.append(segBtn(true, '1'), segBtn(false, '2'));
        group.append(lab, seg);
        wrap.appendChild(group);
    }

    // Always in the layout, greyed out at the shipped preset, so it can't shove the steppers sideways
    // the moment a value changes.
    const shipped = `±${SPIRAL_RANGE_DEFAULT}, ${SPIRAL_CENTER_DEFAULT > 0 ? '+' : ''}${SPIRAL_CENTER_DEFAULT}`;
    const atDefault = range === SPIRAL_RANGE_DEFAULT && center === SPIRAL_CENTER_DEFAULT && even === SPIRAL_EVEN_DEFAULT;
    const reset = document.createElement('button');
    reset.className = 'ctl-reset';
    reset.textContent = 'reset';
    reset.disabled = !editable || atDefault;
    reset.title = reset.disabled ? `at shipped default (${shipped})` : `back to shipped (${shipped})`;
    reset.addEventListener('click', () => { lastPressed = null; onChange(SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, SPIRAL_EVEN_DEFAULT); });
    wrap.appendChild(reset);

    // The 'repair' PROBE toggle (snap the fold-centre scale to its best-fit diatonic window) is hidden
    // from the panel: it is experimental and off by default. The `repair` state and the `?rp=1` URL lever
    // still work, so it can be exercised without the button.
    if (!control) {
        // A/B toggle: run the old 'mean' drift-and-fold side substrate instead of the shipped diatonic
        // frame. Streaming rungs only (the two-pass tier has its own mean fold already).
        const mf = document.createElement('button');
        mf.className = 'ctl-reset' + (meanFrame ? ' on' : '');
        mf.textContent = 'mean';
        mf.disabled = !streaming;
        mf.title = 'run the mean drift-and-fold side substrate instead of the diatonic frame: the slots drift and the side is their running average, so it re-orients faster at a key change and matches the notated side more often on stitched multi-key pieces (WTC2), at the cost of a few more incoherent slips. The frame holds steadier. The key lane also reads separately from the surface here. A/B';
        mf.dataset.k = 'mean';
        mf.addEventListener('click', () => { lastPressed = 'mean'; onMeanFrame(!meanFrame); });
        if (mf.dataset.k === lastPressed) focusLater.push(mf);
        wrap.appendChild(mf);
    }

    // preventScroll: refocusing must not nudge the page, which is the whole point of this panel change.
    if (focusLater[0]) queueMicrotask(() => focusLater[0]!.focus({ preventScroll: true }));
    return wrap;
}

function range(a: number, b: number): number[] {
    const out: number[] = [];
    for (let t = a; t <= b; t++) out.push(t);
    return out;
}
