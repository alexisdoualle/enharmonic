/**
 * MusicXML export of a live take. The spellings are the speller's own (`<alter>` carries them; the
 * notation app draws accidentals against the key), so the file is a starting point to correct, not a
 * ground truth. Rhythm is quantised to the take's metronome grid:
 *
 *  1. CHORDS COLLAPSE first: notes within the onset tolerance of a chord's first note start with it.
 *  2. SNAP with a metric bias, in 16ths: within 0.6 of a 16th of a beat it is the beat, within 0.45 of an
 *     8th it is the 8th, otherwise the nearest 16th. A slightly early downbeat lands on the beat, a real
 *     16th stays a 16th, and 32nds never appear.
 *  3. CLEAN LENGTHS: a legato overlap of less than an 8th is trimmed to the next onset; a gap of less
 *     than a 16th is closed; every note lasts at least a 16th.
 *  4. VOICES: a grand staff split at middle C; per staff, notes that start and end together are one
 *     chord, and a note still held when the next one starts goes to another voice.
 *  5. BARS: notes split with ties at bar lines (and at the half bar in 4/4).
 *
 * The key signature follows the real-time speller's diatonic frame (fifths = its major tonic on the line
 * of fifths), changing only at a bar line and only once the new key holds for two bars.
 */
import type { Grid } from '../metronome.js';
import { clickMs } from '../metronome.js';

export interface ExportNote { midi: number; onT: number; offT: number; step: string; alter: number; }
export interface ExportInput {
    notes: ExportNote[];
    grid: Grid | null;               // null: a free-time take (tempo and 4/4 are estimated)
    keys: { t: number; fifths: number }[];   // the frame's key over time (onset order)
    title: string;
    speller: string;                 // which speller produced the spellings (for the encoding note)
    chordMs?: number;                // onset tolerance for chord collapse (ms)
}

/** One notated event in a voice: a chord (pitches) or a rest (no pitches), in 16ths from bar 1. */
export interface Ev { start: number; dur: number; pitches: { midi: number; step: string; alter: number }[];
    tieStart?: boolean; tieStop?: boolean; }
export interface Layout {
    bpm: number; num: number; den: number;   // bpm counts the beat (dotted quarter in 6/8)
    barLen: number;                          // 16ths per bar
    bars: number;
    keys: number[];                          // fifths per bar
    /** staves[0] = treble, [1] = bass; each a list of voices; each voice a list of bars of events. */
    staves: Ev[][][][];
}

const DIV = 4;                               // MusicXML divisions per quarter: the 16th grid
const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_VALUES = [16, 12, 8, 6, 4, 3, 2, 1];   // whole … 16th, single dots, in 16ths
const TYPE: Record<number, [string, boolean]> = {
    16: ['whole', false], 12: ['half', true], 8: ['half', false], 6: ['quarter', true],
    4: ['quarter', false], 3: ['eighth', true], 2: ['eighth', false], 1: ['16th', false],
};

/** Written octave: B♯3 sounds as midi 60, so the octave comes from the letter, not from the midi. */
export const writtenOctave = (midi: number, step: string, alter: number) =>
    Math.round((midi - alter - STEP_PC[step]!) / 12) - 1;

const compound = (g: { num: number; den: number }) => g.den === 8 && g.num % 3 === 0;

