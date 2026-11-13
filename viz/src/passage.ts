/**
 * Box-select passage export: a text report of a region of the piano roll, for an agent to read in place
 * of a screenshot.
 *
 * The box is a span of onsets (time) and a band of MIDI pitches. The notes struck inside it are reported;
 * the harmony context uses everything sounding in that time span, in or out of the band. Sections:
 * header, text piano-roll, voices, harmony timeline, decisions for the wrong and flipped notes, and
 * automatic pattern flags. Like the other copy reports it reads the replay snapshots the panels render,
 * and spellings are ASCII (Gb / F#). Pure apart from `header` reading `location.href`.
 */
import type { AppState } from './state.js';
import type { Replay, ReplayNote, Snapshot } from './replay.js';
import type { Pitch, PitchClass } from '../../src/index.js';
import type { LocalKey } from '../../src/key.js';
import { isKeyDegree, isLeadingTone, isWideLeadingTone } from '../../src/key.js';
import { intervalBetween, intervalLabel } from '../../src/interval.js';
import { ascii } from './format.js';
import { candidateTotal, deltaColumns, type DecisionCandidate } from './decision.js';
import { chordReading, chordReadingText } from './chord.js';
import { header, keyPair, pitch } from './copy.js';

/** A box on the piano roll: onsets `onFrom..onTo` (0-based on-index, inclusive) × MIDI `midiLo..midiHi`. */
export interface PassageBox { onFrom: number; onTo: number; midiLo: number; midiHi: number; }

/** `box=<onFrom>-<onTo>:<midiLo>-<midiHi>` (on-indices 0-based, as in the copy reports' onset numbers). */
export function formatBox(b: PassageBox): string { return `${b.onFrom}-${b.onTo}:${b.midiLo}-${b.midiHi}`; }
export function parseBox(raw: string | null): PassageBox | null {
    const m = raw ? /^(\d+)-(\d+):(\d+)-(\d+)$/.exec(raw.trim()) : null;
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
    return { onFrom: Math.min(a, b), onTo: Math.max(a, b), midiLo: Math.min(c, d), midiHi: Math.max(c, d) };
}
/** Clamp a box to a replay; null if it holds no onset. */
export function clampBox(b: PassageBox, replay: Replay): PassageBox | null {
    const n = replay.notes.length;
    if (!n || b.onFrom >= n) return null;
    return { ...b, onTo: Math.min(b.onTo, n - 1) };
}

const ROLL_COLS = 90;      // text piano-roll columns before onsets are binned
const MAX_VOICES = 10, MAX_RUNS = 16, MAX_HARMONY = 40, MAX_DECISIONS = 20, MAX_FLAGS = 12;

