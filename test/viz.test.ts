/**
 * Viz ↔ bench parity guard.
 *
 * The viz drives its OWN kernel (`viz/src/replay.ts::buildReplay`) and used to carry its own private
 * tier classifier, which silently drifted from the bench scorer — an isolated wrong-side note showed as
 * "flipped (coherent side)" in the app while the bench (correctly) never counted it as a flip
 * (WTC1 prelude onset 209). Nothing compared the two, so the drift hid.
 *
 * This test pins them together: for every curated fixture and latency mode, the viz replay's
 * {correct,flipped,wrong,unread} tally must equal the bench `scoreTiers` over the same fixture. It
 * catches BOTH a re-divergent classifier AND any drift between the viz's kernel path and the public
 * `Speller`/`spellTwoPass` the bench uses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertEq, suite, test } from './framework.js';
import { FIXTURES, REPO_ROOT, loadEvents, loadExpected, onsetKeys, predict, type Mode } from './eval/fixtures.js';
import { scoreTiers } from './eval/score.js';
import { buildReplay, withSectionAutoResets, type RawEvent } from '../viz/src/replay.js';
import { readableSearch, sideOverridesFromSearch, stepFromSearch, writeSideOverrides } from '../viz/src/state.js';

// The viz replays every benchmark speller, including the pedagogical rung 1 (`core`).
const MODES: Mode[] = ['core', 'rt', 'la', 'tp'];

/** Raw events.json (on/off/respell) — what the viz consumes directly. */
const loadRaw = (id: string): RawEvent[] =>
    JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[];

suite('viz ↔ bench parity', () => {
    for (const id of FIXTURES) {
        for (const mode of MODES) {
            test(`${id}/${mode}: viz tally == bench scoreTiers`, () => {
                const raw = loadRaw(id);
                const expected = loadExpected(id);
                const events = loadEvents(id);
                const vizTally = buildReplay(mode, raw, expected).tally;
                const bench = scoreTiers(predict(mode, events), expected, onsetKeys(events));
                assertEq(
                    { correct: vizTally.correct, flipped: vizTally.flipped, wrong: vizTally.wrong, unread: vizTally.unread, total: vizTally.total },
                    { correct: bench.correct, flipped: bench.flipped, wrong: bench.wrong, unread: bench.unread, total: bench.total },
                );
            });
        }
    }
});

suite('viz side markers', () => {
    test('a stitched score releases a marker when its measure number restarts', () => {
        const expected = [
            { step: 'C', alter: 0, measure: 4 }, { step: 'D', alter: 0, measure: 5 },
            { step: 'C', alter: 0, measure: 1 }, { step: 'D', alter: 0, measure: 2 },
        ];
        assertEq(withSectionAutoResets(expected, [{ from: 1, comma: 1 }]), [{ from: 1, comma: 1 }, { from: 2, comma: 0 }]);
    });

    test('a manual marker at a stitched boundary takes precedence over auto release', () => {
        const expected = [{ step: 'C', alter: 0, measure: 2 }, { step: 'C', alter: 0, measure: 1 }];
        assertEq(withSectionAutoResets(expected, [{ from: 1, comma: -1 }]), [{ from: 1, comma: -1 }]);
    });

    test('URL markers are 1-based grouped lists', () => {
        const p = new URLSearchParams();
        writeSideOverrides(p, [
            { from: 3303, comma: 1 }, { from: 13854, comma: -1 }, { from: 10, comma: 0 },
        ]);
        assertEq(p.toString(), 'sharp=3304&flat=13855&auto=11');
        assertEq(sideOverridesFromSearch(p), [
            { from: 10, comma: 0 }, { from: 3303, comma: 1 }, { from: 13854, comma: -1 },
        ]);
        assertEq(stepFromSearch('13855'), 13854);
        assertEq(stepFromSearch(null), 0);
    });

    test('multi-onset lists keep literal commas in the query', () => {
        const p = new URLSearchParams({ fixture: 'bach_wtc2', mode: 'tp' });
        writeSideOverrides(p, [{ from: 3304, comma: 1 }, { from: 4123, comma: 1 }, { from: 13855, comma: -1 }]);
        assertEq(readableSearch(p), '?fixture=bach_wtc2&mode=tp&sharp=3305,4124&flat=13856');
        // The reader accepts the literal form it just wrote.
        assertEq(sideOverridesFromSearch(new URLSearchParams(readableSearch(p))), [
            { from: 3304, comma: 1 }, { from: 4123, comma: 1 }, { from: 13855, comma: -1 },
        ]);
    });
});
