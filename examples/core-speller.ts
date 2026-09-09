/**
 * CoreSpeller — the complete two-pillar enharmonic speller, self-contained.
 *
 * This is the pedagogical reference for the paper: the ENTIRE spelling model in
 * one file with zero imports — no library, no dependencies, ~100 effective lines.
 * It is the same algorithm the repo ships as rung 1 (`src/core.ts`), inlined so
 * the whole thing can be read top to bottom. `src/core.ts` is the source of truth
 * (the bench drives it as rung 1 and shares its primitives with rungs 2–4); this
 * file is a derived artifact, kept byte-identical by `test/examples/standalone.ts`.
 *
 * Two pillars, and nothing else:
 *   1. The 7-LETTER LIMIT. A running "resolved scale" holds one spelling per
 *      letter A–G. Every note overwrites its letter's slot; a note is spelled by
 *      choosing WHICH letter to claim.
 *   2. INTERVAL SCORING. Among the enharmonic candidates for a pitch, pick the one
 *      that forms the most consonant intervals with the rest of the resolved scale
 *      (perfect/imperfect consonances reward, augmented/diminished punish). This
 *      alone makes the scale drift into key without any explicit key detection.
 *
 * Frameless and PERSISTENT: one drifting scale whose slots are overwritten and
 * never reverted. That is the minimal causal baseline; the shipped Speller
 * (rungs 2/3) and `spellTwoPass` (rung 4) improve on it. This standalone is
 * deliberately the weakest speller — yet it still beats classic SOTA on tonal
 * corpora, which is the point the ~100 lines are here to make.
 */

// ── Types ────────────────────────────────────────────────────────────────────

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
/** Double-flat through double-sharp; the speller produces nothing more remote. */
type Accidental = -2 | -1 | 0 | 1 | 2;
interface PitchClass { readonly step: Letter; readonly alter: Accidental; }
interface Pitch { readonly step: Letter; readonly alter: Accidental; readonly octave: number; }

// ── Constant tables ──────────────────────────────────────────────────────────

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
/** Natural pitch class of each letter (C = 0). */
const LETTER_BASE: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Diatonic index, C=0 … B=6 — the letter distance used for interval NUMBER. */
const LETTER_IDX: Record<Letter, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
/** Line-of-fifths position of each natural, F=−1 … B=+5 — used for interval QUALITY. */
const LETTER_CHROMA: Record<Letter, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

// ── Enharmonic candidates ────────────────────────────────────────────────────

/**
 * Every spelling of `midi`'s pitch class with an accidental in [−2, +2], ordered
 * by |accidental| ascending then letter order (so the plainest spelling is first).
 *   0 → [C, B♯, D♭♭]   1 → [C♯, D♭, B♯♯]   8 → [G♯, A♭]
 */
function enharmonicCandidatesFor(midi: number): PitchClass[] {
    const pc = ((midi % 12) + 12) % 12;
    const found: { step: Letter; alter: Accidental; order: number }[] = [];
    for (let i = 0; i < LETTERS.length; i++) {
        const step = LETTERS[i]!;
        const raw = ((pc - LETTER_BASE[step]) % 12 + 12) % 12; // required accidental, 0..11
        const alter = raw > 6 ? raw - 12 : raw;                // fold into −6..+5
        if (Math.abs(alter) <= 2) found.push({ step, alter: alter as Accidental, order: i });
    }
    found.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || a.order - b.order);
    return found.map(({ step, alter }) => ({ step, alter }));
}

// ── Interval quality & scoring ───────────────────────────────────────────────

/** Signed interval quality from line-of-fifths distance: 0=P, ±1=M/m, ±2=A/d, ±3=AA/dd… */
function qualityFromChroma(c: number): number {
    if (Math.abs(c) <= 1) return 0;
    if (c > 0 && c <= 5) return Math.floor((c + 5) / 7);
    if (c < 0 && c >= -5) return Math.ceil((c - 5) / 7);
    if (c > 5) return Math.floor((c + 8) / 7);
    return Math.floor((c - 2) / 7);
}