const mod12 = (n: number) => ((n % 12) + 12) % 12;
const sgn = (n: number) => (n > 0 ? '+' + n : String(n));
const trimNum = (x: number) => String(Math.round(x * 100) / 100);
const PC_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const PC_MINOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
/** A gate key (pitch-class tonic + mode) by its conventional name; the key tables carry no spelling. */
const keyText = (k: LocalKey | null | undefined) => (k ? `${(k.minor ? PC_MINOR : PC_MAJOR)[mod12(k.tonic)]} ${k.minor ? 'min' : 'maj'}` : '—');
const pcOfSp = (p: { step: string; alter: number }) => mod12(({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[p.step]! + p.alter);
const samePc = (a: PitchClass | null | undefined, b: PitchClass | null | undefined) => !!a && !!b && a.step === b.step && a.alter === b.alter;
const tierMark = (n: ReplayNote) => (n.tier === 'wrong' ? '✗' : n.tier === 'flipped' ? '~' : n.tier === 'unread' && !n.expected ? '?' : '');
const ours = (n: ReplayNote) => pitch(n.committed);
const composer = (n: ReplayNote) => (n.expected ? pitch(n.expected as unknown as Pitch) : '—');
const pc = (p: Pitch | PitchClass | null | undefined) => (p ? ascii(p) : '—');

/** "68:1.5" from the fixture's measure/beat; the onset number when the fixture has none. */
function pos(n: ReplayNote | undefined): string {
    const e = n?.expected;
    if (e?.measure == null) return n ? `#${n.onIndex}` : '?';
    return e.beat != null ? `${e.measure}:${trimNum(e.beat)}` : `${e.measure}`;
}

/** Everything the report needs about the box, computed once. */
interface Ctx {
    s: AppState; r: Replay; box: PassageBox;
    notes: ReplayNote[];          // struck inside the box (onset range × pitch band), onset order
    heldIn: ReplayNote[];         // in the band, struck before the box, still sounding at its first onset
    voiceOf: Map<number, number>; // onIndex → voice (0 = top)
    voices: ReplayNote[][];       // per voice, onset order
    msPerBeat: number | null;
    onsetTimes: number[];         // every distinct onset time in the box's span (all pitches)
    lastAtTime: Map<number, number>; // onset time → last on-index at that time (the whole chord is in)
}

/** Median ms per beat around the box, from pairs of onsets in one measure (fixtures carry measure/beat). */
function msPerBeat(r: Replay, from: number, to: number): number | null {
    const lo = Math.max(0, from - 64), hi = Math.min(r.notes.length - 1, to + 64);
    const est: number[] = [];
    let prev: ReplayNote | null = null;
    for (let i = lo; i <= hi; i++) {
        const n = r.notes[i]!;
        const e = n.expected, p = prev?.expected;
        if (prev && e?.measure != null && e.beat != null && p?.measure === e.measure && p.beat != null && e.beat > p.beat && n.onT > prev.onT)
            est.push((n.onT - prev.onT) / (e.beat - p.beat));
        if (!prev || n.onT !== prev.onT) prev = n;
    }
    if (!est.length) return null;
    est.sort((a, b) => a - b);
    return est[est.length >> 1]!;
}

/**
 * Nearest-pitch voice proxy (the fixtures carry no notated voice or part). Onsets in time order; a voice is
 * free once its last note has ended (30 ms slack). Each chord's notes go to the free voices by smallest pitch
 * move first; a note more than an octave from every free voice opens a new one. Voices are then numbered from
 * the top by mean pitch.
 */
function separateVoices(notes: readonly ReplayNote[]): number[][] {
    const vs: { last: ReplayNote; members: number[] }[] = [];
    const groups = new Map<number, number[]>();
    notes.forEach((n, k) => (groups.get(n.onT) ?? groups.set(n.onT, []).get(n.onT)!).push(k));
    for (const [t, ks] of [...groups].sort((a, b) => a[0] - b[0])) {
        const free = new Set(vs.map((_, v) => v).filter(v => vs[v]!.last.offT <= t + 30));
        const pairs: { k: number; v: number; d: number }[] = [];
        for (const k of ks) for (const v of free) pairs.push({ k, v, d: Math.abs(notes[k]!.midi - vs[v]!.last.midi) });
        pairs.sort((a, b) => a.d - b.d);
        const done = new Set<number>();
        for (const p of pairs) {
            if (done.has(p.k) || !free.has(p.v) || p.d > 12) continue;
            done.add(p.k); free.delete(p.v);
            vs[p.v]!.members.push(p.k); vs[p.v]!.last = notes[p.k]!;
        }
        for (const k of ks) if (!done.has(k)) vs.push({ last: notes[k]!, members: [k] });
    }
    const mean = (m: number[]) => m.reduce((a, k) => a + notes[k]!.midi, 0) / m.length;
    return vs.map(v => v.members).sort((a, b) => mean(b) - mean(a));
}

function buildCtx(s: AppState, box: PassageBox): Ctx {
    const r = s.replay!;
    const inBand = (n: ReplayNote) => n.midi >= box.midiLo && n.midi <= box.midiHi;
    const notes = r.notes.slice(box.onFrom, box.onTo + 1).filter(inBand);
    const t0 = r.notes[box.onFrom]!.onT;
    const heldIn: ReplayNote[] = [];
    for (let i = box.onFrom - 1; i >= Math.max(0, box.onFrom - 400); i--) {
        const n = r.notes[i]!;
        if (inBand(n) && n.onT < t0 && n.offT > t0) heldIn.unshift(n);
    }
    const groups = separateVoices(notes);
    const voiceOf = new Map<number, number>();
    groups.forEach((g, v) => g.forEach(k => voiceOf.set(notes[k]!.onIndex, v)));
    const voices = groups.map(g => g.map(k => notes[k]!));
    const lastAtTime = new Map<number, number>();
    for (let i = box.onFrom; i <= box.onTo; i++) lastAtTime.set(r.notes[i]!.onT, i);
    return { s, r, box, notes, heldIn, voiceOf, voices, msPerBeat: msPerBeat(r, box.onFrom, box.onTo),
        onsetTimes: [...lastAtTime.keys()].sort((a, b) => a - b), lastAtTime };
}

const beats = (c: Ctx, ms: number) => (c.msPerBeat ? `${trimNum(ms / c.msPerBeat)} beat${Math.abs(ms / c.msPerBeat - 1) < 0.01 ? '' : 's'}` : `${Math.round(ms)} ms`);
const voiceName = (c: Ctx, v: number) => {
    const n = c.voices.length;
    return `v${v + 1}${n === 1 ? '' : v === 0 ? ' top' : v === n - 1 ? ' bass' : ' mid'}`;
};
/** The snapshot holding the whole chord struck at time `t` (the last onset at that time inside the box). */
const snapAt = (c: Ctx, t: number): Snapshot | undefined => { const i = c.lastAtTime.get(t); return i == null ? undefined : c.r.snapshots[i]; };
/** Pitch classes sounding at time `t`, optionally without one midi (this voice's own note). */
function soundingPcs(c: Ctx, t: number, without?: number): string {
    const sn = snapAt(c, t);
    return sn ? [...new Set(sn.sounding.filter(x => x.midi !== without).map(x => mod12(x.midi)))].sort((a, b) => a - b).join(',') : '';
}
/** The note of pitch `midi` sounding at time `t` (latest struck at or before t), for spellings of held notes. */
function noteSoundingAt(c: Ctx, midi: number, t: number): ReplayNote | null {
    const end = c.lastAtTime.get(t) ?? c.box.onTo;
    for (let i = end; i >= Math.max(0, end - 400); i--) {
        const n = c.r.notes[i]!;
        if (n.midi === midi && n.onT <= t && (n.offT > t || n.onT === t)) return n;
    }
    return null;
}

// ── 2. text piano-roll ─────────────────────────────────────────────────────────

function rollLines(c: Ctx): string[] {
    const L = ['## piano roll (rows = pitches in the box, spelled as ours; columns = onsets)',
        'legend: ▪ strike  ═ held  ✗ strike spelled wrong  ~ strike flipped  · silent  (* on a row: spelled more than one way)'];
    const all = [...c.heldIn, ...c.notes];
    if (!c.notes.length) return [...L, '(no notes struck inside the box)', ''];
    const times = [...new Set(c.notes.map(n => n.onT))].sort((a, b) => a - b);
    const per = Math.ceil(times.length / ROLL_COLS);
    const cols: number[] = [];   // start time of each column
    for (let k = 0; k < times.length; k += per) cols.push(times[k]!);
    const colOf = (t: number) => { let lo = 0, hi = cols.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cols[m]! <= t) lo = m; else hi = m - 1; } return lo; };
    if (per > 1) L.push(`(compressed: ${times.length} onsets, ${per} per column)`);
    const rank: Record<string, number> = { '·': 0, '═': 1, '▪': 2, '~': 3, '✗': 4 };
    const mids = [...new Set(all.map(n => n.midi))].sort((a, b) => b - a);
    const labels = mids.map(m => {
        const tally = new Map<string, number>();
        for (const n of c.notes) if (n.midi === m) tally.set(ours(n), (tally.get(ours(n)) ?? 0) + 1);
        if (!tally.size) for (const n of c.heldIn) if (n.midi === m) tally.set(ours(n), 1);
        const best = [...tally].sort((a, b) => b[1] - a[1])[0]![0];
        return best + (tally.size > 1 ? '*' : '');
    });
    const w = Math.max(4, ...labels.map(x => x.length));
    // Measure ruler: "|68" at the column where a measure starts.
    const ruler = new Array<string>(cols.length).fill(' ');
    let lastM: number | undefined, freeAt = 0;
    for (let k = 0; k < cols.length; k++) {
        const n = c.notes.find(x => x.onT === cols[k]);
        const m = n?.expected?.measure;
        if (m == null || m === lastM) continue;
        lastM = m;
        const tag = `|${m}`;
        if (k < freeAt) { ruler[k] = '|'; continue; }
        for (let j = 0; j < tag.length && k + j < cols.length; j++) ruler[k + j] = tag[j]!;
        freeAt = k + tag.length;
    }
    L.push(`${' '.repeat(w)} ${ruler.join('')}`);
    mids.forEach((m, row) => {
        const cells = new Array<string>(cols.length).fill('·');
        const put = (k: number, ch: string) => { if (rank[ch]! > rank[cells[k]!]!) cells[k] = ch; };
        for (const n of all.filter(x => x.midi === m)) {
            const struck = c.notes.includes(n);
            if (struck) put(colOf(n.onT), n.tier === 'wrong' ? '✗' : n.tier === 'flipped' ? '~' : '▪');
            for (let k = 0; k < cols.length; k++) if (cols[k]! > n.onT && cols[k]! < n.offT) put(k, '═');
        }
        L.push(`${labels[row]!.padStart(w)} ${cells.join('')}`);
    });
    L.push('');
    return L;
}

