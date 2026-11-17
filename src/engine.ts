/**
 * SpellingEngine: the shipped speller. One engine; the latency modes are presets over it
 * ({@link RT_PRESET}, {@link LA_PRESET}; two-pass runs LA_PRESET both ways). The engine detects no key; the look-ahead
 * caller may pass local keys (key.ts), used only by the leading-tone and key-degree gates.
 *
 * Two principles do the base work:
 *   1. INTERVAL SCORING. Among a pitch's candidates, pick the one most consonant with the resolved
 *      scale. This alone drifts the scale into key.
 *   2. 7-LETTER LIMIT. The resolved scale holds one spelling per letter A–G. A note is spelled by
 *      choosing which letter to claim; that overwrites the letter's slot.
 *
 * Named-option mechanisms sit on top; each is documented on its {@link EngineOptions} field:
 *   RECENCY GUARD: penalise a same-letter clash within K onsets (coherence, the `wrong` tier).
 *   SPIRAL FOLD: when the frame drifts too far to one side, fold it one comma back (side, the `flipped`
 *     tier). `'clamp'` folds past a deadzone edge; `'economy'` folds by accidental count.
 *   DIATONIC-ANCHOR LEASH: penalise a candidate far outside the recent collection's centre. Resists side
 *     drift continuously, where the fold only reacts after it.
 *   LOOK-AHEAD: given a note's resolution direction, spell the step toward it (an F♯-bound note spells E♯, not F).
 *     The LEADING-TONE GATE withholds it for a falling note that is a leading tone of the supplied local key;
 *     the KEY-DEGREE GATE withholds it for a move into a pitch outside the local key; the HELD-LETTER TARGET
 *     finds a rising leading tone's target when the note's own other spelling holds the target's letter.
 *   DOUBLE-ACC PENALTY, VERTICAL GUARD, COLLISION REPAIR: smaller correctness levers.
 *
 * Frameless: every centre is a statistic of committed notes, never a detected key. Shares only the
 * library's pitch primitives. Read-back returns a sounding note's own committed spelling, else the
 * scale's current spelling of its pitch class.
 */

import type { Pitch, PitchClass } from './pitch.js';
import { pitchAt } from './pitch.js';
import { acc, C_MAJOR, candidates, COMMA, letter, letterAt, LETTER_ORDER, lofOf, pitchClass, spellingOf } from './lof.js';
import { intervalScore } from './scoring.js';
import { isKeyDegree, isLeadingTone, isWideLeadingTone, type LocalKey } from './key.js';
import type { DominantChord } from './dominant.js';
import type { NoteContext } from './kernel.js';
import { SIGNATURE_NEIGHBOURHOOD } from './key-side.js';

// Every spelling below is a line-of-fifths position n (see lof.ts), and a scale is 7 of them indexed
// by letter slot. {step, alter} appears only at the public API and in the decision trace.

// consonance + intervalScore live in src/scoring.ts (one source, shared with CoreSpeller).

/**
 * Is the pair {a, b} a MISSPELLED THIRD: a diminished fourth (should be a major third, C–F♭ ⇒ C–E) or
 * an augmented second (should be a minor third, C–D♯ ⇒ C–E♭), in either direction? On the line of
 * fifths a d4 is 8 apart and an A2 is 9. This is the exact vertical tell: a note off the sheet where an
 * in-sheet third neighbour was available. It does not flag an augmented sixth (10 apart). A diminished
 * seventh is the A2 inverted, so it is flagged; the guard only runs inside a perfect triad, which a
 * diminished-seventh chord is not.
 */
function isMisspelledThird(a: number, b: number): boolean {
    const d = Math.abs(a - b);
    return d === 8 || d === 9;
}

/** The [−2, +2] spelling of pitch class `pc` nearest centre `c` (letter free). Equal distances go to
 *  the first letter from C to B. */
function spellNearest(pc: number, c: number): number {
    const ns = NEAR_CANDIDATES[pc]!;
    let best = 0, bestD = Infinity;
    for (let k = 0; k < ns.length; k++) {
        const n = ns[k]!;
        if (Math.abs(n - c) < bestD) { bestD = Math.abs(n - c); best = n; }
    }
    return best;
}
/** {@link spellNearest}'s candidates per pitch class: its [−2, +2] spellings in letter order C to B. */
const NEAR_CANDIDATES: number[][] = Array.from({ length: 12 }, (_, pc) => {
    const ns: number[] = [];
    for (const s of LETTER_ORDER) {
        const raw = ((pc - pitchClass(s - 1)) % 12 + 12) % 12;
        const alter = raw > 6 ? raw - 12 : raw;
        if (Math.abs(alter) <= 2) ns.push(s - 1 + 7 * alter);
    }
    return ns;
});

/** The economy fold's evidence as per-pitch-class counts: every raw pc in the window plus the current onset.
 *  Costing each heard pitch class once (count × accidentals) instead of once per note gives the same integer
 *  sum, and makes the fold about 6× cheaper on two-pass, where it runs at every note. */
function heardCounts(win: number[][], cur: number[]): { counts: number[]; total: number } {
    const counts = new Array<number>(12).fill(0); let total = 0;
    for (const w of win) for (const pc of w) { counts[pc]!++; total++; }
    for (const pc of cur) { counts[pc]!++; total++; }
    return { counts, total };
}
/** Accidentals needed to notate the counted pitch classes from centre `c` (each pc spelled nearest `c`),
 *  counted from the key signature whose relative-major tonic is `sig` on the line of fifths (0 = C, no
 *  signature). With a signature, a spelling costs the commas between it and its letter's spelling in the
 *  signature (whose collection is the fifths [sig − 1, sig + 5]): under five flats, D♭ costs 0 and D costs 1. */
function costAtCounts(counts: number[], c: number, sig = 0): number {
    let total = 0;
    if (sig === 0) {
        for (let pc = 0; pc < 12; pc++) if (counts[pc]) total += counts[pc]! * Math.abs(acc(spellNearest(pc, c)));
        return total;
    }
    for (let pc = 0; pc < 12; pc++) if (counts[pc]) {
        const n = spellNearest(pc, c), v = sig - 1 + ((((n - (sig - 1)) % 7) + 7) % 7);
        total += counts[pc]! * Math.abs(n - v) / 7;
    }
    return total;
}

/** The 7-letter diatonic collection whose line-of-fifths centre is `c`, e.g. `collectionAt(2)` is C
 *  major (a major key's centre = tonic + 2), `collectionAt(−3)` is D♭ major. A supplied-key seed. */
export function collectionAt(c: number): PitchClass[] { return LETTER_ORDER.map(s => spellingOf(letterAt(s, c))); }

// ── Options + presets ──────────────────────────────────────────────────────────

/** Which spiral fold-back the engine runs (see the class doc): a range-CLAMP on how far the frame has
 *  drifted, an accidental-ECONOMY vote over recent raw pitch classes, or none. */
export type FoldMode = 'clamp' | 'economy' | 'off';

/**
 * The full mechanism switchboard. Every field is optional; the defaults reproduce the shipped
 * real-time tier ({@link RT_PRESET}). A note on units: G/K/W/D/windows count ONSETS (co-struck notes
 * share one onset); the fold centre/radius and the leash anchor/radius are line-of-fifths distances.
 */
