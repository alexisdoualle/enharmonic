/** App state for the step-through viz. */
import type { Mode, Replay } from './replay.js';

export interface SideOverride { from: number; comma: number; }

export interface AppState {
    fixtureId: string | null;
    mode: Mode;
    replay: Replay | null;
    step: number;             // index into replay.snapshots
    spiralRange: number;      // engine spiralRange override (digging-depth cap; floor 6, up to 8)
    spiralCenter: number;     // engine spiralCenter override (LoF writability bias; default +1)
    spiralEven: boolean;      // engine spiralEven: window parity (false = odd/symmetric; true = 12-slot even)
    repair: boolean;          // PROBE: repair the fold-centre scale (snap outliers to the diatonic window)
    meanFrame: boolean;       // A/B: run rt/la on the old 'mean' drift-and-fold instead of the diatonic frame
    lookAhead: boolean;       // real-time mode option: near-real-time letter look-ahead (Speller({ lookAhead }))
    showKeyLanes: boolean;    // EXPERIMENTAL, display-only: the local + stable collection lanes (default off)
    sideOverrides: SideOverride[]; // editorial comma orientation markers for two-pass replay
}

export const initialState: AppState = { fixtureId: null, mode: 'rt', replay: null, step: 0, spiralRange: 7, spiralCenter: 1, spiralEven: false, repair: false, meanFrame: false, lookAhead: false, showKeyLanes: false, sideOverrides: [] };

/** Shipped-preset defaults: the spiral controls reset to these, and the URL omits them when unchanged.
 *  `range` is the clamp radius directly, so the default is 7 (= RT_PRESET foldRadius); min 6 = a tighter fold. */
export const SPIRAL_RANGE_DEFAULT = 7;
export const SPIRAL_CENTER_DEFAULT = 1;
export const SPIRAL_EVEN_DEFAULT = false;
export const SPIRAL_RANGE_MIN = 6, SPIRAL_RANGE_MAX = 12;
export const SPIRAL_CENTER_MIN = -6, SPIRAL_CENTER_MAX = 6;
export const clampRange = (n: number) => Math.max(SPIRAL_RANGE_MIN, Math.min(SPIRAL_RANGE_MAX, Math.round(n)));
export const clampCenter = (n: number) => Math.max(SPIRAL_CENTER_MIN, Math.min(SPIRAL_CENTER_MAX, Math.round(n)));

export function clampStep(s: AppState, i: number): number {
    const n = s.replay?.snapshots.length ?? 0;
    if (n === 0) return 0;
    return Math.max(0, Math.min(n - 1, i));
}

export function current(s: AppState) {
    return s.replay?.snapshots[s.step] ?? null;
}

/** URL onsets are 1-based, matching the transport counter. Internal indices stay 0-based. */
export function stepFromSearch(raw: string | null): number {
    if (!raw || !/^\d+$/.test(raw)) return 0;
    return Math.max(0, Number(raw) - 1);
}

const SIDE_URL = { sharp: 1, flat: -1, auto: 0 } as const;

function parseOnsetList(raw: string | null): number[] {
    if (!raw) return [];
    return raw.split(',').flatMap(part => {
        const n = Number(part.trim());
        return Number.isInteger(n) && n >= 1 ? [n - 1] : [];
    });
}

/** Read `sharp` / `flat` / `auto` onset lists. A later group wins if the same onset appears twice. */
export function sideOverridesFromSearch(p: URLSearchParams): SideOverride[] {
    const byFrom = new Map<number, number>();
    for (const key of ['sharp', 'flat', 'auto'] as const)
        for (const from of parseOnsetList(p.get(key))) byFrom.set(from, SIDE_URL[key]);
    return [...byFrom].map(([from, comma]) => ({ from, comma })).sort((a, b) => a.from - b.from);
}

/** Write grouped marker lists; omit empty groups. */
export function writeSideOverrides(p: URLSearchParams, markers: readonly SideOverride[]): void {
    const groups: Record<keyof typeof SIDE_URL, number[]> = { sharp: [], flat: [], auto: [] };
    for (const o of markers) {
        const n = o.from + 1;
        if (o.comma > 0) groups.sharp.push(n);
        else if (o.comma < 0) groups.flat.push(n);
        else groups.auto.push(n);
    }
    for (const key of ['sharp', 'flat', 'auto'] as const) {
        if (groups[key].length) p.set(key, groups[key].join(','));
        else p.delete(key);
    }
}

/** `URLSearchParams` form-encodes commas to `%2C`, which makes the onset lists unreadable. A comma is
 *  a legal query character, so restore it: the parser decodes both spellings identically. */
export function readableSearch(p: URLSearchParams): string {
    const q = p.toString().replace(/%2C/g, ',');
    return q ? `?${q}` : '';
}
