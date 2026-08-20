/** App state for the step-through viz. */
import type { Mode, Replay } from './replay.js';

export interface AppState {
    fixtureId: string | null;
    mode: Mode;
    replay: Replay | null;
    step: number;             // index into replay.snapshots
    spiralRange: number;      // substrate spiralRange override (digging-depth cap; floor 6, up to 8)
    spiralCenter: number;     // substrate spiralCenter override (LoF writability bias; default +1)
}

export const initialState: AppState = { fixtureId: null, mode: 'rt', replay: null, step: 0, spiralRange: 6, spiralCenter: 1 };

/** Shipped-preset defaults — the spiral controls reset to these, and the URL omits them when unchanged. */
export const SPIRAL_RANGE_DEFAULT = 6;
export const SPIRAL_CENTER_DEFAULT = 1;
export const SPIRAL_RANGE_MIN = 6, SPIRAL_RANGE_MAX = 12;
export const SPIRAL_CENTER_MIN = -2, SPIRAL_CENTER_MAX = 2;
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