/** Lay the take out on the grid: everything except the XML. */
export function layoutTake(input: ExportInput): Layout {
    const chordMs = input.chordMs ?? 50;
    const all = input.notes.slice().sort((a, b) => a.onT - b.onT);
    const grid = input.grid ?? estimateGrid(all);
    const sixteenthMs = compound(grid) ? clickMs(grid) / 6 : clickMs(grid) * grid.den / 16;
    // With a recording, only its bars: free play before it (or after it) is left out, and a note still
    // sounding at the end is cut at the last bar line.
    const t1 = input.grid?.t1;
    const notes = input.grid
        ? all.filter(n => n.onT >= grid.t0 - 0.6 * sixteenthMs && (t1 === undefined || n.onT < t1))
            .map(n => t1 === undefined ? n : { ...n, offT: Math.min(n.offT, t1) })
        : all;
    const barLen = grid.num * 16 / grid.den;
    const beat = compound(grid) ? 6 : 16 / grid.den;
    const levels = [{ l: beat, tol: 0.6 }, { l: 2, tol: 0.45 }].filter(x => x.l <= beat);
    const toU = (t: number) => (t - grid.t0) / sixteenthMs;

    // 1. Chord collapse, 2. snap (monotone; a group landing on its predecessor merges into it).
    type Group = { at: number; raw: number; notes: ExportNote[] };
    const groups: Group[] = [];
    let open: { first: number; notes: ExportNote[] } | null = null;
    const flush = () => {
        if (!open) return;
        const raw = toU(open.first);
        const at = snap(raw, levels);
        const prev = groups[groups.length - 1];
        if (prev && at <= prev.at) { prev.notes.push(...open.notes); open = null; return; }
        groups.push({ at: Math.max(0, at), raw, notes: open.notes });
        open = null;
    };
    for (const n of notes) {
        if (open && n.onT - open.first <= chordMs && !open.notes.some(m => m.midi === n.midi)) open.notes.push(n);
        else { flush(); open = { first: n.onT, notes: [n] }; }
    }
    flush();

    const lastEnd = Math.max(0, ...groups.flatMap(g => g.notes.map(n => Math.round(toU(n.offT)))));
    const bars = input.grid?.t1 !== undefined
        ? Math.max(1, Math.round((input.grid.t1 - grid.t0) / sixteenthMs / barLen))
        : Math.max(1, Math.ceil(lastEnd / barLen));
    const end = bars * barLen;

    // 3 + 4 per staff: lengths, then voices.
    const staves: Ev[][][][] = [0, 1].map(staff => {
        const sg = groups.map(g => ({ at: g.at, raw: g.raw, notes: g.notes.filter(n => (n.midi >= 60) === (staff === 0)) }))
            .filter(g => g.notes.length && g.at < end);
        type N = { midi: number; step: string; alter: number; start: number; end: number };
        const placed: N[] = [];
        sg.forEach((g, gi) => {
            const next = sg[gi + 1];
            for (const n of g.notes) {
                let e = Math.max(g.at + 1, Math.round(toU(n.offT)));
                if (next) {
                    const over = e - next.at;
                    if (over > 0 && over < 2) e = next.at;                       // legato overlap < an 8th
                    const gapMs = next.raw * sixteenthMs - (n.offT - grid.t0);
                    if (e < next.at && gapMs < sixteenthMs) e = next.at;          // a gap < a 16th
                }
                placed.push({ midi: n.midi, step: n.step, alter: n.alter, start: g.at, end: Math.min(e, end) });
            }
        });
        // Voices: same start and end = one chord; a voice is free once its last chord has ended.
        const chords = new Map<string, N[]>();
        for (const p of placed) {
            const k = `${p.start}:${p.end}`;
            (chords.get(k) ?? chords.set(k, []).get(k)!).push(p);
        }
        const voices: { free: number; evs: Ev[] }[] = [];
        for (const c of [...chords.values()].sort((a, b) => a[0]!.start - b[0]!.start || b[0]!.end - a[0]!.end)) {
            const { start, end: e } = c[0]!;
            let v = voices.find(x => x.free <= start);
            if (!v) {
                if (voices.length < 4) { v = { free: 0, evs: [] }; voices.push(v); }
                else {   // no free voice: cut the voice that frees soonest short at this onset
                    v = voices.reduce((a, b) => a.free <= b.free ? a : b);
                    const last = v.evs[v.evs.length - 1]!;
                    last.dur = Math.max(1, start - last.start);
                }
            }
            v.evs.push({ start, dur: e - start, pitches: c.map(({ midi, step, alter }) => ({ midi, step, alter })).sort((a, b) => a.midi - b.midi) });
            v.free = e;
        }
        if (!voices.length) voices.push({ free: 0, evs: [] });
        return voices.map(v => toBars(v.evs, bars, barLen, grid));
    });

    return { bpm: grid.bpm, num: grid.num, den: grid.den, barLen, bars, keys: barKeys(input.keys, grid, sixteenthMs, barLen, bars), staves };
}

