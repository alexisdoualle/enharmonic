import type { LiveSpeller, LiveState } from '../live.js';
import { LETTER_COLOR } from '../format.js';
import { LO, HI, lofOf, pcOfLof, letterSpoke, letterOfLof, nameOfLof, fifthSteps, fifthQuality, lofRuns, bandBridges, offTurn } from '../spirals.js';

/**
 * Two windings of the line of fifths, side by side. Left, the pitch spiral (12 fifths a turn, equal temperament):
 * MIDI gives the spoke, a pitch class with its 2 or 3 spellings a ring apart. Right, the letter spiral (7 fifths a
 * turn): the speller picks the letter, the accidentals are the rings. On both, the blue band is the speller's
 * seven-letter surface and the lit beads are the sounding notes; the letter spiral colours each altered fifth.
 */

/** Altered fifths on the letter spiral: 'band' fills them along the spiral, 'dashed' draws a dashed line. */
const ARC_STYLE: 'band' | 'dashed' = 'band';

const BG = '#fffefb', INK = '#222', DIM = '#8a8a8a', GUIDE = '#e2e2e2', SPOKE = '#ececec';
/** A colour mixed toward white by `t` (0 = white, 1 = the colour). */
const tint = (hex: string, t: number) => '#' + [1, 3, 5].map(i => Math.round(255 + (parseInt(hex.slice(i, i + 2), 16) - 255) * t).toString(16).padStart(2, '0')).join('');
/** The speller's choice in its letter's colour (as in the coiled Tonnetz and the piano roll), faded so it
 *  never reads as the A5 green or the d5 pink. */
const colourOf = (n: number) => tint(LETTER_COLOR[letterOfLof(n)]!, 0.6);
const SPIKE_GREY = '#c4c4c4';
const SHIFTED_P5 = '#5b9bd5';
const BAND = '#9cc7ea', DIM5 = '#e7a1cf', AUG5 = '#a6d9a0', DIM5_LABEL = '#a8327f', AUG5_LABEL = '#3c8a46';
const BAND_OPACITY = 0.45, BAND_W = 15;
const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
const CELL = 460, TITLE = 24;
const LS = 13;   // note label size
const BEAD = 3.6, BEAD_HOT = 4.6, HALO = 11;

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const f = (v: number) => v.toFixed(1);
type Point = [number, number];

/** One winding: `step` degrees per fifth, radius growing linearly from rIn (at LO) to rOut (at HI). */
class Winding {
    constructor(readonly cx: number, readonly cy: number, readonly step: number, readonly rIn: number, readonly rOut: number) {}
    ang(n: number) { return (-90 + n * this.step) * Math.PI / 180; }
    rad(n: number) { return this.rIn + (n - LO) * (this.rOut - this.rIn) / (HI - LO); }
    at(r: number, a: number): Point { return [this.cx + r * Math.cos(a), this.cy + r * Math.sin(a)]; }
    bead(n: number): Point { return this.at(this.rad(n), this.ang(n)); }
    /** Path along the spiral from n1 to n2 (fractional n allowed). */
    path(n1: number, n2: number, samples: number): string {
        let d = '';
        for (let i = 0; i <= samples; i++) {
            const n = n1 + (n2 - n1) * i / samples, [x, y] = this.bead(n);
            d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
        }
        return d;
    }
    line(a: Point, b: Point, attrs: string) { return `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" ${attrs}/>`; }
}

export interface SpiralView {
    surface: number[];     // the seven-letter surface, as line-of-fifths positions
    heldPcs: number[];     // sounding pitch classes
    held: number[];        // sounding spellings
    flash: number | null;  // the spelling just committed, flashed once
}

export function viewOf(s: LiveState, flash: boolean): SpiralView {
    const held = s.heldSpellings.map(key => { const [step, alter] = key.split(':'); return lofOf({ step: step!, alter: Number(alter) }); });
    return {
        surface: s.scaleSpellings.map(lofOf),
        heldPcs: s.heldPCs,
        held,
        flash: flash && s.lastSpelling ? lofOf(s.lastSpelling) : null,
    };
}

/** Pitch-spiral label ink: near black on the middle turn (A♭..C♯), greying slowly out to F𝄫 and B𝄪. */
function fadedInk(n: number): string {
    const d = Math.abs(n - 2), t = Math.max(0, d - 6) / (Math.max(HI - 2, 2 - LO) - 6);
    const v = Math.round(0x22 + t * (0xa0 - 0x22)).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
}