export interface EngineOptions {
    /** RECENCY GUARD penalty G for a same-letter/different-accidental clash within the guard window (0 = off). */
    recencyGuard?: number;
    /** RECENCY GUARD window K, in onsets. */
    guardWindow?: number;
    /** Which spiral {@link FoldMode} to run (default `'clamp'`). */
    fold?: FoldMode;
    /** CLAMP fold centre on the 7-slot mean LoF (a major key sits at tonic + 2, so +3 = G-centred, the
     *  conventional sharp bias). Also the economy fold ignores this. */
    foldCenter?: number;
    /** CLAMP fold radius: fold only when the frame drifts more than this past the centre. */
    foldRadius?: number;
    /** ECONOMY fold window W, in onsets (how much recent raw material the economy sees). */
    foldWindow?: number;
    /** ECONOMY fold margin M: fold only when a comma-neighbour is cheaper by more than this. */
    foldMargin?: number;
    /** ECONOMY fold chromaticity gate: skip the fold when the window spans more than this many distinct
     *  pitch classes (0 = no gate). A near-chromatic window has no trustworthy key to prefer. */
    foldMaxChroma?: number;
    /** Fold DEBOUNCE D: a direction must be favoured this many consecutive onsets before it fires. */
    foldDebounce?: number;
    /** DIATONIC-ANCHOR LEASH weight: penalty per fifth a candidate sits beyond the anchor deadzone (0 = off). */
    sideWeight?: number;
    /** LEASH deadzone radius, in fifths, around the anchor. */
    sideRadius?: number;
    /** LEASH memory: how many recent commits feed the anchor's collection median. */
    anchorWindow?: number;
    /** LOOK-AHEAD: when a note's resolution direction is supplied, reward the diatonic-step letter toward
     *  its semitone resolution and penalise the target's own letter. */
    lookAhead?: boolean;
    /** LOOK-AHEAD reward/penalty magnitude. */
    lookAheadWeight?: number;
    /** LEADING-TONE BOOST: extra look-ahead magnitude applied ONLY to an UP-resolution into a NATURAL
     *  (diatonic) target: the genuine leading tone (A♯→B), where the frame slot the note resolves to is
     *  unaltered. Leaves up-into-chromatic (C→C♯) and all down-resolutions at the base weight, so it flips
     *  margin-1 leading tones without over-sharpening same-letter chromatic inflections (0 = off). */
    leadingToneBoost?: number;
    /** DRIFT LEASH: penalty for a double-accidental (|alter| ≥ 2) spelling (0 = off). */
    doubleAccPenalty?: number;
    /** VERTICAL GUARD weight: penalty per misspelled third (dim4/aug2) a candidate forms with a
     *  co-sounding note, but only inside a PERFECT (major/minor) triad, a P5 in the sonority (0 = off). */
    verticalWeight?: number;
    /** COLLISION REPAIR: after a commit, move a non-sounding letter that now spells the same pitch class
     *  as the committed note back to a distinct spelling, keeping 7 distinct pitch classes. */
    collisionRepair?: boolean;
    /** ONE SPELLING PER PITCH CLASS (diatonic frame + keep-alive): a commit evicts a held alteration that
     *  spells the same pitch class on ANOTHER letter (A♭ evicts G♯), unless that note is still sounding; the
     *  evicted letter returns to its collection spelling (G). The diatonic-frame counterpart of
     *  collisionRepair, which that path never reaches. Default false. */
    keepAliveOnePc?: boolean;
    /** Drop STALE slots from the CLAMP fold's centre mean: a letter not committed within this many onsets
     *  holds an outdated spelling (a degree the music has not used for a while) that should not anchor the
     *  key centre. Averaging only the recently-sounded letters keeps the fold centre on the live key.
     *  0 = off (all 7 slots). */
    foldSlotRecency?: number;
    /** REPAIR the scale before the clamp centre mean: fit the best contiguous 7-fifth window to the slots
     *  and snap any outlier (>3 off the window centre, a chromatic alteration) to its diatonic member, so
     *  the centre reads the underlying key rather than the drifted surface. Off by default. */
    foldRepairScale?: boolean;
    /** Gate the CLAMP fold by accidental economy: once the frame has drifted past a deadzone edge, only
     *  actually fold if the target comma-side spells the recent raw pitch classes no dearer than the current
     *  side. Clamp picks WHEN, economy picks WHETHER. Off by default. */
    foldEconomyGate?: boolean;
    /** FRAME MODE (default 'mean'). 'mean' = the shipped drift-and-fold (the frame is the committed slots'
     *  mean, corrected past a deadzone edge). 'diatonic' = a principled explicit frame: every onset the
     *  collection is chosen by COVERAGE over the recent RAW pitch classes (anti-poison, mode-blind), placed
     *  on the spiral at the comma nearest the held frame (continuity + range fold), and held by hysteresis;
     *  the 7 slots ARE that collection, so a chromatic is a raised/lowered degree of a slot, never drift.
     *  Replaces the mean AND the committed anchor with one moving diatonic frame. No functional/mode logic.
     *  This flag picks between the two side-substrates described on the SpellingEngine class doc: 'diatonic'
     *  for every shipped tier; 'mean' is no longer used by a preset. */
    frameMode?: 'mean' | 'diatonic';
    /** 'diatonic' frame: recency half-life (onsets) of the raw-pc coverage window. Default 64. */
    frameHalfLife?: number;
    /** 'diatonic' frame: hysteresis: hold the current collection unless a rival's coverage beats it by more
     *  than this (in decayed pc weight). Default 1. */
    frameMargin?: number;
    /** 'diatonic' frame: KEEP-ALIVE. A committed chromatic (a spelling that differs from its collection slot,
     *  e.g. a raised leading tone A♯ over a collection whose A-slot is A♮) stays in its slot on the surface
     *  until the collection MOVES (which pulls it back) or a different accidental of that letter is committed.
     *  Without it every onset re-derives the pure collection, so a recurring chromatic re-flattens to the
     *  nearest rep (A♯→B♭), the frame's biggest coherence loss vs the mean's drift. Default true. */
    frameKeepAlive?: boolean;
    /** 'diatonic' frame: how the spiral places the collection's SIDE (comma). 'continuity' (default) = the
     *  comma nearest the held frame; 'drift' = nearest the recent committed notes' median LoF (the notated
     *  side). A/B lever; continuity is the clean default. */
    frameSide?: 'continuity' | 'drift';
    /** 'diatonic' frame: SEVEN-ACCIDENTAL TWIN. A frame move to a collection that needs seven or more
     *  accidentals is written on its enharmonic twin when that twin needs five or fewer: a modulation that would
     *  need seven accidentals is notated in its five-accidental enharmonic. C♯ minor moving to its parallel major
     *  lands on D♭ major (F, C natural), not C♯ major (E♯, B♯); continuity alone keeps C♯ major, which the fold
     *  band (up to eight sharps) never folds back (Chopin Op. 28/15 m75). Applies only when the frame moves to a
     *  new collection, not when it holds one; off once a key signature is supplied ({@link keySignature}), which
     *  names the side itself. Known cost: a composer reaching seven sharps by fifths from a sharp neighbourhood
     *  (Chopin's Barcarolle m81–106, F♯ major → C♯ major). Default false. */
    frameTwin?: boolean;
    /** 'diatonic' frame: MINOR COLLECTION. A minor key's collection holds its leading tone: when the frame's
     *  collection is heard as its relative minor, a note outside the collection is scored with the minor's raised
     *  7th in that slot (C minor: B, not B♭), whether or not the 7th sounded recently. In C minor, G–?–G with only
     *  B♭ heard spells F♯ (it completes B–D–F♯), not G♭. The minor reading: the local key when the caller supplies
     *  one (`NoteContext.localKey`), else the relative minor's tonic triad outweighs the major's on the frame's own
     *  recency-weighted raw pitch classes. Not while the ♭7 sounds, nor when a kept alteration holds the slot.
     *  Known cost: a chromatic note of a third key the pair does not name (Confutatis m14, G–B♭–C♯ over a
     *  G-major frame read as E minor: B♭ becomes A♯). Default false. */
    minorLeadingTone?: boolean;
    /** 'diatonic' frame: raw-pc coverage window in onsets (the memory length that defines the collection).
     *  Too short churns the collection on dense music; this is the frame's one real tuning, the equivalent
     *  of the mean fold's. Default 128. */
    frameWindow?: number;
    /** CHROMATIC SHARP-LEAN: for a note whose pitch class is OUTSIDE the frame collection (a true
     *  chromatic), reward the SHARPER of its two single-accidental enharmonic spellings (F♯ over G♭,
     *  E♯ over F, B over C♭) by this many points. The leading-tone / raised-degree asymmetry (a chromatic is
     *  far more often a raise than a lowering) means the ambiguous melodic/isolated chromatic (no
     *  co-sounding P5 for the vertical guard to break the F♯/G♭ tie) leans to the raise. A LoF-DIRECTION
     *  preference (higher LoF), NOT accidental economy: F♯/G♭ have equal accidental count and it still
     *  picks F♯. Gated to out-of-collection pcs, so a diatonic flat (D♭ in D♭ major) is never touched.
     *  Risk: worsens a chromatic already side-locked sharp (D♭→C♯). 0 = off. */
    chromaticSharpLean?: number;
    /** ONSET TOLERANCE (in `t` units, ms for live input): a note joins the current onset if it starts
     *  within this much of the onset's FIRST note and its pitch is not already in the onset. Performed
     *  chords arrive spread over a few tens of ms; exact-`t` grouping splits them into several onsets.
     *  Causal (no waiting). 0 = exact `t` equality (default). */
    onsetTolerance?: number;
    /** ONSET BUFFER: when a later note of the same onset commits, re-decide the onset's earlier notes with
     *  it ringing, so a bass struck first can follow the chord above it. Read-back sees the revised spelling;
     *  live output waits for the onset to complete. Diatonic frame only. Default false. */
    onsetRevise?: boolean;
    /** The recency guard does not dock a note one chromatic step above its letter's last spelling when the
     *  note resolves up a semitone at the exact pitch (B → B♯ → C♯ in one voice): a rising chromatic line, not
     *  a reclaimed letter. Needs `resolveExact`. Default false. */
    guardRaiseLine?: boolean;
    /** ORNAMENT WINDOW (in `t` units, ms for live input): a chromatic's keep-alive slot waits this long. If the
     *  note ends sooner (a grace note) it never enters the surface; if it still sounds at the window's end or is
     *  held longer, it is kept as usual. Its own spelling is not delayed. Needs `t` at note-off. 0 = off. */
    ornamentMs?: number;
    /** The vertical guard's triad test on pitch classes, the note's own included: a root struck after its third
     *  and fifth still counts as inside the triad. A dim7 has no fifth by pitch class either. Default false. */
    verticalPcTriad?: boolean;
    /** The vertical guard counts a misspelled third only inside a perfect triad that holds the note: by pitch class,
     *  the note is the root, third or fifth of a sounding major or minor triad, and only that triad's members count
     *  against it. A P5 elsewhere in the sonority does not make every dim4/aug2 a misspelled third: in the German
     *  sixth D–F♯–A–B♯ the B♯ belongs to no triad, so its aug2 with A is not read as a misspelled C. A note that
     *  would be a triad's third while the triad's other third is sounding is that third's chromatic neighbour, not
     *  its third: A♭ struck against a ringing F–A–C (a legato A still held as G♯/A♭ arrives) is not counted as
     *  F minor's third. Default false. */
    verticalOwnTriad?: boolean;
    /** AUGMENTED SIXTH BY OUTWARD CONVERGENCE (look-ahead only). Two tones ten semitones apart that move
     *  outward and meet on one pitch class are an augmented sixth, and the rising tone is the ♯4: it is spelled
     *  ten fifths sharp of its partner's committed spelling (F♯ against A♭, never G♭), dispositively, over
     *  every score. The pair comes from the caller (`NoteContext.outwardPartner`, found by `outwardPairs`).
     *  KEY GATE: only when the meeting pitch is a degree of the key collection and the rising tone is not. A
     *  diatonic tone rising a semitone into a chromatic one is that tone's inflection (the dom7's seventh D→D♯
     *  in E7 → B/D♯), not a ♯4; a chromatic tone rising into the key takes its letter from its goal. Default
     *  false. */
    aug6Outward?: boolean;
    /** AN AUG6 MEETING THAT NEEDS A DOUBLE FLAT ON A NATURAL IS A PASSING VOICE (with `aug6Outward`). When the
     *  rule would spell the falling tone as a double flat while the frame names that pitch class with a natural,
     *  the pair is one passing voice: neither tone takes the rule, the rising one included, until either tone is
     *  released. In an A-major frame, C and D (tones of a D7) both moving onto one C♯ would give C and E𝄫; the
     *  frame names D, so they stay C and D (Villa-Lobos, Bachianas 5 m7). Default false. */
    aug6PassingVoice?: boolean;
    /** LEADING-TONE GATE (look-ahead only). A leading tone of the local key (its ♯4 leading to the dominant; in
     *  minor also its raised 6th and 7th) is named by the key, and a falling chromatic line from it cancels it:
     *  C♯→C in D minor is C♯, not D♭. So when a note falls a semitone (`resolveDir` −1) and its pitch class is a
     *  leading tone of `localKey`, the look-ahead's letter-step vote (D♭→C) is withheld and the other scores
     *  decide. Rising notes are untouched. The key comes from the caller (`NoteContext.localKey`, read by
     *  `localKeys` on onsets centred on the note); without one the gate does nothing. Default false. */
    leadingToneGate?: boolean;
    /** KEY-DEGREE GATE (look-ahead only). A semitone resolution is a letter step only into a degree of the local
     *  key (major: its seven degrees; minor: natural minor plus the raised 6th and 7th); a move into a chromatic
     *  pitch keeps the note's letter. In C major F rising to F♯ stays F, not E♯ (F♯ is not in the key); in A
     *  major the same rise is E♯→F♯. So when the target `resolveDir` points at is not a degree of `degreeKey`,
     *  the look-ahead's vote is withheld (both directions). The key comes from the caller
     *  (`NoteContext.degreeKey`, read by `degreeKeys`: the tonic-triad table on ±12 notes); without one the gate
     *  does nothing. Default false. */
    keyDegreeGate?: boolean;
    /** HELD-LETTER TARGET (look-ahead only). A rising note whose target letter is held by the note's own other
     *  spelling is still the target's leading tone, when the local key names it one. F♯ rising to G while the
     *  G slot holds G♭ (F♯'s own other name) finds no target in the surface, so the look-ahead gave no vote;
     *  now the target takes the collection's letter (G) and F♯ the step below it, when `localKey` (the
     *  leading-tone gate's) names F♯ a leading tone (`isWideLeadingTone`: major ♮7, ♯4, ♯1, ♯5 and the 2nd;
     *  minor ♯7, ♯4, ♯6, ♯1 and the 2nd). Default false. */
    heldLetterTarget?: boolean;
}

