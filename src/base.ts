/**
 * DiatonicBaseSubstrate — the reverting, time-windowed frame model (diatonic lineage).
 *
 * A structurally different memory model from {@link PersistentSubstrate}: rather
 * than one drifting scale, the surface is REBUILT every note as
 *
 *     bare diatonic base  +  (keep-alive)  +  the notes still sounding
 *
 * The frame is the diatonic COLLECTION (one of the 12 circle-of-fifths windows)
 * that leaves the fewest recently-sounding raw pitch classes outside it, held
 * with a hysteresis margin — non-circular, it reads MIDI numbers never the
 * speller's own decisions. A chromatic rides on top only while it sounds and its
 * slot reverts the moment it releases, so nothing accumulates.
 *
 * Two composable options reproduce the two standalone spellers byte-for-byte:
 *   - off                 ≡ DiatonicSpeller       (pure revert-and-overlay)
 *   - `keepAlive` (+cap)  ≡ DiatonicAnchorSpeller (a played chromatic stays in
 *     its slot until contradicted; capped to avoid runaway drift)
 *   - `lookAhead`         the opt-in leading-tone resolution bias, fed via
 *     NoteContext.resolveDir (the kernel/driver computes it).
 *
 * The frame is time-windowed, so it reads a clock: NoteContext.t when supplied
 * (batch / deterministic replay), else the injected `clock` (default Date.now).
 */

import { LETTER_BASE, type Letter, type PitchClass } from './pitch.js';
import { rawIntervalBetween, lineOfFifths } from './interval.js';
import { intervalBufferScore, intervalScore } from './scoring.js';
import type { NoteContext, ScoredCandidate, Substrate, SubstrateTrace } from './kernel.js';

/** Which post-score mechanism (if any) moved the pick off the frame's argmax, for the viz decision trace. */
export type DecisionOverride =
    | 'none' | 'lookahead-vertical-gate' | 'lookahead-coherence-gate' | 'sounding-tiebreak' | 'rel-minor-lt';
/** One enharmonic candidate as scored at decision time: base frame score + the additive look-ahead /
 *  neighbour-step deltas the commit loop applied. `base + laDelta + nsDelta` is the argmax key. */
export interface DecisionCandidate { readonly c: PitchClass; readonly base: number; readonly laDelta: number; readonly nsDelta: number; }
/** A full record of one commit decision — VIZ-ONLY instrumentation (populated only when the `trace`
 *  option is on, which no shipped preset sets). Read-only; recording it never changes a spelling. */
export interface DecisionTrace {
    readonly frame: PitchClass[];              // LETTERS-order surface the candidates were scored against
    readonly candidates: DecisionCandidate[];  // enharmonicCandidatesFor order
    readonly chosen: PitchClass;
    readonly override: DecisionOverride;        // what (if anything) overrode the base-frame argmax
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const satisfies readonly Letter[];
const SHARPEN_ORDER: readonly Letter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLATTEN_ORDER: readonly Letter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const KEYSIG_SHARPS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];
const DIATONIC_DEGREES = [0, 2, 4, 5, 7, 9, 11];

const pcVal = (p: PitchClass): number => ((LETTER_BASE[p.step] + p.alter) % 12 + 12) % 12;
const inDiatonic = (pc: number, relMajorPc: number): boolean =>
    DIATONIC_DEGREES.includes(((pc - relMajorPc) % 12 + 12) % 12);

/** A spelled interval between two co-ringing pitch classes is a "wolf" when augmented or diminished —
 *  EXCEPT the tritone (A4/d5), which both enharmonic sides spell as aug/dim and so is uninformative.
 *  quality is signed: 0=P, ±1=M/m, ±2=A/d. Mirrors substrate-heptatonic's `isVertWolf`. */
function isVertWolf(a: PitchClass, b: PitchClass): boolean {
    const { quality, number } = rawIntervalBetween(a, b);
    if (Math.abs(quality) < 2) return false;
    const sn = ((number - 1) % 7) + 1;
    if ((sn === 4 && quality === 2) || (sn === 5 && quality === -2)) return false;   // tritone
    return true;
}
/** How many of `ctx` a candidate `c` forms a wolf with (aug/dim excl. tritone). */
function wolfCount(c: PitchClass, ctx: readonly PitchClass[]): number {
    let n = 0; for (const x of ctx) if (isVertWolf(c, x)) n++; return n;
}

/** Build a major scale from a SIGNED key-signature count (−7…+7): >0 sharpens, <0 flattens.
 *  |sharps| up to 7 stays single-accidental (7 flats = Cb major, 7 sharps = C♯ major). */
function majorScaleForSharps(sharps: number): Map<Letter, PitchClass> {
    const scale = new Map<Letter, PitchClass>();
    for (const L of LETTERS) scale.set(L, { step: L, alter: 0 });
    if (sharps > 0) for (let i = 0; i < sharps; i++) scale.set(SHARPEN_ORDER[i]!, { step: SHARPEN_ORDER[i]!, alter: 1 });
    else for (let i = 0; i < -sharps; i++) scale.set(FLATTEN_ORDER[i]!, { step: FLATTEN_ORDER[i]!, alter: -1 });
    return scale;
}

function majorScaleForTonic(relMajorPc: number): Map<Letter, PitchClass> {
    return majorScaleForSharps(KEYSIG_SHARPS[relMajorPc]!);
}

// --- SPIRAL frame orientation (the line-of-fifths model) --------------------------------------
// The frame's KEY is a SIGNED position on the line of fifths, not a mod-12 pc, so D♭(−5) and C♯(+7)
// are DISTINCT positions. A collection is rendered at the LoF tonic reached by CONTINUITY (the nearest
// enharmonic of the held tonic) — so an adjacent-key move keeps one side (F♯→C♯, not F♯→D♭), digging
// smoothly along the spiral instead of flipping the whole spelling every fifth. Deepenings (G♯=+8,
// F♭=−8) are reachable only by WALKING from an adjacent held position; a cold start takes a writable
// key (`bestColdTonic`). SPIRAL_RANGE caps the dig: past it, the only in-range orientation is the
// enharmonic on the other side, so continuity FOLDS BACK rather than ratchet into F♭♭/E𝄪 — realising
// "if we dig too far it may respell" (F♭ at −8 is KEPT; the fold happens only beyond it).
const LETTER_LOF: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const LOF_TO_LETTER: Record<number, Letter> = { 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F' };
// The deepest single spelling allowed is the `spiralRange` option (default/floor 6, up to 8 = G♯=+8 /
// F♭=−8; realistic keys are ±7); the comments below say "SPIRAL_RANGE" for that per-instance cap.
const COLD_RANGE = 7;     // a fresh start lands in a writable key: C♭(−7) … C♯(+7), never a deepening.

/** Spell the pitch at signed line-of-fifths position `p` (…F=−1, C=0, G=1…, F♯=+6, C♯=+7, G♯=+8…). */
function spellFromLof(p: number): PitchClass {
    const L = LOF_TO_LETTER[((p % 7) + 7) % 7]!;
    return { step: L, alter: Math.round((p - LETTER_LOF[L]) / 7) as PitchClass['alter'] };
}
/** The 7-letter major scale whose tonic sits at LoF position `t` (spans the fifths [t−1 … t+5]). */
function lofMajorScale(t: number): Map<Letter, PitchClass> {
    const m = new Map<Letter, PitchClass>();
    for (let p = t - 1; p <= t + 5; p++) { const sp = spellFromLof(p); m.set(sp.step, sp); }
    return m;
}
/** For each relative-major pc, the signed tonics in [−range, range] that spell it (seam pcs have 2),
 *  cached per range. Minimum valid range is 6 — pc 6 (F♯/G♭) has no shallower spelling. Lowering the
 *  range removes the DEEP enharmonics (C♯=+7, C♭=−7, G♯=+8…), forcing those pcs to their shallow
 *  minimal-accidental side — i.e. hugging the 12-key convention (fewer flips, less digging headroom). */
const SPIRAL_ORIENTS_CACHE = new Map<string, Map<number, number[]>>();
function spiralOrientsFor(range: number, center: number): Map<number, number[]> {
    const key = `${range},${center}`;
    let m = SPIRAL_ORIENTS_CACHE.get(key);
    if (!m) {
        m = new Map();
        for (let pc = 0; pc < 12; pc++) { const ts: number[] = []; for (let t = center - range; t <= center + range; t++) if (pcVal(spellFromLof(t)) === pc) ts.push(t); m.set(pc, ts); }
        SPIRAL_ORIENTS_CACHE.set(key, m);
    }
    return m;
}
/** Pick the LoF tonic for collection `pc`: nearest the HELD tonic (continuity/dig), then nearest the
 *  writability CENTER (default 0 = C; a positive center biases toward the sharp side), then the
 *  conventional minimal-accidental reading when cold (held === null). */
function spiralOrient(pc: number, held: number | null, range: number, center: number): number {
    const cands = spiralOrientsFor(range, center).get(pc)!;
    if (cands.length === 1) return cands[0]!;
    if (held === null) return [...cands].sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || (a === KEYSIG_SHARPS[pc] ? -1 : 1))[0]!;
    return [...cands].sort((a, b) => Math.abs(a - held) - Math.abs(b - held) || Math.abs(a - center) - Math.abs(b - center))[0]!;
}
/** Diatonic pc-set of the writable collection at each cold tonic, for the cold-start containment test
 *  (precomputed wide so a shifted center's window stays in bounds). */
