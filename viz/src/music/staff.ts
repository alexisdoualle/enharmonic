/**
 * VexFlow staff: a page of 4 measures holding the current note (pages overlap by one), engraving the fixture's
 * GROUND-TRUTH spellings with the piece's real key signature. Accidentals are context-aware:
 * in-key notes draw no accidental (VexFlow's `Accidental.applyAccidentals`), and mid-piece key
 * changes render with cancellation + new signature. Notehead COLORS still indicate whether the
 * speller succeeded (green/blue = correct/flipped, red/purple = wrong); the staff shows what
 * the note SHOULD be, the color shows whether we found it.
 *
 * Rhythm is a DISPLAY approximation: durations come from onset/offset deltas quantized to the
 * nearest (possibly dotted) note value, not engraving-accurate values; soft voices (Voice.Mode.SOFT)
 * tolerate the resulting rounding instead of throwing on a bar that doesn't sum exactly.
 */
import { Renderer, Stave, StaveNote, GhostNote, StaveConnector, Accidental, Dot, Formatter, Voice, BarlineType } from 'vexflow';
import type { Replay, ReplayNote, RespellEvent } from '../replay.js';
import type { Pitch, Letter, Accidental as Alter } from '../../../src/index.js';

const WINDOW = 4;          // most measures on a page (fewer when dense bars would not fit)
const MEASURE_W = 260;
const STAVE_Y = 60;        // stave top in the initial canvas; the SVG is then cropped to real content
const STAFF_H = 300;       // initial canvas height (generous); overridden to the engraved content height
const ZOOM_MIN = 0.7;      // floor for the final zoom: a denser page scrolls sideways, centred on the current note
const GAP = 70;             // the bass stave's top, below the treble stave's (a grand staff, split at middle C)
const REST_KEY: Record<string, string> = { treble: 'b/4', bass: 'd/3' };
const inStaff = (clef: string) => (n: ReplayNote) => (n.midi >= 60) === (clef === 'treble');
const STAFF_SCALE = 0.8;  // engrave small, so a grand staff (and most ledger lines) fits the band without scrolling

/** Zoom that fits the page to the panel width: only shrink, never enlarge, and never below ZOOM_MIN, so a
 *  dense page keeps its size and scrolls. A narrow (phone) panel has no floor and fits the width instead. */
function zoomFor(avail: number, totalW: number): number {
    const narrow = avail > 0 && avail < 640;
    const fit = Math.min(1, avail > 0 ? (avail - 2) / totalW : 1) * STAFF_SCALE;
    return narrow ? Math.max(0.1 * STAFF_SCALE, fit * 0.85) : Math.max(ZOOM_MIN, fit);
}
const ACC: Record<number, string> = { 2: '##', 1: '#', 0: '', [-1]: 'b', [-2]: 'bb' };

// Major-key names indexed by accidental count (VexFlow draws the right glyphs).
const SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLAT_KEYS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

type Scale = { letter: string; accidental: number }[];

/** Derive a key-signature spec from a section's `respell` scale. Counts altered letters → n-sharp /
 *  n-flat key. Falls back to 'C' for anything that isn't a clean diatonic signature. */
function keySpecFromScale(scale: Scale | undefined): string {
    if (!scale) return 'C';
    let sharps = 0, flats = 0;
    for (const s of scale) {
        if (s.accidental === 1) sharps++;
        else if (s.accidental === -1) flats++;
        else if (s.accidental !== 0) return 'C'; // double accidental → not a plain key sig
    }
    if (sharps && flats) return 'C';
    if (sharps) return SHARP_KEYS[sharps] ?? 'C';
    if (flats) return FLAT_KEYS[flats] ?? 'C';
    return 'C';
}

/** The most recent `respell` scale at or before time `t_ms`. */
function sectionScale(respells: RespellEvent[], t_ms: number): Scale | undefined {
    let scale: Scale | undefined;
    for (const r of respells) {
        if (r.t_ms <= t_ms) scale = r.scale;
        else break;   // respells are in time order; once we pass t_ms, stop
    }
    return scale;
}

