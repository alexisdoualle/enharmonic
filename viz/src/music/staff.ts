/**
 * VexFlow staff: a window of ~4 measures centered on the current note, engraving the fixture's
 * GROUND-TRUTH spellings with the piece's real key signature. Accidentals are context-aware:
 * in-key notes draw no accidental (VexFlow's `Accidental.applyAccidentals`), and mid-piece key
 * changes render with cancellation + new signature. Notehead COLORS still indicate whether the
 * speller succeeded (green/blue = correct/flipped, red/purple = wrong) — the staff shows what
 * the note SHOULD be, the color shows whether we found it.
 *
 * Rhythm is a DISPLAY approximation: durations come from onset/offset deltas quantized to the
 * nearest (possibly dotted) note value, not engraving-accurate values — soft voices (Voice.Mode.SOFT)
 * tolerate the resulting rounding instead of throwing on a bar that doesn't sum exactly.
 */
import { Renderer, Stave, StaveNote, Accidental, Dot, Formatter, Voice } from 'vexflow';
import type { Replay, ReplayNote, RespellEvent } from '../replay.js';
import type { Pitch, Letter, Accidental as Alter } from '../../../src/index.js';

const WINDOW = 4;          // measures shown
const MEASURE_W = 260;
const STAVE_Y = 60;        // stave top in the initial canvas; the SVG is then cropped to real content
const STAFF_H = 220;       // initial canvas height (generous); overridden to the engraved content height
const ZOOM_MIN = 0.4;      // floor for the width-fit zoom: below this a very dense window scrolls sideways
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

// Rebuild only when the piece slice, the measure window, or the sounding set actually change — a
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
    const curMeasure = cur.expected?.measure ?? firstMeasure(pcNotes) ?? 1;
    const start = Math.max(1, curMeasure - 1);
    const sounding = soundingSet(replay, s);
    const soundSig = [...sounding].sort((a, b) => a - b).join(',');

    // Fit-to-width depends on the panel's inner width, so bucket it into the cache token — a window
    // resize that crosses a bucket busts the cache and re-fits (main wires a resize → render).
    const avail = host.clientWidth || 0;
    const token = `${pcLo}|${start}|${soundSig}|${Math.round(avail / 40)}`;
    if (replay === builtForReplay && token === builtToken) return;
    builtForReplay = replay; builtToken = token;

    try { build(host, start, sounding, pcNotes, avail, replay.respells); }
    catch (err) { host.innerHTML = emptyMsg(`staff render failed: ${String(err)}`); }
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

// onIndexes of every note sounding at note `step`'s onset (onT ≤ headT < offT) — the same rule the
// piano roll's active-outline pass uses, so both panels agree on "what's ringing right now."
function soundingSet(replay: Replay, step: number): Set<number> {
    const t = replay.notes[step]!.onT;
    const out = new Set<number>();
    for (const n of replay.notes) if (n.onT <= t && t < n.offT) out.add(n.onIndex);
    return out;
}