const COLD_PCSET = new Map<number, Set<number>>();
for (let t = -13; t <= 13; t++) {
    const set = new Set<number>();
    for (let p = t - 1; p <= t + 5; p++) set.add(pcVal(spellFromLof(p)));
    COLD_PCSET.set(t, set);
}
/** Cold-start tonic: the SHALLOWEST writable collection (|t| smallest) containing the most recent pcs.
 *  Containment alone flips D♭→C♯ once a pc only the sharp side spells cleanly arrives; |t| breaks ties;
 *  and a remaining |t| tie (only the antipode F♯=+6 / G♭=−6) breaks toward the CONVENTIONAL side
 *  (`KEYSIG_SHARPS` — F♯), so a cold F♯-major start doesn't arbitrarily land on G♭. */
function bestColdTonic(pcs: readonly number[], coldRange: number, center: number): number {
    let best = center, bestOut = Number.POSITIVE_INFINITY, bestAbs = Number.POSITIVE_INFINITY, bestConv = false;
    for (let t = center - coldRange; t <= center + coldRange; t++) {
        const set = COLD_PCSET.get(t)!;
        let out = 0; for (const pc of pcs) if (!set.has(pc)) out++;
        const conv = t === KEYSIG_SHARPS[pcVal(spellFromLof(t))];
        const better = out < bestOut
            || (out === bestOut && Math.abs(t - center) < bestAbs)
            || (out === bestOut && Math.abs(t - center) === bestAbs && conv && !bestConv);
        if (better) { bestOut = out; bestAbs = Math.abs(t - center); bestConv = conv; best = t; }
    }
    return best;
}