/** Key spec in effect at a given time. */
function keyAtTime(respells: RespellEvent[], t_ms: number): string {
    return keySpecFromScale(sectionScale(respells, t_ms));
}

// Rebuild only when the piece slice, the measure window, or the sounding set actually change: a
// mere playhead move within the same window (e.g. stepping to the next note in the same measure)
// is a cheap no-op. `builtForReplay` covers the "different fixture/mode" case (a new Replay object);
// `builtToken` covers "same replay, different window/sounding".
let builtForReplay: Replay | null = null;
let builtToken = '';

export function renderStaff(replay: Replay, step: number): void {
    const host = document.getElementById('staff')!;
    if (!replay.notes.length) { host.innerHTML = emptyMsg('no notes'); builtForReplay = null; return; }

    const s = Math.max(0, Math.min(replay.notes.length - 1, step));
    const cur = replay.notes[s]!;
    // Scope to the current PIECE. Concatenated fixtures reset measure numbers at each piece boundary,
    // so a global `measure === m` filter would collect that measure from every piece in the corpus
    // into one unreadable chord stack. A piece is the maximal run (in playing order) whose measure
    // numbers never decrease; a decrease marks the next piece's start.
    const [pcLo, pcHi] = pieceRange(replay.notes, cur.onIndex);
    const pcNotes = replay.notes.slice(pcLo, pcHi);
    const first = firstMeasure(pcNotes) ?? 1;
    const curMeasure = cur.expected?.measure ?? first;
    const sounding = soundingSet(replay, s);
    const soundSig = [...sounding].sort((a, b) => a - b).join(',');

    // Fit-to-width depends on the panel's inner width, so bucket it into the cache token: a window
    // resize that crosses a bucket busts the cache and re-fits (main wires a resize → render).
    const avail = host.clientWidth || 0;
    const [start, count] = pageOf(replay, pcLo, pcNotes, curMeasure, avail);
    const token = `${pcLo}|${start}|${count}|${soundSig}|${Math.round(avail / 40)}`;
    if (replay === builtForReplay && token === builtToken) return;
    builtForReplay = replay; builtToken = token;

    try { build(host, start, count, sounding, pcNotes, avail, replay.respells); }
    catch (err) { host.innerHTML = emptyMsg(`staff render failed: ${String(err)}`); }
}

const EST_ONSET_W = 42;   // rough engraved width of one onset, to size pages before engraving them

// Pages of the current piece, cached per replay, piece and width bucket: [first measure, bar count][].
let pagesKey = '', pagesFor: Replay | null = null, pages: [number, number][] = [];

/** The page holding measure `m`: up to WINDOW bars, fewer when dense bars would not fit the panel at
 *  ZOOM_MIN. Pages are cut greedily from the piece start, so they hold still while the music crosses
 *  them. Pages overlap by one bar (the shared bar belongs to the earlier page). */
function pageOf(replay: Replay, pcLo: number, notes: ReplayNote[], m: number, avail: number): [number, number] {
    const narrow = avail > 0 && avail < 640;
    const key = `${pcLo}|${narrow ? 'n' : Math.round(avail / 40)}`;
    if (pagesFor !== replay || pagesKey !== key) {
        pagesFor = replay; pagesKey = key;
        pages = cutPages(notes, narrow || avail <= 0 ? Infinity : (avail - 2) * STAFF_SCALE / ZOOM_MIN);
    }
    return pages.find(([a, c]) => m >= a && m < a + c) ?? pages[pages.length - 1] ?? [m, WINDOW];
}

