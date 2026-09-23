/**
 * Piano-roll scrub track: time → X, pitch → Y, one row per pitch, coloured by scoring tier.
 * Below the notes, a single "frame/key over time" lane shows the shipped spiral engine's
 * live line-of-fifths tonic (the same signal the spiral-of-fifths panel lights up) as contiguous
 * coloured runs, so you can see the key drift/flip alongside the notes that caused it.
 *
 * VIRTUALIZED: bach_jesu alone has ~7374 notes, and every step (arrow key) would otherwise touch
 * thousands of DOM nodes. Note *layouts* (x/y/width/color) are precomputed once per replay: cheap,
 * O(notes), no DOM, but only the rects inside (and a margin around) the visible scroll viewport are
 * ever materialized. Scrolling and seeking both just adjust which slice of `layouts` is live.
 *
 * Kept deliberately minimal (no tonal-center / local-key / analysis / cadence / chord / scale /
 * music21 / portal / frame-override badges): this viz has exactly one engine (the shipped spiral)
 * so there is exactly one key lane.
 */
import type { Replay, ReplayNote, Tier } from '../replay.js';
import type { Letter, Accidental } from '../../../src/index.js';
import { label } from '../format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const PX_PER_SEC = 90;
const ROW_H = 9;
const PAD = 8;
const LANE_GAP = 10;   // space between the note rows and the first lane
const LANE_H = 22;     // height of each lane (frame key, mode-aware key)
const CAPTION_H = 16;  // space under each lane for its caption
const LANE_GAP2 = 8;   // space between the two lanes
const MARGIN_PX = 400; // materialize this far beyond the viewport so scrolling stays ahead of the eye

// Same idiom as panels/wheel.ts's keyName/colorForFifth (copied, not imported: the wheel's helpers
// aren't exported, and these are a two-liner each). `lof` is the signed line-of-fifths tonic.
const LOF_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
function keyName(lof: number): string {
    const idx = ((lof + 1) % 7 + 7) % 7;
    const alt = Math.floor((lof + 1) / 7);
    return LOF_ORDER[idx]! + (alt > 0 ? '♯'.repeat(alt) : alt < 0 ? '♭'.repeat(-alt) : '');
}
// The frame lof names a major key; its relative minor sits +3 along the line of fifths
// (C→Am, G→Em, F→Dm). Show both so the lane reads e.g. "C/Am".
function keyLabel(lof: number): string {
    return `${keyName(lof)} / ${keyName(lof + 3)}m`;
}
const colorForFifth = (fifth: number, light = 40) => `hsl(${(((fifth % 12) + 12) % 12) * 30}, 42%, ${light}%)`;

const TIER_COLOR: Record<Tier, string> = { correct: '#57caa0', flipped: '#d8b35a', wrong: '#e06c75', unread: '#9aa3b2' };

interface Layout {
    x: number; w: number; y: number;
    onIndex: number; onT: number; offT: number;
    tier: Tier; midi: number; committedLabel: string; expectedLabel: string;
}

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
    const n = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n as SVGElement;
}

let onSeek: (step: number) => void = () => {};
export function initPianoRoll(seek: (step: number) => void): void { onSeek = seek; }

// The replay we last built the SVG for: rebuild keys off OBJECT IDENTITY. main.ts makes a fresh
// Replay on every fixture/mode change, so any such change rebuilds automatically; a mere seek (same
// replay, new step) skips straight to the cheap path (move playhead, recolor, maybe scroll).
let builtForReplay: Replay | null = null;
let svg: SVGSVGElement | null = null;
let notesGroup: SVGGElement | null = null;
let playhead: SVGLineElement | null = null;
let layouts: Layout[] = [];                 // one per note, index == onIndex, ascending by x (== onset order)
let maxW = 0;                                // widest note, so long-held notes starting off-screen-left still show
let rects: (SVGRectElement | null)[] = [];   // sparse, indexed by onIndex: only the visible ones exist
let rendered = new Set<number>();            // onIndices currently materialized in the DOM
let pxPerMs = PX_PER_SEC / 1000;
let rowH = ROW_H;                             // per-semitone height; scaled down on phones (see build)
let prevActive: number[] = [];
let scrollBound = false;
// Autoscroll "follow": the playhead keeps itself in view while stepping, but a manual scroll
// disengages follow so the user can inspect elsewhere; it re-engages once the playhead drifts back
// into view on its own. `expectedScrollLeft` is the value WE last wrote, so the scroll listener can
// tell our own programmatic scroll from a real user scroll (which lands somewhere we didn't set).
let follow = true;
let expectedScrollLeft = -1;