// KNOB SENSITIVITY IS MEASURED — see docs/mechanism-ablation.md before tuning any of these. Under the
// coherence scorer only keepAlive (the wrong-lever) and keepAliveCap≈3 materially move accuracy; the diatonic
// base itself is a FLIP-lever (holds orientation, ~neutral on wrong); baseMargin / keepAliveEvict /
// baseWindowMs are ~washes. Falsified experiment flags were removed (paper presets never used them).
// Run `npx tsx tools/benchmark/ablate.ts --meredith` to reproduce. Don't re-walk these.
export interface DiatonicBaseSubstrateOptions {
    clock?: () => number;
    baseWindowMs?: number;
    baseMargin?: number;
    lookAhead?: boolean;
    lookAheadWeight?: number;
    /** How the look-ahead tips a resolving note (default 'sign'):
     *  - 'sign'    : boost by resolveDir·sign(alter) — the original; BLIND to a natural competitor
     *                (E♯-vs-F, B♯-vs-C), since sign(0)=0, so a mis-spelled natural leading tone wins.
     *  - 'letter'  : letter-aware — a semitone resolution is a diatonic STEP (E♯→F♯ is E→F), so boost
     *                the candidate whose LETTER is one step toward the frame's target spelling and
     *                penalise the SAME-letter spelling (F→F♯ is an augmented unison, not a step).
     *  - 'samepen' : 'sign' boost PLUS the same-letter penalty (the minimal patch over 'sign'). */
    lookAheadMode?: 'sign' | 'letter' | 'samepen';
    /** VERTICAL GATE for the look-ahead (default off; needs {@link lookAhead}). The look-ahead is a
     *  TENDENCY (where the note resolves); the co-onset struck chord is DISPOSITIVE (what's sounding).
     *  When the frame's base (pre-look-ahead) pick is ALREADY vertically coherent with the co-onset
     *  committed notes — forms no wolf (aug/dim excl. tritone) with any of them — the vertical has
     *  decided, so the look-ahead is SUPPRESSED for this note: it must not respell a coherent chord
     *  tone / leading tone just because it sits next to a semitone step. The look-ahead still fires when
     *  the base pick is vertically INCOHERENT (a wolf, e.g. a C♯–F dim4 that wants E♯) — that is the
     *  ambiguity it exists to fix. Targeted, unlike sounding-tiebreak (which lets the chord DECIDE and
     *  regresses on a look-ahead base): this only WITHHOLDS the look-ahead, never overrides the pick. */
    lookAheadVerticalGate?: boolean;
    /** LOOK-AHEAD COHERENCE GATE (experimental, default off; spiral only). The look-ahead names the LETTER
     *  of a resolving note (the diatonic step into its resolution) — that is a WITHIN-side refinement. But
     *  the look-ahead WEIGHT is a global scalar, and when it is strong enough it also flips the note's SIDE,
     *  dragging it off a coherently-oriented passage (the bach_wtc1 idx3465 F♯-in-a-B♭-minor-passage
     *  straggler). The SIDE is owned by the frame, not the resolution. So: if the look-ahead moved the pick
     *  to a spelling FARTHER (on the line of fifths) from the frame's LoF tonic than the look-ahead-suppressed
     *  pick, revert — the resolution may refine the letter or pull toward the centre, never drag a note away
     *  from the passage's orientation. Sibling of {@link lookAheadVerticalGate} (vertical dissonance); this is
     *  the horizontal/side-coherence half. Withholds the look-ahead, never invents a new pick. */
    lookAheadCoherenceGate?: boolean;
    /** Recent-commit window (# of prior commits) whose MEDIAN line-of-fifths is the coherence reference for
     *  {@link lookAheadCoherenceGate}. Default 12 (~ the look-ahead horizon). A structural context size, not
     *  a fitted weight — the gate decision itself is threshold-free (farther-or-not). */
    lookAheadCoherenceWindow?: number;
    frameSoftMargin?: number;
    /** SUPPLIED-KEY (key-signature) anchor margin — WITH-KEYS mode only (default: falls back to
     *  {@link frameSoftMargin}, so byte-identical when unset). A `reset(scale)` from a key-signature/respell
     *  event stores that collection as a SOFT anchor; each onset the frame keeps it only while
     *  `outside(key) <= bestOut + margin`, else the raw-pitch-class argmin overrides it. With the default
     *  margin (18) a chromatic tonicization inside the span (Bach's WTC1 C♯-major fugue tonicizing A♯m)
     *  drifts the frame OFF the notated key onto a flat neighbour (D♭↔A♭ wobble), throwing away the side
     *  the signature gave us. A notated key signature is the composer NAMING the collection and its side, so
     *  a bigger margin here holds the frame ON the signature through internal tonicizations — and because
     *  the frame then equals `suppliedKey`, the render returns the signature's own SIGNED spelling
     *  (`suppliedFrame`: C♯ D♯ E♯…, not the minimal-accidental D♭). Set large (e.g. 999) to trust the
     *  signature until the next respell. The no-keys presets never set `suppliedKey`, so this is inert in
     *  the paper ladder (and in Meredith, which carries no key signatures). */
    suppliedKeyMargin?: number;
    /** Keep a played chromatic alive in its slot until contradicted (DiatonicSticky). */
    keepAlive?: boolean;
    /** Re-anchor cap: max simultaneously-kept slots before the layer is wiped. Default 3. */
    keepAliveCap?: number;
    /** What overflowing the cap does (default 'clear'):
     *  - 'clear'  : wipe ALL kept slots — resets the whole accumulated orientation (the original).
     *  - 'oldest' : evict only the OLDEST kept slot — bounded memory that KEEPS the orientation,
     *               so a long flipped passage stays internally coherent instead of flickering. */
    keepAliveEvict?: 'clear' | 'oldest';
    /** SPIRAL frame (default off): render the held collection from a SIGNED line-of-fifths tonic chosen
     *  by continuity (dig to the nearest enharmonic of the held tonic) with a writable cold start,
     *  instead of the fixed minimal-accidental table. The collection FINDER is unchanged — only the
     *  enharmonic SIDE of the rendering. Fixes the adjacent-window naming flip-flop (F♯↔D♭ every fifth)
     *  by keeping circle-of-fifths-adjacent windows on the same side.
     *  {@link spiralRange} caps the digging depth (default 6, hugging the 12-key minimal-accidental
     *  convention — fewest flips); raise it toward 8 for more coherence headroom at the cost of more flips.
     *
     *  This is the line-of-fifths model promoted from the viz research fork (`AccidentalTraced`) into
     *  the core: the KEY is a signed LoF position (D♭=−5 vs C♯=+7 are DISTINCT), a piece cold-starts on a
     *  writable key and DIGS deeper by continuity (an adjacent-key move keeps one side), folding back only
     *  past the SPIRAL_RANGE cap (F♭ at −8 is kept — the deep-flat Chopin case — the fold happens beyond it).
     *
     *  MEASURED 2026-08-12, real coherence scorer (raw + dedupeOnsets unique), FULL corpus, spiral OFF→ON,
     *  via `tools/probe/_spiralmeasure.ts` (also `_wtc2osc.ts` flip-flop, `_spiralreset.ts` per-piece reset):
     *
     *      rung2 anchor     wrong 1.696% → 1.592%  (−348)   flip 12430 → 31004 (+18574)
     *      rung3 anchor+LA  wrong 1.289% → 1.228%  (−206)   flip 12469 → 31048 (+18579)
     *      two-pass rung4   wrong 1.03%  → 1.045%          (WASH/slight regress — see below)
     *
     *  `wrong` drops on EVERY fixture but shostakovich_sq8_op110 (+20/+23). Held-out Meredith (single-key
     *  movements) is neutral-to-slightly-positive: anchor wrong 0.47→0.45, LA 0.31→0.31, tonal flat/up.
     *
     *  THE FLIP JUMP IS NOT A LOSS — it is the reframe of the old (deleted) signedOrient "13:1" verdict:
     *  under the comma-offset scorer a COHERENT flip is FREE (`flip`, not `wrong`), and CLAUDE.md states
     *  matching the composer's exact SIDE is not the goal. The spiral collapses the per-note flip-flop into
     *  one coherent side per section; `wrong` falls, `flip` rises. And that rise is ~88% a CONCATENATION
     *  ARTIFACT: 3 glued multi-piece fixtures — bach_wtc2 (14166), bach_wtc1 (8268), chopin_waltzes (5272) —
     *  are 88% of all flips; on genuine SINGLE pieces the flip is ~1pp (Meredith 0.2→1.2%). Streaming through
     *  a 24-piece stream and staying coherent across each abrupt key change — WITHOUT a reset signal — is the
     *  point, not a defect (a musician reads D♭-spelled C♯ major fine).
     *
     *  TWO OPEN LEVERS (why this is default-off pending more work):
     *  1. **SIDE, not coherence, is what remains.** The spiral makes each section coherent, so a section is
     *     now cleanly EITHER right-side (correct) OR wrong-side (a whole-section flip). It often lands the
     *     WRONG (but writable-minimal) side — the C♯ prelude cold-starts D♭ because 5♭ < Bach's 7♯. That is
     *     no longer a per-note problem: the OFFLINE two-pass (rung 4), holding the whole piece, could DETECT
     *     a uniformly-flipped section and FLIP THE ENTIRE SECTION back as one unit (preserving coherence).
     *     This is the natural successor to `docs/handoff-twopass-oscillation.md` — the spiral already
     *     collapsed the oscillation the handoff worried about; what's left is the section-level SIDE vote.
     *  2. **Two-pass currently does NOT benefit** (slight regress) — it already resolves boundary lag via
     *     forward+backward, so the spiral's cold-start side adds nothing until the section-flip (lever 1)
     *     exists. So a landing would enable spiral on the STREAMING rungs 2/3 only, not rung 4.
     *
     *  Wired but default-OFF: the four presets are unchanged (byte-identical goldens). The viz exposes it as
     *  the "🌀 spiral frame (LoF)" toggle on rungs 2/3/4 for inspection. See the memory
     *  `spiral-is-central-frame-model`. */
    spiral?: boolean;
    /** SPIRAL digging-depth cap (default 6, min 6). At 6 the deep enharmonics (C♯=+7, C♭=−7, G♯=+8…) are
     *  out of the vocabulary and those pcs snap to their shallow minimal-accidental side — hugging the
     *  conventional 12 keys (fewest flips). Raise toward 8 to allow deeper digging (more coherence, more
     *  flips). pc 6 (F♯/G♭) has no shallower spelling, so 6 is the floor. */
    spiralRange?: number;
    /** SPIRAL writability CENTER on the line of fifths (default +1 = a mild sharp nudge, the recommended
     *  value: it drops G♭ out of the range-6 window so the F♯/G♭ tritone key is always F♯, as Bach notates
     *  it). 0 = symmetric on C. A larger positive value biases further sharp — +2 pushes D♭(−5) out so
     *  pc 1 is C♯(+7), which over-sharpens real flat keys and craters. Negative biases flat. Shifts the
     *  cold-start, the tiebreak, AND the ±range window. */
    spiralCenter?: number;
    /** PARALLEL-FLIP THIRD GATE (default off; ON in the look-ahead presets — {@link createDiatonicAnchorLA}
     *  and the two-pass). The THIRD is dispositive for major vs minor; the raised 6th/7th are melodic-minor
     *  inflections that belong to the minor key, NOT evidence for the parallel major. So a frame flip between
     *  PARALLEL collections (the major and minor of ONE tonic — ±3 fifths apart on the LoF: C major↔C minor =
     *  collections 0↔3) is allowed only if the TARGET side's third is the DOMINANT third (to C major: E♮
     *  struck more than E♭; to C minor: E♭ more than E♮) — else the raised 6/7 of a melodic minor, or a
     *  passing chromatic, is spoofing the parallel flip. Surgical: it touches ONLY the ambiguous parallel
     *  case, never the general outside-count, so it perturbs no unrelated collection. Fixes bach_wtc1 m28
     *  (a cadential C-melodic-minor passage — E♭ present, E♮ absent, dense in the raised 6/7 A♮/B♮ — flipping
     *  the frame to C MAJOR even though E♮, what C major requires, never sounds). Self-correcting: the gate
     *  releases the instant the major third genuinely takes over, so a real parallel move still fires. On the
     *  look-ahead rungs (where the ♯7 is spelled sharp BY RESOLUTION) it composes cleanly — corpus wrong
     *  rung3 −154 / rung4 −47, flip −104 / −241; Meredith held-out neutral (±1). Needs look-ahead: on the
     *  no-LA rung 2 it regresses (the minor's ♯7 can't be spelled sharp without the resolution), so it is NOT
     *  in {@link BOX_FAMILY_DEFAULTS}. The two orthogonal primitives: THIRD → the collection, RESOLUTION → the
     *  ♯7's side. See the memory `frame-parallel-third-gate` / handoff-local-key-signals. */
    parallelThirdGate?: boolean;
    /** PREFER RELATIVE-MINOR LEADING TONE over the lowered tonic, gated on a SOUNDING DOMINANT. The pc
     *  `(relMajorPc+8)` is enharmonically the ♯7 of the relative minor — a leading tone (B in a
     *  C-minor/E♭ collection) — OR its ♭1, the LOWERED TONIC (C♭), which is over-rotation and virtually
     *  never notated. When the note is about to be committed as the ♭1 AND the relative-minor DOMINANT
     *  root `(relMajorPc+4)` is currently SOUNDING (a struck V under the note — the LT is its 3rd), this
     *  takes the ♯7 instead, OVERRIDING {@link soundingTiebreak} (whose pure-consonance vote wrongly
     *  prefers the ♭1: C♭ makes a consonant m3 with a sounding ♭6 where B makes a dissonant aug2). The
     *  rel-minor tonic is read from the COLLECTION ({@link baseCur}), NOT the noisy key tracker.
     *
     *  The gate is a VERTICAL DOMINANT, deliberately: a leading tone splits into a vertical regime (inside
     *  a struck V, spelling determinate now — this catches it) and a melodic/arpeggiated regime (no V
     *  struck with it — only the resolution disambiguates → {@link lookAhead}). The two are complementary,
     *  which is why this stacks with look-ahead. Looser gates (rel-minor tonic merely present, or dominant
     *  merely recent) let major-key ♭6 borrowings through — measured damage; the vertical simultaneity is
     *  what makes it clean. Default-ON in createDiatonicAnchor / …LA; OFF in the two-pass (rung 4), whose
     *  own backward pass is the better offline side-fixer (streaming gate washes-to-worse there, like the
     *  spiral). Held-out Meredith: rung2 clean −39 / noisy −109 wrong, rung3 −8 / −14, flip flat. */
    preferRelMinorLT?: boolean;
    /** HARD-PIN AUTO-RELEASE (default true, but VIZ-ONLY — inert in every preset). A manual frame
     *  override (`reset(scale, hard=true)`, the viz `Shift+A–G` / `frameOverrides` pin) sets
     *  {@link suppliedHard}, which otherwise forces the pinned collection for the REST of the piece —
     *  so a forced C on a fast modulator (grieg) never swings back to a later sharp region. With this
     *  on, once the AUTO best-fit collection strictly contains the music better than the pin
     *  (`bestOut < outside(pin)`) for {@link pinReleaseSustain} CONSECUTIVE onsets — sustained contrary
     *  evidence, not a one-onset flicker — the pin is dropped and the auto frame resumes. The presets
     *  never hard-pin (suppliedHard is only ever set via a viz override), so this is byte-identical to
     *  the old behaviour there (compose-golden stays green); it only changes the viz manual pin. Set
     *  false to restore the old hold-until-next-override pin. */
    pinAutoRelease?: boolean;
    /** Consecutive onsets the auto best-fit must strictly beat the hard pin before {@link pinAutoRelease}
     *  fires. Larger = the pin holds more firmly (a deliberate manual pin should resist transient
     *  chromaticism). Default 8. */
    pinReleaseSustain?: number;
    /** NEIGHBOUR-STEP (default off): a note a SEMITONE from the immediately-preceding same-voice note is
     *  usually a leading-tone/neighbour — a diatonic STEP (a different letter, F♯→E♯), not a same-letter
     *  augmented unison (F♯→F). Add +W to the step-letter candidate and −W to the same-letter candidate
     *  before the argmax. Same additive-in-commit pattern as the look-ahead. The "previous same-voice
     *  note" is a crude PROXY: the most-recent committed note strictly earlier, nearest in pitch, within
     *  |Δmidi| ≤ 4 and {@link neighbourWindowMs}. EXCEPTION — a CHROMATIC RUN ({@link neighbourRunGate}
     *  consecutive ±1 moves ending at prev): the note is a passing tone, the same-letter/direction
     *  spelling is correct (F♯→F→E♮), so suppress. Optional {@link neighbourVerticalGate} extra guard. */
    neighbourStep?: boolean;
    /** +W added to the step candidate, −W to the same-letter candidate. Default 2 (integer). */
    neighbourStepWeight?: number;
    /** Chromatic-run gate K: suppress the signal when ≥ K consecutive ±1 moves end at the previous note
     *  (a passing tone). Default 2. Set 0 to disable the gate (the single-axis, over-firing variant). */
    neighbourRunGate?: number;
    /** Time window (ms) for the same-voice proxy: prev must be within this of the current onset. Default 1500. */
    neighbourWindowMs?: number;
    /** VERTICAL-CONVERGENCE gate (default off): only apply the step reward when a CO-ONSET committed note
     *  (same t — a bass struck first) forms a strictly LESS-altered interval with the STEP spelling than
     *  with the same-letter spelling (step avoids an aug/dim the same-letter creates — C♯–E♯ M3 vs C♯–F
     *  d4). Uses {@link rawIntervalBetween}. */
    neighbourVerticalGate?: boolean;
    /** SOUNDING-TIEBREAK (default off): when the interval scorer against the full held frame is
     *  (near-)TIED between the two enharmonic candidates of a CHROMATIC note (neither candidate is in the
     *  frame collection), the full held scale can't decide — a B-minor scale supports BOTH A♯ ({C♯,F♯})
     *  and B♭ ({D,G}). Break the tie by re-scoring ONLY the tied candidates against a SHORT recency
     *  window of recently-struck notes (the chord/beat), NOT the full frame — an F♯7 arpeggio (recent F♯,
     *  no G) then reads as F♯7→A♯. Fires on the BASE frame score BEFORE any look-ahead adjustment, and
     *  OVERRIDES the look-ahead / neighbour pick when it fires (so it can undo an LA regression). If the
     *  recency re-score is also tied (the symmetric dim7 case, C♯°7), it falls back to candidate order. */
    soundingTiebreak?: boolean;
    /** Max base-score gap for the top-2 candidates to count as tied (default 0 = exact; try 1). */
    stEpsilon?: number;
    /** Recency window definition (default 'onsets'):
     *  - 'coonset' : co-onset committed notes only (same t);
     *  - 'recent'  : co-onset + notes struck within {@link stWindowMs};
     *  - 'last3'   : co-onset + the last 3 committed notes (any time);
     *  - 'onsets'  : the last {@link stBufferN} distinct committed spellings (any time). */
    stWindow?: 'coonset' | 'recent' | 'last3' | 'onsets';
    /** Number of distinct committed spellings in the onset-count tie buffer. Default 5. */
    stBufferN?: number;
    /** Time window (ms) for stWindow='recent'. Default 400. */
    stWindowMs?: number;
    /** VIZ-ONLY (default off): record a {@link DecisionTrace} on every commit (base scores + look-ahead /
     *  neighbour-step deltas + which override fired), readable via {@link DiatonicBaseSubstrate.decision}.
     *  Record-only — it never influences a spelling — so it is byte-identical to off in the presets, which
     *  never set it. The `viz/` debugger turns it on to render the per-candidate scoring table. */
    trace?: boolean;
}

