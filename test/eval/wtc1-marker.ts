/**
 * Repeatable audit of the C♯/D♭ editorial marker in the stitched WTC I fixture.
 *
 * `npm run wtc1:marker` uses the sibling lab checkout by default. Override it with
 * `WTC1_FIXTURE=/path/to/bach_wtc1 npm run wtc1:marker` when the corpus lives elsewhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spellTwoPass } from '../../src/index.js';
import { scoreTiers } from './score.js';

type Event = { t_ms: number; type: 'on' | 'off'; midi: number };
type Expected = { step: string; alter: number };
const fixture = process.env.WTC1_FIXTURE
    ? resolve(process.env.WTC1_FIXTURE)
    : resolve('..', 'enharmonic-lab', 'fixtures', 'bach_wtc1');
const eventsPath = join(fixture, 'events.json'), expectedPath = join(fixture, 'expected.json');
if (!existsSync(eventsPath) || !existsSync(expectedPath)) {
    throw new Error(`WTC I fixture not found at ${fixture}; set WTC1_FIXTURE=/path/to/bach_wtc1`);
}
const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as Event[];
const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected[];
const notes: { midi: number; tOn: number; tOff: number }[] = [];
const open = new Map<number, number[]>();
for (const e of events) {
    if (e.type === 'on') {
        const i = notes.length;
        notes.push({ midi: e.midi, tOn: e.t_ms, tOff: e.t_ms });
        (open.get(e.midi) ?? open.set(e.midi, []).get(e.midi)!).push(i);
    } else if (e.type === 'off') {
        const i = open.get(e.midi)?.shift();
        if (i != null) notes[i]!.tOff = e.t_ms;
    }
}
const onsetKeys = notes.map(n => n.tOn);
const report = (name: string, predicted: ReturnType<typeof spellTwoPass>) => {
    const t = scoreTiers(predicted, expected, onsetKeys);
    console.log(`${name.padEnd(15)} exact ${t.correct}  flipped ${t.flipped}  wrong ${t.wrong}  total ${t.total}`);
};
console.log(`WTC I marker audit: ${fixture}`);
report('automatic', spellTwoPass(notes));
report('C# section', spellTwoPass(notes, { sideOverrides: [{ from: 5300, comma: 1 }, { from: 5423, comma: 0 }] }));
