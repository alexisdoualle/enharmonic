/** Notes grouped by onset. Onset c holds notes `start[c]` to `start[c + 1] − 1`. */
export interface Onsets {
    /** First note of each onset, then the note count: `start.length − 1` onsets. */
    readonly start: number[];
    /** Per note, its onset. */
    readonly of: number[];
}

/** Group notes sorted by onset; co-struck notes share an exact `tOn`. */
export function groupOnsets(notes: readonly { readonly tOn: number }[]): Onsets {
    const start: number[] = [], of: number[] = [];
    notes.forEach((note, i) => {
        if (i === 0 || note.tOn !== notes[i - 1]!.tOn) start.push(i);
        of.push(start.length - 1);
    });
    start.push(notes.length);
    return { start, of };
}
