/**
 * Triad colouring shared by the 3D Tonnetz panel and the piano-roll chord lane, ported verbatim from the
 * tonnetz app's getTriadColor so the hues match. Major and minor triads take a hue GRADIENT along the
 * fifths chain (the triad's mean fifths-position within the current surface's fifths range), which is
 * the app's "hue offset" look: the hue shows the chord's role relative to the scale. Other qualities use
 * fixed fallback colours. Pure: the surface is passed in explicitly.
 */

/** A spelled note in either shape: the library's {step, alter} or the tonnetz3d PitchClass {letterName, accidental}. */
export type SpelledNote = { step: string; alter: number } | { letterName: string; accidental: number };

export const MAJOR_HUE_LOW = 65, MAJOR_HUE_HIGH = 10;   // major gradient endpoints
export const MINOR_HUE_LOW = 197, MINOR_HUE_HIGH = 236; // minor gradient endpoints
export const TRIAD_FALLBACK: Record<string, string> = {
    major: '#ffcc80', minor: '#abcefb', diminished: '#f8bbd9', augmented: '#c8e6c9',
    flat5: '#f295c4', aug6: '#f5be9e', aug3: '#b39ddb', dim3: '#80cbc4',
};

const FIFTHS_ORDER = 'FCGDAEB';   // fifths-chain position of each natural: F=0 ... B=6 (same as LatticeGeometry)

/** Extended fifths position of a spelled note: F=0, C=1, ..., B=6; F♯=7, B♭=-1, ... */
export function fifthsPos(n: SpelledNote): number {
    const letter = 'step' in n ? n.step : n.letterName;
    const alter = 'step' in n ? n.alter : n.accidental;
    return FIFTHS_ORDER.indexOf(letter) + alter * 7;
}

export function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Colour from a triad's MEAN fifths position (the form the chord lane needs when a seventh chord's
 *  triad is only partly spelled). Falls back to the quality's fixed colour without a 7-note surface. */
export function triadColorAt(type: string, meanPos: number, surface: readonly SpelledNote[]): string {
    if ((type === 'major' || type === 'minor') && surface.length >= 7) {
        const scalePos = surface.map(fifthsPos);
        const min = Math.min(...scalePos), max = Math.max(...scalePos), range = max - min;
        if (range > 0) {
            const t = Math.max(0, Math.min(1, (meanPos - min) / range));
            return type === 'major'
                ? hslToHex(MAJOR_HUE_LOW + t * (MAJOR_HUE_HIGH - MAJOR_HUE_LOW), 100, 75)
                : hslToHex(MINOR_HUE_LOW + t * (MINOR_HUE_HIGH - MINOR_HUE_LOW), 90, 80);
        }
    }
    return TRIAD_FALLBACK[type] ?? '#abcefb';
}

/** getTriadColor: `surface` (the current 7-letter surface) sets the fifths range the gradient normalises against. */
export function triadColor(type: string, notes: readonly SpelledNote[] | undefined, surface: readonly SpelledNote[]): string {
    if (notes && notes.length === 3 && (type === 'major' || type === 'minor')) {
        const pos = notes.map(fifthsPos);
        return triadColorAt(type, (pos[0]! + pos[1]! + pos[2]!) / 3, surface);
    }
    return TRIAD_FALLBACK[type] ?? '#abcefb';
}