// ── 3. voices ──────────────────────────────────────────────────────────────────

interface Run { notes: ReplayNote[] }
/** Consecutive notes of one pitch in a voice. */
const runsOf = (v: ReplayNote[]): Run[] => {
    const out: Run[] = [];
    for (const n of v) { const last = out.at(-1); if (last && last.notes[0]!.midi === n.midi) last.notes.push(n); else out.push({ notes: [n] }); }
    return out;
};
/** "Eb x5, D# x3" in order of first appearance. */
function tallyText(xs: string[]): string {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].map(([k, n]) => (m.size === 1 && n === 1 ? k : `${k} x${n}`)).join(', ');
}

function voiceLines(c: Ctx): string[] {
    const L = ['## voices (nearest-pitch proxy: the fixture has no notated voices or parts)'];
    if (!c.voices.length) return [...L, '(none)', ''];
    c.voices.slice(0, MAX_VOICES).forEach((v, vi) => {
        const lo = Math.min(...v.map(n => n.midi)), hi = Math.max(...v.map(n => n.midi));
        const span = (m: number) => ours(v.find(n => n.midi === m)!);
        const runs = runsOf(v);
        L.push(`${voiceName(c, vi)} (${lo === hi ? span(lo) : `${span(lo)}-${span(hi)}`}; ${v.length} note${v.length === 1 ? '' : 's'}, ${runs.length} run${runs.length === 1 ? '' : 's'})`);
        for (const run of runs.slice(0, MAX_RUNS)) {
            const ns = run.notes, f = ns[0]!, l = ns.at(-1)!;
            const where = ns.length > 1 ? `${pos(f)}-${pos(l)}` : pos(f);
            let what: string;
            if (ns.length > 1) {
                const durs = ns.map(n => n.offT - n.onT).sort((a, b) => a - b);
                const chords = new Set(ns.map(n => soundingPcs(c, n.onT, n.midi))).size;
                what = `struck x${ns.length} (${beats(c, durs[durs.length >> 1]!)} each, ${chords === 1 ? 'chord unchanged' : `chord changes ${chords - 1}x`})`;
            } else {
                const over = c.onsetTimes.filter(t => t > f.onT && t < f.offT).length;
                what = `${beats(c, f.offT - f.onT)}${over ? `, held over ${over} onset${over === 1 ? '' : 's'}` : ''}`;
            }
            const nW = ns.filter(n => n.tier === 'wrong').length, nF = ns.filter(n => n.tier === 'flipped').length;
            const marks = (nW ? ` ✗${ns.length > 1 ? nW : ''}` : '') + (nF ? ` ~${ns.length > 1 ? nF : ''}` : '');
            const comp = ns.some(n => n.expected) ? `  composer ${tallyText(ns.map(n => n.expected ? pc(n.expected as unknown as PitchClass) : '—'))}` : '';
            L.push(`  ${where.padEnd(13)} ${ours(f).padEnd(5)} ${what}  ours ${tallyText(ns.map(n => pc(n.committed)))}${marks}${comp}`);
        }
        if (runs.length > MAX_RUNS) L.push(`  … ${runs.length - MAX_RUNS} more runs (truncated)`);
    });
    if (c.voices.length > MAX_VOICES) L.push(`… ${c.voices.length - MAX_VOICES} more voices (truncated)`);
    L.push('');
    return L;
}

