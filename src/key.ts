/**
 * The local key around a note: the context the engine's leading-tone and key-degree gates read.
 *
 * Proposition: a leading tone of the local key (its ♯7, or the ♯4 leading to its dominant) is named by the
 * key, and a falling chromatic line from it cancels it (C♯→C in D minor stays C♯, not D♭). The look-ahead
 * would otherwise spell a falling semitone as a letter step (D♭→C) and lose the key's own leading tone.
 *
 * {@link localKeys} reads the key from the notes alone, on a window of onsets CENTRED on each note (it needs
 * the next few onsets, so it is look-ahead or offline context, like `resolveDir`). It correlates the window's
 * pitch-class counts with a key table rotated to each of the 24 keys and takes the best. The engine decides
 * whether a falling note is the key's leading tone, in its `leadingToneGate` option, and applies it.
 *
 * Two tables:
 *   - `'temperley'`: Temperley's key profiles, pitch-class distributions of the Kostka–Payne textbook corpus
 *     (D. Temperley, *Music and Probability*, MIT Press 2007, ch. 4; the same numbers as music21's
 *     `TemperleyKostkaPayne`). A fitted profile; the look-ahead tier reads it on ±6 onsets.
 *   - `'tonic-triad'`: from theory, no fitted numbers. "A key is its tonic triad inside its seven-note
 *     collection": tonic-triad tones 3, the collection's other tones 2, the rest 0; major uses the diatonic
 *     collection, minor the harmonic minor (the minor collection whose leading tone is a scale tone).
 *     The two-pass tier reads it on ±12 onsets.
 * Pearson correlation ignores a table's scale and offset, so only the ratio of the gaps between levels matters.
 *
 * The key-degree gate ({@link isKeyDegree}, engine option `keyDegreeGate`) reads its own key, the tonic-triad
 * table on ±12 NOTES centred on the note ({@link degreeKeys}), on both look-ahead and two-pass.
 */

/** A local key: its tonic's pitch class (C = 0) and mode. */
export interface LocalKey {
    readonly tonic: number;
    readonly minor: boolean;
}

/** A note with its onset (any `t` units). */
export interface KeyNote {
    readonly midi: number;
    readonly tOn: number;
}

/** Which key table {@link localKeys} correlates against. */
export type KeyTable = 'temperley' | 'tonic-triad';

export interface LocalKeyOptions {
    /** The key table. Default `'temperley'` (the look-ahead tier's). */
    table?: KeyTable;
    /** Onsets on each side of the note's own onset in the window (co-struck notes are one onset). Default 6. */
    radius?: number;
    /** What `radius` counts: `'onsets'` (default) or `'notes'`, the notes of the input order on each side of
     *  the note itself (the input must then be in onset order, co-struck notes in any fixed order). */
    unit?: 'onsets' | 'notes';
}

/** Twelve weights per mode, by interval above the tonic: [major, minor]. */
type Table = readonly [readonly number[], readonly number[]];

