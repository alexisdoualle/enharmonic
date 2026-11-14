/**
 * A DOMINANT NAMES ITS TENDENCY TONES (look-ahead context).
 *
 * When a major triad or dominant seventh sounds and the next chord with a different root has its root a fifth
 * below, the chord is a dominant of what follows, and its two tendency tones take the spelling that makes them
 * its tones: the third (the leading tone of the target) and the seventh (the tone that falls to the target's
 * third). The root and fifth are not renamed; they are the reference the third and seventh are named from.
 * Example: Chopin Op. 28 No. 4 m4, E7 → Am7: the G♯ is E7's third, not A♭ (the falling line G♯→G would
 * otherwise vote A♭).
 *
 * {@link dominantChords} reads it from the notes alone (the pitch classes that SOUND at each note's onset, and the
 * chords that follow), like `degreeKeys`; the engine applies it (see `NoteContext.dominant`).
 *
 * REACH is a theory parameter, not a latency budget: how far ahead the chord a fifth below may lie and still make
 * the sounding chord its dominant. It is counted in ONSETS, so a dense texture does not shorten it, and it may
 * therefore look past the look-ahead's 16-note buffer (see the README for the measured distances).
 */

/** A note as {@link dominantChords} reads it. */
export interface DominantNote { readonly midi: number; readonly tOn: number; readonly tOff: number }

/** A dominant of what follows: its root pitch class, and each chord tone's pitch class → its line-of-fifths offset
 *  from the root (root 0, fifth +1, third +4, seventh −2). */
export interface DominantChord { readonly root: number; readonly offs: ReadonlyMap<number, number> }

/** How far ahead the chord a fifth below may lie. `unit: 'onsets'` counts distinct onsets after the dominant's
 *  own (a chord is one onset, however many notes it has). Only 'onsets' exists now; the shape leaves room for a
 *  time unit or an "until resolved" mode later. */
export interface DominantOptions {
    /** Onsets after the dominant's onset scanned for the next chord with a different root. Default 16. */
    readonly reach?: number;
    readonly unit?: 'onsets';
}

/** The default reach: 16 onsets. */
export const DOMINANT_REACH: Required<DominantOptions> = { reach: 16, unit: 'onsets' };

type Tone = [semis: number, fifths: number];
const TEMPLATES: Record<string, Tone[]> = {
    maj: [[0, 0], [4, 4], [7, 1]],
    min: [[0, 0], [3, -3], [7, 1]],
    dim: [[0, 0], [3, -3], [6, -6]],
    aug: [[0, 0], [4, 4], [8, 8]],
    dom7: [[0, 0], [4, 4], [7, 1], [10, -2]],
    maj7: [[0, 0], [4, 4], [7, 1], [11, 5]],
    min7: [[0, 0], [3, -3], [7, 1], [10, -2]],
    hdim7: [[0, 0], [3, -3], [6, -6], [10, -2]],
    dim7: [[0, 0], [3, -3], [6, -6], [9, -9]],
};

/** The chord a pitch-class set best matches: the root must sound and at least 2 template tones; ranked by
 *  (template complete, matched − extras, matched, −extras, template size). */
export function chordOf(pcs: ReadonlySet<number>): { name: string; root: number } | null {
    let best: { key: number[]; name: string; root: number } | null = null;
    for (const [name, tones] of Object.entries(TEMPLATES)) {
        for (let r = 0; r < 12; r++) {
            if (!pcs.has(r)) continue;
            const tp = new Set(tones.map(([s]) => (r + s) % 12));
            let m = 0; for (const p of tp) if (pcs.has(p)) m++;
            if (m < 2) continue;
            const ex = pcs.size - m;
            const key = [m === tones.length ? 1 : 0, m - ex, m, -ex, tones.length];
            if (!best || cmpKey(key, best.key) > 0) best = { key, name, root: r };
        }
    }
    return best && { name: best.name, root: best.root };
}
function cmpKey(a: number[], b: number[]): number { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; }

/**
 * Per note (input order): the dominant sounding at its onset when the note's pitch class is one of its tones,
 * else null. The chord at an onset is every pitch class ringing there (at least 3 for the dominant, 2 for the
 * chord after it); dim7 and augmented chords name no root and are skipped while scanning ahead.
 */
export function dominantChords(notes: readonly DominantNote[], opts: DominantOptions = {}): (DominantChord | null)[] {
    const reach = opts.reach ?? DOMINANT_REACH.reach;
    const n = notes.length;
    const idx = notes.map((_, i) => i).sort((a, b) => notes[a]!.tOn - notes[b]!.tOn || notes[a]!.midi - notes[b]!.midi);
    // Distinct onset times, and for each the position (in idx) of its first note.
    const times: number[] = [], firstAt: number[] = [];
    idx.forEach((i, k) => { const t = notes[i]!.tOn; if (!times.length || times[times.length - 1] !== t) { times.push(t); firstAt.push(k); } });
    // The pitch classes sounding at each onset: notes with tOn ≤ t < tOff, plus the onset's own notes.
    const sound: Set<number>[] = [];
    const live = new Set<number>();
    for (let j = 0; j < times.length; j++) {
        const t = times[j]!, end = j + 1 < times.length ? firstAt[j + 1]! : n;
        for (let k = firstAt[j]!; k < end; k++) live.add(idx[k]!);
        for (const i of [...live]) if (notes[i]!.tOff <= t && notes[i]!.tOn < t) live.delete(i);
        sound.push(new Set([...live].map(i => ((notes[i]!.midi % 12) + 12) % 12)));
    }
    const cache = new Map<number, { name: string; root: number } | null>();
    const chordAt = (j: number, min: number) => {
        const s = sound[j]!; if (s.size < min) return null;
        if (!cache.has(j)) cache.set(j, chordOf(s));
        return cache.get(j)!;
    };
    const atOnset: (DominantChord | null)[] = times.map((_, j) => {
        const c = chordAt(j, 3);
        if (!c || (c.name !== 'maj' && c.name !== 'dom7')) return null;
        // The next chord with a different root within `reach` onsets decides: a fifth below makes c its dominant.
        for (let j2 = j + 1; j2 < times.length && j2 - j <= reach; j2++) {
            const c2 = chordAt(j2, 2);
            if (!c2 || c2.name === 'aug' || c2.name === 'dim7' || c2.root === c.root) continue;
            if ((c2.root - c.root + 12) % 12 !== 5) return null;
            const offs = new Map<number, number>();
            for (const [s, f] of TEMPLATES[c.name]!) offs.set((c.root + s) % 12, f);
            return { root: c.root, offs };
        }
        return null;
    });
    const out: (DominantChord | null)[] = new Array(n).fill(null);
    let j = -1;
    idx.forEach((i, k) => {
        if (j + 1 < times.length && firstAt[j + 1] === k) j++;
        const v = atOnset[j];
        if (v && v.offs.has(((notes[i]!.midi % 12) + 12) % 12)) out[i] = v;
    });
    return out;
}