function cutPages(notes: ReplayNote[], budget: number): [number, number][] {
    const onsets = new Map<number, Set<number>>();   // measure → distinct onset times
    for (const n of notes) {
        const m = n.expected?.measure;
        if (m == null) continue;
        let set = onsets.get(m);
        if (!set) onsets.set(m, set = new Set());
        set.add(Math.round(n.onT));
    }
    if (!onsets.size) return [];
    const lo = Math.min(...onsets.keys()), hi = Math.max(...onsets.keys());
    const widthOf = (m: number) => Math.max(MEASURE_W, 40 + EST_ONSET_W * (onsets.get(m)?.size ?? 0));
    const out: [number, number][] = [];
    let a = lo;
    for (;;) {
        let c = 1, w = 120 + widthOf(a);   // 120: clef, key signature and margins
        while (c < WINDOW && a + c <= hi && w + widthOf(a + c) <= budget) { w += widthOf(a + c); c++; }
        out.push([a, c]);
        if (a + c > hi) break;
        a += c > 1 ? c - 1 : 1;
    }
    return out;
}

/** PAGES: the staff holds still while the music crosses it, then turns to the next page. Pages of `size`
 *  overlap by one (bars 1-4, 4-7, 7-10), so after a turn the bar just played is still in view. Returns the
 *  first slot of the page holding slot `i` (0-based); the shared slot belongs to the earlier page. */
function pageStart(i: number, size: number): number {
    const step = size - 1;
    return Math.max(0, Math.ceil(i / step) - 1) * step;
}

const LIVE_ONSETS = 16;   // chords on a page of the live staff
const LIVE_GROUP_MS = 50; // notes this close to a chord's first note stack with it (the take's onset tolerance)

/** A live take has no meter and no composer spelling: engrave the speller's own spellings in onset order,
 *  chords stacked, as plain quarter notes on a grand staff (split at middle C) with no barlines. Accidentals carry across the
 *  whole stave, as they would within one long bar. */
export function renderLiveStaff(replay: Replay, step: number): void {
    const host = document.getElementById('staff')!;
    builtForReplay = null;   // a fixture shown next rebuilds from scratch
    if (!replay.notes.length) { host.innerHTML = emptyMsg('play a note'); return; }
    const s = Math.max(0, Math.min(replay.notes.length - 1, step));
    const sounding = soundingSet(replay, s);

    // Chord groups, the same grouping the engine used; the page holding the current note's chord.
    const groups: ReplayNote[][] = [];
    let curIdx = 0;
    replay.notes.forEach((n, i) => {
        const g = groups[groups.length - 1];
        if (g && n.onT - g[0]!.onT <= LIVE_GROUP_MS && !g.some(m => m.midi === n.midi)) g.push(n);
        else groups.push([n]);
        if (i === s) curIdx = groups.length - 1;
    });
    const p0 = pageStart(curIdx, LIVE_ONSETS);
    const shown = groups.slice(p0, p0 + LIVE_ONSETS);
    const curGroup = groups[curIdx]!;

    host.innerHTML = '';
    try {
        // Each chord is split at middle C between the two staves; an empty side gets a quarter rest.
        const voiceFor = (clef: string): Voice => {
            const tickables = shown.map(g => {
                const sorted = g.filter(inStaff(clef)).sort((a, b) => a.midi - b.midi);
                if (!sorted.length) return new StaveNote({ clef, keys: [REST_KEY[clef]!], duration: 'qr' });
                const keys = sorted.map(n => {
                    const sp = spellOf(n);
                    return `${sp.step.toLowerCase()}${ACC[sp.alter] ?? ''}/${sp.octave}`;
                });
                const sn = new StaveNote({ clef, keys, duration: 'q' });
                sorted.forEach((n, i) => {
                    const color = g === curGroup || sounding.has(n.onIndex) ? '#1f6feb' : '#222';
                    sn.setKeyStyle(i, { fillStyle: color, strokeStyle: color });
                });
                return sn;
            });
            // Empty slots keep a page's spacing fixed while it fills, so notes never shift as you play.
            const slots = [...tickables, ...Array.from({ length: LIVE_ONSETS - tickables.length }, () => new GhostNote({ duration: 'q' }))];
            const voice = new Voice({ num_beats: slots.length, beat_value: 4 }).setMode(Voice.Mode.SOFT);
            voice.addTickables(slots);
            Accidental.applyAccidentals([voice], 'C');
            return voice;
        };
        const voices = [voiceFor('treble'), voiceFor('bass')];
        const fmt = new Formatter().joinVoices([voices[0]!]).joinVoices([voices[1]!]);
        const lead = 46, rightPad = 18;
        const noteArea = Math.max(MEASURE_W, Math.ceil(fmt.preCalculateMinTotalWidth(voices)) + 12 * LIVE_ONSETS);
        const totalW = lead + noteArea + rightPad + 20;
        const avail = host.clientWidth || 0;
        const zoom = zoomFor(avail, totalW);
        const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
        const ctx = renderer.getContext();
        renderer.resize(Math.ceil(totalW * zoom), Math.ceil(STAFF_H * zoom));
        if (zoom !== 1) ctx.scale(zoom, zoom);
        const staves = [new Stave(10, STAVE_Y, lead + noteArea + rightPad), new Stave(10, STAVE_Y + GAP, lead + noteArea + rightPad)];
        staves.forEach((stave, si) => {
            stave.addClef(si === 0 ? 'treble' : 'bass');
            stave.setEndBarType(BarlineType.NONE);
            stave.setContext(ctx).draw();
        });
        new StaveConnector(staves[0]!, staves[1]!).setType('brace').setContext(ctx).draw();
        new StaveConnector(staves[0]!, staves[1]!).setType('singleLeft').setContext(ctx).draw();
        fmt.format(voices, noteArea);
        voices[0]!.draw(ctx, staves[0]!);
        voices[1]!.draw(ctx, staves[1]!);
        fitToBand(host, staves[0]!, zoom, totalW);
    } catch (err) { host.innerHTML = emptyMsg(`staff render failed: ${String(err)}`); }
}

