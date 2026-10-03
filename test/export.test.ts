/**
 * MusicXML export of a live take: quantising, voices, bars and ties (the layout), plus the written octave
 * and the encoding mark. The XML itself is re-imported in the browser; here the layout is checked.
 */
import { assert, assertEq, suite, test } from './framework.js';
import { layoutTake, toMusicXml, writtenOctave, type ExportNote, type Ev } from '../viz/src/export/musicxml.js';

// 120 bpm in 4/4: a beat is 500 ms, a 16th 125 ms, a bar 2000 ms. Bar 1 starts at t0.
const t0 = 1000;
const n = (midi: number, step: string, alter: number, on: number, off: number): ExportNote =>
    ({ midi, step, alter, onT: t0 + on, offT: t0 + off });
const notes: ExportNote[] = [
    n(60, 'C', 0, -40, 480), n(63, 'E', -1, -32, 480), n(67, 'G', 0, -24, 480),   // early, rolled chord
    n(69, 'A', 0, -30, 2000),                                                       // held the whole bar
    n(74, 'D', 0, 520, 1030),                                                       // 20 ms late, legato overlap
    n(76, 'E', 0, 1000, 1370), n(77, 'F', 0, 1375, 1490),                           // dotted 8th + 16th
    n(79, 'G', 0, 1500, 2500),                                                      // tied over the bar line
    n(48, 'C', 0, 0, 4000),                                                         // bass: two whole notes
];
const input = { notes, grid: { bpm: 120, num: 4, den: 4, t0, t1: t0 + 4000 }, keys: [{ t: t0, fifths: -3 }], title: 'test', speller: 'real-time' };
const L = layoutTake(input);
const attacks = (L.staves.flat(2).flat() as Ev[]).filter(e => e.pitches.length && !e.tieStop);
const at = (midi: number) => attacks.find(e => e.pitches.some(p => p.midi === midi));

suite('MusicXML export', () => {
    test('the recording sets the bar count and the frame sets the key', () => {
        assertEq(L.bars, 2);
        assertEq(L.keys.join(','), '-3,-3');
    });

    test('every voice fills every bar exactly', () => {
        L.staves.forEach((voices, s) => voices.forEach((bars, v) => bars.forEach((evs, b) =>
            assertEq(evs.reduce((a, e) => a + e.dur, 0), L.barLen, `staff ${s + 1} voice ${v + 1} bar ${b + 1}`))));
    });

    test('an early, rolled chord lands on beat 1 as one chord', () => {
        const c = at(60)!;
        assertEq(c.start, 0);
        assertEq(c.pitches.map(p => p.midi).join(','), '60,63,67');
        assertEq(c.dur, 4);
    });

    test('a note held under a moving line goes to a second voice', () => {
        const voices = L.staves[0]!;
        assert(voices.length >= 2, 'two treble voices');
        const v = voices.findIndex(bars => bars.flat().some(e => e.pitches.some(p => p.midi === 69)));
        const w = voices.findIndex(bars => bars.flat().some(e => e.pitches.some(p => p.midi === 60)));
        assert(v !== w, 'A4 and the chord are in different voices');
    });

    test('a late note snaps to the beat and a legato overlap is trimmed', () => {
        assertEq(at(74)!.start, 4);
        assertEq(at(74)!.dur, 4);
    });

    test('a dotted 8th and 16th keep their rhythm', () => {
        assertEq(at(76)!.start, 8); assertEq(at(76)!.dur, 3);
        assertEq(at(77)!.start, 11); assertEq(at(77)!.dur, 1);
    });

    test('a note over the bar line is tied', () => {
        const pieces = (L.staves.flat(2).flat() as Ev[]).filter(e => e.pitches.some(p => p.midi === 79));
        assertEq(pieces.map(e => `${e.start}:${e.dur}`).join(' '), '12:4 16:4');
        assert(pieces[0]!.tieStart && pieces[1]!.tieStop, 'tie start then stop');
    });

    test('spellings come through unchanged', () => {
        const e = at(63)!.pitches.find(p => p.midi === 63)!;
        assertEq(`${e.step}${e.alter}`, 'E-1');
    });

    test('the written octave follows the letter, not the midi', () => {
        assertEq(writtenOctave(60, 'B', 1), 3);    // B♯3 sounds as middle C
        assertEq(writtenOctave(59, 'C', -1), 4);   // C♭4 sounds as B3
        assertEq(writtenOctave(61, 'D', -1), 4);
    });

    test('the file marks its spellings as the speller\'s', () => {
        const xml = toMusicXml(L, input);
        assert(xml.includes('<software>enharmonic viz</software>'), 'software mark');
        assert(xml.includes('<fifths>-3</fifths>'), 'key');
        assert(xml.includes('<alter>-1</alter>'), 'alter');
        assert(xml.includes('<tie type="start"/>'), 'tie');
    });

    test('a chord released unevenly stays one chord in one voice', () => {
        // C major, then F major: the C chord's fingers lift 480, 620 and 700 ms after it (ends at 4, 5 and
        // 6 sixteenths), the last one an 8th into the F chord.
        const uneven = [n(60, 'C', 0, 0, 480), n(64, 'E', 0, 0, 620), n(67, 'G', 0, 0, 700),
            n(65, 'F', 0, 500, 1990), n(69, 'A', 0, 500, 1990), n(72, 'C', 0, 500, 1990)];
        const U = layoutTake({ ...input, notes: uneven, grid: { ...input.grid, t1: t0 + 2000 } });
        assertEq(U.staves[0]!.length, 1, 'one treble voice');
        const evs = U.staves[0]![0]![0]!.filter(e => e.pitches.length);
        // The F chord, beat 2 to the bar's end, is a quarter tied over the half bar to a half.
        assertEq(evs.map(e => `${e.start}:${e.dur}:${e.pitches.length}`).join(' '), '0:4:3 4:4:3 8:8:3');
    });
    test('five notes struck together, released apart, still fill each bar exactly', () => {
        const five = [72, 74, 76, 77, 79].map((m, k) => n(m, 'CDEFG'[k]!, 0, 0, 4000 - k * 500));
        const L5 = layoutTake({ ...input, notes: five });
        L5.staves.forEach((voices, s) => voices.forEach((bars, v) => bars.forEach((evs, b) =>
            assertEq(evs.reduce((a, e) => a + e.dur, 0), L5.barLen, `staff ${s + 1} voice ${v + 1} bar ${b + 1}`))));
        const struck = (L5.staves.flat(2).flat() as Ev[]).filter(e => e.pitches.length && !e.tieStop).flatMap(e => e.pitches.map(p => p.midi));
        assertEq([...struck].sort().join(','), '72,74,76,77,79');
    });
});