let builtWithKeyLanes = false;
let builtMobile = false;
// Phones get a zoomed-out roll (more time and pitch range on a small screen); wide screens use full size.
const isMobile = () => window.matchMedia('(max-width: 720px)').matches;
export function renderPianoRoll(replay: Replay, step: number, showKeyLanes = false): void {
    if (replay !== builtForReplay || showKeyLanes !== builtWithKeyLanes || isMobile() !== builtMobile) {
        build(replay, showKeyLanes); builtForReplay = replay; builtWithKeyLanes = showKeyLanes; builtMobile = isMobile();
    }
    updatePlayhead(replay, step);
}

function build(replay: Replay, showKeyLanes: boolean): void {
    const host = document.getElementById('pianoroll')!;
    host.innerHTML = '';
    rects = []; rendered = new Set(); prevActive = [];
    const lo = Math.min(replay.minMidi, replay.maxMidi), hi = Math.max(replay.minMidi, replay.maxMidi);
    const sc = isMobile() ? 0.6 : 1;           // zoom the whole roll out on phones (time + pitch axes together)
    pxPerMs = (PX_PER_SEC / 1000) * sc;
    rowH = ROW_H * sc;
    const width = Math.max(host.clientWidth, PAD * 2 + replay.durationMs * pxPerMs);
    const noteH = (hi - lo + 1) * rowH;
    const laneTop = PAD + noteH + LANE_GAP;                              // frame-key lane (spelling frame)
    // EXPERIMENTAL collection lanes (local + stable) render only when enabled.
    const localLaneTop = laneTop + LANE_H + CAPTION_H + LANE_GAP2;       // LOCAL collection (tonicizations)
    const stableLaneTop = localLaneTop + LANE_H + CAPTION_H + LANE_GAP2; // STABLE collection (home key)
    const lanesBottom = showKeyLanes ? stableLaneTop + LANE_H : laneTop + LANE_H;
    const height = lanesBottom + CAPTION_H + PAD;

    svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.display = 'block';

    // faint row guides at octave Cs
    for (let m = lo; m <= hi; m++) {
        if (m % 12 !== 0) continue;
        const y = PAD + (hi - m) * rowH + rowH / 2;
        svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: y, y2: y, stroke: '#222833', 'stroke-width': 1 }));
    }

    // precompute layouts (cheap, O(notes), no DOM); replay.notes is already in onset (== x) order
    layouts = new Array(replay.notes.length);
    maxW = 0;
    for (const note of replay.notes) {
        const w = Math.max(3, (note.offT - note.onT) * pxPerMs);
        if (w > maxW) maxW = w;
        layouts[note.onIndex] = {
            x: PAD + note.onT * pxPerMs, w, y: PAD + (hi - note.midi) * rowH,
            onIndex: note.onIndex, onT: note.onT, offT: note.offT, tier: note.tier, midi: note.midi,
            committedLabel: label(note.committed), expectedLabel: expLabel(note.expected),
        };
    }
    rects = new Array(replay.notes.length).fill(null);

    notesGroup = document.createElementNS(SVGNS, 'g') as SVGGElement;
    svg.appendChild(notesGroup);

    buildKeyLane(replay, svg, width, laneTop);
    if (showKeyLanes) {
        buildCollectionLane(replay, svg, width, localLaneTop, 'local');
        buildCollectionLane(replay, svg, width, stableLaneTop, 'stable');
    }

    playhead = document.createElementNS(SVGNS, 'line') as SVGLineElement;
    playhead.setAttribute('y1', String(PAD)); playhead.setAttribute('y2', String(lanesBottom));
    playhead.setAttribute('stroke', '#6ea8fe'); playhead.setAttribute('stroke-width', '1.5');   // literal: var() is invalid in an SVG presentation attribute
    svg.appendChild(playhead);

    // click background → seek to the onset nearest the clicked time. Map the click through the svg's
    // rendered rect (rect.width is the on-screen width, `width` its internal px), so the position stays
    // correct under the page zoom; `e.offsetX` is skewed by CSS `zoom`.
    svg.addEventListener('click', e => {
        const rect = svg.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (width / rect.width);
        onSeek(nearestNoteAtTime(replay, (x - PAD) / pxPerMs));
    });

    host.appendChild(svg);
    if (!scrollBound) {
        host.addEventListener('scroll', () => {
            // A scroll that didn't land where we put it = the user grabbing the scrollbar / wheeling.
            // Disengage follow so they can look around; updatePlayhead re-engages it once the
            // playhead scrolls back into view.
            if (Math.abs(host.scrollLeft - expectedScrollLeft) > 2) follow = false;
            renderVisible();
            applyActiveStrokes(replay, lastStep);
        });
        scrollBound = true;
    }
    follow = true; expectedScrollLeft = -1;   // a fresh build (new fixture/mode) follows again
    renderVisible();
}

