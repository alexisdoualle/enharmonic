/** Browser-side spelling formatting: unicode accidental glyphs. */
import type { Pitch, PitchClass } from '../../src/index.js';

const GLYPH: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };

/** "C♯", "E♭" (pitch class) or "C♯4" (with octave). */
export function label(p: Pitch | PitchClass | null): string {
    if (!p) return '∅';
    const base = `${p.step}${GLYPH[p.alter] ?? '?'}`;
    return 'octave' in p ? `${base}${(p as Pitch).octave}` : base;
}

/** Same as {@link label} but the raw ASCII form ("C#", "Eb"), for equality/keys. */
export function ascii(p: Pitch | PitchClass | null): string {
    if (!p) return '';
    const suffix = p.alter === 0 ? '' : (p.alter > 0 ? '#'.repeat(p.alter) : 'b'.repeat(-p.alter));
    return `${p.step}${suffix}`;
}

/** One colour per letter, shared by the coiled Tonnetz and the piano roll's ungraded (live take) notes. */
export const LETTER_COLOR: Record<string, string> = {
    C: '#cb6a62', G: '#e0975a', D: '#cdb45c', A: '#6fb389',
    E: '#5aa79b', B: '#6f95c4', F: '#9c78bd',
};