/** Raw (unclamped) interval between two pitch classes: signed quality + number (1..8). */
function intervalBetween(from: PitchClass, to: PitchClass): { quality: number; number: number } {
    const letterDist = (LETTER_IDX[to.step] - LETTER_IDX[from.step] + 7) % 7;
    const chroma = (LETTER_CHROMA[to.step] + 7 * to.alter) - (LETTER_CHROMA[from.step] + 7 * from.alter);
    // Same letter but flatter (C → C♭): read as the ascending diminished octave, not a unison.
    const stepspan = letterDist === 0 && chroma < 0 ? 7 : letterDist;
    return { quality: qualityFromChroma(chroma), number: stepspan + 1 };
}

/** Per-interval score: consonances reward, augmented/diminished punish (clamped at −2). */
function scoreFor(quality: number, number: number): number {
    if (quality === 0) return number === 4 || number === 5 ? 1 : 0; // P4/P5 consonant; P1/P8 neutral
    const absQ = Math.abs(quality);
    if (absQ === 1) return number === 3 || number === 6 ? 1 : 0;    // M/m 3rds & 6ths consonant
    if (absQ === 2) return -1;                                       // augmented / diminished
    return -2;                                                       // doubly-aug/dim and beyond
}

/** Sum of interval scores of a candidate against the rest of the resolved scale. Higher = better fit. */
function intervalScore(candidate: PitchClass, resolved: ReadonlyMap<Letter, PitchClass>): number {
    let total = 0;
    for (const [letter, pc] of resolved) {
        if (letter === candidate.step) continue; // candidate replaces this slot
        const { quality, number } = intervalBetween(candidate, pc);
        total += scoreFor(quality, number);
    }
    return total;
}

// ── The speller ──────────────────────────────────────────────────────────────

export class CoreSpeller {
    /** One spelling per letter A–G — the drifting scale. Starts at C major. */
    private resolved = new Map<Letter, PitchClass>();
    /** midi → the spelling committed while that note is sounding, so read-back at note-off returns
     *  the note's OWN spelling even if a later same-letter note has since overwritten the slot. */
    private active = new Map<number, PitchClass>();

    constructor() {
        for (const L of LETTERS) this.resolved.set(L, { step: L, alter: 0 });
    }

    /** Commit a spelling for `midi`: the candidate whose intervals best fit the current scale. */
    noteOn(midi: number): void {
        let best: PitchClass | null = null;
        let bestScore = Number.NEGATIVE_INFINITY;
        for (const c of enharmonicCandidatesFor(midi)) {
            const s = intervalScore(c, this.resolved);
            if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best === null) return;
        this.resolved.set(best.step, best);
        this.active.set(midi, best);
    }

    noteOff(midi: number): void {
        this.active.delete(midi);
    }

    /** The spelling of a sounding note (its committed one), else the scale's current spelling of it. */
    getSpelling(midi: number): Pitch | null {
        const octave = Math.floor(midi / 12) - 1;
        const sounding = this.active.get(midi);
        if (sounding) return { step: sounding.step, alter: sounding.alter, octave };
        const target = ((midi % 12) + 12) % 12;
        for (const L of LETTERS) {
            const pc = this.resolved.get(L)!;
            if (((LETTER_BASE[pc.step] + pc.alter) % 12 + 12) % 12 === target) {
                return { step: pc.step, alter: pc.alter, octave };
            }
        }
        return null;
    }

    /** Read-only snapshot of the current 7-letter scale (introspection). */
    getResolvedScale(): PitchClass[] {
        return LETTERS.map(L => ({ ...this.resolved.get(L)! }));
    }
}

// ── Tiny demo (run: `npx tsx examples/core-speller.ts`) ───────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
    // A short chromatic ascent; the speller spells each MIDI note in context.
    const speller = new CoreSpeller();
    const stream = [60, 62, 64, 66, 67, 69, 71, 72]; // C D E F♯ G A B C — the F♯ is the interesting one
    const names = ['bb', 'b', '', '#', '##'];
    for (const midi of stream) {
        speller.noteOn(midi);
        const p = speller.getSpelling(midi)!;
        console.log(`midi ${midi} → ${p.step}${names[p.alter + 2]}${p.octave}`);
        speller.noteOff(midi);
    }
}
