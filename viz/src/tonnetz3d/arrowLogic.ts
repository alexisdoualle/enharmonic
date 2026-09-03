/**
 * Pure logic for determining whether a semitone arrow should be lit.
 * Returns a strength value: 1 = fully lit, 0.5 = defused (half), 0 = dim.
 * Extracted for testability.
 */

// Minimum resonance activation to count as "present" — filters out
// sympathetic noise that would otherwise cause arrows to flicker.
export const LIT_THRESHOLD = 0.05;

// Source note must have at least 50% resonance for an arrow to appear;
// held/active notes bypass this (they're at full strength by definition).
const SOURCE_LIT_THRESHOLD = 0.5;

// Letter-name index: C=0 D=1 E=2 F=3 G=4 A=5 B=6
export const LETTER_INDICES: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const NATURAL_MIDI = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B

// A5 policy — which end of an augmented 5th is allowed to carry an arrow?
// Root is allowed only when the crown is NOT also active (see isActive param).
const allowA5crown = true;  // true → don't block arrows pointing to the crown of an A5

/**
 * Check whether the target note sits in a non-perfect 5th with a neighbor.
 * Uses letter names: look at the letter a 5th above and below the target,
 * check their resolved midi values, and verify the interval is exactly 7
 * semitones (P5).  If not, return true → block arrow (subject to A5 policy).
 *
 * resolvedMidi maps letter index (0–6) → midi pitch class (0–11) or null.
 * isActive checks whether a pitch class is sounding (held, active, or resonating).
 * When the target is the root of an A5, the root is only allowed as a target
 * if the crown is NOT also active — otherwise the A5 is truly present and blocks.
 */
export function hasNonPerfectFifth(
    targetMidi: number,
    targetLetterIndex: number,
    resolvedMidi: (letterIdx: number) => number | null,
    isActive?: (pc: number) => boolean,
): boolean {
    // 5th above = 4 letter steps up (e.g. A→E) — target is root
    const aboveIdx = (targetLetterIndex + 4) % 7;
    const aboveMidi = resolvedMidi(aboveIdx);
    if (aboveMidi !== null) {
        const interval = (aboveMidi - targetMidi + 12) % 12;
        // A5: allow root as target only when the crown is not also active
        const a5RootOk = interval === 8 && (!isActive || !isActive(aboveMidi));
        if (interval !== 7 && !a5RootOk) return true;
    }
    // 5th below = 3 letter steps up = 4 steps down (e.g. A→D) — target is crown
    const belowIdx = (targetLetterIndex + 3) % 7;
    const belowMidi = resolvedMidi(belowIdx);
    if (belowMidi !== null) {
        const interval = (targetMidi - belowMidi + 12) % 12;
        if (interval !== 7 && !(allowA5crown && interval === 8)) return true;
    }
    return false;
}

export function computeArrowLit(
    fromPC: number,
    toPC: number,
    heldPCs: Set<number>,
    activePCs: Set<number>,
    activationField: Map<number, number> | null,
    noteOnTimestamps: Map<number, number>,
    shortTermField?: Map<number, number> | null,
): number {
    // Use shortTermField for lit/dim decisions when provided (resonance-based),
    // falling back to activationField (scale decay) if not given
    const litField = shortTermField ?? activationField;
    const fromAct = litField ? (litField.get(fromPC) ?? 0) : 0;
    const toAct = litField
        ? (litField.get(toPC) ?? 0)
        : (activePCs.has(toPC) ? 1 : 0);

    let isLit = heldPCs.has(fromPC) || activePCs.has(fromPC) || fromAct >= SOURCE_LIT_THRESHOLD;

    if (isLit && toAct > LIT_THRESHOLD) {
        const fromTime = noteOnTimestamps.get(fromPC) ?? 0;
        const toTime = noteOnTimestamps.get(toPC) ?? 0;
        // Dim if target was triggered after source (resolution completed)
        if (toTime > fromTime) isLit = false;
        // Dim if source was released while target is still held
        const sourceReleased = !heldPCs.has(fromPC) && !activePCs.has(fromPC);
        const targetHeld = heldPCs.has(toPC) || activePCs.has(toPC);
        if (sourceReleased && targetHeld) isLit = false;
    }

    if (!isLit) return 0;

    // Pitch-class-only tritone check (d5): any active note 6 semitones
    // from target.  This is unambiguous without letter names.
    const tritoneOfTarget = (toPC + 6) % 12;
    const hasTritone = heldPCs.has(tritoneOfTarget)
        || activePCs.has(tritoneOfTarget)
        || (litField ? (litField.get(tritoneOfTarget) ?? 0) > LIT_THRESHOLD : false);
    if (hasTritone) return 0;

    // Defuse: a perfect 5th below the source grounds it, reducing the
    // semitone tension (e.g. E grounds B so B→C shows at low strength).
    // Gradual: as the P5's resonance decays, the arrow regains strength.
    const fifthBelowPC = (fromPC + 5) % 12;
    const fifthHeld = heldPCs.has(fifthBelowPC) || activePCs.has(fifthBelowPC);
    const fifthAct = fifthHeld ? 1 : (litField ? Math.min(1, litField.get(fifthBelowPC) ?? 0) : 0);
    if (fifthAct > LIT_THRESHOLD) {
        // 0.1 when fully resonating, fades to 1 as resonance decays
        return 0.1 + 0.9 * (1 - fifthAct);
    }

    return 1;
}

/** True when a held/active/resonating P5 below the source grounds it. */
export function isDefusedByFifth(
    fromPC: number,
    heldPCs: Set<number>,
    activePCs: Set<number>,
    litField?: Map<number, number> | null,
): boolean {
    const fifthBelowPC = (fromPC + 5) % 12;
    return heldPCs.has(fifthBelowPC) || activePCs.has(fifthBelowPC)
        || (litField ? (litField.get(fifthBelowPC) ?? 0) > LIT_THRESHOLD : false);
}