/** REAL-TIME tier (`new Speller()`): recency guard, spiral-CLAMP fold, and diatonic-anchor leash. The fold
 *  centre averages only recently-sounded letters (foldSlotRecency), so a stale degree's spelling does not
 *  drag the side. */
export const RT_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    fold: 'clamp', foldCenter: 3, foldRadius: 7,
    sideWeight: 1, sideRadius: 6, anchorWindow: 32,
    // The diatonic frame: the 7 slots are the coverage collection (recency-weighted raw pcs), placed on the
    // spiral (continuity plus range fold) and held by hysteresis, with keep-alive for chromatics. Replaces
    // the mean drift-and-fold. verticalWeight breaks the F♯/G♭ side ties by chord consonance;
    // chromaticSharpLean handles the melodic/isolated leading tones the vertical guard cannot (no
    // co-sounding P5), leaning a chromatic to its raise. Not used in look-ahead, which resolves these by
    // direction, so the lean would fight it. onsetRevise lets a bass struck first follow the chord above it.
    frameMode: 'diatonic', chromaticSharpLean: 1, onsetRevise: true,
    ornamentMs: 80,
    // A misspelled third inside a struck perfect triad weighs 2, so it overrules the sharp lean (a conditional
    // preference): in an E♭ chord the pitch class 3 is E♭, not D♯. The triad is read by pitch class and must hold
    // the note (verticalOwnTriad), so a chromatic neighbour beside a triad is not read as its misspelled third.
    // The look-ahead tier's guard reading, with its recency-guard window of 7 onsets.
    verticalWeight: 2, verticalPcTriad: true, verticalOwnTriad: true,
    // A frame move to a seven-accidental collection lands on its twin with five or fewer (C♯ major → D♭ major).
    // Real-time only: in look-ahead the inferred side key re-centres the fold and undoes it, and lowering the
    // deepening limit to match costs wrong notes.
    frameTwin: true,
    // A minor key's collection holds its leading tone: a chromatic note heard in the frame's relative minor is
    // scored with the raised 7th in its slot (C minor G–F♯–G, not G♭). Also on in look-ahead (LA_PRESET).
    minorLeadingTone: true,
};

/** LOOK-AHEAD tier (`new Speller({ lookAhead: true })`): a wider guard window + letter-aware look-ahead
 *  + the double-accidental leash + the vertical guard + the onset buffer + the diatonic-anchor leash, over
 *  the diatonic frame. The mean-frame fields (collisionRepair, foldDebounce, anchorWindow, the clamp fold
 *  mode) are not set: the diatonic frame returns before the code that reads them. The fold RANGE
 *  (foldCenter/foldRadius) is live: it bounds the frame's placement on the spiral. */
export const LA_PRESET: EngineOptions = {
    recencyGuard: 2, guardWindow: 7,
    foldCenter: 3, foldRadius: 7,
    // lookAheadWeight stays 2; the extra pull comes from leadingToneBoost, GATED to up-resolutions into a
    // natural target (a genuine leading tone A♯→B), so it does not over-sharpen same-letter chromatic
    // inflections (C→C♯, C♯→C). A blunt weight bump cannot make that distinction and over-sharpens diatonic
    // passing tones; the gate keeps those clean while still recovering true leading tones. One residual:
    // E♭→E, a lowered borrowed degree rising to the natural 3rd, is inseparable from a leading tone without
    // harmonic context.
    lookAhead: true, lookAheadWeight: 2, leadingToneBoost: 1,
    doubleAccPenalty: 2,
    frameMode: 'diatonic', onsetRevise: true, guardRaiseLine: true,
    aug6Outward: true, aug6PassingVoice: true, leadingToneGate: true, keyDegreeGate: true, heldLetterTarget: true,
    // The leash with a wider deadzone than real-time's: a dim7 spans 9 fifths and an aug6 10, so at radius 6
    // one end of a dim7 or the aug6's sharp is pulled across.
    sideWeight: 1, sideRadius: 8,
    ornamentMs: 80,
    // The vertical guard reads the triad by pitch class and weighs a misspelled third 2.
    verticalWeight: 2, verticalPcTriad: true,
    // A minor key's collection holds its leading tone, as in real time (C minor G–F♯–G, not G♭). Confirmed on
    // the whole development pool (DCML, ASAP, lieder, fresh15–20): wrong −525 [−794, −257], flips flat. The
    // two-pass passes run the mean frame, where the rule does not apply.
    minorLeadingTone: true,
};

// ── Decision trace (introspection only) ────────────────────────────────────────

/** One candidate's scoring breakdown for a note (introspection / visualiser only). The argmax is
 *  `base + guardDelta + laDelta + daDelta + vertDelta + sideDelta + leanDelta`, unless the aug6 outward
 *  rule or the dominant tendency-tone rule fires: each is dispositive and overrides the argmax
 *  (`Decision.chosen` shows it). */
export interface DecisionCandidate {
    readonly c: PitchClass;
    readonly base: number;
    readonly guardDelta: number;
    readonly laDelta: number;
    readonly daDelta: number;
    readonly vertDelta: number;
    readonly sideDelta: number;
    readonly leanDelta: number;
}
/** The most recent note's full scoring trace (introspection / visualiser only). */
export interface Decision {
    readonly scale: PitchClass[];
    readonly candidates: DecisionCandidate[];
    readonly chosen: PitchClass;
}

// ── The engine ─────────────────────────────────────────────────────────────────

/**
 * TWO SIDE-SUBSTRATES COEXIST in this class, chosen by `frameMode`. The interval scoring, the six
 * per-candidate deltas, and read-back are shared; only the way the SIDE (the enharmonic orientation) is
 * held differs. Knowing which one is live explains why half the methods and options never run in a given
 * tier.
 *
 *   'diatonic' (the streaming tiers, RT_PRESET and LA_PRESET). The 7 slots ARE a detected collection:
 *   every onset recomputes the frame centre by coverage over recent RAW pitch classes
 *   (computeFrameCentre), re-spells the slots from it, and holds it with hysteresis plus keep-alive for
 *   chromatics. The comma (side) is the spiral folded INSIDE computeFrameCentre, at the writable band
 *   [foldCenter ± foldRadius]. noteOn RETURNS at the diatonic commit, so maybeFold, repairCollision,
 *   updateCollection and the leash anchor are never reached here.
 *
 *   'mean' (formerly the two-pass passes; no preset uses it now). The 7 slots DRIFT: a commit
 *   overwrites its letter's slot, and the side is corrected AFTER the fact by maybeFold (fold the frame
 *   one comma back once its 7-slot MEAN line-of-fifths drifts past the deadzone, by range clamp or
 *   accidental economy), with updateCollection and diatonicAnchor feeding the continuous leash.
 *
 * The two-pass passes used 'mean' until 2026-11: the diatonic frame now reconciles in two pass (the look-ahead
 * speller run both ways, with a centred side key, has fewer wrong notes than the mean passes on every held-out
 * set). The 'mean' path (maybeFold, updateCollection, diatonicAnchor, repairCollision, spellNearest, and their
 * options) remains only for the viz's A/B toggle and can be deleted; see maybeFold's TODO.
 */
export class SpellingEngine {
    private readonly recencyGuard: number;
    private readonly guardWindow: number;
    private readonly fold: FoldMode;
    private foldCenter: number;   // mutable: a supplied key can re-centre the fold basin mid-stream (setKey)
    private readonly foldRadius: number;
    private readonly foldWindow: number;
    private readonly foldMargin: number;
    private readonly foldMaxChroma: number;
    private readonly foldDebounce: number;
    private readonly sideWeight: number;
    private readonly sideRadius: number;
    private readonly anchorWindow: number;
    private readonly lookAheadOn: boolean;
    private readonly lookAheadWeight: number;
    private readonly leadingToneBoost: number;
    private readonly doubleAccPenalty: number;
    private readonly verticalWeight: number;
    private readonly collisionRepair: boolean;
    private readonly keepAliveOnePc: boolean;
    private readonly foldSlotRecency: number;
    private readonly foldRepairScale: boolean;
    private readonly foldEconomyGate: boolean;
    private readonly frameMode: 'mean' | 'diatonic';
    private readonly frameHalfLife: number;
    private readonly frameMargin: number;
    private readonly frameKeepAlive: boolean;
    private readonly frameSide: 'continuity' | 'drift';
    private readonly frameTwin: boolean;
    private readonly minorLeadingTone: boolean;
    private readonly frameWindow: number;
    private readonly chromaticSharpLean: number;
    private readonly onsetTolerance: number;
    private readonly onsetRevise: boolean;
    private readonly guardRaiseLine: boolean;
    private readonly ornamentMs: number;
    private readonly verticalPcTriad: boolean;
    private readonly verticalOwnTriad: boolean;
    private readonly aug6Outward: boolean;
    private readonly aug6PassingVoice: boolean;
    private readonly leadingToneGate: boolean;
    private readonly keyDegreeGate: boolean;
    private readonly heldLetterTarget: boolean;
    /** midi → a chromatic committed within the ornament window, not yet kept: its spelling and onset time. */
    private pending = new Map<number, { n: number; t: number }>();
    /** The current onset's strike time per midi, to tell a unison doubling from a re-strike. */
    private curOnsetT = new Map<number, number>();
    /** The current onset's look-ahead direction per midi, for the onset buffer's re-decisions. */
    private curOnsetDirs = new Map<number, number>();
    /** The current onset's exact-pitch resolution per midi, for the same. */
    private curOnsetExact = new Map<number, number>();
    /** The current onset's aug6 outward partner per midi (partner midi, role +1 rising / −1 falling). */
    private curOnsetOutward = new Map<number, { partner: number; role: number }>();
    /** aug6PassingVoice: pairs judged one passing voice ("rising:falling" midis), until either tone is released. */
    private deadPairs = new Set<string>();
    /** The current onset's local key per midi (the leading-tone gate's), for the same. */
    private curOnsetKey = new Map<number, LocalKey>();
    /** The current onset's key-degree-gate key per midi, for the same. */
    private curOnsetDegreeKey = new Map<number, LocalKey>();
    /** The current onset's dominant per midi (`NoteContext.dominant`), for the tendency-tone rule. */
    private curOnsetDominant = new Map<number, DominantChord>();
    /** The recency guard's memory as it stood before the current onset: a re-decision reads it, so a note's
     *  own first spelling is not exempt from the guard. */
    private guardBefore: ({ onset: number; n: number } | undefined)[] = [];
    private guardMemo: ({ onset: number; n: number } | undefined)[] | null = null;
    /** 'diatonic' keep-alive: letter slot → the committed chromatic alteration it holds over the collection. */
    private kept = new Map<number, number>();
    /** The latest committed spelling, for `getResolvedScale` (the diatonic frame's slots lag it by a note). */
    private lastCommit: number | null = null;

