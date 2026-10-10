/**
 * CADENCE-SIDE for the two-pass speller (research option, default OFF).
 *
 * A post-process on tp's own output, mechanism = COMMA-SHIFT of committed spellings (no re-run).
 *
 *  1. Read chords over the whole piece from tp's spellings' pitch classes (the pc-level detector of
 *     cadence-side.ts, run causally per onset but over the full piece).
 *  2. A cadence V(7)->I/i of key K counts when K's convention side (fewest key-signature accidentals; ties
 *     F#/Gb major, D#/Eb minor never) differs from tp's side at the tonic arrival Y.
 *  3. Offline persistence: K must last >= minBars after Y (K's tonic chord, or V->K again), with no cadence
 *     to another key in between; otherwise dropped.
 *  4. The seam goes at the bar line at or before Y, not before the V chord's onset (else at the V onset).
 *     From the seam, notes still on the old side are shifted by the comma (+-12 fifths) toward K's side,
 *     until the next confirmed cadence to an opposite-convention key or until tp's own side already agrees.
 *     "Old side" is read from the median line-of-fifths position of a +-window of tp notes, so a run is
 *     shifted uniformly (never a straggler mix).
 */
import { CadenceSide, conventionT, type Chord, type CadenceSideOptions } from './cadence-side.js';

export interface CadenceSideTpOptions extends CadenceSideOptions {
    /** Bar index per note in the CALLER's note order (e.g. a score's measure). Absent: floor(tOn / barLen). */
    bars?: readonly number[];
    /** Half-width (in notes) of the median window that reads tp's local side (default 12). */
    sideWindow?: number;
    /** Which tp notes witness the local side: 'all' (default: plain median of tp's window) or 'altered' (naturals F..B carry no side; post-hoc variant, a wash). */
    sideWitness?: 'altered' | 'all';
    /** Out-parameter: receives one entry per candidate (fired or dropped). */
    log?: CadenceTpLogEntry[];
}

export interface CadenceTpLogEntry {
    kind: 'fire' | 'drop-persist' | 'skip-agree' | 'skip-span' | 'skip-multi';
    key: string; keyPc: number; minor: boolean;
    /** Caller-order note indices. */
    vNote: number; yNote: number; seamNote: number; endNote: number;
    endReason: 'opposite-cadence' | 'tp-agrees' | 'piece-end' | '';
    shift: number; respelled: number;
    barV: number; barY: number; barSeam: number;
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcOf = (m: number): number => ((m % 12) + 12) % 12;

interface ChordEv { first: number; last: number; chord: Chord; X: Chord | null; barIdx: number; }
interface Cad { ev: number; keyPc: number; minor: boolean; t: number; confirmed: boolean; }

export function applyCadenceSideTp(
    sortedNotes: readonly { midi: number; tOn: number; tOff: number }[],
    spellings: readonly number[],
    barsSorted: readonly number[] | null,
    opts: CadenceSideTpOptions,
): { spellings: number[]; log: (CadenceTpLogEntry & { sortedIdx: number[] })[] } {
    const N = sortedNotes, n = N.length;
    const out = spellings.slice();
    const barLen = opts.barLen ?? 2000, minBars = opts.minBars ?? 4, W = opts.sideWindow ?? 12;
    const spanLen = opts.spanLen ?? 2000;

    // running bar index (monotone): count of bar-value changes, or floor(t/barLen)
    const barIdx = new Array<number>(n);
    if (barsSorted) { let c = 0; for (let i = 0; i < n; i++) { if (i > 0 && barsSorted[i] !== barsSorted[i - 1]) c++; barIdx[i] = c; } }
    else for (let i = 0; i < n; i++) barIdx[i] = Math.floor(N[i]!.tOn / barLen);
    const barOf = (i: number): number => barsSorted ? barsSorted[i]! : barIdx[i]!;
    const barStart = (i: number): number => { while (i > 0 && barIdx[i - 1] === barIdx[i]) i--; return i; };

    // 1. chords
    const cs = new CadenceSide({ spanLen, spanNotes: opts.spanNotes ?? 12 });
    const evs: ChordEv[] = [];
    const active: number[] = [];
    let last: Chord | null = null;
    for (let i = 0; i < n;) {
        let j = i; while (j < n && N[j]!.tOn === N[i]!.tOn) j++;
        const t = N[i]!.tOn;
        for (let k = active.length - 1; k >= 0; k--) if (N[active[k]!]!.tOff <= t) active.splice(k, 1);
        for (let k = i; k < j; k++) { active.push(k); cs.note(N[k]!.midi, t); }
        const Y = cs.read(active.map(k => N[k]!.midi), t);
        if (Y && !(last && last.type === Y.type && last.root === Y.root)) {
            evs.push({ first: i, last: j - 1, chord: Y, X: last, barIdx: barIdx[i]! });
            last = Y;
        }
        i = j;
    }

    // 2/3. cadences and persistence
    const cads: Cad[] = [];
    const isCad = (e: ChordEv): boolean => e.X !== null && (e.X.type === 'maj' || e.X.type === 'dom7')
        && (e.chord.type === 'maj' || e.chord.type === 'min') && ((e.X.root - e.chord.root) % 12 + 12) % 12 === 7;
    for (let e = 0; e < evs.length; e++) {
        if (!isCad(evs[e]!)) continue;
        const Y = evs[e]!.chord, minor = Y.type === 'min';
        const t = conventionT((Y.root + (minor ? 3 : 0)) % 12);
        if (t === null) continue;
        let confirmed = false;
        for (let f = e + 1; f < evs.length; f++) {
            const F = evs[f]!;
            const tonic = F.chord.root === Y.root && F.chord.type === (minor ? 'min' : 'maj');
            if (isCad(F) && !(F.chord.root === Y.root && (F.chord.type === 'min') === minor)) break;
            if (tonic && F.barIdx - evs[e]!.barIdx >= minBars) { confirmed = true; break; }
        }
        cads.push({ ev: e, keyPc: Y.root, minor, t, confirmed });
    }

    // tp's local side: median lof of a +-W window. Only ALTERED notes (lof < -1 or > 5) witness a side: a natural
    // is spelled the same on both sides of a collection that holds it, so it carries no orientation.
    const witnessAll = (opts.sideWitness ?? 'all') === 'all';
    const med = (i: number): number | null => {
        const a: number[] = [];
        for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) { const v = spellings[k]!; if (witnessAll || v < -1 || v > 5) a.push(v); }
        if (!a.length) return null;
        a.sort((x, y) => x - y); return a[a.length >> 1]!;
    };
    const log: (CadenceTpLogEntry & { sortedIdx: number[] })[] = [];
    const mk = (c: Cad, kind: CadenceTpLogEntry['kind'], v: number, y: number, seam: number, end: number, reason: CadenceTpLogEntry['endReason'], shift: number, resp: number) =>
        log.push({ kind, key: NAMES[c.keyPc]! + (c.minor ? 'm' : ''), keyPc: c.keyPc, minor: c.minor, vNote: v, yNote: y, seamNote: seam, endNote: end, endReason: reason, shift, respelled: resp,
            barV: barOf(v), barY: barOf(y), barSeam: barOf(Math.min(seam, n - 1)), sortedIdx: [v, y, seam, end] });