// ReplayNote.expected carries loosely-typed step/alter (from the fixture's JSON); the shipped Pitch
// type narrows them to Letter/Accidental. The cast is safe: fixtures are pre-validated against the
// same shipped grammar the speller itself emits.
function expLabel(e: ReplayNote['expected']): string {
    if (!e) return '∅';
    return label({ step: e.step as Letter, alter: e.alter as Accidental, octave: e.octave });
}

// first layout index with x >= target (layouts sorted ascending by x)
function lowerBoundX(target: number): number {
    let lo = 0, hi = layouts.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (layouts[m]!.x < target) lo = m + 1; else hi = m; }
    return lo;
}

function visibleRange(): [number, number] {
    const host = document.getElementById('pianoroll')!;
    const left = host.scrollLeft - MARGIN_PX - maxW; // back up by maxW so wide notes starting earlier still show
    const right = host.scrollLeft + host.clientWidth + MARGIN_PX;
    return [Math.max(0, lowerBoundX(left)), Math.min(layouts.length, lowerBoundX(right))];
}

function makeRect(oi: number): void {
    const L = layouts[oi]!;
    const rect = document.createElementNS(SVGNS, 'rect') as SVGRectElement;
    rect.setAttribute('x', String(L.x)); rect.setAttribute('y', String(L.y));
    rect.setAttribute('width', String(L.w)); rect.setAttribute('height', String(rowH - 1));
    rect.setAttribute('rx', '1.5');
    rect.setAttribute('fill', TIER_COLOR[L.tier]);
    rect.style.cursor = 'pointer';
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `${L.committedLabel} (midi ${L.midi}), expected ${L.expectedLabel}`;
    rect.appendChild(title);
    rect.addEventListener('click', e => { e.stopPropagation(); onSeek(L.onIndex); });
    notesGroup!.appendChild(rect);
    rects[oi] = rect;
}

// Materialize exactly the notes in the visible range; drop the rest from the DOM.
function renderVisible(): void {
    if (!notesGroup) return;
    const [lo, hi] = visibleRange();
    for (const oi of [...rendered]) {
        if (oi < lo || oi >= hi) { rects[oi]?.remove(); rects[oi] = null; rendered.delete(oi); }
    }
    for (let oi = lo; oi < hi; oi++) {
        if (!rendered.has(oi)) { makeRect(oi); rendered.add(oi); }
    }
}

// Contiguous runs of the frame key: the streaming spiral's signed tonic when available, otherwise
// the two-pass resolver's canonical spelling of the selected directional frame.
function frameSegments(replay: Replay): { lof: number; t0: number; t1: number }[] {
    const segs: { lof: number; t0: number; t1: number }[] = [];
    let cur: number | null = null, segStart = 0;
    for (const snap of replay.snapshots) {
        const lof = snap.frameLofTonic ?? snap.frameKeyLof;
        if (lof == null) continue;
        if (cur === null) { cur = lof; segStart = snap.t; }
        else if (lof !== cur) { segs.push({ lof: cur, t0: segStart, t1: snap.t }); cur = lof; segStart = snap.t; }
    }
    if (cur !== null) segs.push({ lof: cur, t0: segStart, t1: replay.durationMs });
    return segs;
}

function laneText(host: SVGSVGElement, x: number, y: number, str: string, fill: string, anchor = 'start', size = 10): void {
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
    t.setAttribute('fill', fill); t.setAttribute('font-size', String(size)); t.setAttribute('text-anchor', anchor);
    t.textContent = str;
    host.appendChild(t);
}