// ── 4. harmony timeline ────────────────────────────────────────────────────────

const frameText = (sn: Snapshot) => {
    const f = sn.frameLofTonic != null ? keyPair(sn.frameLofTonic) : '—';
    return sn.twoPass ? `${f} (${sn.twoPass.source} pass)` : f;
};

function harmonyLines(c: Ctx): string[] {
    const L = ['## harmony timeline (everything sounding in the span, in or out of the box; one line per change of the pitch-class set)'];
    const la = c.r.mode === 'la';
    L.push(`m:beat   chord | ${la ? 'local key (leading-tone gate) / degree key (key-degree gate) | ' : ''}frame (side) | bass | sounding`);
    let prev = '', n = 0, more = 0;
    for (const t of c.onsetTimes) {
        const i = c.lastAtTime.get(t)!, sn = c.r.snapshots[i]!;
        const key = soundingPcs(c, t);
        if (key === prev) continue;
        prev = key;
        if (n >= MAX_HARMONY) { more++; continue; }
        n++;
        const chord = chordReadingText(chordReading(c.r, i), ascii);
        const keys = la ? `${keyText(sn.la?.localKey)} / ${keyText(sn.la?.degreeKey)} | ` : '';
        const bass = sn.sounding[0] ? pitch(sn.sounding[0].pitch) : '—';
        L.push(`${pos(c.r.notes[i]).padEnd(8)} ${chord} | ${keys}${frameText(sn)} | ${bass} | ${sn.sounding.map(x => pitch(x.pitch)).join(' ')}`);
    }
    if (more) L.push(`… ${more} more changes (truncated)`);
    L.push('');
    return L;
}

// ── 5. decisions ───────────────────────────────────────────────────────────────

/** The previous note in the same voice (proxy). */
function prevInVoice(c: Ctx, n: ReplayNote): ReplayNote | null {
    const v = c.voices[c.voiceOf.get(n.onIndex) ?? -1];
    if (!v) return null;
    const k = v.indexOf(n);
    return k > 0 ? v[k - 1]! : null;
}
const moveText = (p: ReplayNote | null, n: ReplayNote) => {
    if (!p) return 'first note of its voice in the box';
    const d = n.midi - p.midi;
    return `${d === 0 ? 'repeat' : Math.abs(d) <= 2 ? 'step' : 'leap'} ${sgn(d)} from ${ours(p)}`;
};

