/**
 * Chromatic melodic-line detector: a polyphony-surviving reader of the chromatic RUNS in a
 * note stream. Analysis tooling, NOT a shipped speller: an experiment (HANDOFF_chromatic_line_core)
 * proved that DETECTING runs is cheap and clean, but SPELLING their notes key-relative needs the
 * frame/side machinery the full Speller has, so a frameless Core line-handler washes. The detector
 * itself is kept because it isolates genuine chromatic lines reliably: a future mode that wants to
 * ROUTE runs to side machinery can lift it into `src/`.
 *
 * What a chromatic RUN is (and what trips naive detectors up):
 *   A run is a chain of notes stepping ±1 SEMITONE in a CONSISTENT direction, connected by LEGATO
 *   HANDOFF (each note ends about when the next begins). Two design choices carry it:
 *   1. STRICT MONOTONICITY: once a line has a direction, only a same-direction ±1 step extends it;
 *      a reversal starts a FRESH line. This is what separates a chromatic run from a trill/neighbour
 *      oscillation, and is the single biggest guard against over-firing. (±1 semitone alone is NOT
 *      chromatic: diatonic scales contain E–F and B–C semitones; but two CONSECUTIVE same-direction
 *      semitones cannot be diatonic, so a run of length ≥ 3 is genuinely chromatic.)
 *   2. LEGATO by note timing, NOT a fixed ms window: a slow chromatic ascent can span seconds. The
 *      connection test is temporal adjacency (previous offset ≈ next onset), scaled to note duration.
 *
 *   Polyphony is handled by tracking MULTIPLE open lines at once: parallel semitone descents (e.g.
 *   Grieg's "each chord has a descent") become parallel lines, each extended by its own ±1 step,
 *   NOT collapsed into one, and NOT grabbing co-onset chord tones the way a nearest-pitch
 *   `prevSameVoice` detector does. It uses no voice/channel labels (the ear streams a chromatic line
 *   across voices, and voice labels were falsified anyway).
 *
 * Causality: the scan is left-to-right and never looks at the future, but a note's reported
 * `runLength` is its line's FINAL length (retroactive): the length a batch/offline consumer sees.
 */

/** One note, in onset order (bass-first within a chord). `tOn`/`tOff` in ms (or any consistent unit). */
export interface LineNote {
    readonly midi: number;
    readonly tOn: number;
    readonly tOff: number;
}

export interface DetectOptions {
    /** Minimum line length (notes) to count as a run. 3 = two consecutive same-direction semitones,
     *  the shortest fragment that cannot be diatonic. Default 3. (4+ over-tightens: it drops real
     *  three-note chromatic fragments: measured to lose Grieg's descents entirely.) */
    readonly minRun?: number;
    /** Legato gap tolerance as a MULTIPLE of the incoming note's duration: a line connects if the
     *  previous note's offset falls within [tOn − 0.5·dur, tOn + legatoGap·dur] (small overlap OR a
     *  small gap). Default 0.25: tight enough to reject cross-voice ±1 coincidences in dense
     *  polyphony, loose enough to keep true legato runs. */
    readonly legatoGap?: number;
}

/** Per-note result, index-aligned with the input notes. */
export interface LineTag {
    /** Final length of the chromatic line this note belongs to (1 = a singleton, not a run). */
    readonly runLength: number;
    /** Direction of this note's line: +1 ascending, −1 descending, 0 for a length-1 singleton. */
    readonly direction: number;
    /** `runLength >= minRun`: whether this note reads as part of a genuine chromatic run. */
    readonly inRun: boolean;
}

interface OpenLine { lastMidi: number; lastTOff: number; dir: number; length: number; }

/**
 * Tag every note with the chromatic line it belongs to. Notes MUST be in onset order (the order the
 * spellers and the scorer use). Returns one {@link LineTag} per note, index-aligned with `notes`.
 */
export function detectChromaticLines(notes: readonly LineNote[], opts: DetectOptions = {}): LineTag[] {
    const minRun = opts.minRun ?? 3;
    const legatoGap = opts.legatoGap ?? 0.25;

    const lines: OpenLine[] = [];
    const lineOf = new Array<number>(notes.length).fill(-1);

    for (let i = 0; i < notes.length; i++) {
        const n = notes[i]!;
        const dur = Math.max(1, n.tOff - n.tOn);
        const gapTol = legatoGap * dur;
        let best = -1;
        let bestSlack = Infinity;
        for (let li = 0; li < lines.length; li++) {
            const L = lines[li]!;
            const step = n.midi - L.lastMidi;
            if (Math.abs(step) !== 1) continue;                         // must be a semitone
            if (L.dir !== 0 && Math.sign(step) !== L.dir) continue;      // strict monotonicity
            const slack = n.tOn - L.lastTOff;                           // >0 gap, <0 overlap
            if (slack > gapTol || slack < -0.5 * dur) continue;         // legato handoff
            if (Math.abs(slack) < bestSlack) { bestSlack = Math.abs(slack); best = li; }
        }
        if (best >= 0) {
            const L = lines[best]!;
            L.dir = Math.sign(n.midi - L.lastMidi);
            L.lastMidi = n.midi;
            L.lastTOff = n.tOff;
            L.length++;
            lineOf[i] = best;
        } else {
            lines.push({ lastMidi: n.midi, lastTOff: n.tOff, dir: 0, length: 1 });
            lineOf[i] = lines.length - 1;
        }
    }

    return notes.map((_n, i) => {
        const L = lines[lineOf[i]!]!;
        return { runLength: L.length, direction: L.dir, inRun: L.length >= minRun };
    });
}

/** Collapse an on/off event list to onset-ordered {@link LineNote}s (durations from matched off events). */
export function linesNotesFromEvents(events: readonly { t: number; type: 'on' | 'off'; midi: number }[]): LineNote[] {
    const notes: { midi: number; tOn: number; tOff: number }[] = [];
    const open = new Map<number, number[]>();
    for (const e of events) {
        if (e.type === 'on') {
            const i = notes.length;
            notes.push({ midi: e.midi, tOn: e.t, tOff: e.t });
            (open.get(e.midi) ?? open.set(e.midi, []).get(e.midi)!).push(i);
        } else {
            const q = open.get(e.midi);
            if (q && q.length) notes[q.shift()!]!.tOff = e.t;
        }
    }
    return notes;
}
