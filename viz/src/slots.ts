/** The three card slots under the music and which view each shows. Each view is in at most one slot. */

export type View = 'scoring' | 'wheel' | 'coiled' | 'spirals' | 'lattice';
export type Slots = [View, View, View];

export const VIEWS: readonly View[] = ['scoring', 'wheel', 'coiled', 'spirals', 'lattice'];
/** The card element of each view. */
export const VIEW_PANEL: Record<View, string> = {
    scoring: 'scoring', wheel: 'wheel', coiled: 'live-tonnetz', spirals: 'spirals', lattice: 'tonnetz',
};
export const VIEW_LABEL: Record<View, string> = {
    scoring: 'scoring', wheel: 'spiral of fifths', coiled: '2D coiled', spirals: 'cipher/key spirals', lattice: '3D lattice',
};
export const DEFAULT_SLOTS: Slots = ['scoring', 'wheel', 'lattice'];

const isView = (v: string): v is View => (VIEWS as readonly string[]).includes(v);

/** "lattice,spirals,scoring" → slots, or null when it is not three distinct views. */
export function parseSlots(text: string | null): Slots | null {
    const parts = (text ?? '').split(',').map(s => s.trim());
    if (parts.length !== 3 || !parts.every(isView) || new Set(parts).size !== 3) return null;
    return parts as Slots;
}

/** Show `view` in slot `i`. A view already in another slot swaps places with the one it replaces. */
export function assign(slots: Slots, i: number, view: View): Slots {
    const next = [...slots] as Slots;
    const j = next.indexOf(view);
    if (j >= 0) next[j] = next[i]!;
    next[i] = view;
    return next;
}

/** Grid column widths: the spiral of fifths is a narrow card wherever it sits; the others share the rest. */
export function slotColumns(slots: Slots): string {
    return slots.map(v => v === 'wheel' ? 'minmax(140px, 0.55fr)' : 'minmax(0, 1fr)').join(' ');
}
