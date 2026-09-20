/**
 * Chromatic-line detector pins (`test/eval/chromatic-lines.ts`).
 *
 * Synthetic invariants nail the two design choices that make it survive polyphony — strict
 * monotonicity (a run, not a trill) and legato-by-timing (a real line, not a co-onset cluster or a
 * cross-voice ±1 coincidence). The Grieg pin locks the validated real-music behaviour: the count of
 * notes it flags on `death_of_ase` (the descents the recency-guard experiment was measured against).
 */

import { assert, assertEq, suite, test } from './framework.js';
import { detectChromaticLines, linesNotesFromEvents, type LineNote } from './eval/chromatic-lines.js';
import { loadEvents } from './eval/fixtures.js';

/** Build legato LineNotes for one monotonic voice: consecutive notes hand off offset→onset. */
function legatoVoice(midis: number[], start = 0, dur = 100): LineNote[] {
    return midis.map((midi, i) => ({ midi, tOn: start + i * dur, tOff: start + (i + 1) * dur }));
}

suite('chromatic-line detector', () => {
    test('a monotonic legato semitone run is fully flagged, with direction', () => {
        const up = detectChromaticLines(legatoVoice([60, 61, 62, 63]));
        assert(up.every(t => t.inRun), 'every note of a 4-note chromatic ascent is in a run');
        assert(up.every(t => t.direction === 1), 'ascending run reads direction +1');
        assertEq(up[3]!.runLength, 4);

        const down = detectChromaticLines(legatoVoice([63, 62, 61, 60]));
        assert(down.every(t => t.inRun && t.direction === -1), 'descending run reads direction −1');
    });

    test('a trill is NOT a run (strict monotonicity)', () => {
        // 60→61→60→61: every reversal starts a fresh line, so no line reaches length 3.
        const trill = detectChromaticLines(legatoVoice([60, 61, 60, 61]));
        assert(trill.every(t => !t.inRun), 'oscillation never forms a run');
    });

    test('diatonic stepwise motion is NOT a run', () => {
        // C D E F G — mostly whole tones; the lone E–F semitone is an isolated length-2 line.
        const scale = detectChromaticLines(legatoVoice([60, 62, 64, 65, 67]));
        assert(scale.every(t => !t.inRun), 'a diatonic scale contains no chromatic run');
    });

    test('a co-onset cluster is NOT a run (legato, not simultaneity)', () => {
        // 60/61/62 struck together: the overlap exceeds the legato tolerance, so no handoff.
        const cluster = detectChromaticLines([
            { midi: 60, tOn: 0, tOff: 100 },
            { midi: 61, tOn: 0, tOff: 100 },
            { midi: 62, tOn: 0, tOff: 100 },
        ]);
        assert(cluster.every(t => !t.inRun), 'a semitone cluster chord is not a chromatic line');
    });

    test('parallel descending lines survive polyphony as SEPARATE runs', () => {
        // Two interleaved legato descents (72→70 and 60→58); neither steals the other’s notes.
        const notes: LineNote[] = [
            { midi: 72, tOn: 0, tOff: 100 }, { midi: 60, tOn: 50, tOff: 150 },
            { midi: 71, tOn: 100, tOff: 200 }, { midi: 59, tOn: 150, tOff: 250 },
            { midi: 70, tOn: 200, tOff: 300 }, { midi: 58, tOn: 250, tOff: 350 },
        ];
        const tags = detectChromaticLines(notes);
        assert(tags.every(t => t.inRun && t.direction === -1), 'both parallel descents are fully detected');
        assert(tags.every(t => t.runLength === 3), 'each line is length 3, uncontaminated by the other');
    });

    test('Grieg death_of_ase: the validated in-run count is stable', () => {
        // Regression pin for the real-music case the chromatic-line experiment measured against
        // (strict-monotonic, legato gap 0.25×dur, minRun 3). See core-chromatic-line-handler-washes.
        const notes = linesNotesFromEvents(loadEvents('grieg_death_of_ase'));
        const tags = detectChromaticLines(notes);
        const inRun = tags.filter(t => t.inRun).length;
        assertEq(inRun, 68, `Grieg in-run count drifted (${inRun} ≠ 68)`);
    });
});