/** Letter-spiral label ink by rings from the spoke's surface spelling: the surface and its neighbours dark,
 *  then lighter each accidental further out. */
const RING_INK = ['#222', '#555', '#999', '#bbb', '#ccc'];

function label(x: number, y: number, text: string, hot: boolean, size = LS, ink = INK): string {
    return `<text x="${f(x)}" y="${f(y + size * 0.34)}" text-anchor="middle" font-size="${hot ? size + 1 : size}" font-weight="${hot ? 700 : 400}" fill="${hot ? INK : ink}" stroke="${BG}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(text)}</text>`;
}

/** A bead: small and dark, or, when it sounds, a soft halo in its letter's colour around a coloured bead. */
function bead(x: number, y: number, n: number, hot: boolean, ink = '#111'): string {
    if (!hot) return `<circle cx="${f(x)}" cy="${f(y)}" r="${BEAD}" fill="${ink}"/>`;
    const c = colourOf(n);
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${HALO}" fill="${c}" fill-opacity="0.22"/>`
        + `<circle cx="${f(x)}" cy="${f(y)}" r="${BEAD_HOT}" fill="${c}" stroke="#555" stroke-width="0.7"/>`;
}

function flashRing(w: Winding, n: number | null): string {
    if (n === null || n < LO || n > HI) return '';
    const [x, y] = w.bead(n);
    return `<circle class="spirals-flash" cx="${f(x)}" cy="${f(y)}" r="${HALO}" fill="none" stroke="${colourOf(n)}" stroke-width="2"/>`;
}