function emptyMsg(text: string): string {
    return `<div class="staff-empty">${text}</div>`;
}

// [lo, hi) bounds in note-index (== onIndex, playing order) of the piece containing note `ci`. The
// piece is the maximal run around `ci` whose measure numbers never decrease; a drop (measure i+1 <
// measure i) is a piece boundary. Notes with no measure (unscored) are absorbed into the run.
function pieceRange(notes: ReplayNote[], ci: number): [number, number] {
    const n = notes.length;
    if (!n) return [0, 0];
    if (ci < 0) ci = 0; else if (ci >= n) ci = n - 1;
    const meas = (i: number) => notes[i]?.expected?.measure ?? null;
    let lo = ci;
    while (lo > 0) { const a = meas(lo - 1), b = meas(lo); if (a != null && b != null && a > b) break; lo--; }
    let hi = ci;
    while (hi < n - 1) { const a = meas(hi), b = meas(hi + 1); if (a != null && b != null && b < a) break; hi++; }
    return [lo, hi + 1];
}

function firstMeasure(notes: ReplayNote[]): number | null {
    for (const n of notes) if (n.expected?.measure != null) return n.expected.measure;
    return null;
}

// onIndexes of every note sounding at note `step`'s onset (onT ≤ headT < offT), the same rule the
// piano roll's active-outline pass uses, so both panels agree on "what's ringing right now."
function soundingSet(replay: Replay, step: number): Set<number> {
    const t = replay.notes[step]!.onT;
    const out = new Set<number>();
    for (const n of replay.notes) if (n.onT <= t && t < n.offT) out.add(n.onIndex);
    return out;
}