function build(host: HTMLElement, start: number, sounding: Set<number>, notes: ReplayNote[], avail: number, respells: RespellEvent[]): void {
    host.innerHTML = '';
    const measures: number[] = [];
    for (let m = start; m < start + WINDOW; m++) if (notes.some(n => n.expected?.measure === m)) measures.push(m);
    if (!measures.length) { host.innerHTML = emptyMsg('no notated measures here'); return; }

    // clef from the window's average pitch
    const win = notes.filter(n => n.expected?.measure != null && measures.includes(n.expected.measure));
    const avg = win.reduce((a, n) => a + n.midi, 0) / (win.length || 1);
    const clef = avg >= 60 ? 'treble' : 'bass';

    // tempo + meter so note values reflect real durations and measures aren't 4/4-padded
    const msPerBeat = estimateMsPerBeat(notes);
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

    // Pass 1: build each measure's voice and measure how wide it actually needs to be. Dense bars
    // (e.g. 16 sixteenths) need far more than a fixed width — squeezing them makes VexFlow overflow
    // notes past the stave into the next measure ("superposed" collisions). So width follows content.
    type Built = { m: number; voice: Voice | null; fmt: Formatter | null; staveW: number; noteArea: number; keySpec: string; prevKey: string };
    const built: Built[] = measures.map((m, mi) => {
        const keySpec = measureKeys[mi]!;
        const prevKey = mi > 0 ? measureKeys[mi - 1]! : keySpec;
        // Extra lead width for a key change within the window (cancellation + new sig glyphs)
        const keyChangeW = mi > 0 && keySpec !== prevKey
            ? (Math.max(SHARP_KEYS.indexOf(prevKey), FLAT_KEYS.indexOf(prevKey), 0) +
               Math.max(SHARP_KEYS.indexOf(keySpec), FLAT_KEYS.indexOf(keySpec), 0)) * 11 + 16
            : 0;
        const lead = (mi === 0 ? firstLead : OTHER_LEAD) + keyChangeW;
        const sn = buildMeasureNotes(notes, m, clef, sounding, msPerBeat, numerator);
        if (!sn.length) return { m, voice: null, fmt: null, staveW: MEASURE_W + keyChangeW, noteArea: MEASURE_W - lead - RIGHT_PAD, keySpec, prevKey };
        const voice = new Voice({ num_beats: numerator, beat_value: 4 }).setMode(Voice.Mode.SOFT);
        voice.addTickables(sn);
        // Let VexFlow place accidentals against the key sig (in-key notes draw nothing).
        Accidental.applyAccidentals([voice], keySpec);
        const fmt = new Formatter().joinVoices([voice]);
        const minW = fmt.preCalculateMinTotalWidth([voice]);
        const noteArea = Math.max(MEASURE_W - lead - RIGHT_PAD, Math.ceil(minW));
        return { m, voice, fmt, staveW: lead + noteArea + RIGHT_PAD, noteArea, keySpec, prevKey };
    });

    const totalW = built.reduce((a, b) => a + b.staveW, 0) + 20;
    // Zoom the whole engraving to fit the panel width (only shrink, never enlarge; floored so a very
    // dense bar stays legible and scrolls instead of collapsing). Draw stays in logical coordinates —
    // ctx.scale maps them into the smaller SVG — so all the width/collision maths above is unaffected.
    // Fit the engraving to BOTH the panel width and the (compact) band height, shrinking only, so a
    // tall-ranged window is zoomed out to fit the band instead of being clipped at the bottom.
    // Fit to the panel width only (shrink-only). The staff renders at a readable size and the compact
    // band scrolls vertically to it, so tall-ranged windows are never clipped.
    const widthZoom = avail > 0 ? (avail - 2) / totalW : 1;
    const zoom = Math.max(ZOOM_MIN, Math.min(1, widthZoom));
    renderer.resize(Math.ceil(totalW * zoom), Math.ceil(STAFF_H * zoom));
    if (zoom !== 1) ctx.scale(zoom, zoom);

    // Pass 2: draw each stave at its computed width, then format+draw its voice into the note area
    // so notes stay within their own measure instead of drifting into the next one.
    let x = 10;
    let firstStave: Stave | null = null;
    for (let mi = 0; mi < built.length; mi++) {
        const b = built[mi]!;
        const stave = new Stave(x, STAVE_Y, b.staveW);
        if (mi === 0) {
            firstStave = stave;
            stave.addClef(clef);
            if (b.keySpec !== 'C') stave.addKeySignature(b.keySpec);
        } else if (b.keySpec !== b.prevKey) {
            // Key change within the window: draw cancellation + new sig
            stave.addKeySignature(b.keySpec, b.prevKey);
        }
        stave.setContext(ctx).draw();
        ctx.save(); ctx.setFillStyle('#999'); ctx.setFont('Arial', 9); ctx.fillText(String(b.m), x + 2, STAVE_Y - 4); ctx.restore();
        if (b.voice && b.fmt) {
            try { b.fmt.format([b.voice], b.noteArea); b.voice.draw(ctx, stave); }
            catch { /* leave this one measure blank rather than blanking the whole staff */ }
        }
        x += b.staveW;
    }

    // Size the SVG to the engraved content, but keep at least half a band of room on each side of the
    // middle staff line so the stave can sit centred in the band. Then scroll to put the stave at the
    // band's centre: deep ledgers above or below are reachable by scrolling, with no dead space on top.
    const svg = host.querySelector('svg');
    if (svg instanceof SVGSVGElement && firstStave) {
        try {
            const bb = svg.getBBox();          // union of everything drawn, in px (zoom already baked in)
            const bandH = host.clientHeight || 100;
            const pad = 6;
            // Centre on middle C (C4), not the stave's middle line, so treble and bass windows are framed
            // the same way and low-register (bass-clef) pieces don't sit too low. C4 is a ledger below the
            // treble staff (line 5) and a ledger above the bass staff (line -1).
            const middleCLine = clef === 'bass' ? -1 : 5;
            const centerY = firstStave.getYForLine(middleCLine) * zoom;
            const top = Math.min(bb.y - pad, centerY - bandH / 2);
            const bottom = Math.max(bb.y + bb.height + pad, centerY + bandH / 2);
            const w = Math.ceil(totalW * zoom);
            const h = Math.ceil(bottom - top);
            svg.setAttribute('viewBox', `0 ${top.toFixed(1)} ${w} ${h}`);
            svg.setAttribute('width', String(w));
            svg.setAttribute('height', String(h));
            svg.style.width = `${w}px`;      // VexFlow sets an inline style height that wins over the
            svg.style.height = `${h}px`;     // attribute, so override it here too or the crop is ignored
            host.scrollTop = Math.max(0, centerY - top - bandH / 2);
        } catch { /* getBBox unavailable (detached node) — leave the fixed-size engraving */ }
    } else host.scrollTop = 0;
}

