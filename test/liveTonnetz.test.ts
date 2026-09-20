import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, assertEq, suite, test } from './framework.js';
import { LiveSpeller } from '../viz/src/live.js';
import { selectSevenNodeLoF } from '../viz/src/tonnetzLine.js';
import { buildReplay, type Expected, type RawEvent } from '../viz/src/replay.js';

// These 3D-tonnetz geometry checks run against a private, gitignored fixture (the Mozart Requiem), so
// they only run on a machine that has it. On a clean checkout / CI, skip rather than crash at import.
const fixtureRoot = join(process.cwd(), 'local-fixtures', 'mozart_requiem');

if (!existsSync(join(fixtureRoot, 'events.json'))) {
    suite('live Tonnetz geometry', () => {
        test('skipped — local-fixtures/mozart_requiem not present', () => { /* private fixture absent */ });
    });
} else {
    const replay = buildReplay(
        'la',
        JSON.parse(readFileSync(join(fixtureRoot, 'events.json'), 'utf8')) as RawEvent[],
        JSON.parse(readFileSync(join(fixtureRoot, 'expected.json'), 'utf8')) as Expected[],
        { spiralRange: 6, spiralCenter: 1 },
    );

    const snapshot = (onIndex: number) => replay.snapshots.find(s => s.onIndex === onIndex)!;
    const apply = (model: LiveSpeller, onIndex: number): string[] => {
        const s = snapshot(onIndex);
        model.setPlaybackState(s.resolvedScale!, s.sounding, s.midi, s.committed);
        return model.state().filledCells;
    };

    suite('live Tonnetz geometry', () => {
        test('retains C♯ as the z bridge in the D-minor surface', () => {
            const cells = apply(new LiveSpeller(), 27);
            assert(cells.includes('0:0:1'), 'expected C♯ at (0,0,1)');
            assert(cells.includes('1:0:0'), 'expected the natural-G home column');
        });

        test('chooses local G♯ deformation over a four-position LoF migration', () => {
            const model = new LiveSpeller();
            const previous = apply(model, 27);
            const current = apply(model, 28);
            const priorLine = selectSevenNodeLoF(previous)!;
            const line = selectSevenNodeLoF(current, { previous: priorLine })!;

            assert(current.includes('1:0:1'), 'expected the local G♯ candidate at (1,0,1)');
            assert(current.includes('8:0:0'), 'expected direct G♯ to remain a valid candidate');
            assert(line.has('1:0:1'), 'expected the continuity-cost winner to use local G♯');
            assert(!line.has('8:0:0'), 'expected the continuity-cost winner to reject the +4 migration');
            assert(model.state().backboneCells.includes('1:0:1'), 'expected the chosen backbone in LiveState');
            assert(!model.state().backboneCells.includes('8:0:0'), 'expected LiveState to expose the local backbone');
            assertEq(Math.min(...[...line].map(k => Number(k.split(':')[0]))), -2);
        });

        test('uses direct LoF spelling when no prior line makes a local deformation available', () => {
            const cells = apply(new LiveSpeller(), 28);
            assert(cells.includes('8:0:0'), 'expected direct G♯ at (8,0,0)');
            assert(!cells.includes('1:0:1'), 'did not expect a history-free local G♯ candidate');
        });
    });
}