const TEMPERLEY: Table = [
    [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
    [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330],
];

const DIATONIC = [0, 2, 4, 5, 7, 9, 11], HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
const MAJOR_TRIAD = [0, 4, 7], MINOR_TRIAD = [0, 3, 7];
/** Tonic triad 3, other collection tones 2, the rest 0. */
const tonicTriad = (collection: number[], triad: number[]) =>
    Array.from({ length: 12 }, (_, i) => (triad.includes(i) ? 3 : collection.includes(i) ? 2 : 0));
const TONIC_TRIAD: Table = [tonicTriad(DIATONIC, MAJOR_TRIAD), tonicTriad(HARMONIC_MINOR, MINOR_TRIAD)];

const TABLES: Record<KeyTable, Table> = { temperley: TEMPERLEY, 'tonic-triad': TONIC_TRIAD };

/** A table's mode templates centred on their means (y − ȳ) with their sums of squares, for Pearson correlation. */
const CENTRED = Object.fromEntries(Object.entries(TABLES).map(([k, modes]) => [k, modes.map(y => {
    const my = y.reduce((a, b) => a + b) / 12;
    const yc = y.map(v => v - my);
    let dy = 0; for (let i = 0; i < 12; i++) dy += yc[i]! ** 2;
    return { yc, dy };
})])) as Record<KeyTable, { yc: number[]; dy: number }[]>;

const XC = new Float64Array(12);   // scratch: the histogram rotated to a tonic, centred

/** The best key of a 12-bin pitch-class COUNT histogram under a table (Pearson correlation of the histogram,
 *  rotated to each tonic, with each mode's template; 0 when the histogram is flat), or null if it is empty.
 *  Ties go to the first key in the order C major, C minor, C♯ major, …, B minor. */
function bestKey(h: readonly number[], table: KeyTable): LocalKey | null {
    let tot = 0; for (let i = 0; i < 12; i++) tot += h[i]!;
    if (!tot) return null;
    const mx = tot / 12;
    const modes = CENTRED[table];
    let tonic = -1, minor = false, br = -Infinity;
    const xc = XC;
    for (let t = 0; t < 12; t++) {
        let dx = 0;
        for (let i = 0; i < 12; i++) { xc[i] = h[(t + i) % 12]! - mx; dx += xc[i]! ** 2; }
        for (let m = 0; m < 2; m++) {
            const { yc, dy } = modes[m]!;
            let n = 0; for (let i = 0; i < 12; i++) n += xc[i]! * yc[i]!;
            const r = dx && dy ? n / Math.sqrt(dx * dy) : 0;
            if (r > br) { br = r; tonic = t; minor = m === 1; }
        }
    }
    return { tonic, minor };
}

/**
 * Each note's local key (same order as the input): the best key of the pitch classes struck in the onsets
 * from `radius` before the note's onset to `radius` after it, one count per note. Onsets are exact `tOn`
 * values. Notes need not be sorted, unless `unit` is `'notes'`.
 */
export function localKeys(notes: readonly KeyNote[], opts: LocalKeyOptions = {}): (LocalKey | null)[] {
    const table = opts.table ?? 'temperley';
    const radius = opts.radius ?? 6;
    const n = notes.length;
    if (opts.unit === 'notes') {
        const pre: number[][] = [new Array<number>(12).fill(0)];
        for (const x of notes) { const h = pre[pre.length - 1]!.slice(); h[((x.midi % 12) + 12) % 12]!++; pre.push(h); }
        return notes.map((_, i) => {
            const a = Math.max(0, i - radius), b = Math.min(n, i + radius + 1);
            return bestKey(pre[b]!.map((v, q) => v - pre[a]![q]!), table);
        });
    }
    const idx = notes.map((_, i) => i).sort((a, b) => notes[a]!.tOn - notes[b]!.tOn);
    // Onsets in time order: their pc counts, and each note's onset.
    const counts: number[][] = [];
    const onsetOf = new Array<number>(n);
    let lastT = NaN;
    for (const i of idx) {
        if (notes[i]!.tOn !== lastT) { counts.push(new Array<number>(12).fill(0)); lastT = notes[i]!.tOn; }
        counts[counts.length - 1]![((notes[i]!.midi % 12) + 12) % 12]!++;
        onsetOf[i] = counts.length - 1;
    }
    // Prefix sums over onsets, so each window is a difference.
    const pre: number[][] = [new Array<number>(12).fill(0)];
    for (const c of counts) pre.push(pre[pre.length - 1]!.map((v, q) => v + c[q]!));
    const byOnset = new Map<number, LocalKey | null>();
    return notes.map((_, i) => {
        const o = onsetOf[i]!;
        if (!byOnset.has(o)) {
            const a = Math.max(0, o - radius), b = Math.min(counts.length - 1, o + radius) + 1;
            byOnset.set(o, bestKey(pre[b]!.map((v, q) => v - pre[a]![q]!), table));
        }
        return byOnset.get(o)!;
    });
}

/** Whether pitch class `pc` is a leading tone of `key`: in major the ♯4 (leading to the dominant); in minor
 *  the ♯4, the raised 6th and the raised 7th. */
export function isLeadingTone(pc: number, key: LocalKey): boolean {
    const d = (((pc - key.tonic) % 12) + 12) % 12;
    return key.minor ? d === 6 || d === 9 || d === 11 : d === 6;
}

/**
 * Each note's key for the key-degree gate (same order as the input, which must be in onset order): the
 * tonic-triad table (from theory, no fitted numbers) on the 12 notes on each side of the note. Both the
 * look-ahead and the two-pass tier read it.
 */
export function degreeKeys(notes: readonly KeyNote[]): (LocalKey | null)[] {
    return localKeys(notes, { table: 'tonic-triad', radius: 12, unit: 'notes' });
}

/** Whether pitch class `pc` is a degree of `key`: in major its seven diatonic degrees; in minor the natural
 *  minor plus the raised 6th and 7th. */
export function isKeyDegree(pc: number, key: LocalKey): boolean {
    const d = (((pc - key.tonic) % 12) + 12) % 12;
    return key.minor ? d !== 1 && d !== 4 && d !== 6 : d === 0 || d === 2 || d === 4 || d === 5 || d === 7 || d === 9 || d === 11;
}

/** Whether the local key names pitch class `pc` a leading tone in the wide sense, the reading the engine's
 *  held-letter target uses. By semitones above the tonic: major 11 (♮7), 6 (♯4), 1 (♯1), 8 (♯5) and 2 (the 2nd,
 *  a semitone under ♭3); minor 11 (♯7), 6 (♯4), 9 (♯6), 1 (♯1) and 2 (the 2nd, leading to ♭3). */
export function isWideLeadingTone(pc: number, key: LocalKey): boolean {
    const d = (((pc - key.tonic) % 12) + 12) % 12;
    return key.minor ? d === 11 || d === 6 || d === 9 || d === 1 || d === 2 : d === 11 || d === 6 || d === 1 || d === 2 || d === 8;
}