export class DiatonicBaseSubstrate implements Substrate {
    private resolved = new Map<Letter, PitchClass>();
    private active = new Map<number, Letter>();
    private activeSpelling = new Map<number, PitchClass[]>();
    private framePcs: { pc: number; t: number }[] = [];
    private kept = new Map<Letter, PitchClass>();
    private baseCur: number | null = null;
    private suppliedKey: number | null = null;
    private suppliedFrame: Map<Letter, PitchClass> | null = null;
    private suppliedHard = false;   // manual frame override → PIN the collection (ignore the window); vs a soft key-sig hint
    /** Bare frame from the most recent frameFor, needed by commit's keep-alive update. */
    private lastBase: Map<Letter, PitchClass> | null = null;

    private readonly clock: () => number;
    private readonly baseWindowMs: number;
    private readonly baseMargin: number;
    private readonly lookAhead: boolean;
    private readonly lookAheadWeight: number;
    private readonly lookAheadMode: 'sign' | 'letter' | 'samepen';
    private readonly lookAheadVerticalGate: boolean;
    private readonly frameSoftMargin: number;
    private readonly suppliedKeyMargin: number | null;
    private readonly keepAlive: boolean;
    private readonly keepAliveCap: number;
    private readonly keepAliveEvict: 'clear' | 'oldest';
    private readonly spiral: boolean;
    private readonly spiralRange: number;
    private readonly spiralCenter: number;
    private readonly parallelThirdGate: boolean;
    private readonly preferRelMinorLT: boolean;
    private readonly lookAheadCoherenceGate: boolean;
    private readonly lookAheadCoherenceWindow: number;
    private readonly pinAutoRelease: boolean;
    private readonly pinReleaseSustain: number;
    /** HARD-PIN AUTO-RELEASE tracking: consecutive onsets the auto best-fit has strictly beaten the pin. */
    private pinReleaseCount = 0;
    private readonly neighbourStep: boolean;
    private readonly neighbourStepWeight: number;
    private readonly neighbourRunGate: number;
    private readonly neighbourWindowMs: number;
    private readonly neighbourVerticalGate: boolean;
    private readonly soundingTiebreak: boolean;
    private readonly stEpsilon: number;
    private readonly stWindow: 'coonset' | 'recent' | 'last3' | 'onsets';
    private readonly stBufferN: number;
    private readonly stWindowMs: number;
    private readonly trace: boolean;
    /** VIZ-ONLY: the most recent commit's decision record (null until the first traced commit). */
    private lastDecision: DecisionTrace | null = null;
    /** Committed-note history for the same-voice proxy: {midi, letter, alter, t}, time-ordered. */
    private noteHistory: { midi: number; step: Letter; alter: number; t: number }[] = [];
    /** SPIRAL mode: signed LoF tonic that renders the frame (null = cold, awaiting the first collection). */
    private frameLofTonic: number | null = null;
    /** The AUTO spiral position (line-of-fifths) — the continuity anchor spiralOrient reads/writes each
     *  onset. {@link frameLofTonic} mirrors it as the displayed/rendered value. */
    private frameLofAnchor: number | null = null;
    /** SPIRAL mode: still deciding the cold-start orientation (fewer than 3 distinct pcs since reset). */
    private superposed = true;