    let lastEnd = -1, lastSign = 0;
    for (const c of cads) {
        const e = evs[c.ev]!;
        const yNote = e.first, vNote = e.X ? evs[c.ev - 1]!.first : e.first;
        if (!c.confirmed) { mk(c, 'drop-persist', vNote, yNote, yNote, yNote, '', 0, 0); continue; }
        // tp's side at Y: the root's spelling
        let L: number | null = null;
        for (let k = e.last, cnt = 0; k >= 0 && cnt < 12; k--, cnt++) if (pcOf(N[k]!.midi) === c.keyPc) { L = spellings[k]!; break; }
        if (L === null) continue;
        const T0 = c.t + (c.minor ? 3 : 0);
        const shift = T0 - L;
        if (shift === 0) { mk(c, 'skip-agree', vNote, yNote, yNote, yNote, '', 0, 0); continue; }
        if (Math.abs(shift) !== 12) { mk(c, 'skip-multi', vNote, yNote, yNote, yNote, '', shift, 0); continue; }
        // seam: the latest bar line in [vNote, yNote]
        let seam = barStart(yNote);
        if (seam < vNote) seam = vNote;
        if (seam < lastEnd && Math.sign(c.t) === lastSign) { mk(c, 'skip-span', vNote, yNote, seam, seam, '', shift, 0); continue; }
        // end: next confirmed cadence to an opposite-convention key, or tp agrees
        let end = n, reason: CadenceTpLogEntry['endReason'] = 'piece-end';
        for (const d of cads) {
            if (d.ev <= c.ev || !d.confirmed || Math.sign(d.t) === Math.sign(c.t)) continue;
            const dv = evs[d.ev - 1]!.first; let ds = barStart(evs[d.ev]!.first); if (ds < dv) ds = dv;
            end = Math.max(seam, ds);
            reason = 'opposite-cadence'; break;
        }
        const t = c.t;
        let i = seam;
        for (; i < end; i++) {
            const m = med(i);
            if (m === null) continue;   // no altered witness nearby: the side carries over
            const old = Math.abs(m - (t - shift)) < Math.abs(m - t);
            if (!old) { reason = 'tp-agrees'; break; }
        }
        const stop = Math.min(i, end);
        let resp = 0;
        for (let k = seam; k < stop; k++) { out[k] = spellings[k]! + shift; resp++; }
        lastEnd = stop; lastSign = Math.sign(c.t);
        mk(c, 'fire', vNote, yNote, seam, stop, reason, shift, resp);
    }
    return { spellings: out, log };
}
