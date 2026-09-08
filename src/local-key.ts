/**
 * Small, pure local-scale reader ported from the lab analysis path. It reads a resolved seven-letter
 * surface rather than a pitch-class histogram, and persistence-gates ambiguous key changes.
 */
import type { Letter, PitchClass } from './pitch.js';
import { pitchClassValue } from './pitch.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const HARMONIC = [0, 2, 3, 5, 7, 8, 11];
const MELODIC = [0, 2, 3, 5, 7, 9, 11];
const NATURAL = [0, 2, 3, 5, 7, 8, 10];
const BASE_LOF: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const naturalForPc: Record<number, Letter> = { 0: 'C', 2: 'D', 4: 'E', 5: 'F', 7: 'G', 9: 'A', 11: 'B' };

export type LocalKeyConfidence = 'high' | 'strong' | 'weak' | 'hold';
export interface LocalKey {
    readonly tonic: number;
    readonly minor: boolean;
    readonly confidence: LocalKeyConfidence;
    readonly step: Letter;
    readonly alter: number;
}

const mod12 = (n: number) => (n % 12 + 12) % 12;
const setFor = (tonic: number, pattern: readonly number[]) => new Set(pattern.map(x => mod12(tonic + x)));
const eqSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every(x => b.has(x));
const same = (a: LocalKey | null, b: LocalKey | null) => !!a && !!b && a.tonic === b.tonic && a.minor === b.minor;

function spelling(surface: readonly PitchClass[], pc: number, prior?: LocalKey | null): { step: Letter; alter: number } {
    for (const p of surface) if (pitchClassValue(p) === pc) return { step: p.step, alter: p.alter };
    if (prior?.tonic === pc) return { step: prior.step, alter: prior.alter };
    const step = naturalForPc[pc] ?? naturalForPc[mod12(pc - 1)]!;
    return { step, alter: naturalForPc[pc] ? 0 : 1 };
}

/** Infer a local tonic/mode from a clean spelling surface, holding the last key through transitions. */
export function readLocalKey(surface: readonly PitchClass[], prior: LocalKey | null): LocalKey | null {
    const pcs = new Set(surface.map(pitchClassValue));
    const attach = (tonic: number, minor: boolean, confidence: LocalKeyConfidence): LocalKey => {
        const s = spelling(surface, tonic, prior);
        return { tonic, minor, confidence, ...s };
    };
    if (pcs.size !== 7) return prior ? attach(prior.tonic, prior.minor, 'hold') : null;
    for (let tonic = 0; tonic < 12; tonic++)
        if (eqSet(pcs, setFor(tonic, HARMONIC)) || eqSet(pcs, setFor(tonic, MELODIC))) return attach(tonic, true, 'high');
    for (let major = 0; major < 12; major++) if (eqSet(pcs, setFor(major, MAJOR)) || eqSet(pcs, setFor(major, NATURAL))) {
        const relMinor = mod12(major + 9);
        if (prior && ((prior.tonic === major && !prior.minor) || (prior.tonic === relMinor && prior.minor))) return attach(prior.tonic, prior.minor, 'strong');
        return attach(major, false, 'weak');
    }
    return prior ? attach(prior.tonic, prior.minor, 'hold') : null;
}

/** Persistence-gated key reader. High-confidence harmonic/melodic-minor reads commit immediately. */
export class LocalKeyReader {
    private committed: LocalKey | null = null;
    private candidate: LocalKey | null = null;
    private count = 0;
    constructor(private readonly persist = 4) {}
    observe(surface: readonly PitchClass[]): LocalKey | null {
        const raw = readLocalKey(surface, this.committed);
        if (!raw) return this.committed;
        if (same(raw, this.committed)) { this.candidate = null; this.count = 0; this.committed = raw; return raw; }
        const threshold = raw.confidence === 'high' ? 1 : this.persist;
        if (same(raw, this.candidate)) this.count++; else { this.candidate = raw; this.count = 1; }
        if (this.count >= threshold) { this.committed = raw; this.candidate = null; this.count = 0; }
        return this.committed;
    }
}

/** The canonical readable side of a local key's collection (C♯ minor → +4, D♭ major → −5). */
export function readableKeyLof(key: LocalKey): number {
    const collectionPc = mod12(key.tonic + (key.minor ? 3 : 0));
    let best = 0;
    for (let t = -12; t <= 12; t++) if (mod12(t * 7) === collectionPc && (Math.abs(t) < Math.abs(best) || best === 0)) best = t;
    return best;
}

/** The signed LoF position of the name currently present in the surface. */
export function spelledKeyLof(key: LocalKey): number {
    return BASE_LOF[key.step] + 7 * key.alter - (key.minor ? 3 : 0);
}

export const localKeyName = (key: LocalKey) => `${key.step}${key.alter > 0 ? '#'.repeat(key.alter) : key.alter < 0 ? 'b'.repeat(-key.alter) : ''}${key.minor ? 'm' : ''}`;