function build(host: HTMLElement, start: number, count: number, sounding: Set<number>, notes: ReplayNote[], avail: number, respells: RespellEvent[]): void {
    host.innerHTML = '';
    const measures: number[] = [];
    for (let m = start; m < start + count; m++) if (notes.some(n => n.expected?.measure === m)) measures.push(m);
    if (!measures.length) { host.innerHTML = emptyMsg('no notated measures here'); return; }

    // tempo + meter so note values reflect real durations and measures aren't 4/4-padded
    // The beat length per bar (else the bars shown, else the piece), so a tempo change doesn't misread
    // the note values after it.
    const pageBeat = estimateMsPerBeat(notes.filter(n => measures.includes(n.expected?.measure ?? NaN)))
        ?? estimateMsPerBeat(notes) ?? 500;
    const beatIn = (m: number) => estimateMsPerBeat(notes.filter(n => n.expected?.measure === m)) ?? pageBeat;
    const numerator = estimateNumerator(notes);

    // Per-measure key signature: find a representative note's onset time, then look up the active key.
    const measureKeys: string[] = measures.map(m => {
        const rep = notes.find(n => n.expected?.measure === m);
        return rep ? keyAtTime(respells, rep.onT) : 'C';
    });

    const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
    const ctx = renderer.getContext();

    // Left padding inside the first stave for clef + key signature (ksCount * 11 + 8 per lab).
    const firstKey = measureKeys[0] ?? 'C';
    const ksCount = firstKey !== 'C' ? Math.max(SHARP_KEYS.indexOf(firstKey), FLAT_KEYS.indexOf(firstKey)) : 0;
    const firstLead = 46 + (ksCount > 0 ? ksCount * 11 + 8 : 0);
    const OTHER_LEAD = 14, RIGHT_PAD = 18;

    // Pass 1: build each measure's two voices (treble and bass, each with rests filling its gaps so the
    // two hands line up) and measure how wide the bar needs to be. Dense bars need far more than a fixed
    // width; squeezing them makes VexFlow overflow notes into the next measure. So width follows content.
    type Built = { m: number; voices: [Voice, Voice]; fmt: Formatter; staveW: number; noteArea: number; keySpec: string; prevKey: string };
    const voiceFor = (clef: string, m: number, keySpec: string): Voice => {
        let sn = buildMeasureNotes(notes.filter(inStaff(clef)), m, clef, sounding, beatIn(m), numerator);
        if (!sn.length) sn = [new StaveNote({ clef, keys: [REST_KEY[clef]!], duration: 'wr', align_center: true })];
        const voice = new Voice({ num_beats: numerator, beat_value: 4 }).setMode(Voice.Mode.SOFT);
        voice.addTickables(sn);
        Accidental.applyAccidentals([voice], keySpec);   // in-key notes draw no accidental
        return voice;
    };
    const built: Built[] = measures.map((m, mi) => {
        const keySpec = measureKeys[mi]!;
        const prevKey = mi > 0 ? measureKeys[mi - 1]! : keySpec;
        // Extra lead width for a key change within the window (cancellation + new sig glyphs)
        const keyChangeW = mi > 0 && keySpec !== prevKey
            ? (Math.max(SHARP_KEYS.indexOf(prevKey), FLAT_KEYS.indexOf(prevKey), 0) +
               Math.max(SHARP_KEYS.indexOf(keySpec), FLAT_KEYS.indexOf(keySpec), 0)) * 11 + 16
            : 0;
        const lead = (mi === 0 ? firstLead : OTHER_LEAD) + keyChangeW;
        const voices: [Voice, Voice] = [voiceFor('treble', m, keySpec), voiceFor('bass', m, keySpec)];
        const fmt = new Formatter().joinVoices([voices[0]]).joinVoices([voices[1]]);
        const minW = fmt.preCalculateMinTotalWidth(voices);
        const noteArea = Math.max(MEASURE_W - lead - RIGHT_PAD, Math.ceil(minW));
        return { m, voices, fmt, staveW: lead + noteArea + RIGHT_PAD, noteArea, keySpec, prevKey };
    });

    const totalW = built.reduce((a, b) => a + b.staveW, 0) + 20;
    // Zoom the whole engraving to fit the panel width (see zoomFor). Draw stays in logical coordinates;
    // ctx.scale maps them into the smaller SVG, so all the width/collision maths above is unaffected.
    const zoom = zoomFor(avail, totalW);
    renderer.resize(Math.ceil(totalW * zoom), Math.ceil(STAFF_H * zoom));
    if (zoom !== 1) ctx.scale(zoom, zoom);

    // Pass 2: draw each bar's two staves at its computed width, then format the two voices together
    // (so the hands align) into the note area.
    let x = 10;
    let firstStave: Stave | null = null;
    for (let mi = 0; mi < built.length; mi++) {
        const b = built[mi]!;
        const staves = [new Stave(x, STAVE_Y, b.staveW), new Stave(x, STAVE_Y + GAP, b.staveW)] as const;
        staves.forEach((stave, si) => {
            if (mi === 0) {
                stave.addClef(si === 0 ? 'treble' : 'bass');
                if (b.keySpec !== 'C') stave.addKeySignature(b.keySpec);
            } else if (b.keySpec !== b.prevKey) {
                stave.addKeySignature(b.keySpec, b.prevKey);   // key change within the window
            }
            stave.setContext(ctx).draw();
        });
        if (mi === 0) {
            firstStave = staves[0];
            new StaveConnector(staves[0], staves[1]).setType('brace').setContext(ctx).draw();
            new StaveConnector(staves[0], staves[1]).setType('singleLeft').setContext(ctx).draw();
        }
        new StaveConnector(staves[0], staves[1]).setType('singleRight').setContext(ctx).draw();
        ctx.save(); ctx.setFillStyle('#999'); ctx.setFont('Arial', 9); ctx.fillText(String(b.m), x + 2, staves[0].getYForLine(0) - 5); ctx.restore();   // just above the top line
        try {
            b.fmt.format(b.voices, b.noteArea);
            b.voices[0].draw(ctx, staves[0]);
            b.voices[1].draw(ctx, staves[1]);
        } catch { /* leave this one measure blank rather than blanking the whole staff */ }
        x += b.staveW;
    }

    fitToBand(host, firstStave, zoom, totalW);
}