/** Left: the shadow. Twelve spokes, one per piano key; the clock is the twelve pitch classes. */
function pitchSpiral(v: SpiralView, cx: number, cy: number): string {
    const w = new Winding(cx, cy, 30, 100, 200), rC = 60, dotR = 12;
    const held = new Set(v.held), heldPcs = new Set(v.heldPcs);
    const spokeAngle = (pc: number) => w.ang((7 * pc) % 12);
    const o: string[] = [];
    for (let k = 0; k < 12; k++) o.push(w.line(w.at(rC + dotR, w.ang(k)), w.at(w.rOut + 6, w.ang(k)), `stroke="${SPOKE}" stroke-width="0.8"`));
    o.push(`<path d="${w.path(LO, HI, 34 * 8)}" fill="none" stroke="${GUIDE}" stroke-width="1.2"/>`);
    // The surface: runs of consecutive fifths. An off-turn note stands alone, a turn away from its letter,
    // even next to another off-turn note (A♯ and E♯ are two dots; their fifth is the dashed A–E).
    const off = offTurn(v.surface);
    const blob = (n: number) => { const [x, y] = w.bead(n); o.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${BAND_W / 2}" fill="${BAND}"/>`); };
    o.push(`<g opacity="${BAND_OPACITY}">`);
    for (const n of off) blob(n);
    for (const [a, b] of lofRuns(v.surface.filter(n => !off.has(n)))) {
        if (a === b) blob(a);
        else o.push(`<path d="${w.path(a, b, (b - a) * 12)}" fill="none" stroke="${BAND}" stroke-width="${BAND_W}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    o.push('</g>');
    // Where the band breaks, the perfect fifth the surface skips, dashed in the colour of the altered fifth
    // that replaces it (A harmonic minor: green over C–G for the A5 C–G♯, pink over G–D for the d5 G♯–D),
    // blue, like the band, for a perfect fifth moved off the turn whole (A♯–E♯ for A–E).
    for (const b of bandBridges(v.surface)) {
        const trim = (BEAD + 4) / (w.rad(b.from) * w.step * Math.PI / 180);
        o.push(`<path d="${w.path(b.from + trim, b.to - trim, 16)}" fill="none" stroke="${b.k < 0 ? DIM5_LABEL : b.k > 0 ? AUG5_LABEL : SHIFTED_P5}" stroke-width="1.4" stroke-dasharray="4 2.5"/>`);
    }
    // Spikes: a sounding pitch class points out along its spoke to every spelling it could be; the
    // spelling the speller holds gets the solid spike.
    for (const pc of heldPcs) {
        let outer = -Infinity;
        for (let n = LO; n <= HI; n++) if (pcOfLof(n) === pc) outer = n;
        o.push(w.line(w.at(rC + dotR, spokeAngle(pc)), w.at(w.rad(outer), spokeAngle(pc)), `stroke="${SPIKE_GREY}" stroke-width="1"`));
    }
    for (const n of held) if (n >= LO && n <= HI) o.push(w.line(w.at(rC + dotR, w.ang(n)), w.bead(n), `stroke="${colourOf(n)}" stroke-width="2"`));
    for (let n = LO; n <= HI; n++) {
        const [x, y] = w.bead(n), hot = held.has(n);
        const ink = fadedInk(n);
        o.push(bead(x, y, n, hot, ink));
        const [lx, ly] = w.at(w.rad(n) + LS + (hot ? 6 : 2), w.ang(n));
        o.push(label(lx, ly, nameOfLof(n), hot, LS, ink));
    }
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rC}" fill="none" stroke="#bbb" stroke-width="0.9"/>`);
    for (let pc = 0; pc < 12; pc++) {
        // A sounding key takes the colour of the letter the speller chose for it.
        const [x, y] = w.at(rC, spokeAngle(pc)), white = WHITE_PC.has(pc);
        const chosen = v.held.find(n => pcOfLof(n) === pc), c = chosen !== undefined ? colourOf(chosen) : heldPcs.has(pc) ? '#999' : null;
        const fill = c ? tint(c, 0.4) : white ? '#fff' : '#333';
        o.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${c ? dotR + 1.5 : dotR}" fill="${fill}" stroke="${c ?? (white ? '#777' : 'none')}" stroke-width="${c ? 1.6 : 0.8}"/>`);
        o.push(`<text x="${f(x)}" y="${f(y + 4.2)}" text-anchor="middle" font-size="12" font-weight="${c ? 700 : 400}" fill="${c || white ? '#222' : '#fff'}">${pc}</text>`);
    }
    o.push(flashRing(w, v.flash));
    return o.join('');
}

/** Right: the names. Seven spokes, one per letter; the accidentals are the rings. */
function letterSpiral(v: SpiralView, cx: number, cy: number): string {
    const w = new Winding(cx, cy, 360 / 7, 96, 200), rC = 52, dotR = 12;
    const held = new Set(v.held), heldSpokes = new Set(v.held.map(letterSpoke));
    const sw = w.step * Math.PI / 180;
    const o: string[] = [];
    for (let k = 0; k < 7; k++) o.push(w.line(w.at(rC + dotR, w.ang(k)), w.at(w.rOut + 6, w.ang(k)), `stroke="${SPOKE}" stroke-width="0.8"`));
    o.push(`<path d="${w.path(LO, HI, 34 * 16)}" fill="none" stroke="${GUIDE}" stroke-width="1.2"/>`);
    // The surface as a cycle, one spoke to the next: blue for a perfect fifth, pink diminished, green augmented.
    const steps = fifthSteps(v.surface);
    const curve = (s: { from: number; to: number }, u0: number, u1: number, samples: number) => {
        let d = '';
        for (let i = 0; i <= samples; i++) {
            const u = u0 + (u1 - u0) * i / samples;
            const [x, y] = w.at(w.rad(s.from) + (w.rad(s.to) - w.rad(s.from)) * u, w.ang(s.from) + sw * u);
            d += `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
        }
        return d;
    };
    const colour = (k: number) => k === 0 ? BAND : k < 0 ? DIM5 : AUG5;
    o.push(`<g opacity="${BAND_OPACITY}">`);
    for (const s of steps) {
        if (ARC_STYLE === 'dashed' && s.k !== 0) continue;
        o.push(`<path d="${curve(s, 0, 1, 32)}" fill="none" stroke="${colour(s.k)}" stroke-width="${BAND_W}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    o.push('</g>');
    const arcLabels: string[] = [];
    for (const s of steps) {
        if (s.k === 0) continue;
        if (ARC_STYLE === 'dashed') {
            const gap = BEAD + 4, u0 = gap / (w.rad(s.from) * sw), u1 = 1 - gap / (w.rad(s.to) * sw);
            o.push(`<path d="${curve(s, u0, u1, 24)}" fill="none" stroke="${s.k < 0 ? DIM5_LABEL : AUG5_LABEL}" stroke-width="1.4" stroke-dasharray="4 2.5"/>`);
        }
        const [mx, my] = w.at((w.rad(s.from) + w.rad(s.to)) / 2 - LS * 1.2, w.ang(s.from) + sw / 2);
        arcLabels.push(`<text x="${f(mx)}" y="${f(my + LS * 0.3)}" text-anchor="middle" font-size="${f(LS * 0.9)}" font-style="italic" fill="${s.k < 0 ? DIM5_LABEL : AUG5_LABEL}" stroke="${BG}" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${fifthQuality(s.k)}</text>`);
    }
    for (const n of held) if (n >= LO && n <= HI) o.push(w.line(w.at(rC + dotR, w.ang(n)), w.bead(n), `stroke="${colourOf(n)}" stroke-width="2"`));
    const active = new Map(v.surface.map(n => [letterSpoke(n), n]));
    for (let n = LO; n <= HI; n++) {
        const a = w.ang(n), [x, y] = w.bead(n), hot = held.has(n), name = nameOfLof(n);
        const s = active.get(letterSpoke(n)), ink = RING_INK[Math.min(s === undefined ? 0 : Math.abs(n - s) / 7, 4)];
        o.push(bead(x, y, n, hot, ink));
        // A spoke holds five spellings a ring apart, so the label sits beside its bead, across the spoke.
        const off = (hot ? HALO - 2 : BEAD + 3) + LS * 0.31 * [...name].length;
        o.push(label(x + Math.sin(a) * off, y - Math.cos(a) * off, name, hot, LS, ink));
    }
    o.push(...arcLabels);
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rC}" fill="none" stroke="#bbb" stroke-width="0.9"/>`);
    for (let k = 0; k < 7; k++) {
        const [x, y] = w.at(rC, w.ang(k)), hot = heldSpokes.has(k);
        const c = hot ? colourOf(k) : null;
        o.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${c ? dotR + 1.5 : dotR}" fill="${c ? tint(c, 0.4) : '#fff'}" stroke="${c ?? '#777'}" stroke-width="${c ? 1.6 : 0.8}"/>`);
        o.push(`<text x="${f(x)}" y="${f(y + 4.6)}" text-anchor="middle" font-size="13" font-weight="${c ? 700 : 400}" fill="#222">${letterOfLof(k)}</text>`);
    }
    o.push(flashRing(w, v.flash));
    return o.join('');
}

/** Both spirals, side by side, or stacked when the panel is taller than wide. */
export function renderSpiralsSvg(v: SpiralView, stacked: boolean): string {
    const W = stacked ? CELL : 2 * CELL, H = stacked ? 2 * (CELL + TITLE) : CELL + TITLE;
    const [lx, ly] = [CELL / 2, TITLE + CELL / 2];
    const [rx, ry] = stacked ? [CELL / 2, 2 * TITLE + 1.5 * CELL] : [1.5 * CELL, TITLE + CELL / 2];
    const title = (x: number, y: number, t: string) => `<text x="${x}" y="${y}" text-anchor="middle" font-size="14" fill="${DIM}">${t}</text>`;
    return `<svg class="spirals-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="Georgia, 'Times New Roman', serif">`
        + `<rect width="${W}" height="${H}" fill="${BG}"/>`
        + title(lx, ly - CELL / 2 + 4, 'pitch class: 12 fifths a turn')
        + title(rx, ry - CELL / 2 + 4, 'letter: 7 fifths a turn')
        + pitchSpiral(v, lx, ly) + letterSpiral(v, rx, ry)
        + '</svg>';
}

export function initSpirals(host: HTMLElement, model: LiveSpeller): { setVisible(on: boolean): void } {
    host.innerHTML = `<div class="panel-title">spirals: the pitch class and its letter</div><div class="spirals-host"></div>`;
    const svgHost = host.querySelector('.spirals-host') as HTMLElement;
    let visible = false, latest: LiveState | null = null, prevHeld = new Set<number>(), prevLast = '';
    const paint = (flash: boolean) => {
        if (!visible || !latest) return;
        const stacked = svgHost.clientHeight > svgHost.clientWidth * 1.15;
        svgHost.innerHTML = renderSpiralsSvg(viewOf(latest, flash), stacked);
    };
    model.subscribe(s => {
        // Flash a newly struck note once; a release or a held note's re-render does not flash again.
        const last = s.lastMidi !== null && s.lastSpelling ? `${s.lastMidi}:${s.lastSpelling.step}:${s.lastSpelling.alter}` : '';
        const flash = s.lastMidi !== null && s.heldMidi.includes(s.lastMidi) && (!prevHeld.has(s.lastMidi) || last !== prevLast);
        prevHeld = new Set(s.heldMidi); prevLast = last;
        latest = s;
        paint(flash);
    });
    new ResizeObserver(() => paint(false)).observe(svgHost);
    return { setVisible(on) { visible = on; paint(false); } };
}