function decisionBlock(c: Ctx, n: ReplayNote): string[] {
    const sn = c.r.snapshots[n.onIndex]!;
    const L = [`${pos(n)}  midi ${n.midi}  ours ${ours(n)}  composer ${composer(n)}  ${n.tier}  [${voiceName(c, c.voiceOf.get(n.onIndex) ?? 0)}; ${moveText(prevInVoice(c, n), n)}]`];
    const dec = sn.decision;
    if (sn.twoPass) {
        const tp = sn.twoPass;
        L.push(`  two-pass: taken from the ${tp.source} pass; forward ${pc(tp.forward)}, backward ${pc(tp.backward)}${tp.agrees ? ' (the passes agree)' : ' (the passes disagree)'}`
            + (dec ? `; the trace below is the ${tp.source} pass's decision` : ''));
    }
    if (!dec) { L.push('  no per-candidate trace for this mode, so the deciding mechanism cannot be told'); return L; }
    const laActive = c.r.mode === 'la' || c.r.mode === 'tp';
    const cols = deltaColumns(dec.candidates, laActive);
    const terms = (x: DecisionCandidate) => [`base ${sgn(x.base)}`, ...cols.filter(col => col.val(x)).map(col => `${col.h} ${sgn(col.val(x))}`)].join(' ');
    const isChosen = (x: DecisionCandidate) => samePc(x.c, dec.chosen);
    L.push('  candidates: ' + dec.candidates.map(x => `${isChosen(x) ? '>' : ''}${pc(x.c)} ${sgn(candidateTotal(x))} (${terms(x)})`).join('  |  '));
    // The engine takes the first strict maximum in candidate order.
    let top = dec.candidates[0]!;
    for (const x of dec.candidates) if (candidateTotal(x) > candidateTotal(top)) top = x;
    const chosen = dec.candidates.find(isChosen);
    if (!chosen) L.push(`  note-on pick ${pc(dec.chosen)} is not among the candidates listed (trace mismatch)`);
    else if (!samePc(top.c, chosen.c)) {
        const ow = sn.la?.outward;
        L.push(ow ? `  tipped by: aug6 outward rule (dispositive, above every total): ${ow.role > 0 ? 'rising' : 'falling'} tone of a pair with midi ${ow.partner}, top total was ${pc(top.c)}`
            : `  the pick is not the top total (${pc(top.c)}); the trace does not say what overrode it`);
    } else {
        const rest = dec.candidates.filter(x => x !== chosen);
        if (rest.length) {
            const ru = rest.reduce((a, b) => (candidateTotal(b) > candidateTotal(a) ? b : a));
            const margin = candidateTotal(chosen) - candidateTotal(ru);
            if (margin === 0) L.push(`  tie with ${pc(ru.c)} at ${sgn(candidateTotal(chosen))}: decided by candidate order (the first listed wins)`);
            else {
                const all = [{ h: 'base', val: (x: DecisionCandidate) => x.base }, ...cols];
                const tip = all.filter(col => col.val(chosen) - col.val(ru) >= margin);
                const diff = all.filter(col => col.val(chosen) !== col.val(ru)).map(col => `${col.h} ${sgn(col.val(chosen) - col.val(ru))}`);
                L.push(tip.length
                    ? `  tipped by: ${tip.map(col => `${col.h} (${sgn(col.val(chosen))} vs ${sgn(col.val(ru))} for ${pc(ru.c)})`).join(', ')}; without ${tip.length === 1 ? 'it' : 'any one of them'} ${pc(ru.c)} would tie or win (margin ${margin})`
                    : `  no single term decides: margin ${margin} over ${pc(ru.c)} from ${diff.join(', ')}`);
            }
        }
    }
    if (c.r.mode === 'la' && sn.la) L.push(...laExplain(sn, dec.frame, dec.candidates));
    else if (c.r.mode === 'tp') L.push('  look-ahead gates: run inside the two-pass resolver; their keys are not in its trace');
    const final = n.committed;
    if (chosen && final && !samePc(final, dec.chosen))
        L.push(`  final spelling ${pc(final)} (read at note-off) differs from the note-on pick ${pc(dec.chosen)}: re-spelled after the trace (onset revise of a co-struck chord, or keep-alive); the trace explains ${pc(dec.chosen)}`);
    L.push(`  fold/frame: frame ${frameText(sn)}; the trace does not record fold moves`);
    return L;
}

