/**
 * Speller: the shipped real-time product API.
 *
 * One class, two latency modes over the single {@link SpellingEngine}:
 *   - `new Speller()`                    → real-time (recency guard + spiral fold + diatonic-anchor leash)
 *   - `new Speller({ lookAhead: true })` → near-real-time (adds letter-aware look-ahead + vertical guard)
 *
 * For offline use with the whole piece in hand, see {@link spellTwoPass} (highest accuracy).
 *
 * The speller is frameless and detects no key: the side/orientation it settles on is an emergent
 * statistic of the notes it has committed, never a detected key signature.
 */

import type { Pitch, PitchClass } from './pitch.js';
import type { NoteContext } from './kernel.js';
import { SpellingEngine, RT_PRESET, LA_PRESET, collectionAt } from './engine.js';

export interface SpellerOptions {
    /**
     * Letter-aware look-ahead: the caller supplies each note's resolution direction
     * (`NoteContext.resolveDir`) from a small forward buffer, so a spelling can wait for
     * what comes next instead of committing blind. Default `false` (pure real-time).
     */
    lookAhead?: boolean;
    /**
     * PROTOTYPE: supply the piece's key as the signed line-of-fifths of its major TONIC (C=0, G=+1,
     * F=−1, A=+3, D♭=−5, …; for a minor key pass its RELATIVE MAJOR's tonic, A minor → C = 0). Keyless
     * (the default) the spiral fold basin is parked SHARP (foldCenter +3), so a genuinely flat piece
     * drifts across the flat wall and folds to its sharp enharmonic (D♭→C♯). A supplied key RE-CENTRES
     * that basin on the key (foldCenter = tonic + 2, the key's own diatonic mean) and seeds the opening
     * frame there, so the piece stays on its notated side, e.g. D♭ (tonic −5): keyless rt spells it ~half
     * flipped to C♯ (exact 49%); keyed it holds flat (exact 88%). Omit for the shipped keyless behaviour.
     * See the `fold-center-is-sharp-side-basin` finding.
     */
    keyTonic?: number;
}

export class Speller {
    private readonly engine: SpellingEngine;
    readonly lookAhead: boolean;

    constructor(opts: SpellerOptions = {}) {
        this.lookAhead = opts.lookAhead ?? false;
        this.engine = new SpellingEngine(this.lookAhead ? LA_PRESET : RT_PRESET);
        // An initial key is just setKey at t=0 plus a matching frame seed (see setKey / keyTonic).
        if (opts.keyTonic !== undefined) { this.engine.setKey(opts.keyTonic); this.engine.reset(collectionAt(opts.keyTonic + 2)); }
    }

    /**
     * Change the key mid-stream: call between notes at each notated key-signature change (a modulation, or
     * a new piece in a concatenated file), the way you would replay a MusicXML/MIDI key track. It re-centres
     * the spiral fold basin on the new key WITHOUT clearing the running frame, so continuity is kept; a
     * single construction-time `keyTonic` is just the t=0 case. `keyTonic` = signed line-of-fifths of the
     * MAJOR tonic (minor: its relative major). For a HARD boundary that should also reset the frame (truly
     * independent pieces), call `reset(scale)` at the seam as well.
     */
    setKey(keyTonic: number): void {
        this.engine.setKey(keyTonic);
    }

    noteOn(midi: number, ctx: NoteContext = {}): void {
        this.engine.noteOn(midi, ctx.t, ctx.resolveDir ?? 0);
    }

    noteOff(midi: number): void {
        this.engine.noteOff(midi);
    }

    getSpelling(midi: number): Pitch | null {
        return this.engine.getSpelling(midi);
    }

    /**
     * Re-seed. No-arg / empty clears frame state (cold start). A 7-letter scale is a
     * soft key-signature hint. `hard` is accepted for API compatibility; the engine has no
     * hard pin (the frame is always free to drift), so it is treated as a soft seed.
     */
    reset(scale?: readonly PitchClass[], hard = false): void {
        this.engine.reset(scale ?? [], hard);
    }

    /** Current 7-letter surface. */
    getResolvedScale(): PitchClass[] | null {
        return this.engine.getResolvedScale();
    }
}

export type { NoteContext };