    constructor(opts: DiatonicBaseSubstrateOptions = {}) {
        this.clock = opts.clock ?? (() => Date.now());
        this.baseWindowMs = opts.baseWindowMs ?? 8000;
        this.baseMargin = opts.baseMargin ?? 3;
        this.lookAhead = opts.lookAhead ?? false;
        this.lookAheadWeight = opts.lookAheadWeight ?? 2;
        this.lookAheadMode = opts.lookAheadMode ?? 'sign';
        this.lookAheadVerticalGate = opts.lookAheadVerticalGate ?? false;
        this.frameSoftMargin = opts.frameSoftMargin ?? 18;
        this.suppliedKeyMargin = opts.suppliedKeyMargin ?? null;
        this.keepAlive = opts.keepAlive ?? false;
        this.keepAliveCap = opts.keepAliveCap ?? 3;
        this.keepAliveEvict = opts.keepAliveEvict ?? 'clear';
        this.spiral = opts.spiral ?? false;
        // Default 6 = hug the 12-key convention (fewest flips); raise toward 8 for deeper digging / more
        // coherence. Floored at 6 (pc 6 F♯/G♭ has no shallower spelling).
        this.spiralRange = Math.max(6, opts.spiralRange ?? 6);
        // Default +1 = the recommended sharp nudge: the F♯/G♭ tritone key snaps to F♯ (as Bach notates it),
        // which recovers most of the range-6 flip cost while keeping the coherence (wrong) win.
        this.spiralCenter = opts.spiralCenter ?? 1;
        this.parallelThirdGate = opts.parallelThirdGate ?? false;
        this.preferRelMinorLT = opts.preferRelMinorLT ?? false;
        this.lookAheadCoherenceGate = opts.lookAheadCoherenceGate ?? false;
        this.lookAheadCoherenceWindow = opts.lookAheadCoherenceWindow ?? 12;
        this.pinAutoRelease = opts.pinAutoRelease ?? true;
        this.pinReleaseSustain = opts.pinReleaseSustain ?? 8;
        this.neighbourStep = opts.neighbourStep ?? false;
        this.neighbourStepWeight = opts.neighbourStepWeight ?? 2;
        this.neighbourRunGate = opts.neighbourRunGate ?? 2;
        this.neighbourWindowMs = opts.neighbourWindowMs ?? 1500;
        this.neighbourVerticalGate = opts.neighbourVerticalGate ?? false;
        this.soundingTiebreak = opts.soundingTiebreak ?? false;
        this.stEpsilon = opts.stEpsilon ?? 0;
        this.stWindow = opts.stWindow ?? 'onsets';
        this.stBufferN = Math.max(1, opts.stBufferN ?? 5);
        this.stWindowMs = opts.stWindowMs ?? 400;
        this.trace = opts.trace ?? false;
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
    }

    frameFor(midi: number, ctx: NoteContext): Map<Letter, PitchClass> {
        // 1. Feed the raw pitch class into the time-windowed frame evidence.
        const t = ctx.t ?? this.clock();
        const pc = ((midi % 12) + 12) % 12;
        this.framePcs.push({ pc, t });
        const cutoff = t - this.baseWindowMs;
        while (this.framePcs.length && this.framePcs[0]!.t < cutoff) this.framePcs.shift();
        // 2. Infer the diatonic base. With keep-alive, a window change wipes the kept layer.
        const prevWindow = this.baseCur;
        const frame = this.findBase();
        if (this.keepAlive && prevWindow !== null && this.baseCur !== prevWindow) this.kept.clear();

        // 3. Rebuild the surface = frame, (keep-alive), then sounding overlay.
        if (frame !== null) {
            for (const [L, pc] of frame) this.resolved.set(L, { step: pc.step, alter: pc.alter });
            if (this.keepAlive) {
                for (const [L, sp] of this.kept) {
                    if (frame.get(L)!.alter !== sp.alter) this.resolved.set(L, sp);
                    else this.kept.delete(L);
                }
            }
        }
        for (const [m, L] of this.active) {
            if (m === midi) continue;
            const stk = this.activeSpelling.get(m);
            const held = stk && stk.length ? stk[stk.length - 1]! : undefined;
            if (held) this.resolved.set(L, held);
        }

        this.lastBase = frame;
        return this.resolved;
    }