/** What the look-ahead and its gates did for this note, rebuilt from the context the engine was fed. */
function laExplain(sn: Snapshot, frame: readonly PitchClass[], cands: readonly DecisionCandidate[]): string[] {
    const la = sn.la!;
    const own = mod12(sn.midi);
    const keys = `local key ${keyText(la.localKey)}, degree key ${keyText(la.degreeKey)}`;
    if (la.resolveDir === 0) return [`  look-ahead: no semitone resolution in the next 16 onsets, so no vote (${keys})`];
    const target = mod12(sn.midi + la.resolveDir);
    const tSp = frame.find(p => pcOfSp(p) === target);
    const head = `  look-ahead: resolves ${la.resolveDir > 0 ? 'up' : 'down'} a semitone to pc ${target}${tSp ? ` (${ascii(tSp)} in the surface)` : ' (not in the surface)'}`
        + `${la.exactDir === la.resolveDir ? ', same octave' : ', other octave'}; ${keys}`;
    const out = [head];
    const voted = cands.some(x => x.laDelta !== 0);
    if (la.resolveDir === -1 && la.localKey && isLeadingTone(own, la.localKey))
        out.push(`  leading-tone gate: FIRED (pc ${own} is a leading tone of ${keyText(la.localKey)}): look-ahead vote withheld`);
    else if (la.degreeKey && !isKeyDegree(target, la.degreeKey))
        out.push(`  key-degree gate: FIRED (target pc ${target} is not a degree of ${keyText(la.degreeKey)}): look-ahead vote withheld`);
    else if (voted) {
        const step = cands.find(x => x.laDelta > 0), tgt = cands.find(x => x.laDelta < 0);
        const via = !tSp && la.resolveDir === 1 && la.localKey && isWideLeadingTone(own, la.localKey) ? ' via the held-letter target (the target letter holds this note\'s other spelling; the local key names it a leading tone)' : '';
        out.push(`  look-ahead vote: ${step ? `${pc(step.c)} ${sgn(step.laDelta)} (letter step)` : ''}${step && tgt ? ', ' : ''}${tgt ? `${pc(tgt.c)} ${sgn(tgt.laDelta)} (target's own letter)` : ''}${via}; gates passed`);
    } else out.push('  look-ahead vote: none (gates passed, but no surface letter for the target and the held-letter target did not apply)');
    if (la.outward) out.push(`  aug6 outward pair: partner midi ${la.outward.partner}, ${la.outward.role > 0 ? 'rising' : 'falling'} tone (applies only when the meeting pitch is in the key and the rising tone is not)`);
    return out;
}

function decisionLines(c: Ctx): string[] {
    const bad = c.notes.filter(n => n.tier === 'wrong' || n.tier === 'flipped');
    const L = [`## decisions for wrong and flipped notes (${bad.length})`];
    if (!bad.length) return [...L, '(none: every scored note in the box matches the composer)', ''];
    // Wrong first, then flipped. Consecutive notes of one pitch decided the same way (same candidate
    // totals and the same deciding line) print once, with the other positions listed.
    const ordered = [...bad.filter(n => n.tier === 'wrong'), ...bad.filter(n => n.tier === 'flipped')];
    const sig = (b: string[]) => b.filter(x => /^ {2}(candidates|tipped|tie|no single|the pick|look-ahead vote|leading-tone|key-degree|two-pass)/.test(x)).join('|');
    let shown = 0, k = 0;
    while (k < ordered.length && shown < MAX_DECISIONS) {
        const n = ordered[k]!, block = decisionBlock(c, n), key = sig(block);
        const same: string[] = [];
        let j = k + 1;
        while (j < ordered.length && ordered[j]!.midi === n.midi && ordered[j]!.tier === n.tier && sig(decisionBlock(c, ordered[j]!)) === key) same.push(pos(ordered[j++]));
        L.push(...block);
        if (same.length) L.push(`  same decision at: ${same.join(', ')}`);
        shown++; k = j;
    }
    const rest = ordered.length - k;
    if (rest) L.push(`… ${rest} more (truncated)`);
    L.push('');
    return L;
}

// ── 6. patterns ────────────────────────────────────────────────────────────────

function capped(title: string, items: string[], empty: string): string[] {
    const L = [`${title} (${items.length})`];
    if (!items.length) L.push(`  ${empty}`);
    L.push(...items.slice(0, MAX_FLAGS).map(x => '  ' + x));
    if (items.length > MAX_FLAGS) L.push(`  … ${items.length - MAX_FLAGS} more (truncated)`);
    return L;
}
const pairPc = (a: Pitch | PitchClass | null, b: Pitch | PitchClass | null) => (a && b ? intervalLabel(intervalBetween(a, b)) : '?');
const altered = (lbl: string) => /^(A|d|AA|dd)\d/.test(lbl);

function patternLines(c: Ctx): string[] {
    const L = ['## patterns (automatic flags)'];
    const names = c.voices.map((_, v) => voiceName(c, v));
    const vOf = (n: ReplayNote) => names[c.voiceOf.get(n.onIndex) ?? 0]!;

    // Repeated runs with a mid-run respell.
    const reps: string[] = [];
    c.voices.forEach((v, vi) => runsOf(v).forEach(run => {
        const ns = run.notes;
        if (ns.length < 3 || new Set(ns.map(n => pc(n.committed))).size < 2) return;
        const k = ns.findIndex((n, j) => j > 0 && pc(n.committed) !== pc(ns[j - 1]!.committed));
        const chords = new Set(ns.map(n => soundingPcs(c, n.onT, n.midi))).size;
        reps.push(`${names[vi]} ${ours(ns[0]!)} x${ns.length} ${pos(ns[0])}-${pos(ns.at(-1))}: ours ${ns.map(n => pc(n.committed)).join(' ')}; composer ${ns.map(n => n.expected ? pc(n.expected as unknown as PitchClass) : '—').join(' ')}`
            + `; first respell at strike ${k + 1} (${pos(ns[k])}); ${chords === 1 ? 'chord unchanged' : `chord changes ${chords - 1}x`}`);
    }));
    L.push(...capped('repeated runs respelled mid-run (>=3 strikes of one pitch in one voice)', reps, 'none'));

    // Chromatic runs: >= 3 notes joined by same-direction semitones (repeats collapsed).
    const chrom: string[] = [];
    c.voices.forEach((v, vi) => {
        const line = runsOf(v).map(r => r.notes[0]!);
        let a = 0;
        while (a < line.length - 1) {
            const d = line[a + 1]!.midi - line[a]!.midi;
            let b = a + 1;
            if (Math.abs(d) === 1) while (b + 1 < line.length && line[b + 1]!.midi - line[b]!.midi === d) b++;
            if (Math.abs(d) === 1 && b - a >= 2) {
                const seg = line.slice(a, b + 1);
                const oursS = seg.map(ours).join(' '), compS = seg.map(composer).join(' ');
                const sameLetter = seg.slice(1).filter((n, j) => n.committed && seg[j]!.committed && n.committed.step === seg[j]!.committed!.step).length;
                chrom.push(`${names[vi]} ${d > 0 ? 'rising' : 'falling'} ${pos(seg[0])}-${pos(seg.at(-1))}: ours ${oursS}${oursS === compS ? ' (= composer)' : `; composer ${compS}`}; ${sameLetter} same-letter step${sameLetter === 1 ? '' : 's'} in ours`);
            }
            a = b;
        }
    });
    L.push(...capped('chromatic runs (>=3 notes, same-direction semitones, one voice)', chrom, 'none'));

    // One voice moves while the others hold (held or re-struck at the same pitch).
    const stag: string[] = [];
    const lastOf = new Map<number, ReplayNote>();   // voice → its latest note
    for (const t of [...new Set(c.notes.map(n => n.onT))].sort((a, b) => a - b)) {
        const struck = c.notes.filter(n => n.onT === t);
        const moved: ReplayNote[] = [], holding: string[] = [];
        for (const n of struck) { const p = lastOf.get(c.voiceOf.get(n.onIndex)!); if (p && p.midi !== n.midi) moved.push(n); }
        lastOf.forEach((p, v) => {
            const again = struck.find(n => c.voiceOf.get(n.onIndex) === v);
            if ((again && again.midi === p.midi) || (!again && p.offT > t)) holding.push(ours(again ?? p));
        });
        if (moved.length === 1 && holding.length >= 2) {
            const n = moved[0]!, p = lastOf.get(c.voiceOf.get(n.onIndex)!)!;
            stag.push(`${pos(n)} ${vOf(n)} ${ours(p)}->${ours(n)}${tierMark(n) ? ' ' + tierMark(n) : ''} over held ${holding.join(' ')}`);
        }
        for (const n of struck) lastOf.set(c.voiceOf.get(n.onIndex)!, n);
    }
    L.push(...capped('one voice moves while the others hold (staggered harmony)', stag, 'none'));

    // Spelling changes of one pitch where the sounding pitch-class set did not change.
    const respell: string[] = [];
    const lastByMidi = new Map<number, ReplayNote>();
    for (const n of c.notes) {
        const p = lastByMidi.get(n.midi);
        if (p && pc(p.committed) !== pc(n.committed) && soundingPcs(c, p.onT) === soundingPcs(c, n.onT))
            respell.push(`${pos(p)} -> ${pos(n)} midi ${n.midi}: ${ours(p)} -> ${ours(n)}${tierMark(n) ? ' ' + tierMark(n) : ''}; composer ${composer(p)} -> ${composer(n)}`);
        lastByMidi.set(n.midi, n);
    }
    L.push(...capped('spelling changes with the chord unchanged (same pitch, same sounding pitch-class set)', respell, 'none'));

    // Leaps vs steps into wrong notes.
    const into = c.notes.filter(n => n.tier === 'wrong').map(n => ({ n, p: prevInVoice(c, n) }));
    const cnt = { step: 0, leap: 0, repeat: 0, first: 0 };
    for (const { n, p } of into) { const d = p ? Math.abs(n.midi - p.midi) : -1; cnt[d < 0 ? 'first' : d === 0 ? 'repeat' : d <= 2 ? 'step' : 'leap']++; }
    L.push(`approach into wrong notes (${into.length}): step ${cnt.step}, leap ${cnt.leap}, repeat ${cnt.repeat}, first in voice ${cnt.first}`);
    L.push(...into.slice(0, MAX_FLAGS).map(({ n, p }) => `  ${pos(n)} ${vOf(n)} ${ours(n)} (composer ${composer(n)}): ${moveText(p, n)}`));
    if (into.length > MAX_FLAGS) L.push(`  … ${into.length - MAX_FLAGS} more (truncated)`);

    // Augmented / diminished intervals: melodic (consecutive notes of a voice) and vertical (struck vs sounding).
    const mel: string[] = [];
    let a1 = 0;
    c.voices.forEach((v, vi) => {
        const line = runsOf(v).map(r => r.notes[0]!);
        for (let k = 1; k < line.length; k++) {
            const p = line[k - 1]!, n = line[k]!;
            const [lo, hi] = p.midi < n.midi ? [p, n] : [n, p];
            const o = pairPc(lo.committed, hi.committed);
            if (!altered(o)) continue;
            if (o === 'A1') { a1++; continue; }
            const e = pairPc(lo.expected as unknown as Pitch, hi.expected as unknown as Pitch);
            mel.push(`${names[vi]} ${pos(p)}->${pos(n)} ${ours(p)}->${ours(n)} ${o}${e === o ? ' (composer too)' : `; composer ${composer(p)}->${composer(n)} ${e}`}`);
        }
    });
    L.push(...capped(`augmented/diminished melodic intervals in a voice, ours (A1 chromatic inflections not listed: ${a1})`, mel, 'none'));
    // One line per distinct pair (pitches + our interval), at its first onset, with its repeat count.
    const vert = new Map<string, { text: string; n: number }>();
    let tritones = 0;
    const seen = new Set<string>();
    for (const t of [...new Set(c.notes.map(n => n.onT))].sort((x, y) => x - y)) {
        const sn = snapAt(c, t);
        if (!sn) continue;
        for (const n of c.notes.filter(z => z.onT === t)) for (const x of sn.sounding) {
            if (x.midi === n.midi) continue;
            const other = noteSoundingAt(c, x.midi, t);
            const otherP = other?.committed ?? x.pitch;
            const [loP, hiP] = x.midi < n.midi ? [otherP, n.committed] : [n.committed, otherP];
            const [lo, hi] = x.midi < n.midi ? [other, n] : [n, other];
            const o = pairPc(loP, hiP);
            if (!altered(o)) continue;
            const at = `${t}:${Math.min(x.midi, n.midi)}:${Math.max(x.midi, n.midi)}`;
            if (seen.has(at)) continue;
            seen.add(at);
            if (o === 'A4' || o === 'd5') { tritones++; continue; }
            const id = `${pitch(loP)}-${pitch(hiP)}`;
            const hit = vert.get(id);
            if (hit) { hit.n++; continue; }
            const e = lo?.expected && hi?.expected ? pairPc(lo.expected as unknown as Pitch, hi.expected as unknown as Pitch) : '?';
            const bad = [lo, hi].some(z => z && (z.tier === 'wrong' || z.tier === 'flipped'));
            vert.set(id, { text: `${pos(n)} ${id} ${o}${e === o ? ' (composer too)' : `; composer ${e}`}${bad ? ' [involves a wrong/flipped note]' : ''}`, n: 1 });
        }
    }
    const vertItems = [...vert.values()].map(v => v.text + (v.n > 1 ? ` (x${v.n} onsets)` : ''));
    L.push(...capped(`augmented/diminished intervals in a chord (a struck note against everything sounding; tritones not listed: ${tritones})`, vertItems, 'none'));
    L.push('');
    return L;
}

// ── report ─────────────────────────────────────────────────────────────────────

export function passageReport(s: AppState, box: PassageBox): string {
    if (!s.replay) return '(no fixture loaded)';
    const b = clampBox(box, s.replay);
    if (!b) return '(the box holds no onset)';
    const c = buildCtx(s, b);
    const r = s.replay, first = r.notes[b.onFrom]!, last = r.notes[b.onTo]!;
    const scored = c.notes.filter(n => n.expected);
    const t = { w: scored.filter(n => n.tier === 'wrong').length, f: scored.filter(n => n.tier === 'flipped').length };
    const L: string[] = [`# enharmonic viz: passage ${pos(first)} - ${pos(last)}`, ''];
    L.push(...header(s));
    L.push(`box:     onsets ${b.onFrom}-${b.onTo} (on-index, 0-based), midi ${b.midiLo}-${b.midiHi}; positions are measure:beat; URL param box=${formatBox(b)}`);
    L.push(`in box:  ${c.notes.length} notes struck${c.heldIn.length ? `, ${c.heldIn.length} held in from before` : ''}; ${scored.length} scored: ${t.w} wrong, ${t.f} flipped`
        + `${c.msPerBeat ? `; ~${Math.round(c.msPerBeat)} ms per beat` : ''}`);
    L.push('');
    L.push(...rollLines(c), ...voiceLines(c), ...harmonyLines(c), ...decisionLines(c), ...patternLines(c));
    return L.join('\n').trimEnd();
}
