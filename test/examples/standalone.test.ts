/**
 * Standalone ↔ shipped-model parity guard.
 *
 * `examples/core-speller.ts` is the self-contained reference copy: the entire two-pillar speller in one
 * file (zero imports, ~100 effective lines). It is a DERIVED copy: `src/core.ts` is the
 * source of truth (the bench drives it as Core and shares its primitives with the rest of the speller). This test
 * pins the copy to the original: for every curated fixture the standalone must produce byte-identical
 * spellings to `CoreSpeller`, so "the complete speller in ~100 lines" stays a true claim as the code
 * evolves. Edit `src/core.ts` and this drift will fail here until the standalone is re-synced.
 */
import { assertEq, suite, test } from '../framework.js';
import { CoreSpeller as Standalone } from '../../examples/core-speller.js';
import { FIXTURES, loadEvents, predict, type BatchEv } from '../eval/fixtures.js';
import type { Pitch } from '../../src/pitch.js';

/** Drive the standalone through the same note-off read-back path the bench's `drive()` uses. */
function driveStandalone(events: BatchEv[]): (Pitch | null)[] {
    const s = new Standalone();
    const out: (Pitch | null)[] = [];
    const pending = new Map<number, number[]>();
    for (const e of events) {
        if (e.type === 'on') {
            s.noteOn(e.midi);
            const idx = out.length; out.push(null);
            (pending.get(e.midi) ?? pending.set(e.midi, []).get(e.midi)!).push(idx);
        } else {
            const q = pending.get(e.midi);
            if (q && q.length) out[q.shift()!] = s.getSpelling(e.midi) as Pitch | null;
            s.noteOff(e.midi);
        }
    }
    return out;
}

const spell = (p: Pitch | null) => (p ? `${p.step}${p.alter}/${p.octave}` : 'null');

suite('examples/core-speller ↔ src/core parity', () => {
    for (const id of FIXTURES) {
        test(`${id}: standalone spellings == shipped CoreSpeller`, () => {
            const events = loadEvents(id);
            assertEq(driveStandalone(events).map(spell), predict('core', events).map(spell));
        });
    }
});
