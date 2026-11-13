/** Box-select passage export (viz/src/passage.ts): the box URL form and the report's sections. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, assertEq, suite, test } from './framework.js';
import { REPO_ROOT, loadExpected } from './eval/fixtures.js';
import { buildReplay, type RawEvent } from '../viz/src/replay.js';
import { initialState } from '../viz/src/state.js';
import { clampBox, formatBox, parseBox, passageReport } from '../viz/src/passage.js';

suite('viz passage export', () => {
    test('box param round-trips and orders its ends', () => {
        assertEq(parseBox('1185-1160:80-40'), { onFrom: 1160, onTo: 1185, midiLo: 40, midiHi: 80 });
        assertEq(formatBox(parseBox('1160-1185:40-80')!), '1160-1185:40-80');
        assertEq(parseBox('nonsense'), null);
        assertEq(parseBox(null), null);
    });
    test('mozart_k545 la m68: aug6 rule named for the Ab grace notes, every section present', () => {
        const id = 'mozart_k545';
        const replay = buildReplay('la', JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', id, 'events.json'), 'utf8')) as RawEvent[], loadExpected(id), {});
        const g = globalThis as { location?: unknown };
        const had = 'location' in g, prev = g.location;
        g.location = { href: 'http://localhost/?fixture=mozart_k545&mode=la&box=1160-1185:0-127' };
        try {
            const box = clampBox(parseBox('1160-1185:0-127')!, replay)!;
            const text = passageReport({ ...initialState, fixtureId: id, replay }, box);
            for (const h of ['## piano roll', '## voices', '## harmony timeline', '## decisions', '## patterns'])
                assert(text.includes(h), `missing ${h}`);
            assert(text.includes('F# diminished 7'), 'harmony names the dim7');
            assert(/68:3 .*ours Ab5 {2}composer G#5 {2}wrong/.test(text), 'the wrong Ab5 is reported');
            assert(text.includes('tipped by: aug6 outward rule'), 'aug6 override detected');
            assert(!/[♯♭]/.test(text), 'ASCII accidentals only');
        } finally { if (had) g.location = prev; else delete g.location; }
    });
});