    /** One spelling per letter slot: the drifting scale. Starts at C major. */
    private scale: number[] = [...C_MAJOR];
    /** midi → the spelling committed while that note is sounding, so read-back at note-off returns the
     *  note's OWN spelling even if a later same-letter note has since overwritten the slot. */
    private active = new Map<number, number>();
    /** Note-ons per pitch still ringing. A pitch leaves `active` only when its count reaches 0, so the shorter of two
     *  overlapping same-pitch voices ending first does not drop the pitch while the other still holds it. A re-strike
     *  overwrites `active[midi]` (latest commit's spelling wins; read-back at note-off sees that one). */
    private held = new Map<number, number>();
    /** letter slot → the onset and spelling last committed there, the recency guard's memory. */
    private lastByLetter: ({ onset: number; n: number } | undefined)[] = [];
    /** Running onset counter (co-struck notes share one onset); −1 before the first note. */
    private onset = -1;
    /** The `t` of the current onset, so co-struck notes (same `t`) don't each bump `onset`. */
    private lastT = NaN;
    /** Sliding window of recent onsets' RAW pitch classes (one entry per onset), the economy fold's evidence. */
    private pcWindow: number[][] = [];
    /** The current onset's raw pcs, flushed into pcWindow when the onset advances. */
    private curOnsetPcs: number[] = [];
    /** The current onset's midis: with an onset tolerance, a repeated pitch starts a new onset. */
    private curOnsetMidis = new Set<number>();
    /** Fold DEBOUNCE state: the direction (±12) currently favoured, and for how many consecutive onsets. */
    private pendingDir = 0;
    private pendingCount = 0;
    /** LEASH memory: the line-of-fifths of recently committed notes, for the diatonic anchor. */
    private committedLof: number[] = [];
    /** LEASH penalty centre: the running median-of-core line-of-fifths. */
    private anchor = 1;
    /** LEASH display: the diatonic COLLECTION's centre: the best-fit contiguous 7-fifth window over
     *  recent commits, moved only when a rival window strictly covers more (hysteresis). +2 = C major. */
    private collectionCentre = 2;
    /** The line-of-fifths centre the clamp fold last tested (recency + repair applied), a viz read-out. */
    private foldCentre = 2;
    /** 'diatonic' frame: the current collection's segment CENTRE on the line of fifths (tonic + 2). */
    private frameCentre = 2;
    /** Introspection only: the most recent note's per-candidate scoring. */
    private lastDecision: Decision | null = null;

    constructor(opts: EngineOptions = {}) {
        this.recencyGuard = opts.recencyGuard ?? 2;
        this.guardWindow = opts.guardWindow ?? 3;
        this.fold = opts.fold ?? 'clamp';
        this.foldCenter = opts.foldCenter ?? 3;
        this.foldRadius = opts.foldRadius ?? 7;
        this.foldWindow = opts.foldWindow ?? 24;
        this.foldMargin = opts.foldMargin ?? 7;
        this.foldMaxChroma = opts.foldMaxChroma ?? 0;
        this.foldDebounce = opts.foldDebounce ?? 8;
        this.sideWeight = opts.sideWeight ?? 0;
        this.sideRadius = opts.sideRadius ?? 6;
        this.anchorWindow = opts.anchorWindow ?? 32;
        this.lookAheadOn = opts.lookAhead ?? false;
        this.lookAheadWeight = opts.lookAheadWeight ?? 2;
        this.leadingToneBoost = opts.leadingToneBoost ?? 0;
        this.doubleAccPenalty = opts.doubleAccPenalty ?? 0;
        this.verticalWeight = opts.verticalWeight ?? 0;
        this.collisionRepair = opts.collisionRepair ?? false;
        this.keepAliveOnePc = opts.keepAliveOnePc ?? false;
        this.foldSlotRecency = opts.foldSlotRecency ?? 0;
        this.foldRepairScale = opts.foldRepairScale ?? false;
        this.foldEconomyGate = opts.foldEconomyGate ?? false;
        this.frameMode = opts.frameMode ?? 'mean';
        this.frameHalfLife = opts.frameHalfLife ?? 64;
        this.frameMargin = opts.frameMargin ?? 1;
        this.frameKeepAlive = opts.frameKeepAlive ?? true;
        this.frameSide = opts.frameSide ?? 'continuity';
        this.frameTwin = opts.frameTwin ?? false;
        this.minorLeadingTone = opts.minorLeadingTone ?? false;
        this.frameWindow = opts.frameWindow ?? 128;
        this.chromaticSharpLean = opts.chromaticSharpLean ?? 0;
        this.onsetTolerance = opts.onsetTolerance ?? 0;
        this.onsetRevise = opts.onsetRevise ?? false;
        this.guardRaiseLine = opts.guardRaiseLine ?? false;
        this.ornamentMs = opts.ornamentMs ?? 0;
        this.verticalPcTriad = opts.verticalPcTriad ?? false;
        this.verticalOwnTriad = opts.verticalOwnTriad ?? false;
        this.aug6Outward = opts.aug6Outward ?? false;
        this.aug6PassingVoice = opts.aug6PassingVoice ?? false;
        this.leadingToneGate = opts.leadingToneGate ?? false;
        this.keyDegreeGate = opts.keyDegreeGate ?? false;
        this.heldLetterTarget = opts.heldLetterTarget ?? false;
    }

    /**
     * Commit a spelling for `midi`: the candidate whose combined score (interval fit plus every enabled
     * mechanism's delta) is highest; then run the fold check. `ctx.t`, when given, groups co-struck notes
     * (same `t`) into one onset; omit it to treat every call as its own onset. The rest of `ctx` is the
     * look-ahead context ({@link NoteContext}): `sideKey` is applied first (as {@link sideKey}), `resolveDir`
     * feeds the look-ahead when enabled, `outwardPartner`/`outwardRole` the aug6 outward rule, `localKey` the
     * leading-tone gate, `degreeKey` the key-degree gate and `dominant` the tendency-tone rule.
     */
    noteOn(midi: number, ctx: NoteContext = {}): void {
        const { t, resolveDir = 0, resolveExact = 0, outwardPartner, outwardRole = 0, localKey, degreeKey, dominant } = ctx;
        if (ctx.sideKey !== undefined) this.sideKey(ctx.sideKey);
        // Advance the onset (and flush the previous onset's raw pcs into the fold window) at each new `t`.
        const newOnset = t === undefined || (this.onsetTolerance > 0
            // NaN lastT: new onset. A repeated pitch arriving LATER than its first strike is a re-strike (a unison
            // struck at the same instant stays, wherever it falls in a spread chord).
            ? !(t - this.lastT <= this.onsetTolerance) || (this.curOnsetT.has(midi) && t !== this.curOnsetT.get(midi))
            : t !== this.lastT);
        if (newOnset) {
            this.curOnsetMidis.clear();
            this.curOnsetT.clear();
            this.curOnsetDirs.clear();
            this.curOnsetExact.clear();
            this.curOnsetOutward.clear();
            this.curOnsetKey.clear();
            this.curOnsetDegreeKey.clear();
            this.curOnsetDominant.clear();
            if (this.onsetRevise) this.guardBefore = [...this.lastByLetter];
            if (this.curOnsetPcs.length) {
                this.pcWindow.push(this.curOnsetPcs);
                // Keep enough onsets for whichever consumer needs the most: the economy fold (foldWindow) or
                // the diatonic frame's coverage (frameWindow). Recency weighting inside handles the rest.
                const cap = this.frameMode === 'diatonic' ? Math.max(this.foldWindow, this.frameWindow) : this.foldWindow;
                if (this.pcWindow.length > cap) this.pcWindow.shift();
                this.curOnsetPcs = [];
            }
            if (t !== undefined) this.lastT = t;
            this.onset++;
        }
        this.curOnsetPcs.push(((midi % 12) + 12) % 12);
        this.curOnsetMidis.add(midi);
        if (t !== undefined && !this.curOnsetT.has(midi)) this.curOnsetT.set(midi, t);
        this.curOnsetDirs.set(midi, resolveDir);
        this.curOnsetExact.set(midi, resolveExact);
        // A unison doubling without a pair of its own keeps its twin's (both are the same tone).
        if (outwardPartner !== undefined && outwardRole !== 0) this.curOnsetOutward.set(midi, { partner: outwardPartner, role: outwardRole });
        if (localKey) this.curOnsetKey.set(midi, localKey); else this.curOnsetKey.delete(midi);
        if (degreeKey) this.curOnsetDegreeKey.set(midi, degreeKey); else this.curOnsetDegreeKey.delete(midi);
        if (dominant) this.curOnsetDominant.set(midi, dominant); else this.curOnsetDominant.delete(midi);

        // PRINCIPLED FRAME: the 7 slots ARE the coverage collection (raw-pc, spiral-placed, sticky), set
        // before scoring. A committed note never drifts the frame (see the commit tail); only the raw-pc
        // window moves it. This replaces the mean drift-and-fold AND the committed anchor.
        if (this.pending.size && t !== undefined) {
            for (const [m, p] of this.pending) if (this.lastT - p.t >= this.ornamentMs) { this.pending.delete(m); this.keep(p.n); }
        }
        if (this.frameMode === 'diatonic') {
            const prevCentre = this.frameCentre;
            this.frameCentre = this.computeFrameCentre();
            this.foldCentre = this.frameCentre;         // viz read-outs track the live frame
            this.collectionCentre = this.frameCentre;
            this.anchor = this.frameCentre;
            // The collection moving PULLS BACK the held alterations (they belonged to the old collection).
            if (this.frameKeepAlive && this.frameCentre !== prevCentre) { this.kept.clear(); this.pending.clear(); }
            for (let s = 0; s < 7; s++) this.scale[s] = letterAt(s, this.frameCentre);
            // KEEP-ALIVE overlay: a committed chromatic rides its slot until the collection pulls it back.
            if (this.frameKeepAlive) {
                for (const [s, n] of this.kept) {
                    if (this.scale[s] !== n) this.scale[s] = n;
                    else this.kept.delete(s);   // the collection now spells this letter the same way; drop it
                }
                // A pending chromatic counts in its own onset: the chord around it hears it.
                for (const [m, p] of this.pending) if (this.curOnsetMidis.has(m)) this.scale[letter(p.n)] = p.n;
            }
        }

        // LEASH: refresh the diatonic anchor from recent commits, so a candidate far from the local
        // collection can be penalised. Off (weight 0) leaves the anchor un-consulted. Skipped in the
        // diatonic frame (the collection IS the frame; nothing to leash toward).
        if (this.sideWeight > 0 && this.frameMode !== 'diatonic') this.anchor = this.diatonicAnchor();

        const { best, scale, cands } = this.decide(midi, resolveDir, resolveExact);
        if (best === null) return;
        this.lastDecision = { scale, candidates: cands, chosen: spellingOf(best) };
        this.active.set(midi, best);
        this.held.set(midi, (this.held.get(midi) ?? 0) + 1);
        this.lastCommit = best;
        this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
        if (this.frameMode === 'diatonic') {
            // The frame is the collection; a commit never drifts the SLOTS. But it does record the committed
            // line-of-fifths (the 'drift' side anchor reads its recent median) and keeps a chromatic alive.
            this.committedLof.push(best);
            if (this.committedLof.length > this.anchorWindow) this.committedLof.shift();
            if (this.frameKeepAlive) {
                if (best === letterAt(letter(best), this.frameCentre)) this.kept.delete(letter(best));
                // Timed from the onset's first note, so a spread chord does not shorten its notes.
                else if (this.ornamentMs > 0 && t !== undefined) this.pending.set(midi, { n: best, t: this.lastT });
                else this.kept.set(letter(best), best);
                this.evictSamePc(best);
            }
            if (this.onsetRevise) this.reviseOnset(midi);
            return;
        }

        this.scale[letter(best)] = best;
        if (this.sideWeight > 0) {
            this.committedLof.push(best);
            if (this.committedLof.length > this.anchorWindow) this.committedLof.shift();
            this.updateCollection();
        }
        if (this.collisionRepair) this.repairCollision(best);

        if (this.fold !== 'off') this.maybeFold();
    }