/** Snap to the coarsest level the onset is close to (`tol` in 16ths), else to the nearest 16th. */
function snap(u: number, levels: { l: number; tol: number }[]): number {
    for (const { l, tol } of levels) {
        const m = Math.round(u / l) * l;
        if (Math.abs(u - m) <= tol) return m;
    }
    return Math.round(u);
}

/** A free-time take: 4/4, bar 1 at the first note, beat = the median gap between chords (folded into
 *  60–160 bpm). A rough guess; the metronome gives the real grid. */
function estimateGrid(notes: ExportNote[]): Grid {
    const ons = [...new Set(notes.map(n => n.onT))].sort((a, b) => a - b);
    const gaps = ons.slice(1).map((t, i) => t - ons[i]!).filter(g => g > 60).sort((a, b) => a - b);
    let beat = gaps.length ? gaps[gaps.length >> 1]! : 500;
    while (60000 / beat < 60) beat /= 2;
    while (60000 / beat > 160) beat *= 2;
    return { bpm: Math.round(60000 / beat), num: 4, den: 4, t0: ons[0] ?? 0 };
}

/** Cut a voice into bars: rests fill the gaps (a whole empty bar is one bar rest); notes split with ties at
 *  bar lines and the 4/4 half bar. */
function toBars(evs: Ev[], bars: number, barLen: number, g: Grid): Ev[][] {
    const out: Ev[][] = Array.from({ length: bars }, () => []);
    const cuts = g.num === 4 && g.den === 4 ? [8] : [];
    const push = (start: number, dur: number, pitches: Ev['pitches']) => {
        let s = start, left = dur, first = true;
        while (left > 0) {
            const bar = Math.floor(s / barLen), inBar = s - bar * barLen;
            if (!pitches.length && inBar === 0 && left >= barLen) {   // a bar rest
                out[bar]!.push({ start: s, dur: barLen, pitches });
                s += barLen; left -= barLen; continue;
            }
            const stop = Math.min(barLen, ...cuts.filter(c => c > inBar));
            for (const v of decompose(inBar, Math.min(left, stop - inBar))) {
                out[bar]!.push({ start: s, dur: v, pitches, tieStop: pitches.length > 0 && !first });
                first = false; s += v; left -= v;
            }
        }
    };
    let t = 0;
    for (const e of evs) {
        if (e.start > t) push(t, e.start - t, []);
        push(e.start, e.dur, e.pitches);
        t = e.start + e.dur;
    }
    if (t < bars * barLen) push(t, bars * barLen - t, []);
    // Every piece of a note but its last carries tie-start (pieces of one note are adjacent).
    const flat = out.flat();
    for (let i = 0; i < flat.length - 1; i++) if (flat[i + 1]!.tieStop) flat[i]!.tieStart = true;
    return out;
}

/** Split a length into notatable values, largest first, keeping each value on a position it fits. */
function decompose(pos: number, len: number): number[] {
    const vals: number[] = [];
    while (len > 0) {
        // A value starts where its undotted base would (a dotted 8th on an 8th), and nothing waits past a beat.
        const v = NOTE_VALUES.find(x => x <= len && pos % Math.min(4, x % 3 === 0 ? x * 2 / 3 : x) === 0) ?? 1;
        vals.push(v); pos += v; len -= v;
    }
    return vals;
}

