/**
 * The look-ahead context of every note, read from the notes around it: what `Speller({ lookAhead: true })`
 * takes in `noteOn`. Each part needs notes ahead of the note, so a caller reads them from a buffer or the
 * whole piece.
 */

import type { NoteContext } from './kernel.js';
import { outwardPairs } from './aug6.js';
import { localKeys, degreeKeys } from './key.js';
import { sideKeys } from './key-side.js';
import { dominantChords } from './dominant.js';
import { resolutionDirs, type ResolutionReach } from './resolution.js';

/** A note as {@link lookAheadContext} reads it. */
export interface LookAheadNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

/**
 * Per note (same order as the input), its look-ahead context without `t`: the resolution directions
 * ({@link resolutionDirs}, read with `reach`), the aug6 outward partner and role ({@link outwardPairs}), the
 * local key ({@link localKeys}), the key-degree key ({@link degreeKeys}), the side key ({@link sideKeys}) and
 * the dominant ({@link dominantChords}). Notes must be sorted by onset; co-struck notes share an exact `tOn`.
 * Pass each as `speller.noteOn(midi, { ...context[i], t })`.
 */
export function lookAheadContext(notes: readonly LookAheadNote[], reach: ResolutionReach = {}): NoteContext[] {
    const res = resolutionDirs(notes, reach), pairs = outwardPairs(notes);
    const keys = localKeys(notes), degree = degreeKeys(notes), sides = sideKeys(notes), doms = dominantChords(notes);
    return notes.map((_, i) => {
        const y = pairs.partner[i]!;
        return {
            resolveDir: res.dir[i]!, resolveExact: res.exact[i]!,
            ...(y >= 0 ? { outwardPartner: notes[y]!.midi, outwardRole: pairs.role[i]! } : {}),
            localKey: keys[i], degreeKey: degree[i], sideKey: sides[i]!, dominant: doms[i],
        };
    });
}
