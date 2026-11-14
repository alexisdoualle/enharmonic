/**
 * Key → side: the enharmonic side the look-ahead tier holds, read from the local key's conventional signature.
 *
 * Proposition: a passage is notated on the side of the conventional key signature of its local key. D♭ major
 * sounds → the side is D♭'s (five flats): D♭–F–A♭, not C♯–E♯–G♯. The key is read from what sounds, mapped to
 * its relative major's fewest-accidental tonic on the line of fifths (C = 0, G = +1, F = −1, D♭ = −5), and the
 * speller re-centres its fold on it (`Speller.setKey`) whenever it changes. The engine never reads a key
 * signature; the side is still decided by the notes.
 *
 * {@link sideKeys} reads it from the notes alone, LOOK-AHEAD LEGAL: each note sees the last 96 onsets plus the
 * next 16 notes, no more. Three parts:
 *   - KEY: correlation of that window's pitch-class counts with a primary-triads table (tonic and fifth 4,
 *     third 3, the collection's other tones 2, the rest 0; major on the diatonic collection, minor on the
 *     harmonic minor), best of the 24 keys. A table from theory, but a table: provisional.
 *   - CONFIRMATION: a side change is taken only when the next 16 notes sound the new key's own notes (outside
 *     the old key's collection) more often than the old key's own notes. A passing tonicization does not move
 *     the side; a modulation does.
 *   - DEEPENING: a modulation goes along the spiral from the current side, up to 7 accidentals: from B major
 *     (+5) the key a fifth up stays sharp (C♯ major, +7) instead of folding to D♭ (−5).
 * The F♯/G♭ tie (six accidentals either way) is returned as `NaN`; the speller resolves it to the side nearer
 * its current surface.
 */
import type { KeyNote } from './key.js';

const DIATONIC = [0, 2, 4, 5, 7, 9, 11], HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
/** The primary-triads table, centred and with its squared norm, for major and minor. */
const TABLE = [[DIATONIC, [0, 4, 7]], [HARMONIC_MINOR, [0, 3, 7]]].map(([coll, triad]) => {
    const y = Array.from({ length: 12 }, (_, i): number => (i === 0 || i === 7 ? 4 : triad!.includes(i) ? 3 : coll!.includes(i) ? 2 : 0));
    const my = y.reduce((a, b) => a + b) / 12, yc = y.map(v => v - my);
    return { yc, dy: yc.reduce((a, v) => a + v * v, 0) };
});
interface Key { readonly tonic: number; readonly minor: boolean }

/** The best-correlated key of a pitch-class histogram (null when empty). */
function bestKey(h: readonly number[]): Key | null {
    let tot = 0; for (const v of h) tot += v;
    if (!tot) return null;
    const mx = tot / 12; let br = -Infinity, bt = -1, bm = false;
    for (let t = 0; t < 12; t++) {
        let dx = 0; const xc: number[] = [];
        for (let i = 0; i < 12; i++) { xc.push(h[(t + i) % 12]! - mx); dx += xc[i]! ** 2; }
        for (let m = 0; m < 2; m++) {
            const { yc, dy } = TABLE[m]!; let s = 0;
            for (let i = 0; i < 12; i++) s += xc[i]! * yc[i]!;
            const r = dx && dy ? s / Math.sqrt(dx * dy) : 0;
            if (r > br) { br = r; bt = t; bm = m === 1; }
        }
    }
    return { tonic: bt, minor: bm };
}

/** A key's collection: major diatonic; minor natural plus the raised 6th and 7th. */
const inCollection = (pc: number, k: Key): boolean => {
    const d = (((pc - k.tonic) % 12) + 12) % 12;
    return k.minor ? d !== 1 && d !== 4 && d !== 6 : DIATONIC.includes(d);
};
/** Relative-major tonic pitch class → its fewest-accidental line-of-fifths x (NaN: F♯/G♭, six either way). */
const PC_TO_X = [0, -5, 2, -3, 4, -1, NaN, 1, -4, 3, -2, 5];
const xOf = (k: Key): number => PC_TO_X[(k.tonic + (k.minor ? 3 : 0)) % 12]!;

/** Look-ahead window: onsets behind, notes ahead; confirmation span; deepening limit. */
const BEHIND_ONSETS = 96, AHEAD_NOTES = 16, CONFIRM_NOTES = 16, DEEPEN = 7;

/**
 * Each note's side key (same order as the input): the relative major's tonic on the line of fifths, NaN for
 * the F♯/G♭ tie, null before any key can be read. Notes must be in onset order (co-struck notes share `tOn`).
 * Pass it as `NoteContext.sideKey`.
 */
export function sideKeys(notes: readonly KeyNote[]): (number | null)[] {
    const n = notes.length;
    const pc = notes.map(x => ((x.midi % 12) + 12) % 12);
    const pre: Int32Array[] = [new Int32Array(12)];
    for (let i = 0; i < n; i++) { const h = Int32Array.from(pre[i]!); h[pc[i]!]!++; pre.push(h); }
    const hist = (a: number, b: number): number[] => {
        a = Math.max(0, a); b = Math.min(n, b);
        const h: number[] = []; for (let q = 0; q < 12; q++) h.push(b > a ? pre[b]![q]! - pre[a]![q]! : 0);
        return h;
    };
    // Onsets: first note index and end (exclusive) of each, and each note's onset.
    const onsetOf: number[] = [], first: number[] = [], end: number[] = [];
    for (let i = 0; i < n; i++) {
        if (i === 0 || notes[i]!.tOn !== notes[i - 1]!.tOn) { first.push(i); end.push(i); }
        end[end.length - 1] = i + 1; onsetOf.push(first.length - 1);
    }
    // KEY on the last 96 onsets, the note's own onset, and the next 16 notes.
    const read: (Key | null)[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = onsetOf[i]!;
        read[i] = bestKey(hist(first[Math.max(0, o - BEHIND_ONSETS)]!, Math.max(end[o]!, Math.min(n, i + AHEAD_NOTES + 1))));
    }
    // CONFIRMATION: move to a new side only when the next 16 notes favour the new key's own notes.
    const keys: (Key | null)[] = []; let cur: Key | null = null;
    for (let i = 0; i < n; i++) {
        const r = read[i]!;
        if (!r || !cur) { cur = r ?? cur; keys.push(cur); continue; }
        const xr = xOf(r), xc = xOf(cur);
        if (xr === xc || (Number.isNaN(xr) && Number.isNaN(xc))) { cur = r; keys.push(cur); continue; }
        let score = 0;
        for (let j = i; j < Math.min(n, i + CONFIRM_NOTES + 1); j++) {
            const a = inCollection(pc[j]!, r), b = inCollection(pc[j]!, cur);
            if (a && !b) score++; else if (b && !a) score--;
        }
        if (score > 0) cur = r;
        keys.push(cur);
    }
    // DEEPENING: each new key goes along the spiral from the current side, within ±7 accidentals.
    let prev: number | null = null, lastRaw: number | null = null, lastOut: number | null = null;
    return keys.map(k => {
        if (!k) return null;
        const x = xOf(k);
        if (x === lastRaw) return lastOut;
        lastRaw = x;
        let out: number;
        if (prev === null) out = x;
        else {
            const cands = Number.isNaN(x) ? [6, -6] : [x, x + 12, x - 12];
            const ok = cands.filter(c => Math.abs(c) <= DEEPEN);
            out = (ok.length ? ok : cands).reduce((a, c) => (Math.abs(c - prev!) < Math.abs(a - prev!) ? c : a));
        }
        if (!Number.isNaN(out)) prev = out;
        lastOut = out;
        return out;
    });
}