    /** Score every spelling of `midi` against the current frame and the notes ringing (less `self`, the note
     *  being re-decided), and return the best with its per-candidate trace. */
    private decide(midi: number, resolveDir: number, resolveExact: number, self?: number): { best: number | null; scale: PitchClass[]; cands: DecisionCandidate[] } {
        // MINOR COLLECTION ({@link minorLeadingTone}): a note outside the frame's collection is scored with the
        // relative minor's raised 7th in its slot when the collection is heard as that minor.
        if (this.minorLeadingTone && this.frameMode === 'diatonic') {
            const pc = ((midi % 12) + 12) % 12;
            if (!LETTER_ORDER.some(s => pitchClass(letterAt(s, this.frameCentre)) === pc)) {
                const live = this.scale;
                this.scale = [...live];
                this.raiseMinorLeadingTone(midi);
                try { return this.decideOn(midi, resolveDir, resolveExact, self); } finally { this.scale = live; }
            }
        }
        return this.decideOn(midi, resolveDir, resolveExact, self);
    }

    private decideOn(midi: number, resolveDir: number, resolveExact: number, self?: number): { best: number | null; scale: PitchClass[]; cands: DecisionCandidate[] } {
        // LOOK-AHEAD: if this note resolves a semitone to a target the scale already spells, reward the
        // diatonic-STEP letter toward it and penalise the target's own letter.
        // LEADING-TONE GATE: a falling note that is a leading tone of the local key keeps the key's name.
        const key = this.leadingToneGate && resolveDir === -1 ? this.curOnsetKey.get(midi) : undefined;
        let laOn = this.lookAheadOn && resolveDir !== 0 && !(key && isLeadingTone(((midi % 12) + 12) % 12, key));
        // KEY-DEGREE GATE: a semitone resolution is a letter step only into a degree of the local key; a move into
        // a chromatic pitch keeps the note's letter.
        if (laOn && this.keyDegreeGate) {
            const dk = this.curOnsetDegreeKey.get(midi);
            if (dk && !isKeyDegree((((midi + resolveDir) % 12) + 12) % 12, dk)) laOn = false;
        }
        let laStep: number | null = null, laTarget: number | null = null, laWeight = this.lookAheadWeight;
        if (laOn) {
            const targetPc = (((midi + resolveDir) % 12) + 12) % 12;
            laTarget = LETTER_ORDER.find(s => pitchClass(this.scale[s]!) === targetPc) ?? null;
            // HELD-LETTER TARGET: the target's letter is held by this note's own other spelling (the G slot holds
            // G♭ while F♯ rises to G); if the key names the note a leading tone, take the collection's letter.
            if (laTarget === null && this.heldLetterTarget && resolveDir === 1) {
                const c = this.frameMode === 'diatonic' ? this.frameCentre : this.surfaceCollectionCentre();
                const s0 = LETTER_ORDER.find(s => pitchClass(letterAt(s, c)) === targetPc);
                const own = ((midi % 12) + 12) % 12, k = this.curOnsetKey.get(midi);
                if (s0 !== undefined && k && isWideLeadingTone(own, k) && pitchClass(this.scale[s0]!) === own) laTarget = s0;
            }
            // The step letter: one letter below the target for an up-resolution, above for down. A letter
            // step is 2 slots on the line of fifths (C=1, D=3).
            if (laTarget !== null) laStep = ((laTarget - 2 * resolveDir) % 7 + 7) % 7;
            // LEADING-TONE BOOST: only for an UP-resolution into a NATURAL (unaltered) target: a genuine
            // leading tone (A♯→B). Up-into-chromatic (C→C♯) and down-resolutions keep the base weight, so
            // the boost never over-sharpens a same-letter chromatic inflection of a degree.
            if (laTarget !== null && resolveDir === 1 && acc(this.scale[laTarget]!) === 0) laWeight += this.leadingToneBoost;
        }

        const scale = LETTER_ORDER.map(s => spellingOf(this.scale[s]!));   // the surface scored against
        // VERTICAL GUARD context: the notes still ringing. The guard only fires inside a PERFECT triad:
        // a dim4/aug2 is a valid interval elsewhere. The triad's tell is a P5 (LoF distance 1); a dim7 /
        // aug6 has no P5, so they don't qualify.
        const coSounding = this.verticalWeight > 0 ? [...this.active].filter(([m]) => m !== self).map(([, v]) => v) : [];
        const pcs = this.verticalPcTriad
            ? [...new Set([...this.active.keys()].filter(m => m !== self).concat([midi]).map(m => ((m % 12) + 12) % 12))] : [];
        const inPerfectTriad = this.verticalPcTriad
            ? pcs.some(a => pcs.some(b => (b - a + 12) % 12 === 7))
            : coSounding.some((p, i) => coSounding.some((q, j) => j > i && Math.abs(p - q) === 1));
        // OWN TRIAD: only the members of a sounding major/minor triad that holds this note's pitch class count.
        let triadMates: number[] | null = null;
        if (this.verticalOwnTriad && this.verticalWeight > 0) {
            const own = ((midi % 12) + 12) % 12;
            const ring = [...this.active].filter(([m]) => m !== self);
            const have = new Set(ring.map(([m]) => ((m % 12) + 12) % 12)); have.add(own);
            const mates = new Set<number>();
            for (const off of [0, 3, 4, 7]) {
                const r = (own - off + 12) % 12;
                if (!have.has(r) || !have.has((r + 7) % 12)) continue;
                for (const third of [3, 4]) {
                    if (!have.has((r + third) % 12) || (off !== 0 && off !== 7 && off !== third)) continue;
                    // The note as a third while the triad's other third is ringing is that third's neighbour.
                    if (off === third && have.has((r + 7 - third) % 12)) continue;
                    mates.add(r); mates.add((r + third) % 12); mates.add((r + 7) % 12);
                }
            }
            triadMates = ring.filter(([m]) => mates.has(((m % 12) + 12) % 12)).map(([, v]) => v);
        }
        // CHROMATIC SHARP-LEAN: if this note's pc is outside the frame collection, reward the sharper
        // (higher-LoF) of its single-accidental spellings, the raised leading tone / raised degree.
        let leanTarget: number | null = null;
        if (this.chromaticSharpLean > 0) {
            const centre = this.frameMode === 'diatonic' ? this.frameCentre : this.collectionCentre;
            const collectionPcs = new Set(LETTER_ORDER.map(s => pitchClass(letterAt(s, centre))));
            if (!collectionPcs.has(((midi % 12) + 12) % 12)) {
                let m = -Infinity;
                for (const n of candidates(midi)) if (Math.abs(acc(n)) <= 1) m = Math.max(m, n);
                if (m !== -Infinity) leanTarget = m;
            }
        }
        const outward = this.aug6Outward && this.lookAheadOn ? this.outwardSpelling(midi) : null;
        const cands: DecisionCandidate[] = [];
        let best: number | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        let outwardIsCandidate = false;
        for (const n of candidates(midi)) {
            if (n === outward) outwardIsCandidate = true;
            const base = intervalScore(n, this.scale);
            const last = (this.guardMemo ?? this.lastByLetter)[letter(n)];
            const raiseLine = this.guardRaiseLine && resolveExact === 1 && last !== undefined && n - last.n === 7;
            const guarded = this.recencyGuard && last && last.n !== n && this.onset - last.onset <= this.guardWindow && !raiseLine;
            const guardDelta = guarded ? -this.recencyGuard : 0;
            const laDelta = laOn ? (letter(n) === laStep ? laWeight : letter(n) === laTarget ? -laWeight : 0) : 0;
            const daDelta = Math.abs(acc(n)) >= 2 ? -this.doubleAccPenalty : 0;
            let misThirds = 0;
            if (this.verticalWeight > 0 && inPerfectTriad) for (const x of triadMates ?? coSounding) if (isMisspelledThird(n, x)) misThirds++;
            const vertDelta = -this.verticalWeight * misThirds;
            // LEASH: one point per fifth the candidate sits BEYOND the anchor's deadzone. Zero inside, so
            // ordinary chromatic colour is free; it only bites a spelling that would strand the note far
            // from where the last bar of music has sat.
            const sideDelta = this.sideWeight > 0
                ? -this.sideWeight * Math.max(0, Math.abs(n - this.anchor) - this.sideRadius)
                : 0;
            const leanDelta = (leanTarget !== null && Math.abs(acc(n)) <= 1 && n === leanTarget) ? this.chromaticSharpLean : 0;
            const s = base + guardDelta + laDelta + daDelta + vertDelta + sideDelta + leanDelta;
            cands.push({ c: spellingOf(n), base, guardDelta, laDelta, daDelta, vertDelta, sideDelta, leanDelta });
            if (s > bestScore) { bestScore = s; best = n; }
        }
        // DOMINANT NAMES ITS TENDENCY TONES: dispositive over every score (the look-ahead vote included), below
        // the aug6 outward rule.
        const named = this.lookAheadOn && !outwardIsCandidate ? this.dominantSpelling(midi, self) : null;
        if (named !== null) best = named;
        // AUG6 OUTWARD: dispositive, above every score (a struck augmented sixth is a fact, not a preference).
        if (outwardIsCandidate) best = outward;
        return { best, scale, cands };
    }