/** Size the SVG to the engraved content, but keep at least half a band of room on each side of the
 *  middle staff line so the stave can sit centred in the band. Then scroll to put the stave at the
 *  band's centre: deep ledgers above or below are reachable by scrolling, with no dead space on top. */
// A vertical scroll by the user is kept across redraws (the staff redraws as the playhead moves).
let userScrollTop: number | null = null, expectedScrollTop = -1, scrollWatched = false;
function watchScroll(host: HTMLElement): void {
    if (scrollWatched) return;
    scrollWatched = true;
    host.addEventListener('scroll', () => {
        if (Math.abs(host.scrollTop - expectedScrollTop) > 2) { userScrollTop = host.scrollTop; expectedScrollTop = host.scrollTop; }
    });
}
/** Forget the user's staff scroll (a new piece or take is centred again). */
export function resetStaffScroll(): void { userScrollTop = null; }

function fitToBand(host: HTMLElement, firstStave: Stave | null, zoom: number, totalW: number): void {
    const svg = host.querySelector('svg');
    if (svg instanceof SVGSVGElement && firstStave) {
        try {
            // VexFlow zooms by the viewBox: the drawing is in its own units, the SVG element in screen px.
            // So crop the viewBox in drawing units (the whole width, the drawn height, at least a band's
            // worth around the middle) and size the element in px.
            const bb = svg.getBBox();          // what is drawn, in drawing units
            const bandU = (host.clientHeight || 100) / zoom;
            const pad = 6 / zoom;
            // Centre the band on what is drawn (staff plus ledger-line notes), so a high or low passage is
            // framed instead of sitting at the edge.
            const centerY = bb.y + bb.height / 2;
            const top = Math.min(bb.y - pad, centerY - bandU / 2);
            const bottom = Math.max(bb.y + bb.height + pad, centerY + bandU / 2);
            const wPx = Math.ceil(totalW * zoom), hPx = Math.ceil((bottom - top) * zoom);
            svg.setAttribute('viewBox', `0 ${top.toFixed(1)} ${totalW} ${(bottom - top).toFixed(1)}`);
            svg.setAttribute('width', String(wPx));
            svg.setAttribute('height', String(hPx));
            svg.style.width = `${wPx}px`;      // VexFlow sets an inline style height that wins over the
            svg.style.height = `${hPx}px`;     // attribute, so override it here too or the crop is ignored
            // The user's own scroll wins until the piece changes (resetStaffScroll); otherwise centre.
            host.scrollTop = userScrollTop ?? Math.max(0, (centerY - top - bandU / 2) * zoom);
            expectedScrollTop = host.scrollTop;
            watchScroll(host);
            // A page wider than the panel scrolls sideways: centre the sounding notes.
            const cx = soundingCentreX(svg);
            if (cx != null) host.scrollLeft = Math.max(0, cx * zoom - host.clientWidth / 2);
        } catch { /* getBBox unavailable (detached node): leave the fixed-size engraving */ }
    } else host.scrollTop = 0;
}