// ms-per-beat from consecutive same-measure onsets (Δt / Δbeat), median for robustness. The
// fixtures are score-quantized so this is exact, but the median tolerates a stray grace-note or
// rolled-chord outlier that would otherwise skew a mean.
function estimateMsPerBeat(notes: ReplayNote[]): number {
    const sorted = notes.filter(n => n.expected?.beat != null).sort((a, b) => a.onT - b.onT);
    const ratios: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1]!, b = sorted[i]!;
        if (a.expected!.measure !== b.expected!.measure) continue;
        const db = b.expected!.beat! - a.expected!.beat!;
        const dt = b.onT - a.onT;
        if (db > 0.01 && dt > 0) ratios.push(dt / db);
    }
    if (!ratios.length) return 500;
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
// next onset (or the barline) — so held notes and dotted rhythms come out roughly right instead of
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
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!.slice().sort((a, b) => a.midi - b.midi);
        const beat = g[0]!.expected!.beat ?? 0;
        const nextOnset = gi + 1 < groups.length ? (groups[gi + 1]![0]!.expected!.beat ?? beat + 1) : numerator + 1;
        const avail = Math.max(0.125, nextOnset - beat);
        const actualQ = Math.max(...g.map(n => (n.offT - n.onT) / msPerBeat));
        const { code, dots } = quantizeDur(Math.min(actualQ, avail));

        // Encode the accidental into the key string (e.g. 'c#/4', 'bb/3') so applyAccidentals can
        // decide whether to draw it against the key signature (in-key notes get no accidental glyph).
        const keys = g.map(n => {
            const sp = spellOf(n);
            const accGlyph = ACC[sp.alter] ?? '';
            return `${sp.step.toLowerCase()}${accGlyph}/${sp.octave}`;
        });
        const sn = new StaveNote({ clef, keys, duration: code });
        if (dots) Dot.buildAndAttach([sn], { all: true });
        // No manual accidental adding — applyAccidentals in the caller handles it per the key sig.

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
function quantizeDur(q: number): { code: string; dots: 0 | 1 } {
    let best = DUR_TABLE[4]!, bestErr = Infinity;
    for (const d of DUR_TABLE) {
        const err = Math.abs(Math.log2(q / d.q));
        if (err < bestErr) { bestErr = err; best = d; }
    }
    return best;
}
