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
import { prefixCounts, windowCounts, type KeyNote } from './key.js';
import { groupOnsets } from './onsets.js';

const DIATONIC = [0, 2, 4, 5, 7, 9, 11], HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
/** The primary-triads table, centred and with its squared norm, for major and minor. */
const TABLE = [[DIATONIC, [0, 4, 7]], [HARMONIC_MINOR, [0, 3, 7]]].map(([coll, triad]) => {
    const y = Array.from({ length: 12 }, (_, i): number => (i === 0 || i === 7 ? 4 : triad!.includes(i) ? 3 : coll!.includes(i) ? 2 : 0));
    const my = y.reduce((a, b) => a + b) / 12, yc = y.map(v => v - my);
    return { yc, dy: yc.reduce((a, v) => a + v * v, 0) };
});
export interface Key { readonly tonic: number; readonly minor: boolean }
/** A key with the side the deepening gave it. */
interface Sided { readonly k: Key; readonly out: number }

const XC = new Float64Array(12);   // scratch: the histogram rotated to a tonic, centred

/** The best-correlated key of a pitch-class histogram (null when empty). */
function bestKey(h: readonly number[]): Key | null {
    let tot = 0; for (const v of h) tot += v;
    if (!tot) return null;
    const mx = tot / 12; let br = -Infinity, bt = -1, bm = false;
    const xc = XC;
    for (let t = 0; t < 12; t++) {
        let dx = 0;
        for (let i = 0; i < 12; i++) { xc[i] = h[(t + i) % 12]! - mx; dx += xc[i]! ** 2; }
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

/** Pitch-class histograms over note ranges (prefix sums), and the notes grouped by onset. */
function scan(notes: readonly KeyNote[]) {
    const n = notes.length;
    const pc = notes.map(x => ((x.midi % 12) + 12) % 12);
    const pre = prefixCounts(n, k => notes[k]!.midi);
    const hist = (a: number, b: number): number[] => windowCounts(pre, Math.max(0, a), Math.min(n, b));
    return { n, pc, hist, on: groupOnsets(notes) };
}

/**
 * DEEPENING: each new key goes along the spiral from the current side, within ±7 accidentals.
 *
 * `keyReturn` (two-pass only): a key written on the near side only because its far reading is past the ±7 limit is a
 * readability respell. When the music returns to the key in force before it, that key keeps its prior side.
 * Pathétique ii: A♭ minor (−7) → F♭ major, forced to E major (+4) → A♭ minor, read −7 again, not G♯ minor (+5). A
 * parallel key (same tonic), or the parallel of the relative, of the forced key or of the key just before keeps that
 * key's tonic letter, so it is never a return; such a candidate disarms the pending return (the music has reached the
 * old key's pitch classes under the forced key's letter, and later recurrences continue it).
 */
function deepen(keys: readonly (Key | null)[], keyReturn = false): (number | null)[] {
    let prev: number | null = null, lastRaw: number | null = null, lastOut: number | null = null;
    // `keyReturn`: the key just before (held), and, once the limit forces a respell, the key in force before it (pre)
    // and the forced key itself, each with its side.
    let held: Sided | null = null, pre: Sided | null = null, forced: Sided | null = null;
    const parallel = (a: Sided | null, k: Key): boolean => !!a && (a.k.tonic === k.tonic || (a.k.tonic + (a.k.minor ? 3 : 9)) % 12 === k.tonic);
    return keys.map(k => {
        if (!k) return null;
        const x = xOf(k);
        if (x === lastRaw) return lastOut;
        lastRaw = x;
        if (pre && prev !== null && k.tonic === pre.k.tonic && k.minor === pre.k.minor) {
            const ret = parallel(forced, k) || parallel(held, k) ? null : pre.out;
            pre = forced = null;
            if (ret !== null) { prev = lastOut = ret; held = { k, out: ret }; return ret; }
        }
        let out: number;
        if (prev === null) out = x;
        else {
            const cands = Number.isNaN(x) ? [6, -6] : [x, x + 12, x - 12];
            const ok = cands.filter(c => Math.abs(c) <= DEEPEN);
            const near = (cs: number[]) => cs.reduce((a, c) => (Math.abs(c - prev!) < Math.abs(a - prev!) ? c : a));
            out = near(ok.length ? ok : cands);
            if (keyReturn && !Number.isNaN(x) && near(cands) !== out && held) { pre = held; forced = { k, out }; }
        }
        if (!Number.isNaN(out)) prev = out;
        lastOut = out; held = { k, out };
        return out;
    });
}

/**
 * Each note's side key (same order as the input): the relative major's tonic on the line of fifths, NaN for
 * the F♯/G♭ tie, null before any key can be read. Notes must be in onset order (co-struck notes share `tOn`).
 * Pass it as `NoteContext.sideKey`.
 */
export function sideKeys(notes: readonly KeyNote[]): (number | null)[] {
    const { n, pc, hist, on } = scan(notes);
    // KEY on the last 96 onsets, the note's own onset, and the next 16 notes.
    const read: (Key | null)[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const o = on.of[i]!;
        read[i] = bestKey(hist(on.start[Math.max(0, o - BEHIND_ONSETS)]!, Math.max(on.start[o + 1]!, Math.min(n, i + AHEAD_NOTES + 1))));
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
    return deepen(keys);
}

/** {@link centredSideKeys}: onsets read on each side of the note. */
export const CENTRED_SIDE_RADIUS = 48;

/**
 * OFFLINE side keys, for the two-pass tier: each note's key is read on the onsets centred on it (±48 onsets,
 * the note's own included), with the same table and deepening as {@link sideKeys} and no confirmation step (a
 * centred window already sees the passage on both sides). Same output convention: the relative major's tonic
 * on the line of fifths (deepened up to ±7), NaN for the F♯/G♭ tie, null for none. Not look-ahead legal.
 * `keyReturn` (default `true`): a return to the key in force before a limit-forced respell keeps that key's side
 * (see `deepen`; `TwoPassOptions.keyReturn`).
 */
export function centredSideKeys(notes: readonly KeyNote[], radius = CENTRED_SIDE_RADIUS, keyReturn = true): (number | null)[] {
    return deepen(centredKeys(notes, radius), keyReturn);
}

/** {@link centredSideKeys} from keys already read by {@link centredKeys} (two-pass reads them once for both uses). */
export function deepenCentredKeys(keys: readonly (Key | null)[], keyReturn = true): (number | null)[] {
    return deepen(keys, keyReturn);
}

/** Each note's key read on the onsets centred on it (±radius), before deepening. The notes of one onset share
 *  their window, so the key is read once per onset. `starts` (note indices, each starting a section, as
 *  {@link sectionStarts}) bound the window: it reads only the onsets of the note's own section. */
export function centredKeys(notes: readonly KeyNote[], radius: number, starts: readonly number[] = []): (Key | null)[] {
    const { n, hist, on } = scan(notes);
    const last = on.start.length - 2;
    const keys: (Key | null)[] = new Array(n);
    const cuts = starts.map(c => on.of[c]!);
    let c = 0;
    for (let i = 0; i < n; i++) {
        const o = on.of[i]!;
        if (i > 0 && on.of[i - 1] === o) { keys[i] = keys[i - 1]!; continue; }
        while (c < cuts.length && cuts[c]! <= o) c++;
        const lo = Math.max(0, o - radius, c > 0 ? cuts[c - 1]! : 0);
        const hi = Math.min(last, o + radius, c < cuts.length ? cuts[c]! - 1 : last);
        keys[i] = bestKey(hist(on.start[lo]!, on.start[hi + 1]!));
    }
    return keys;
}

/** {@link sectionStarts}: a silence this long (ms) ends a section. */
export const SECTION_SILENCE_MS = 2000;
/** {@link sectionStarts}: a silence this long (ms) ends a section where the key moves {@link SECTION_KEY_JUMP} fifths. */
export const SECTION_SHORT_SILENCE_MS = 500;
/** {@link sectionStarts}: fifths between the collections read before and after a short silence. */
export const SECTION_KEY_JUMP = 3;

/**
 * SECTION BREAKS. A section ends at a silence of {@link SECTION_SILENCE_MS} ms, or of
 * {@link SECTION_SHORT_SILENCE_MS} ms where the collection read on the `radius` onsets before it and the one read on
 * the `radius` onsets after it lie {@link SECTION_KEY_JUMP} or more fifths apart. Returns the note index starting each
 * new section, in order. Notes sorted by onset; a silence is measured from the latest release so far.
 */
export function sectionStarts(notes: readonly (KeyNote & { readonly tOff: number })[], radius = CENTRED_SIDE_RADIUS): number[] {
    const { hist, on } = scan(notes);
    const m = on.start.length - 1, starts: number[] = [];
    const pc = (k: Key | null) => (k ? (k.tonic + (k.minor ? 3 : 0)) % 12 : 0);
    let end = -Infinity;
    for (let o = 1; o < m; o++) {
        for (let i = on.start[o - 1]!; i < on.start[o]!; i++) end = Math.max(end, notes[i]!.tOff);
        const gap = notes[on.start[o]!]!.tOn - end;
        if (gap < SECTION_SHORT_SILENCE_MS) continue;
        const before = bestKey(hist(on.start[Math.max(0, o - radius)]!, on.start[o]!));
        const after = bestKey(hist(on.start[o]!, on.start[Math.min(m, o + radius)]!));
        const d = (((pc(after) - pc(before)) * 7) % 12 + 12) % 12;
        if (gap >= SECTION_SILENCE_MS || Math.min(d, 12 - d) >= SECTION_KEY_JUMP) starts.push(on.start[o]!);
    }
    return starts;
}

/** {@link anchoredSideKeys}: the most fifths a local key may lie from the notated signature and still be in its
 *  diatonic neighbourhood (the closely related keys, whose collections share six of seven notes with it). */
export const SIGNATURE_NEIGHBOURHOOD = 1;

/**
 * NOTATED SIGNATURE → SIDE (two-pass `keySignatures`). Proposition: a passage is notated on the side of its key
 * signature while its local key stays within one fifth of it. Each note's centred local key (as
 * {@link centredSideKeys}, ±radius onsets) is read as its enharmonic reading nearest the signature `sigs[i]` (a tie in
 * distance goes to fewer accidentals, then the flat side). The neighbourhood is measured on the line of fifths with no
 * seven-accidental limit: that limit bounds the signatures a key reader may invent, not the keys next to a notated one.
 * Bach, WTC I/3 (seven sharps): the G♯-major passages (eight sharps, F𝄪) are one fifth from the signature and keep
 * Bach's sharps; read within ±7 they were A♭ major, eleven fifths away, and both passes wrote A♭, E♭, C. Within
 * {@link SIGNATURE_NEIGHBOURHOOD} fifths of the signature, the side is the signature; farther, or with no signature
 * (null), it is `inferred[i]`, the side read from the notes alone. Chopin, Sonata No. 2/ii (E♭ minor, six flats): the
 * signature settles the F♯/G♭ tie the inferred key cannot, and m114–179 keep Chopin's D♭, C♭, G♭. Beethoven,
 * *Pathétique* ii m42–49 (E major written with sharps under four flats): the local key is four fifths from the
 * signature, so the side stays the inferred one. Not look-ahead legal.
 */
export function anchoredSideKeys(notes: readonly KeyNote[], sigs: readonly (number | null)[], inferred: readonly (number | null)[], radius = CENTRED_SIDE_RADIUS, keys: readonly (Key | null)[] = centredKeys(notes, radius)): (number | null)[] {
    return keys.map((k, i) => {
        const s = sigs[i] ?? null;
        if (s === null) return inferred[i] ?? null;
        if (!k) return s;
        const x = xOf(k);
        // Every reading counts, also past seven accidentals: G♯ major (+8) is one fifth from seven sharps.
        const cands = Number.isNaN(x) ? [-6, 6] : [x, x + 12, x - 12];
        const near = cands.reduce((a, c) => (Math.abs(c - s) < Math.abs(a - s) || (Math.abs(c - s) === Math.abs(a - s) && Math.abs(c) < Math.abs(a)) ? c : a));
        return Math.abs(near - s) <= SIGNATURE_NEIGHBOURHOOD ? s : inferred[i] ?? null;
    });
}
