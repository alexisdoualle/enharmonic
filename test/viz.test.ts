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
import { FIXTURES, REPO_ROOT, loadEvents, loadExpected, predict, type Mode } from './eval/fixtures.js';
import { scoreTiers } from './eval/score.js';
import { buildReplay, type RawEvent } from '../viz/src/replay.js';

const MODES: Mode[] = ['rt', 'la', 'tp'];

/** Raw events.json (on/off/respell) — what the viz consumes directly. */
const loadRaw = (id: string): RawEvent[] =>
    JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[];

suite('viz ↔ bench parity', () => {
    for (const id of FIXTURES) {
        for (const mode of MODES) {
            test(`${id}/${mode}: viz tally == bench scoreTiers`, () => {
                const raw = loadRaw(id);
                const expected = loadExpected(id);
                const vizTally = buildReplay(mode, raw, expected).tally;
                const bench = scoreTiers(predict(mode, loadEvents(id)), expected);
                assertEq(
                    { correct: vizTally.correct, flipped: vizTally.flipped, wrong: vizTally.wrong, unread: vizTally.unread, total: vizTally.total },
                    { correct: bench.correct, flipped: bench.flipped, wrong: bench.wrong, unread: bench.unread, total: bench.total },
                );
            });
        }
    }
});