function buildKeyLane(replay: Replay, host: SVGSVGElement, width: number, laneTop: number): void {
    const text = (x: number, y: number, str: string, fill: string, anchor = 'start', size = 10) =>
        laneText(host, x, y, str, fill, anchor, size);
    const segs = frameSegments(replay);
    if (segs.length === 0) {
        host.appendChild(svgEl('rect', { x: PAD, y: laneTop, width: width - PAD * 2, height: LANE_H, fill: '#1b1f27' }));
        text(PAD + 6, laneTop + LANE_H / 2 + 4, 'no frame key', '#6b7280');
        return;
    }
    for (const seg of segs) {
        const x = PAD + seg.t0 * pxPerMs, w = (seg.t1 - seg.t0) * pxPerMs;
        host.appendChild(svgEl('rect', { x, y: laneTop, width: Math.max(0, w), height: LANE_H, fill: colorForFifth(seg.lof) }));
        if (w > 60) text(x + w / 2, laneTop + LANE_H / 2 + 4, keyLabel(seg.lof), '#e6e8ec', 'middle');
    }
    for (let i = 1; i < segs.length; i++) {
        const x = PAD + segs[i]!.t0 * pxPerMs;
        host.appendChild(svgEl('line', {
            x1: x, x2: x, y1: laneTop, y2: laneTop + LANE_H,
            stroke: '#d0a020', 'stroke-width': 1, 'stroke-dasharray': '2 2',
        }));
    }
    text(PAD + 2, laneTop + 8, 'frame key (collection · mode-blind)', '#8b93a1', 'start', 8);
    const flips = Math.max(0, segs.length - 1);
    const onsets = replay.snapshots.length;
    const rate = onsets ? (flips / onsets * 100).toFixed(2) : '0.00';
    text(PAD, laneTop + LANE_H + 12, `frame key: ${flips} change${flips === 1 ? '' : 's'} · ${rate} per 100 onsets`, '#9aa4b2', 'start', 9);
}

// Contiguous runs of a COLLECTION lane (display-only; major + relative minor as one unit: the axis the
// mode-blind frame lane cannot express). `which` selects the LOCAL (tonicizations) or STABLE (home key)
// read. See music/collection.ts + the memory `modeaware-key-read-viz`.
export function collectionSegments(replay: Replay, which: 'local' | 'stable'): { name: string; relMajorPc: number; margin: number; t0: number; t1: number }[] {
    const segs: { name: string; relMajorPc: number; margin: number; t0: number; t1: number }[] = [];
    let cur: string | null = null, segStart = 0, relMajorPc = 0, margin = 0;
    for (const snap of replay.snapshots) {
        const cr = which === 'local' ? snap.localColl : snap.stableColl;
        if (!cr) continue;
        if (cr.name !== cur) {
            if (cur !== null) segs.push({ name: cur, relMajorPc, margin, t0: segStart, t1: snap.t });
            cur = cr.name; segStart = snap.t; relMajorPc = cr.relMajorPc; margin = cr.margin;
        }
    }
    if (cur !== null) segs.push({ name: cur, relMajorPc, margin, t0: segStart, t1: replay.durationMs });
    return segs;
}

// Hue by the collection's circle-of-fifths position (neighbouring collections 30° apart, matching the
// frame lane). A low margin (the collection barely beat a neighbour = an uncertain/transition patch) is
// faded toward grey, so confident regions read strong and ambiguous ones read washed-out.
function collectionColor(relMajorPc: number, margin: number, stable: boolean): string {
    const cof = (((relMajorPc * 7) % 12) + 12) % 12;
    const sat = margin < 2 ? 14 : margin < 5 ? 30 : 46;   // low margin → desaturated (uncertain)
    const light = stable ? 40 : 46;                        // the stable lane a touch darker to distinguish it
    return `hsl(${cof * 30}, ${sat}%, ${light}%)`;
}