/** Key per bar: the frame's most common key in each bar, changed only when the new key holds two bars. */
function barKeys(keys: ExportInput['keys'], g: Grid, sixteenthMs: number, barLen: number, bars: number): number[] {
    const raw: (number | null)[] = Array.from({ length: bars }, () => null);
    const votes: Map<number, number>[] = Array.from({ length: bars }, () => new Map());
    for (const k of keys) {
        const bar = Math.floor((k.t - g.t0) / sixteenthMs / barLen);
        if (bar < 0 || bar >= bars) continue;
        const f = Math.max(-7, Math.min(7, k.fifths));
        votes[bar]!.set(f, (votes[bar]!.get(f) ?? 0) + 1);
    }
    votes.forEach((m, b) => { if (m.size) raw[b] = [...m.entries()].sort((a, c) => c[1] - a[1] || Math.abs(a[0]) - Math.abs(c[0]))[0]![0]; });
    const first = raw.find(x => x !== null) ?? 0;
    const out: number[] = [];
    let cur = first;
    for (let b = 0; b < bars; b++) {
        const v = raw[b], next = raw[b + 1];
        if (v !== null && v !== cur && (next === v || next === null || b === bars - 1)) cur = v;
        out.push(cur);
    }
    return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The MusicXML document (score-partwise 4.0, one piano part on a grand staff). */
export function toMusicXml(L: Layout, input: Pick<ExportInput, 'title' | 'speller'>, date = new Date()): string {
    const out: string[] = [];
    const quarterBpm = compound(L) ? L.bpm * 1.5 : L.bpm * 4 / L.den;
    out.push('<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
        '<score-partwise version="4.0">',
        `  <work><work-title>${esc(input.title)}</work-title></work>`,
        '  <identification>',
        '    <encoding>',
        '      <software>enharmonic viz</software>',
        `      <encoding-date>${date.toISOString().slice(0, 10)}</encoding-date>`,
        '    </encoding>',
        '    <miscellaneous>',
        `      <miscellaneous-field name="enharmonic-spellings">spelled by the enharmonic speller (${esc(input.speller)}), not checked by a person</miscellaneous-field>`,
        '    </miscellaneous>',
        '  </identification>',
        '  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>',
        '  <part id="P1">');
    for (let b = 0; b < L.bars; b++) {
        out.push(`    <measure number="${b + 1}">`);
        if (b === 0 || L.keys[b] !== L.keys[b - 1]) {
            out.push('      <attributes>');
            if (b === 0) out.push(`        <divisions>${DIV}</divisions>`);
            out.push(`        <key><fifths>${L.keys[b]}</fifths></key>`);
            if (b === 0) out.push(`        <time><beats>${L.num}</beats><beat-type>${L.den}</beat-type></time>`,
                '        <staves>2</staves>',
                '        <clef number="1"><sign>G</sign><line>2</line></clef>',
                '        <clef number="2"><sign>F</sign><line>4</line></clef>');
            out.push('      </attributes>');
        }
        if (b === 0) out.push(`      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(quarterBpm)}</per-minute></metronome></direction-type><sound tempo="${Math.round(quarterBpm)}"/></direction>`);
        let first = true;
        L.staves.forEach((voices, si) => voices.forEach((bars, vi) => {
            const evs = bars[b]!;
            const isMain = vi === 0;
            if (!isMain && evs.every(e => !e.pitches.length)) return;   // an empty extra voice is left out
            if (!first) out.push(`      <backup><duration>${L.barLen}</duration></backup>`);
            first = false;
            const voice = si * 4 + vi + 1;
            for (const e of evs) {
                const [type, dot] = TYPE[e.dur]!;
                if (!e.pitches.length) {
                    const whole = e.dur === L.barLen && isMain;
                    out.push(`      <note${isMain ? '' : ' print-object="no"'}><rest${whole ? ' measure="yes"' : ''}/><duration>${e.dur}</duration><voice>${voice}</voice>`
                        + (whole ? '' : `<type>${type}</type>${dot ? '<dot/>' : ''}`) + `<staff>${si + 1}</staff></note>`);
                    continue;
                }
                e.pitches.forEach((p, i) => {
                    const alter = p.alter ? `<alter>${p.alter}</alter>` : '';
                    const ties = (e.tieStop ? '<tie type="stop"/>' : '') + (e.tieStart ? '<tie type="start"/>' : '');
                    const tied = (e.tieStop ? '<tied type="stop"/>' : '') + (e.tieStart ? '<tied type="start"/>' : '');
                    out.push(`      <note>${i ? '<chord/>' : ''}<pitch><step>${p.step}</step>${alter}<octave>${writtenOctave(p.midi, p.step, p.alter)}</octave></pitch>`
                        + `<duration>${e.dur}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dot ? '<dot/>' : ''}<staff>${si + 1}</staff>`
                        + (tied ? `<notations>${tied}</notations>` : '') + '</note>');
                });
            }
        }));
        out.push('    </measure>');
    }
    out.push('  </part>', '</score-partwise>', '');
    return out.join('\n');
}