    /** The tendency-tone rule's spelling for `midi`, or null when it does not apply. The note must be the third
     *  or the seventh of its onset's dominant (`NoteContext.dominant`). The root is named from the committed
     *  spellings of the chord's sounding root and fifth (majority; on a tie or with none sounding, from the
     *  frame surface), never from the tones being named, so one provisional third cannot rename the chord. The
     *  rule stays inside the leash deadzone (`sideRadius` fifths from the collection centre): a farther name
     *  means the root was read on the far side, and the summed scores decide instead. */
    private dominantSpelling(midi: number, self?: number): number | null {
        const v = this.curOnsetDominant.get(midi);
        if (!v) return null;
        const off = v.offs.get(((midi % 12) + 12) % 12);
        if (off !== 4 && off !== -2) return null;
        const votes = new Map<number, number>();
        for (const [m, x] of this.active) {
            if (m === midi || m === self) continue;
            const o = v.offs.get(((m % 12) + 12) % 12);
            if (o === 0 || o === 1) votes.set(x - o, (votes.get(x - o) ?? 0) + 1);
        }
        const ranked = [...votes].sort((p, q) => q[1] - p[1]);
        let root: number;
        if (ranked.length && !(ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) root = ranked[0]![0];
        else {
            const s = LETTER_ORDER.find(x => pitchClass(this.scale[x]!) === v.root);
            if (s === undefined) return null;
            root = this.scale[s]!;
        }
        const named = root + off;
        if (!candidates(midi).includes(named)) return null;
        const centre = this.frameMode === 'diatonic' ? this.frameCentre : this.surfaceCollectionCentre();
        return Math.abs(named - centre) > this.sideRadius ? null : named;
    }

    /** The aug6 outward rule's spelling for `midi`, or null when it does not apply: the note has a pair this
     *  onset whose partner is committed and sounding, the pair's meeting pitch is a degree of the key
     *  collection and the rising tone is not. The rising tone is ten fifths sharp of its partner, the falling
     *  tone ten fifths flat. */
    private outwardSpelling(midi: number): number | null {
        const pair = this.curOnsetOutward.get(midi);
        if (!pair) return null;
        const partnerN = this.active.get(pair.partner);
        if (partnerN === undefined) return null;
        const centre = this.frameMode === 'diatonic' ? this.frameCentre : this.surfaceCollectionCentre();
        const collection = new Set(LETTER_ORDER.map(s => pitchClass(letterAt(s, centre))));
        const meetPc = (((midi + pair.role) % 12) + 12) % 12;
        const risingPc = (((pair.role === 1 ? midi : pair.partner) % 12) + 12) % 12;
        if (!collection.has(meetPc) || collection.has(risingPc)) return null;
        const out = pair.role === 1 ? partnerN + 10 : partnerN - 10;
        if (this.aug6PassingVoice) {
            // A falling tone the rule would write as a double flat of a pitch the frame names natural (A → B𝄫):
            // the pair is a passing voice, and stays one for both tones while they sound.
            const key = pair.role === 1 ? `${midi}:${pair.partner}` : `${pair.partner}:${midi}`;
            if (this.deadPairs.has(key)) return null;
            if (pair.role === -1) {
                const fallPc = ((midi % 12) + 12) % 12;
                if (collection.has(fallPc)) {
                    const framed = letterAt(LETTER_ORDER.find(s => pitchClass(letterAt(s, centre)) === fallPc)!, centre);
                    if (acc(out) <= -2 && acc(framed) === 0) { this.deadPairs.add(key); return null; }
                }
            }
        }
        return out;
    }

    /** The mean frame keeps no diatonic collection: the centre of the contiguous 7-fifth window that covers the
     *  most of the drifting surface's slots (ties to the slots' median). Used by the aug6 key gate. */
    private surfaceCollectionCentre(): number {
        const L = this.scale.slice().sort((a, b) => a - b), med = L[3]!;
        let bestK = med, bestCov = -1;
        for (let k = Math.min(L[0]! + 3, L[6]! - 3); k <= Math.max(L[0]! + 3, L[6]! - 3); k++) {
            let cov = 0; for (const v of L) if (v >= k - 3 && v <= k + 3) cov++;
            if (cov > bestCov || (cov === bestCov && Math.abs(k - med) < Math.abs(bestK - med))) { bestCov = cov; bestK = k; }
        }
        return bestK;
    }

    /** ONSET BUFFER: re-decide each earlier note of the current onset with the whole onset so far ringing. */
    private reviseOnset(just: number): void {
        // Re-decisions do not hear a pending chromatic, struck after the note they re-decide (it may be a grace
        // note): its slot reads as before it.
        const live = this.scale;
        if (this.pending.size) {
            this.scale = [...this.scale];
            for (const p of this.pending.values()) this.scale[letter(p.n)] = this.kept.get(letter(p.n)) ?? letterAt(letter(p.n), this.frameCentre);
        }
        try { this.reviseOnsetNotes(just); } finally { this.scale = live; }
    }

    private reviseOnsetNotes(just: number): void {
        for (const m of this.curOnsetMidis) {
            if (m === just || !this.active.has(m)) continue;
            const old = this.active.get(m)!;
            this.guardMemo = this.guardBefore;
            const { best } = this.decide(m, this.curOnsetDirs.get(m) ?? 0, this.curOnsetExact.get(m) ?? 0, m);
            this.guardMemo = null;
            if (best === null || best === old) continue;
            this.active.set(m, best);
            this.lastByLetter[letter(best)] = { onset: this.onset, n: best };
            const i = this.committedLof.lastIndexOf(old);
            if (i >= 0) this.committedLof[i] = best;
            if (this.frameKeepAlive) {
                if (this.kept.get(letter(old)) === old) this.kept.delete(letter(old));
                const pend = this.pending.get(m);
                if (pend) pend.n = best;
                else if (best !== letterAt(letter(best), this.frameCentre)) this.kept.set(letter(best), best);
                this.evictSamePc(best);
            }
        }
    }

    /**
     * Collision repair: after committing `just`, if another (non-sounding) letter now spells the SAME
     * pitch class, move it to its nearest sensible spelling so the scale keeps 7 distinct pitch classes.
     * A letter whose note is currently sounding is left alone: a genuine enharmonic doubling, not drift.
     */
    private repairCollision(just: number): void {
        const pc = pitchClass(just);
        const sounding = new Set<number>(); for (const n of this.active.values()) sounding.add(letter(n));
        for (let s = 0; s < 7; s++) {
            if (s === letter(just) || sounding.has(s)) continue;
            if (pitchClass(this.scale[s]!) !== pc) continue;   // no collision on this letter
            for (const alt of [0, -1, 1, -2, 2]) {               // nearest natural first
                const n = s - 1 + 7 * alt;
                if (pitchClass(n) !== pc) { this.scale[s] = n; break; }
            }
        }
    }

    /**
     * The spiral fold-back. Measure the frame's side as the mean line-of-fifths of its 7 slots, decide a
     * fold direction (by the range clamp or the accidental economy), debounce it, and (once it fires)
     * re-anchor the 7 slots one comma toward the cheaper side. Sounding notes keep their committed spelling.
     */
    private maybeFold(): void {
        // TODO: the fold centre is the INSTANTANEOUS 7-slot MEAN, the wrong substrate for the flip on
        // modulating pieces: the mean is yanked by every chromatic note and mis-fires at modulation seams.
        // The intended replacement is an evidence-based frame (a detected key-signature or diatonic
        // collection that holds until new evidence overturns it, laggier but robust across modulation) as
        // the side substrate, replacing or gating this mean.
        // Centre entries [slot, n] for the 7 slots, C to B.
        let entries = LETTER_ORDER.map(s => [s, this.scale[s]!] as [number, number]);
        // Drop STALE slots (letters not committed within N onsets): a degree the music has not used for a
        // while holds an outdated spelling that should not anchor the fold centre. Fall back to all 7.
        if (this.foldSlotRecency > 0) {
            const fresh = entries.filter(([s]) => { const last = this.lastByLetter[s]; return last != null && this.onset - last.onset <= this.foldSlotRecency; });
            if (fresh.length) entries = fresh;
        }
        if (this.foldRepairScale) {
            const vals = entries.map(([, v]) => v); const med = this.median(vals);
            let bestK = med, bestCov = -1;
            for (let k = med - 6; k <= med + 6; k++) { const cov = vals.reduce((n, v) => n + (Math.abs(v - k) <= 3 ? 1 : 0), 0); if (cov > bestCov || (cov === bestCov && Math.abs(k - med) < Math.abs(bestK - med))) { bestCov = cov; bestK = k; } }
            entries = entries.map(([s, v]) => [s, Math.abs(v - bestK) <= 3 ? v : letterAt(s, bestK)] as [number, number]);
        }
        const cFrame = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
        this.foldCentre = cFrame;   // the actual quantity the clamp tests (recency + repair applied), for the viz

        let favoured = 0;
        if (this.fold === 'clamp') {
            // Fold only when the frame drifts PAST an edge of the deadzone: far-sharp to flat, far-flat to
            // sharp, never touching central keys.
            if (cFrame > this.foldCenter + this.foldRadius) favoured = -COMMA;
            else if (cFrame < this.foldCenter - this.foldRadius) favoured = +COMMA;
            // Economy gate (foldEconomyGate, off by default): the clamp decides WHEN to fold (frame far out),
            // this decides WHETHER, folding only if the target comma-side spells the recent raw pitch classes
            // at least as cheaply. It vetoes over-folding a moderate flat while still confirming a deep one.
            // It only VETOES, though; it cannot fix UNDER-firing, where a fold that should happen never
            // triggers because the centre never reaches the edge.
            if (favoured !== 0 && this.foldEconomyGate) {
                const heard = heardCounts(this.pcWindow, this.curOnsetPcs);
                if (heard.total) {
                    const costAt = (c: number) => costAtCounts(heard.counts, c);
                    if (costAt(cFrame + favoured) > costAt(cFrame)) favoured = 0;   // target dearer ⇒ veto
                }
            }
        } else {
            // Accidental economy over every raw pc heard across the window (repeats kept, so a
            // key-defining note pulls harder for free). Fold toward a comma-neighbour that notates it
            // cheaper, unless a near-chromatic window (no clear key) vetoes the vote.
            const heard = heardCounts(this.pcWindow, this.curOnsetPcs);
            if (heard.total === 0) return;
            const vetoed = this.foldMaxChroma > 0 && heard.counts.filter(k => k > 0).length > this.foldMaxChroma;
            const costAt = (c: number) => costAtCounts(heard.counts, c, this.signature);
            const here = costAt(cFrame);
            const up = costAt(cFrame + COMMA), dn = costAt(cFrame - COMMA);
            if (up < here - this.foldMargin && up <= dn) favoured = +COMMA;
            else if (dn < here - this.foldMargin) favoured = -COMMA;
            if (vetoed) favoured = 0;
        }

        // Debounce: a direction must stay favoured for D consecutive onsets before it fires; resetting the
        // count after a fold also blocks an immediate fold-back (the ping-pong), so no cooldown is needed.
        if (favoured !== 0 && favoured === this.pendingDir) this.pendingCount++;
        else { this.pendingDir = favoured; this.pendingCount = favoured === 0 ? 0 : 1; }
        if (favoured === 0 || this.pendingCount < this.foldDebounce) return;
        this.pendingDir = 0; this.pendingCount = 0;

        const newCentre = cFrame + favoured;
        for (let s = 0; s < 7; s++) this.scale[s] = letterAt(s, newCentre);
    }

    /**
     * The diatonic-collection anchor. Take the recent committed line-of-fifths, find its median, DROP the
     * alterations (anything more than 3 fifths off, the raised/lowered degrees), and re-take the median
     * of the remaining diatonic CORE. That "un-alter to reveal the diatonic" step stops a run of chromatic
     * raises (a leading tone, a tonicisation) from dragging the centre sharp. The result is the collection's
     * line-of-fifths centre: a frameless, emergent local key-centre (no key is ever detected).
     */
    /**
     * The principled frame centre ('diatonic' mode): the diatonic COLLECTION as one contiguous 7-fifth
     * segment centred at the returned line-of-fifths position (tonic + 2). Chosen by COVERAGE over the
     * recent RAW pitch classes, recency-weighted (half-life {@link frameHalfLife}), anti-poison (never the
     * speller's own spellings), so it fixes the collection without lag or drift. The comma (SIDE) is the
     * spiral: among the equal-best-coverage commas, take the one nearest the held frame (continuity), with a
     * hard barrier past the writable band [foldCenter ± foldRadius] (the fold). Hysteresis holds the current
     * collection unless a rival's coverage beats it by more than {@link frameMargin}. One number, no drift.
     */
    /** The frame's evidence: the recency-weighted raw-pc histogram over the frame window. The current onset
     *  weighs 1, each older onset × decay^age (half-life {@link frameHalfLife}). Raw pcs, never our spellings. */
    private frameCounts(): number[] {
        const decay = Math.pow(0.5, 1 / this.frameHalfLife);
        const counts = new Array(12).fill(0);
        let w = 1;
        for (const pc of this.curOnsetPcs) counts[pc] += w;
        for (let j = this.pcWindow.length - 1; j >= 0; j--) { w *= decay; for (const pc of this.pcWindow[j]!) counts[pc] += w; }
        return counts;
    }

    /** MINOR COLLECTION ({@link minorLeadingTone}): put the relative minor's raised 7th in its slot when the
     *  frame's collection is heard as that minor, the slot still holds the frame's own ♭7, and the ♭7 is not
     *  sounding. The minor reading: the caller's local key, else the two tonic triads on the frame's evidence. */
    private raiseMinorLeadingTone(midi: number): void {
        const c = this.frameCentre, flat7 = c - 1, lt = c + 6, s = letter(lt);
        if (this.scale[s] !== flat7) return;   // a kept alteration already holds the slot
        const t = pitchClass(c + 1), T = pitchClass(c - 2);   // minor and major tonics
        const k = this.curOnsetKey.get(midi);
        let minor: boolean;
        if (k) minor = k.minor && k.tonic === t;
        else {
            const h = this.frameCounts();
            minor = h[t]! + h[(t + 3) % 12]! + h[(t + 7) % 12]! > h[T]! + h[(T + 4) % 12]! + h[(T + 7) % 12]!;
        }
        if (!minor) return;
        for (const m of this.active.keys()) if (((m % 12) + 12) % 12 === pitchClass(flat7)) return;
        this.scale[s] = lt;
    }

    private computeFrameCentre(): number {
        // Recency-weighted raw-pc histogram over the frame window: the current onset weighs 1, each older
        // onset × decay^age (half-life {@link frameHalfLife}). Anti-poison: raw pcs, never our own spellings.
        const counts = this.frameCounts();
        let total = 0; for (const c of counts) total += c;
        if (total === 0) return this.frameCentre;
        // Coverage of the 7-fifth collection centred at c (recency-weighted mass of its pitch classes).
        const coverage = (c: number): number => { let s = 0; for (let i = -3; i <= 3; i++) s += counts[(((7 * (c + i)) % 12) + 12) % 12]!; return s; };
        const prev = this.frameCentre;
        // SIDE anchor for the spiral: 'drift' follows the recent committed notes' median LoF (the side the
        // music has been notated on); 'continuity' (default) holds the previous comma.
        const anchor = (this.frameSide === 'drift' && this.committedLof.length) ? this.median(this.committedLof) : prev;
        // THE SPIRAL: pick the max-coverage collection, place its comma nearest the anchor (continuity),
        // clamped to the writable range [foldCenter ± foldRadius] (a hard barrier = the fold). A collection
        // hysteresis (frameMargin) holds the held comma unless a rival collection covers more than the margin.
        const sideCost = (c: number) => Math.abs(c - anchor) + 1000 * Math.max(0, Math.abs(c - this.foldCenter) - this.foldRadius);
        let bestC = prev, bestCov = -1, bestSide = Infinity;
        for (let c = prev - 12; c <= prev + 12; c++) {
            const cov = coverage(c), sc = sideCost(c);
            if (cov > bestCov || (cov === bestCov && sc < bestSide)) { bestCov = cov; bestC = c; bestSide = sc; }
        }
        if (coverage(prev) >= bestCov - this.frameMargin && sideCost(prev) <= bestSide) return prev;
        // SEVEN-ACCIDENTAL TWIN ({@link frameTwin}): a move to a NEW collection (not a comma shift of the held one)
        // whose placement needs seven or more accidentals (|tonic| ≥ 7) takes the twin a comma away when the twin
        // needs five or fewer. A supplied signature names the side itself, so the rule is off then.
        if (this.frameTwin && this.signedKey === null && (((bestC - prev) % 12) + 12) % 12 !== 0) {
            const tonic = bestC - 2;
            if (Math.abs(tonic) >= 7) { const twin = bestC - 12 * Math.sign(tonic); if (Math.abs(twin - 2) <= 5) return twin; }
        }
        return bestC;
    }

    private diatonicAnchor(): number {
        const w = this.committedLof;
        if (w.length === 0) return this.anchor;
        const m0 = this.median(w);
        const core = w.filter(v => Math.abs(v - m0) <= 3);   // within a diatonic span of the centre
        return core.length ? this.median(core) : m0;
    }

    private median(v: number[]): number {
        const s = v.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)]!;
    }

    /** Re-fit the diatonic collection (display) to recent commits: a contiguous 7-fifth window [k−3, k+3]
     *  whose centre covers the most recent commits, moved only when a rival strictly covers more (hysteresis). */
    private updateCollection(): void {
        const w = this.committedLof;
        if (w.length === 0) return;
        const lo = Math.min(...w), hi = Math.max(...w);
        const cover = (k: number) => w.reduce((n, v) => n + (v >= k - 3 && v <= k + 3 ? 1 : 0), 0);
        let bestK = this.collectionCentre, bestCov = cover(this.collectionCentre);
        for (let k = lo + 3; k <= hi + 3; k++) {
            const cov = cover(k);
            if (cov > bestCov || (cov === bestCov && Math.abs(k - this.collectionCentre) < Math.abs(bestK - this.collectionCentre))) { bestK = k; bestCov = cov; }
        }
        if (bestCov > cover(this.collectionCentre)) this.collectionCentre = bestK;
    }

    /** The spelling of a sounding note (its committed one), else the scale's current spelling of it. */
    getSpelling(midi: number): Pitch | null {
        const n = this.active.get(midi)
            ?? LETTER_ORDER.map(s => this.scale[s]!).find(m => pitchClass(m) === ((midi % 12) + 12) % 12);
        return n === undefined ? null : pitchAt(spellingOf(n), midi);
    }

    /** One spelling per pitch class: drop held alterations (kept or pending) that spell `n`'s pitch class on
     *  another letter, unless that note is still sounding, and return their letters to the collection. */
    private evictSamePc(n: number): void {
        if (!this.keepAliveOnePc) return;
        const pc = pitchClass(n);
        const sounding = new Set(this.active.values());
        for (const [s, k] of [...this.kept]) {
            if (s === letter(n) || pitchClass(k) !== pc || sounding.has(k)) continue;
            this.kept.delete(s);
            this.scale[s] = letterAt(s, this.frameCentre);
        }
        for (const [m, p] of [...this.pending]) {
            if (letter(p.n) === letter(n) || pitchClass(p.n) !== pc || sounding.has(p.n)) continue;
            this.pending.delete(m);
            this.scale[letter(p.n)] = letterAt(letter(p.n), this.frameCentre);
        }
    }

    /** Keep a chromatic alive in its letter's slot, unless a later commit has since respelled that letter. */
    private keep(n: number): void {
        const last = this.lastByLetter[letter(n)];
        if (!last || last.n === n) this.kept.set(letter(n), n);
    }

    noteOff(midi: number, t?: number): void {
        if (this.deadPairs.size) for (const k of [...this.deadPairs]) { const [a, b] = k.split(':').map(Number); if (a === midi || b === midi) this.deadPairs.delete(k); }
        const p = this.pending.get(midi);
        if (p) {
            this.pending.delete(midi);
            if (t === undefined || t - p.t >= this.ornamentMs) this.keep(p.n);
        }
        const c = (this.held.get(midi) ?? 1) - 1;
        if (c > 0) this.held.set(midi, c);
        else { this.held.delete(midi); this.active.delete(midi); }
    }

    /**
     * Re-seed the frame. No-arg / empty-scale clears all state to a cold C-major start. A scale of
     * pitch classes seeds the matching letter slots (a soft key-signature hint); other letters keep
     * their natural. The engine has no hard pin (the frame is always free to drift), so `hard` is
     * accepted for API compatibility but treated the same as a soft seed.
     */
    reset(scale: readonly PitchClass[] = [], _hard = false): void {
        this.scale = [...C_MAJOR];
        for (const pc of scale) { const n = lofOf(pc); this.scale[letter(n)] = n; }
        this.active.clear();
        this.held.clear();
        this.lastByLetter = [];
        this.onset = -1;
        this.lastT = NaN;
        this.pcWindow = [];
        this.curOnsetPcs = [];
        this.curOnsetMidis.clear();
        this.curOnsetT.clear();
        this.curOnsetDirs.clear();
        this.curOnsetExact.clear();
        this.pending.clear();
        this.pendingDir = 0;
        this.pendingCount = 0;
        this.committedLof = [];
        this.anchor = 1;
        this.collectionCentre = 2;
        this.foldCentre = 2;
        this.frameCentre = 2;
        this.kept.clear();
        this.deadPairs.clear();
        this.lastCommit = null;
        this.lastDecision = null;
    }

    /**
     * Re-centre the spiral CLAMP fold basin on a supplied key mid-stream, WITHOUT wiping the running
     * memory, for a notated key-signature change (a modulation, or a new piece in a concatenation). The
     * clamp deadzone moves to the key's diatonic mean (foldCenter = keyTonic + 2), so the next few onsets
     * fold the frame onto the new side instead of clinging to the old one. `keyTonic` is the signed
     * line-of-fifths of the MAJOR tonic (minor: its relative major; C=0, G=+1, F=−1, D♭=−5, …). Only the
     * CLAMP fold reads foldCenter, so this is inert under the economy fold / fold `'off'`. Call `reset`
     * instead when the boundary is a hard restart that should also clear the frame and side memory.
     */
    setKey(keyTonic: number): void { this.foldCenter = keyTonic + 2; }

    /** The supplied key signature ({@link keySignature}), null for none; a supplied one outranks the first inferred
     *  side key. */
    private signedKey: number | null = null;

    /**
     * A supplied KEY SIGNATURE (the Speller's `keyTonic` and `setKey`): the signature names the collection until the
     * music contradicts it. Re-centres the fold basin as {@link setKey} does and, in the diatonic frame, makes the
     * signature's collection the held frame: the notes heard before it are not evidence against it, so the frame's
     * raw-pc evidence restarts from the signature, and the frame leaves it only when the notes after it out-cover it
     * (the frame's usual hysteresis). A note with no context therefore takes the signature's spelling, and after a
     * change, the new signature's. Alterations held over the old collection are pulled back, as on any collection
     * move; sounding notes keep their committed spelling, and the voice memory (recency guard) is kept. Under the
     * mean frame it seeds the slots before the first note (the old `reset(collectionAt)` seed) and is otherwise
     * {@link setKey}. Restating the current signature changes nothing. `keyTonic` as in {@link setKey}.
     *
     * Keyless runs never call it. (The seed in {@link reset} and in the first {@link sideKey} call does not reach the
     * diatonic frame, whose centre `reset` puts back at C: a known gap, left as is because keyless look-ahead runs
     * through it.)
     */
    keySignature(keyTonic: number): void {
        this.setKey(keyTonic);
        if (keyTonic === this.signedKey) return;   // the same signature restated is not a new one
        this.signedKey = keyTonic;
        const c = Math.round(keyTonic) + 2;   // the frame's centre is a whole position on the line of fifths
        if (this.frameMode !== 'diatonic') { if (this.onset < 0) this.reset(collectionAt(c)); return; }
        this.frameCentre = c;
        this.foldCentre = c;
        this.collectionCentre = c;
        this.anchor = c;
        for (let s = 0; s < 7; s++) this.scale[s] = letterAt(s, c);
        this.kept.clear();
        this.pending.clear();
        this.pcWindow = [];
        this.curOnsetPcs = [];
    }

    /** The key signature the ECONOMY fold counts accidentals from: its relative-major tonic on the line of
     *  fifths (0 = C, the default count). */
    private signature = 0;
    /**
     * Set the key signature the ECONOMY fold counts accidentals from (`keyTonic` as in {@link setKey}: the
     * relative major's tonic on the line of fifths, 0 = C). The two-pass tier calls it before each note-on with
     * the note's offline local key (`TwoPassOptions.keySide`). Inert under the clamp fold and fold `'off'`.
     */
    setSignature(keyTonic: number): void { this.signature = keyTonic; }

    /** Key → side state: whether a side key has been seen, and the last one applied (NaN: the raw tie). */
    private sideStarted = false;
    private sideX: number | null = null;

    /**
     * KEY → SIDE (look-ahead): call before each note-on with the note's side key (`NoteContext.sideKey`, from
     * `sideKeys`): the local key's relative-major tonic on the line of fifths, NaN for the F♯/G♭ tie, null for
     * none. The first call seeds the frame on that key when no note has sounded yet (the `keyTonic` start; a
     * tie seeds the sharp side). After that, a key that differs from the last one re-centres the fold
     * ({@link setKey}). A tie takes the side (F♯ or G♭ major) nearer the current surface's mean.
     *
     * A key the caller gives outranks the speller's own key estimate ON THE SIDE: once a signature is supplied
     * ({@link keySignature}), an inferred key that has a conventional reading (at most 7 accidentals, or past seven
     * within one fifth of the signature: G♯ major under seven sharps) one comma nearer the signature takes that
     * reading: C♯ major (+7) under five flats is D♭ major (−5), where the inferred +7 used to fold the frame back
     * to sharps one note after the signature placed it (Chopin Op. 28/15 m77). The key itself still comes from the
     * notes: a modulation the signature does not name (F minor under four sharps, Grieg's Morning Mood m38) still
     * re-centres the fold. A tie keeps the inferred reading.
     */
    sideKey(x: number | null): void {
        if (!this.sideStarted) {
            this.sideStarted = true;
            // A supplied signature already seeded the start; the inferred side key does not replace it.
            if (x !== null && this.signedKey === null) {
                const kt = Number.isNaN(x) ? 6 : x;
                this.setKey(kt);
                if (this.onset < 0) this.reset(collectionAt(kt + 2));
            }
            this.sideX = x;
        }
        if (x === null) return;
        if (Number.isNaN(x)) {
            const sc = this.getResolvedScale();
            const mean = sc.reduce((a, p) => a + lofOf(p), 0) / sc.length;
            x = Math.abs(6 + 2 - mean) <= Math.abs(-6 + 2 - mean) ? 6 : -6;
        }
        // A supplied signature picks the comma of the inferred key (variant B, chosen 15 Nov 2026).
        // The alternative, variant A (once a signature is supplied, ignore the inferred side key altogether), is
        // better for stitched pieces and sets with many keys inside one input: there each new signature arrives
        // while the inferred key still lags the previous piece by up to its 96-onset window, and when that lagging
        // key has no conventional reading near the new signature, B lets it re-centre the fold and A does not
        // (start of the WTC 1 C♯-major prelude after C-minor material: inferred −3/−4, and +8/+9 is not allowed).
        // Keyed look-ahead (lab tools/probe/_keyhint_bench.ts), no fix → A → B: all 60 fixtures wrong
        // 3,078 → 2,853 → 2,978, flipped 21,802 → 2,200 → 2,335 (the A-over-B gap is WTC 1/2 and the glued Chopin
        // waltzes); Meredith clean wrong 224 → 219 → 224. B was chosen because A breaks every modulation the
        // signature does not name: Grieg's Morning Mood m38, an F-major area under four sharps, drifts to
        // B♯ E♯ G𝄪 (749 notes). On the 50 single pieces B wins every metric: exact 97.47 → 97.64 → 98.27%,
        // flipped 2,090 → 1,878 → 937, wrong 1,696 → 1,659 → 1,656.
        // A reading past seven accidentals counts when it is within one fifth of the signature, as in the two-pass
        // anchor (`anchoredSideKeys`): under seven sharps the dominant G♯ major (+8) is G♯, not A♭ (−4). Farther from
        // the signature the seven-accidental limit stands (A♭ major under four sharps stays A♭, not G♯).
        const sig = this.signedKey;
        const allowed = (c: number) => Math.abs(c) <= 7 || Math.abs(c - sig!) <= SIGNATURE_NEIGHBOURHOOD;
        if (sig !== null) for (const c of [x + 12, x - 12]) if (allowed(c) && Math.abs(c - sig) < Math.abs(x - sig)) x = c;
        if (x !== this.sideX) { this.setKey(x); this.sideX = x; }
    }

    /** Read-only snapshot of the current 7-letter surface (introspection). The diatonic frame rebuilds the
     *  slots at the start of each note and writes nothing at its commit, so the note just committed is
     *  laid over its letter's slot here: the surface includes it. (The mean frame writes the slot itself.) */
    getResolvedScale(): PitchClass[] {
        const slots = [...this.scale];
        if (this.frameMode === 'diatonic' && this.lastCommit !== null) slots[letter(this.lastCommit)] = this.lastCommit;
        return LETTER_ORDER.map(s => spellingOf(slots[s]!));
    }

    /** The diatonic collection's line-of-fifths centre (leash display; a major collection is centred at
     *  tonic + 2, so the implied major tonic = this − 2). Meaningful only when the leash is enabled. */
    getAnchor(): number { return this.collectionCentre; }

    /** The line-of-fifths centre the clamp fold actually tests (the slot mean after recency + repair). The
     *  fold's tonic is this − 2. Reflects the shipped default unless recency drops slots or repair is on. */
    getFoldCentre(): number { return this.foldCentre; }

    /** The 7-letter diatonic COLLECTION: the un-altered substrate, each letter spelled within the current
     *  collection window. The stable "frame" against the altered surface (leash display). */
    getCollection(): PitchClass[] { return collectionAt(this.collectionCentre); }

    /** The most recent note's scoring trace (introspection / visualiser), or null before the first note.
     *  Read-only; recording it never changes a spelling. */
    decision(): Decision | null { return this.lastDecision; }
}