function buildCollectionLane(replay: Replay, host: SVGSVGElement, width: number, laneTop: number, which: 'local' | 'stable'): void {
    const text = (x: number, y: number, str: string, fill: string, anchor = 'start', size = 10) =>
        laneText(host, x, y, str, fill, anchor, size);
    const stable = which === 'stable';
    const laneName = stable ? 'stable key (home)' : 'local key (tonicizations)';
    const segs = collectionSegments(replay, which);
    if (segs.length === 0) {
        host.appendChild(svgEl('rect', { x: PAD, y: laneTop, width: width - PAD * 2, height: LANE_H, fill: '#1b1f27' }));
        text(PAD + 6, laneTop + LANE_H / 2 + 4, 'no key read', '#6b7280');
        return;
    }
    for (const seg of segs) {
        const x = PAD + seg.t0 * pxPerMs, w = (seg.t1 - seg.t0) * pxPerMs;
        const rect = svgEl('rect', { x, y: laneTop, width: Math.max(0, w), height: LANE_H, fill: collectionColor(seg.relMajorPc, seg.margin, stable) });
        const title = document.createElementNS(SVGNS, 'title');
        title.textContent = `${seg.name} · margin ${seg.margin.toFixed(1)} (higher = more certain)`;
        rect.appendChild(title);
        host.appendChild(rect);
        if (w > 42) text(x + w / 2, laneTop + LANE_H / 2 + 4, seg.name, '#e6e8ec', 'middle');
    }
    for (let i = 1; i < segs.length; i++) {
        const x = PAD + segs[i]!.t0 * pxPerMs;
        host.appendChild(svgEl('line', { x1: x, x2: x, y1: laneTop, y2: laneTop + LANE_H, stroke: '#8a6bd0', 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    }
    text(PAD + 2, laneTop + 8, laneName, '#8b93a1', 'start', 8);
    const changes = Math.max(0, segs.length - 1);
    const onsets = replay.snapshots.length;
    const rate = onsets ? (changes / onsets * 100).toFixed(2) : '0.00';
    text(PAD, laneTop + LANE_H + 12, `${laneName}: ${changes} change${changes === 1 ? '' : 's'} · ${rate} per 100 onsets`, '#9aa4b2', 'start', 9);
}

function nearestNoteAtTime(replay: Replay, t: number): number {
    const notes = replay.notes;
    if (!notes.length) return 0;
    let lo = 0, hi = notes.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (notes[mid]!.onT < t) lo = mid + 1; else hi = mid; }
    return notes[lo]!.onIndex;
}

let lastStep = 0;

function updatePlayhead(replay: Replay, step: number): void {
    if (!svg || !playhead || !replay.notes.length) return;
    lastStep = step;
    const cur = replay.notes[Math.max(0, Math.min(replay.notes.length - 1, step))]!;
    const x = PAD + cur.onT * pxPerMs;
    playhead.setAttribute('x1', String(x)); playhead.setAttribute('x2', String(x));

    // autoscroll to keep the playhead in view, then materialize the new viewport. While the user
    // has scrolled away (follow off), don't yank the view back, but re-engage the moment the
    // playhead drifts back into view on its own.
    const host = document.getElementById('pianoroll')!;
    const left = host.scrollLeft, right = left + host.clientWidth;
    if (!follow && x >= left + 60 && x <= right - 60) follow = true;
    if (follow && (x < left + 60 || x > right - 60)) {
        host.scrollLeft = Math.max(0, x - host.clientWidth * 0.4);
        expectedScrollLeft = host.scrollLeft;   // record what WE set, so the scroll listener knows it wasn't the user
    }
    renderVisible();
    applyActiveStrokes(replay, step);
}

// Bold gold outline on the current note; a thin light outline on every other note ringing at this
// instant (onT ≤ headT < offT, the same rule the state-table's "sounding" chips use).
function applyActiveStrokes(replay: Replay, step: number): void {
    for (const oi of prevActive) { const r = rects[oi]; if (r) r.setAttribute('stroke', 'none'); }
    if (!replay.notes.length) { prevActive = []; return; }
    const cur = replay.notes[Math.max(0, Math.min(replay.notes.length - 1, step))]!;
    const t = cur.onT, curOn = cur.onIndex;
    const active: number[] = [];
    for (const oi of rendered) {
        const L = layouts[oi]!;
        if (L.onT <= t && t < L.offT) {
            const rect = rects[oi];
            if (rect) {
                if (oi === curOn) { rect.setAttribute('stroke', '#ffd230'); rect.setAttribute('stroke-width', '2.5'); }
                else { rect.setAttribute('stroke', '#8a93a0'); rect.setAttribute('stroke-width', '1'); }
                active.push(oi);
            }
        }
    }
    prevActive = active;
}