const SOUNDING_FILLS = ['#1f6feb', '#8957e5'];

/** Mid x (drawing units) of the sounding noteheads, from their fill colour; null when none is drawn. */
function soundingCentreX(svg: SVGSVGElement): number | null {
    let lo = Infinity, hi = -Infinity;
    for (const el of svg.querySelectorAll<SVGGraphicsElement>(SOUNDING_FILLS.map(c => `[fill="${c}"]`).join(','))) {
        const b = el.getBBox();
        lo = Math.min(lo, b.x); hi = Math.max(hi, b.x + b.width);
    }
    return lo <= hi ? (lo + hi) / 2 : null;
}

// ms-per-beat from consecutive same-measure onsets (Δt / Δbeat), median for robustness. The
// fixtures are score-quantized so this is exact, but the median tolerates a stray grace-note or
// rolled-chord outlier that would otherwise skew a mean.
function estimateMsPerBeat(notes: ReplayNote[]): number | null {
    const sorted = notes.filter(n => n.expected?.beat != null).sort((a, b) => a.onT - b.onT);
    const ratios: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!, b = sorted[i]!;
        if (a.expected!.measure !== b.expected!.measure) continue;
        const db = b.expected!.beat! - a.expected!.beat!;
        const dt = b.onT - a.onT;
        if (db > 0.01 && dt > 0) ratios.push(dt / db);
    }
    if (!ratios.length) return null;
    ratios.sort((x, y) => x - y);
    return ratios[ratios.length >> 1]!;
}

// Beats-per-measure ≈ the largest integer beat anyone starts on (beats are quarter units, so
// beat_value stays 4). This only sets voice width / barline placement, so an approximation in
// compound meters is harmless under Voice.Mode.SOFT.
function estimateNumerator(notes: ReplayNote[]): number {
    let mx = 0;
    for (const n of notes) if (n.expected?.beat != null) mx = Math.max(mx, Math.floor(n.expected.beat));
    return Math.min(12, Math.max(2, mx));
}

// The spelling to engrave: the fixture's GROUND TRUTH (expected), falling back to committed only
// when expected is null (shouldn't happen for scored notes, but defensive).
function spellOf(n: ReplayNote): Pitch {
    if (n.expected) return { step: n.expected.step as Letter, alter: n.expected.alter as Alter, octave: n.expected.octave };
    if (n.committed) return n.committed;
    // Last resort: derive from MIDI (should never happen for scored notes)
    const octave = Math.floor(n.midi / 12) - 1;
    const pc = n.midi % 12;
    const letters: Letter[] = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
    const alters: Alter[] = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    return { step: letters[pc]!, alter: alters[pc]!, octave };
}

