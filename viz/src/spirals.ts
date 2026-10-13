/**
 * Line-of-fifths geometry for the spirals view: the 35 spellings (n, C = 0) wound every 12 fifths (pitch spiral,
 * one spoke per pitch class) or every 7 fifths (letter spiral, one spoke per letter). DOM-free, so it is tested.
 */

const LOF_LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'] as const;
const LETTER_N: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const GLYPH: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };
const mod = (a: number, m: number) => ((a % m) + m) % m;

/** F𝄫 … B𝄪: the 35 spellings with at most a double accidental. */
export const LO = -15, HI = 19;

export const lofOf = (p: { step: string; alter: number }) => LETTER_N[p.step]! + 7 * p.alter;
export const pcOfLof = (n: number) => mod(7 * n, 12);
/** Spoke on the letter spiral: 0 = C at the top, then G, D, A, E, B, F clockwise. */
export const letterSpoke = (n: number) => mod(n, 7);
export const letterOfLof = (n: number) => LOF_LETTERS[letterSpoke(n)]!;
export function nameOfLof(n: number): string {
    const step = letterOfLof(n);
    return step + (GLYPH[Math.round((n - LETTER_N[step]!) / 7)] ?? '?');
}

/** One step along the letter spiral, from the surface note on one spoke to the note on the next spoke. A
 *  perfect fifth is Δn = 1; each comma of 7 past that is one alteration: k < 0 diminished, k > 0 augmented. */
export interface FifthStep { from: number; to: number; k: number; }

/** The surface (one note per letter) as a cycle in spoke order, each note joined to the next spoke's note.
 *  Empty when a letter is missing. */
export function fifthSteps(surface: readonly number[]): FifthStep[] {
    const bySpoke: (number | undefined)[] = Array.from({ length: 7 }, () => undefined);
    for (const n of surface) bySpoke[letterSpoke(n)] = n;
    if (bySpoke.some(n => n === undefined)) return [];
    const steps: FifthStep[] = [];
    for (let s = 0; s < 7; s++) {
        const from = bySpoke[s]!, to = bySpoke[(s + 1) % 7]!;
        steps.push({ from, to, k: (to - from - 1) / 7 });
    }
    return steps;
}

/** The altered fifths that get a coloured arc: neighbouring spokes whose distance is not one fifth. */
export const alteredFifths = (surface: readonly number[]) => fifthSteps(surface).filter(s => s.k !== 0);

export function fifthQuality(k: number): string {
    return k === 0 ? 'P5' : k < 0 ? 'd'.repeat(-k) + '5' : 'A'.repeat(k) + '5';
}

/** The surface on the pitch spiral: maximal runs of consecutive fifths. A diatonic key is one run of
 *  seven; each note off the turn breaks it. */
export function lofRuns(surface: readonly number[]): [number, number][] {
    const ns = [...new Set(surface)].sort((a, b) => a - b);
    const runs: [number, number][] = [];
    for (const n of ns) {
        const last = runs[runs.length - 1];
        if (last && n === last[1] + 1) last[1] = n;
        else runs.push([n, n]);
    }
    return runs;
}

/** Surface notes off the turn: outside the seven-fifth window that holds the most of them (ties go to the
 *  window nearest the surface's mean). A diatonic key has none; A harmonic minor has G♯. */
export function offTurn(surface: readonly number[]): Set<number> {
    const lo = turnStart(surface);
    return new Set(surface.filter(n => n < lo || n > lo + 6));
}

/** The lowest fifth of that seven-fifth window. */
function turnStart(surface: readonly number[]): number {
    if (!surface.length) return 0;
    const mean = surface.reduce((a, b) => a + b, 0) / surface.length;
    let best = 0, bestCount = -1, bestDist = Infinity;
    for (let lo = Math.min(...surface) - 6; lo <= Math.max(...surface); lo++) {
        const count = surface.filter(n => n >= lo && n <= lo + 6).length, dist = Math.abs(lo + 3 - mean);
        if (count > bestCount || (count === bestCount && dist < bestDist)) [best, bestCount, bestDist] = [lo, count, dist];
    }
    return best;
}

/** Where the band breaks on the pitch spiral: each altered fifth that reaches an off-turn note stands in for
 *  one perfect fifth of the turn. A harmonic minor: the A5 C–G♯ replaces C–G, the d5 G♯–D replaces G–D.
 *  A perfect fifth with both ends off the turn stands in for the same fifth on the turn, k = 0: in
 *  B–C♯–D–E♯–F♯–G–A♯, A♯–E♯ replaces A–E (G–E♯ is the augmented sixth).
 *  `from`/`to` are the replaced perfect fifth's ends (to = from + 1); `k` is the replacing fifth's alteration. */
export function bandBridges(surface: readonly number[]): FifthStep[] {
    const lo = turnStart(surface), off = offTurn(surface);
    const onTurn = (n: number) => n - 7 * Math.floor((n - lo) / 7);
    const bridges: FifthStep[] = [];
    for (const s of fifthSteps(surface)) {
        if (s.k === 0) {
            if (!off.has(s.from) || !off.has(s.to)) continue;
            const from = onTurn(s.from);
            if (onTurn(s.to) === from + 1) bridges.push({ from, to: from + 1, k: 0 });
            continue;
        }
        if (off.has(s.from) === off.has(s.to)) continue;   // the turn's own wrap (its diatonic d5), or both off
        const from = off.has(s.from) ? s.to - 1 : s.from;
        bridges.push({ from, to: from + 1, k: s.k });
    }
    return bridges;
}