    commit(midi: number, scored: readonly ScoredCandidate[], ctx: NoteContext): void {
        // VIZ trace (record-only): the surface the candidates were scored against is `this.resolved` as it
        // stands NOW — commit does not mutate it until the winning letter is set at the end. Deltas are
        // gathered in the argmax loop below; the override tag is set by whichever post-total branch moves best.
        const traceFrame = this.trace ? LETTERS.map(L => ({ ...this.resolved.get(L)! })) : null;
        const traceCands: DecisionCandidate[] | null = this.trace ? [] : null;
        const resolveDir = ctx.resolveDir ?? 0;
        const laOn = this.lookAhead && resolveDir !== 0;
        // For the letter-aware modes: the frame's current letter for the resolution TARGET (a semitone
        // away in resolveDir), and the letter a diatonic STEP toward it (E♯ when resolving up to F♯).
        let targetLetter: Letter | null = null, stepLetter: Letter | null = null;
        if (laOn && this.lookAheadMode !== 'sign') {
            const targetPc = (((midi + resolveDir) % 12) + 12) % 12;
            for (const L of LETTERS) if (pcVal(this.resolved.get(L)!) === targetPc) { targetLetter = L; break; }
            if (targetLetter) stepLetter = LETTERS[((LETTERS.indexOf(targetLetter) - resolveDir) % 7 + 7) % 7]!;
        }
        // NEIGHBOUR-STEP: a semitone from the previous same-voice note is a diatonic STEP, not an
        // augmented unison — reward the step letter, penalise the same letter (gated by chromatic-run
        // + optional vertical convergence). Computed once, applied additively in the argmax loop.
        let nsStepLetter: Letter | null = null, nsSameLetter: Letter | null = null;
        if (this.neighbourStep) {
            const ns = this.neighbourStepLetters(midi, scored, ctx);
            if (ns) { nsStepLetter = ns.stepLetter; nsSameLetter = ns.sameLetter; }
        }
        // First strict-max candidate (in candidate order), optionally tipped toward
        // where the note resolves. NOT sorted — matches the standalone's loop.
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        // The LA-SUPPRESSED argmax (score + neighbour-step, WITHOUT the look-ahead bonus), tracked in
        // parallel so the vertical gate below can compare the look-ahead's pick against it.
        let bestNoLa: PitchClass | null = null;
        let bestNoLaScore = Number.NEGATIVE_INFINITY;
        for (const { c, score } of scored) {
            let laDelta = 0;
            if (laOn) {
                if (this.lookAheadMode === 'letter' && targetLetter) {
                    // letter-aware: reward the diatonic-step letter, punish the same-letter (aug-unison) spelling
                    if (c.step === stepLetter) laDelta += this.lookAheadWeight;
                    else if (c.step === targetLetter) laDelta -= this.lookAheadWeight;
                } else {
                    laDelta += this.lookAheadWeight * resolveDir * Math.sign(c.alter);        // 'sign' boost
                    if (this.lookAheadMode === 'samepen' && c.step === targetLetter) laDelta -= this.lookAheadWeight;
                }
            }
            let nsDelta = 0;
            if (nsStepLetter) {
                if (c.step === nsStepLetter) nsDelta += this.neighbourStepWeight;
                else if (c.step === nsSameLetter) nsDelta -= this.neighbourStepWeight;
            }
            const s = score + laDelta + nsDelta;
            const sNoLa = score + nsDelta;
            if (s > bestScore) { bestScore = s; best = c; }
            if (sNoLa > bestNoLaScore) { bestNoLaScore = sNoLa; bestNoLa = c; }
            if (traceCands) traceCands.push({ c, base: score, laDelta, nsDelta });
        }
        if (best === null) return;
        let traceOverride: DecisionOverride = 'none';

        // LOOK-AHEAD VERTICAL GATE: the look-ahead is a tendency, the co-onset struck chord is
        // dispositive. When the look-ahead has MOVED the pick (best !== bestNoLa) to a spelling that forms
        // strictly MORE wolves with the co-onset committed notes than the look-ahead-suppressed pick,
        // revert to the suppressed pick — the resolution tendency must not increase dissonance with what
        // is sounding. Keeps the look-ahead's wins (a C♯–F dim4 → E♯ M3 REDUCES wolves, so it stands) and
        // drops its collateral (respelling a coherent m3/M3 chord tone to the comma-flipped side that
        // wolfs the chord: wtc2 49093 E→D𝄪, 50330 A♯→B♭). Targeted, unlike sounding-tiebreak.
        if (laOn && this.lookAheadVerticalGate && bestNoLa !== null && best !== bestNoLa && Math.abs(best.alter) >= 2) {
            const co = this.coOnsetCommitted(ctx.t ?? this.clock());
            const revert = co.length > 0 && wolfCount(best, co) > wolfCount(bestNoLa, co);
            if (revert) { best = bestNoLa; traceOverride = 'lookahead-vertical-gate'; }
        }

        // LOOK-AHEAD COHERENCE GATE: the resolution refines the LETTER within a side, but must not drag the
        // note OFF the passage's committed orientation. Reference = the MEDIAN line-of-fifths of the recent
        // COMMITS (not the frame tonic — a legit leading tone is itself far from the tonic, so tonic-distance
        // reverts real fixes). If the look-ahead moved the pick FARTHER from that recent-commit centre than
        // the suppressed pick, revert. See {@link lookAheadCoherenceGate}.
        if (laOn && this.lookAheadCoherenceGate && bestNoLa !== null && best !== bestNoLa && this.noteHistory.length >= 4) {
            const c = this.recentCommitMedianLof(this.lookAheadCoherenceWindow);
            if (c !== null && Math.abs(lineOfFifths(best) - c) > Math.abs(lineOfFifths(bestNoLa) - c)) { best = bestNoLa; traceOverride = 'lookahead-coherence-gate'; }
        }

        // SOUNDING-TIEBREAK: on a BASE-score (near-)tie between two CHROMATIC candidates, the full frame
        // can't decide; re-score the tied pair against a SHORT recency window of struck notes and pick
        // the higher (tie → candidate order). Uses the BASE scores (pre-LA), and OVERRIDES the pick above.
        if (this.soundingTiebreak && this.lastBase !== null && scored.length >= 2) {
            const st = this.soundingTiebreakPick(scored, ctx);
            if (st !== null) { if (st !== best) traceOverride = 'sounding-tiebreak'; best = st; }
        }

        // PREFER RELATIVE-MINOR LEADING TONE over the lowered tonic ♭1, gated on a SOUNDING DOMINANT
        // (OVERRIDES ST). The note's pc = (baseCur+8) is enharmonically the ♯7 of the relative minor
        // (a leading tone) or its ♭1 (lowered tonic, over-rotation). If something (ST, or a raw-consonance
        // tie) is about to commit the ♭1 letter AND the rel-minor DOMINANT root is currently sounding (a
        // struck V — the LT is its 3rd) AND the ♯7 letter is base-score-competitive, take the ♯7. The
        // collection fixes the rel-minor tonic (no key reader); the vertical dominant is the functional
        // gate that keeps it clean (see the option doc).
        if (this.preferRelMinorLT && this.baseCur !== null && this.lastBase !== null && scored.length >= 2
            && (((midi % 12) + 12) % 12) === (this.baseCur + 8) % 12) {
            const minorTonicPc = (this.baseCur + 9) % 12;
            const domPc = (this.baseCur + 4) % 12;                                 // rel-minor dominant root
            let domSounding = false;
            for (const m of this.active.keys()) if ((((m % 12) + 12) % 12) === domPc) { domSounding = true; break; }
            let tonicLetter: Letter | null = null;
            for (const L of LETTERS) if (pcVal(this.lastBase.get(L)!) === minorTonicPc) { tonicLetter = L; break; }
            if (domSounding && tonicLetter && best.step === tonicLetter) {             // about to commit the ♭1 under a struck V
                const ltLetter = LETTERS[(LETTERS.indexOf(tonicLetter) + 6) % 7]!;     // the letter one step below the tonic
                const lt = scored.find(sc => sc.c.step === ltLetter);
                const ft = scored.find(sc => sc.c.step === tonicLetter);
                if (lt && ft && lt.score >= ft.score - this.stEpsilon) { if (lt.c !== best) traceOverride = 'rel-minor-lt'; best = lt.c; }
            }
        }

        if (traceCands && traceFrame) this.lastDecision = { frame: traceFrame, candidates: traceCands, chosen: { ...best }, override: traceOverride };

        this.resolved.set(best.step, best);

        // Keep-alive update: a chromatic commit is kept; a frame-matching one clears.
        if (this.keepAlive && this.lastBase !== null) {
            const fr = this.lastBase.get(best.step)!;
            if (fr.alter !== best.alter) this.kept.set(best.step, best);
            else this.kept.delete(best.step);
            if (this.kept.size > this.keepAliveCap) {
                if (this.keepAliveEvict === 'oldest') this.kept.delete(this.kept.keys().next().value!);
                else this.kept.clear();
            }
        }

        this.active.set(midi, best.step);
        let stk = this.activeSpelling.get(midi);
        if (!stk) { stk = []; this.activeSpelling.set(midi, stk); }
        stk.push(best);

        if (this.neighbourStep || this.soundingTiebreak || this.lookAheadVerticalGate) {
            this.noteHistory.push({ midi, step: best.step, alter: best.alter, t: ctx.t ?? this.clock() });
            if (this.noteHistory.length > 256) this.noteHistory.splice(0, this.noteHistory.length - 256);
        }

    }

    /** The same-voice PROXY previous note: committed note strictly earlier than this onset, within
     *  {@link neighbourWindowMs} and |Δmidi| ≤ 4. A voice moves in small pitch steps, so attribute by
     *  pitch NEARNESS first (|Δmidi| ascending), breaking ties toward the more recent. Crude — it has no
     *  real voice model, so a leap in a monophonic line can mis-attribute; a documented limitation. */
    private prevSameVoice(midi: number, t: number): { midi: number; step: Letter; alter: number; t: number } | null {
        let best: { midi: number; step: Letter; alter: number; t: number } | null = null;
        for (let i = this.noteHistory.length - 1; i >= 0; i--) {
            const h = this.noteHistory[i]!;
            if (h.t >= t) continue;                              // co-onset or future — not "previous"
            if (t - h.t > this.neighbourWindowMs) break;         // too old (history is time-ordered)
            const d = Math.abs(h.midi - midi);
            if (d > 4) continue;
            // Prefer nearer in pitch; among equal distance, the more recent.
            if (best === null || d < Math.abs(best.midi - midi) || (d === Math.abs(best.midi - midi) && h.t > best.t)) best = h;
        }
        return best;
    }

    /** Median line-of-fifths of the last `window` commits — the passage's orientation reference for the
     *  look-ahead coherence gate. Null when fewer than 4 commits exist. */
    private recentCommitMedianLof(window: number): number | null {
        if (this.noteHistory.length < 4) return null;
        const lofs: number[] = [];
        for (let i = this.noteHistory.length - 1, seen = 0; i >= 0 && seen < window; i--, seen++)
            lofs.push(lineOfFifths({ step: this.noteHistory[i]!.step, alter: this.noteHistory[i]!.alter as PitchClass['alter'] }));
        lofs.sort((a, b) => a - b);
        return lofs[lofs.length >> 1]!;
    }