// Build StaveNotes for one measure: group notes by beat (chord-merge same-beat onsets). The note
// value is the group's actual sounding length (offT-onT ÷ ms-per-beat), capped by the gap to the
// next onset (or the barline), so held notes and dotted rhythms come out roughly right instead of
// every note snapping to the onset spacing. Accidentals are encoded in the key string (e.g. 'c#/4')
// so VexFlow's applyAccidentals (called by the caller) can decide whether to draw them.
function buildMeasureNotes(notes: ReplayNote[], measure: number, clef: string, sounding: Set<number>, msPerBeat: number, numerator: number): StaveNote[] {
    const inM = notes.filter(n => n.expected?.measure === measure)
        .sort((a, b) => (a.expected!.beat ?? 0) - (b.expected!.beat ?? 0));
    if (!inM.length) return [];

    const groups: ReplayNote[][] = [];
    for (const n of inM) {
        const last = groups[groups.length - 1];
        if (last && (last[0]!.expected!.beat ?? 0) === (n.expected!.beat ?? 0)) last.push(n);
        else groups.push([n]);
    }

    const out: StaveNote[] = [];
    let cursor = Math.min(1, groups[0]![0]!.expected!.beat ?? 1);   // where the staff has got to, in beats
    const rest = (len: number) => {   // a rest filling a gap, so this staff stays in line with the other
        const r = quantizeDur(len);
        const sn = new StaveNote({ clef, keys: [REST_KEY[clef]!], duration: r.code + 'r' });
        if (r.dots) Dot.buildAndAttach([sn], { all: true });
        out.push(sn);
        cursor += r.q;
    };
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!.slice().sort((a, b) => a.midi - b.midi);
        const beat = g[0]!.expected!.beat ?? 0;
        if (beat - cursor >= 0.2) rest(beat - cursor);
        cursor = beat;
        const nextOnset = gi + 1 < groups.length ? (groups[gi + 1]![0]!.expected!.beat ?? beat + 1) : numerator + 1;
        const avail = Math.max(0.125, nextOnset - beat);
        const actualQ = Math.max(...g.map(n => (n.offT - n.onT) / msPerBeat));
        const { code, dots, q } = quantizeDur(Math.min(actualQ, avail));
        cursor += q;

        // Encode the accidental into the key string (e.g. 'c#/4', 'bb/3') so applyAccidentals can
        // decide whether to draw it against the key signature (in-key notes get no accidental glyph).
        const keys = g.map(n => {
            const sp = spellOf(n);
            const accGlyph = ACC[sp.alter] ?? '';
            return `${sp.step.toLowerCase()}${accGlyph}/${sp.octave}`;
        });
        const sn = new StaveNote({ clef, keys, duration: code });
        if (dots) Dot.buildAndAttach([sn], { all: true });
        // No manual accidental adding: applyAccidentals in the caller handles it per the key sig.

        // Colour per notehead (four-tier, mirroring the lab): sounding+wrong(or unread) = purple,
        // sounding+correct/flipped = blue; silent wrong/unread = red, silent correct = green, silent
        // flipped = amber (same tier palette as the rest of the app, so a wrong-side flip reads the
        // same colour everywhere you look).
        g.forEach((n, i) => {
            const isSounding = sounding.has(n.onIndex);
            const bad = n.tier === 'wrong' || n.tier === 'unread';
            const color = isSounding
                ? (bad ? '#8957e5' : '#1f6feb')
                : (bad ? '#b00' : n.tier === 'flipped' ? '#b8860b' : '#1a7f37');
            sn.setKeyStyle(i, { fillStyle: color, strokeStyle: color });
        });
        out.push(sn);
    }
    return out;
}

// Nearest note value (in quarter-lengths), including single-dotted values, so 1.5 → dotted quarter
// rather than snapping to a plain half. Compared in log2 space so the choice is symmetric across the
// octave of durations (a 2x-too-long guess is penalized the same as a 2x-too-short one).
const DUR_TABLE: { code: string; q: number; dots: 0 | 1 }[] = [
    { code: 'w', q: 4, dots: 0 }, { code: 'w', q: 6, dots: 1 },
    { code: 'h', q: 2, dots: 0 }, { code: 'h', q: 3, dots: 1 },
    { code: 'q', q: 1, dots: 0 }, { code: 'q', q: 1.5, dots: 1 },
    { code: '8', q: 0.5, dots: 0 }, { code: '8', q: 0.75, dots: 1 },
    { code: '16', q: 0.25, dots: 0 }, { code: '16', q: 0.375, dots: 1 },
    { code: '32', q: 0.125, dots: 0 },
];
function quantizeDur(q: number): { code: string; dots: 0 | 1; q: number } {
    let best = DUR_TABLE[4]!, bestErr = Infinity;
    for (const d of DUR_TABLE) {
        const err = Math.abs(Math.log2(q / d.q));
        if (err < bestErr) { bestErr = err; best = d; }
    }
    return best;
}