    /** The co-onset committed notes (same onset t = struck earlier at this instant, bass-first) as
     *  spelled pitch classes, for the look-ahead vertical gate. History is time-ordered, so co-onset
     *  entries sit at the tail; scan tail→head and stop once we pass to an earlier onset. */
    private coOnsetCommitted(t: number): PitchClass[] {
        const out: PitchClass[] = [];
        for (let i = this.noteHistory.length - 1; i >= 0; i--) {
            const h = this.noteHistory[i]!;
            if (h.t !== t) { if (h.t < t) break; else continue; }
            out.push({ step: h.step, alter: h.alter as PitchClass['alter'] });
        }
        return out;
    }

    /** Consecutive ±1-semitone moves in the same-voice-proxy chain ending at `from`. */
    private chromaticRunLength(from: { midi: number; t: number }): number {
        let count = 0, cur = from, guard = 0;
        while (guard++ < 32) {
            const before = this.prevSameVoice(cur.midi, cur.t);
            if (!before) break;
            if (Math.abs(cur.midi - before.midi) === 1) { count++; cur = before; } else break;
        }
        return count;
    }

    /** Compute the step-letter (reward) and same-letter (penalty) for the neighbour-step signal, or null
     *  when it does not fire (no proxy prev, not a semitone move, inside a chromatic run, or — with the
     *  vertical gate — the step does not strictly out-consonate the same-letter against a co-onset note). */
    private neighbourStepLetters(midi: number, scored: readonly ScoredCandidate[], ctx: NoteContext):
        { stepLetter: Letter; sameLetter: Letter } | null {
        const t = ctx.t ?? this.clock();
        const prev = this.prevSameVoice(midi, t);
        if (!prev || Math.abs(midi - prev.midi) !== 1) return null;
        // Chromatic-run gate: ≥ K consecutive semitone moves ending at prev ⇒ passing tone, suppress.
        if (this.neighbourRunGate > 0 && this.chromaticRunLength(prev) >= this.neighbourRunGate) return null;
        const dir = Math.sign(midi - prev.midi);                        // +1 up, −1 down
        const prevIdx = LETTERS.indexOf(prev.step);
        const stepLetter = LETTERS[((prevIdx + dir) % 7 + 7) % 7]!;
        const sameLetter = prev.step;
        // The step / same-letter candidate spellings for this midi (both must exist to compare).
        const stepC = scored.find(s => s.c.step === stepLetter)?.c;
        const sameC = scored.find(s => s.c.step === sameLetter)?.c;
        if (!stepC || !sameC) return null;
        if (this.neighbourVerticalGate) {
            // A co-onset committed note = same t in the history (bass struck first). The step must form a
            // strictly LESS-altered interval with at least one such note than the same-letter does.
            let strictlyBetter = false;
            for (let i = this.noteHistory.length - 1; i >= 0; i--) {
                const h = this.noteHistory[i]!;
                if (h.t !== t) { if (h.t < t) break; else continue; }
                const co: PitchClass = { step: h.step, alter: h.alter as PitchClass['alter'] };
                const qStep = Math.abs(rawIntervalBetween(co, stepC).quality);
                const qSame = Math.abs(rawIntervalBetween(co, sameC).quality);
                if (qStep < qSame) strictlyBetter = true;
            }
            if (!strictlyBetter) return null;
        }
        return { stepLetter, sameLetter };
    }

    /** SOUNDING-TIEBREAK pick, or null when it does not fire. Fires when the top-2 candidates by BASE
     *  frame score are within {@link stEpsilon} AND neither is a member of the current frame collection
     *  (a genuinely chromatic note the full scale can't decide). Re-scores the tied pair against a SHORT
     *  recency window of struck notes; returns the higher (candidate order breaks ties, incl. empty window). */
    private soundingTiebreakPick(scored: readonly ScoredCandidate[], ctx: NoteContext): PitchClass | null {
        // Top-2 by BASE score (stable to candidate order on ties).
        let i0 = -1, i1 = -1;
        for (let i = 0; i < scored.length; i++) {
            if (i0 < 0 || scored[i]!.score > scored[i0]!.score) { i1 = i0; i0 = i; }
            else if (i1 < 0 || scored[i]!.score > scored[i1]!.score) { i1 = i; }
        }
        if (i0 < 0 || i1 < 0) return null;
        if (Math.abs(scored[i0]!.score - scored[i1]!.score) > this.stEpsilon) return null;
        const frameMember = (c: PitchClass) => this.lastBase!.get(c.step)!.alter === c.alter;
        if (frameMember(scored[i0]!.c) || frameMember(scored[i1]!.c)) return null;    // frame decides — not chromatic
        // The tied pair, in CANDIDATE order (scored[] is enharmonicCandidatesFor order).
        const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
        const tied = [scored[lo]!.c, scored[hi]!.c];
        if (this.stWindow === 'onsets') {
            const buffer = this.onsetBuffer();
            if (buffer.length === 0) return tied[0]!;
            let bestC = tied[0]!, bestS = intervalBufferScore(tied[0]!, buffer);
            const s1 = intervalBufferScore(tied[1]!, buffer);
            if (s1 > bestS) bestC = tied[1]!;
            return bestC;
        }
        const recent = this.recencyScale(ctx.t ?? this.clock());
        if (recent.size === 0) return tied[0]!;                                        // abstain → candidate order
        // Re-score against the recency window; strict '>' keeps candidate order on a tie (dim7 case).
        let bestC = tied[0]!, bestS = intervalScore(tied[0]!, recent);
        const s1 = intervalScore(tied[1]!, recent);
        if (s1 > bestS) bestC = tied[1]!;
        return bestC;
    }

    /** Last {@link stBufferN} DISTINCT committed spellings, most-recent first. */
    private onsetBuffer(): PitchClass[] {
        const seen = new Set<string>();
        const out: PitchClass[] = [];
        for (let i = this.noteHistory.length - 1; i >= 0 && out.length < this.stBufferN; i--) {
            const h = this.noteHistory[i]!;
            const key = `${h.step}:${h.alter}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ step: h.step, alter: h.alter as PitchClass['alter'] });
        }
        return out;
    }

    /** The recency window as a letter→spelling scale, from committed struck notes (co-onset always;
     *  plus, per {@link stWindow}, notes within {@link stWindowMs} or the last 3). Most-recent wins per
     *  letter. Time-ordered history ⇒ co-onset (same t) sit at the tail; we scan tail→head and stop early. */
    private recencyScale(t: number): Map<Letter, PitchClass> {
        const m = new Map<Letter, PitchClass>();
        let older = 0;
        for (let i = this.noteHistory.length - 1; i >= 0; i--) {
            const h = this.noteHistory[i]!;
            let include: boolean;
            if (h.t === t) include = true;                                             // co-onset
            else if (this.stWindow === 'coonset') break;
            else if (this.stWindow === 'recent') { if (t - h.t > this.stWindowMs) break; include = true; }
            else { if (older >= 3) break; older++; include = true; }                   // 'last3'
            if (include && !m.has(h.step)) m.set(h.step, { step: h.step, alter: h.alter as PitchClass['alter'] });
        }
        return m;
    }

    readBack(midi: number): PitchClass | null {
        const targetPc = ((midi % 12) + 12) % 12;
        const own = this.activeSpelling.get(midi);
        if (own && own.length) {
            const sp = own[own.length - 1]!;
            if (pcVal(sp) === targetPc) return sp;
        }
        const letter = this.active.get(midi);
        if (letter !== undefined) {
            const sp = this.resolved.get(letter)!;
            if (pcVal(sp) === targetPc) return sp;
        }
        return null;
    }

    frameLookup(midi: number): PitchClass | null {
        const targetPc = ((midi % 12) + 12) % 12;
        for (const L of LETTERS) {
            const pc = this.resolved.get(L)!;
            if (pcVal(pc) === targetPc) return pc;
        }
        return null;
    }

    reset(scale?: readonly PitchClass[], hard = false): void {
        // `active` / `activeSpelling` (currently-sounding notes) are deliberately NOT cleared: a note
        // that already committed keeps its own spelling until its own note-off, even if a key-change
        // (respell/reset) fires under it while it is held. readBack() returns activeSpelling directly
        // (frame-independent), so this is exactly what makes a held pitch survive the reset. Clearing
        // them orphaned held notes → getSpelling() fell through to the new frame at note-off.
        this.framePcs = [];
        this.baseCur = null;
        this.suppliedKey = null;
        this.suppliedFrame = null;
        this.suppliedHard = false;
        this.kept.clear();
        this.frameLofTonic = null;
        this.frameLofAnchor = null;
        this.superposed = true;
        this.pinReleaseCount = 0;
        this.noteHistory = [];
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
        if (scale && scale.length) {
            const want = new Set<number>(scale.map(pcVal));
            for (let c = 0; c < 12; c++) {
                const got = new Set<number>();
                for (const v of majorScaleForTonic(c).values()) got.add(pcVal(v));
                let eq = got.size === want.size;
                for (const x of want) if (!got.has(x)) { eq = false; break; }
                if (eq) {
                    this.baseCur = c;
                    if (this.spiral && hard) {
                        // SPIRAL, manual override: INJECT the orientation, then hand back to continuity —
                        // a manual reset re-seeds the state and lets the library run on from there, NOT a
                        // permanent pin. Seed the signed LoF tonic from the key's OWN tonic spelling
                        // (C♯→+7, D♭→−5) and mark warm, so the next notes DIG from this side by continuity
                        // instead of cold-starting to the fewest-accidentals key (bestColdTonic, which
                        // rebuilds a forced C♯ back to a flat A♭ two notes later). The finder still owns
                        // the collection; this owns only the side.
                        let t = c;
                        for (const pc of scale) if (pcVal(pc) === c) { t = LETTER_LOF[pc.step] + pc.alter * 7; break; }
                        this.frameLofAnchor = t;
                        this.frameLofTonic = t;
                        this.superposed = false;
                    } else {
                        this.suppliedKey = c;
                        this.suppliedHard = hard;   // a soft key-sig hint (non-spiral pin) stays until re-fit
                        const f = new Map<Letter, PitchClass>();
                        for (const L of LETTERS) f.set(L, { step: L, alter: 0 });
                        for (const pc of scale) f.set(pc.step, { step: pc.step, alter: pc.alter });
                        this.suppliedFrame = f;
                    }
                    break;
                }
            }
        }
    }

    noteOff(midi: number): void {
        const stk = this.activeSpelling.get(midi);
        if (stk && stk.length) { stk.pop(); if (stk.length === 0) this.activeSpelling.delete(midi); }
        if (!this.activeSpelling.has(midi)) this.active.delete(midi);
    }

    /** Instrumentation: current surface + (spiral) frame LoF-tonic, sampled between notes (read-only).
     *  `resolvedScale` backs {@link SpellerKernel} → `Speller.getResolvedScale`; `frameLofTonic` backs the
     *  two-pass section-flip. Nothing here feeds a spelling decision. */
    snapshot(): SubstrateTrace {
        return {
            resolvedScale: LETTERS.map(L => ({ ...this.resolved.get(L)! })),
            // the bare diatonic base collection, before keep-alive/sounding overlays (null until the first frame)
            frame: this.lastBase ? LETTERS.map(L => ({ ...this.lastBase!.get(L)! })) : undefined,
            frameLofTonic: this.spiral && this.frameLofTonic != null ? this.frameLofTonic : undefined,
            // Non-spiral callers still have a conventional key spelling for the same collection; this
            // is display-only and must not be confused with the spiral's continuity anchor above.
            frameKeyLof: this.baseCur != null ? KEYSIG_SHARPS[this.baseCur]! : undefined,
        };
    }

    /** VIZ-ONLY: the most recent commit's {@link DecisionTrace}, or null when `trace` is off / no commit yet. */
    decision(): DecisionTrace | null { return this.lastDecision; }

    private findBase(): Map<Letter, PitchClass> | null {
        if (this.framePcs.length === 0) return null;
        const hist = new Array(12).fill(0);
        for (const e of this.framePcs) hist[e.pc]++;
        const outside = (relMajorPc: number): number => {
            let n = 0;
            for (let pc = 0; pc < 12; pc++) {
                if (hist[pc] && !inDiatonic(pc, relMajorPc)) n += hist[pc];
            }
            return n;
        };
        let best = 0, bestOut = Number.POSITIVE_INFINITY;
        for (let c = 0; c < 12; c++) {
            const o = outside(c);
            if (o < bestOut) { bestOut = o; best = c; }
        }
        let relMajorPc = best;
        const heldWithinMargin = this.baseCur !== null && outside(this.baseCur) <= bestOut + this.baseMargin;
        if (this.baseCur !== null && heldWithinMargin) {
            relMajorPc = this.baseCur;
        }
        // HARD-PIN AUTO-RELEASE: a manual pin (suppliedHard) otherwise forces its collection for the rest
        // of the piece. Drop it once the AUTO best-fit strictly contains the music better than the pin for
        // `pinReleaseSustain` CONSECUTIVE onsets — sustained contrary evidence, e.g. grieg modulating away
        // from a forced C. Viz-only (presets never hard-pin, so this never runs there). On release the auto
        // winner (`best`) takes over THIS onset so the held frame doesn't immediately re-stick to the pin.
        if (this.suppliedHard && this.pinAutoRelease && this.suppliedKey !== null) {
            if (bestOut < outside(this.suppliedKey)) this.pinReleaseCount++;
            else this.pinReleaseCount = 0;
            if (this.pinReleaseCount >= this.pinReleaseSustain) {
                this.suppliedKey = null;
                this.suppliedHard = false;
                this.suppliedFrame = null;
                this.pinReleaseCount = 0;
                relMajorPc = best;
            }
        }
        const supMargin = this.suppliedKeyMargin ?? this.frameSoftMargin;
        if (this.suppliedKey !== null && (this.suppliedHard || outside(this.suppliedKey) <= bestOut + supMargin)) {
            relMajorPc = this.suppliedKey;
        }
        // PARALLEL-FLIP THIRD GATE: a flip to the parallel collection (±3 fifths = ±3 pc: the major/minor of
        // one tonic) must be CONFIRMED by the third. The two collections differ essentially in the shared
        // tonic's 3rd (E♮ for C major vs E♭ for C minor); allow the flip only if the target side's third is
        // struck MORE than the other, else the melodic raised 6/7 (or a passing chromatic) is spoofing it.
        if (this.parallelThirdGate && this.baseCur !== null && relMajorPc !== this.baseCur) {
            const diff = ((relMajorPc - this.baseCur) % 12 + 12) % 12;
            if (diff === 3 || diff === 9) {                             // parallel pair (3 fifths apart)
                const M = diff === 3 ? this.baseCur : relMajorPc;   // major-side collection = shared tonic pc
                const maj3 = hist[(M + 4) % 12], min3 = hist[(M + 3) % 12];
                const confirmed = relMajorPc === M ? maj3 > min3 : min3 > maj3;
                if (!confirmed) relMajorPc = this.baseCur;          // block the unconfirmed parallel flip
            }
        }
        this.baseCur = relMajorPc;
        // A SOFT key-sig hint (non-spiral pin) renders the pinned key verbatim while it is held. The spiral
        // path does NOT pin here — a manual spiral override re-seeds the orientation anchor in reset() and
        // then hands control back to continuity (see reset), so suppliedKey stays null under the spiral.
        if (this.suppliedFrame !== null && relMajorPc === this.suppliedKey) return this.suppliedFrame;
        // SPIRAL frame: render the chosen collection from a signed LoF tonic by continuity + writable
        // cold start (the line-of-fifths model). The finder above is untouched; only the side changes.
        if (this.spiral && (this.suppliedKey === null || this.suppliedHard)) return this.spiralScale(relMajorPc);
        return majorScaleForTonic(relMajorPc);
    }

    /** SPIRAL render of the held collection `relMajorPc` as a signed line-of-fifths scale.
     *  Cold (superposed, < 3 distinct pcs since reset): pick the shallowest WRITABLE tonic containing
     *  the recent pcs. Warm: dig to the nearest enharmonic of the held tonic (continuity), which the
     *  ±SPIRAL_RANGE cap folds back only when the collection has no in-range same-side spelling. */
    private spiralScale(relMajorPc: number): Map<Letter, PitchClass> {
        if (this.superposed) {
            const distinct = [...new Set(this.framePcs.map(e => e.pc))];
            this.frameLofAnchor = bestColdTonic(distinct, Math.min(COLD_RANGE, this.spiralRange), this.spiralCenter);
            if (distinct.length >= 3) this.superposed = false;
        } else {
            this.frameLofAnchor = spiralOrient(relMajorPc, this.frameLofAnchor, this.spiralRange, this.spiralCenter);
        }
        this.frameLofTonic = this.frameLofAnchor;
        return lofMajorScale(this.frameLofTonic);
    }

}
