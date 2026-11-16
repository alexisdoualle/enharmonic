/**
 * Invariants every spelling the library returns must satisfy, whatever the speller decides.
 *
 * The parity and accuracy suites compare letters and accidentals only, so they cannot see a wrong
 * OCTAVE. Until 0.2.2 `getSpelling` computed the octave as floor(midi / 12) - 1, which put every B♯ and
 * B𝄪 an octave too high and every C♭ and C𝄫 an octave too low (B♯ at MIDI 60 came back as B♯4 = MIDI 72).
 * These tests hold the round trip: midiOf(pitch) === the MIDI number that was played.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { suite, test, assert, assertEq } from './framework.js';
import { Speller, midiOf, pitchAt, pitchToString, type Pitch, type PitchClass, type Letter, type Accidental } from '../src/index.js';
import { CoreSpeller } from '../src/core.js';
import { FIXTURES, REPO_ROOT, loadEvents, loadExpected, drive } from './eval/fixtures.js';

const LETTERS: Letter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ALTERS: Accidental[] = [-2, -1, 0, 1, 2];
const BASE: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Every returned Pitch must sound at the MIDI number it was asked for. */
function roundTrips(p: Pitch | null, midi: number): string | null {
    if (p === null) return null;
    const back = 12 * (p.octave + 1) + BASE[p.step] + p.alter;
    return back === midi ? null : `${pitchToString(p)} is MIDI ${back}, played ${midi}`;
}

suite('pitch invariants: octave follows the letter', () => {
    test('pitchAt: every spelling of every MIDI number round-trips', () => {
        let n = 0;
        for (let midi = 0; midi <= 127; midi++) for (const step of LETTERS) for (const alter of ALTERS) {
            if (((BASE[step] + alter - midi) % 12 + 12) % 12 !== 0) continue;
            const p = pitchAt({ step, alter } as PitchClass, midi);
            const back = 12 * (p.octave + 1) + BASE[p.step] + p.alter;
            if (back >= 0 && back <= 127) assertEq(midiOf(p), midi, `${step}${alter} at ${midi}`);
            assertEq(back, midi, `${pitchToString(p)} at ${midi}`);
            n++;
        }
        assert(n > 128 * 2, `checked ${n}`);
    });

    test('pitchAt: the B–C boundary cases by name', () => {
        const at = (step: Letter, alter: Accidental, midi: number) => pitchToString(pitchAt({ step, alter }, midi));
        assertEq(at('B', 1, 60), pitchToString({ step: 'B', alter: 1, octave: 3 }));   // B♯3 = middle C
        assertEq(at('B', 2, 61), pitchToString({ step: 'B', alter: 2, octave: 3 }));   // B𝄪3
        assertEq(at('C', -1, 71), pitchToString({ step: 'C', alter: -1, octave: 5 })); // C♭5 = B4
        assertEq(at('C', -2, 70), pitchToString({ step: 'C', alter: -2, octave: 5 })); // C𝄫5
        assertEq(at('C', 0, 60), pitchToString({ step: 'C', alter: 0, octave: 4 }));
        assertEq(at('B', 0, 71), pitchToString({ step: 'B', alter: 0, octave: 4 }));
    });

    test('getSpelling: a B♯ at MIDI 60 is B♯3 (C♯ minor, G♯ dominant)', () => {
        for (const mk of [() => new Speller(), () => new Speller({ lookAhead: true }), () => new CoreSpeller()]) {
            const s = mk();
            let t = 0;
            // C♯ minor tonic, then its dominant G♯ major with the B♯ leading tone at middle C.
            for (const chord of [[49, 56, 61, 64], [44, 56, 60, 63], [49, 56, 61, 64], [44, 56, 60, 63]]) {
                for (const m of chord) s.noteOn(m, { t });
                if (chord.includes(60)) {
                    const p = s.getSpelling(60)!;
                    assert(p !== null, 'no spelling for 60');
                    assertEq(roundTrips(p, 60), null);
                    if (p.step === 'B') assertEq(p.octave, 3, 'B♯ at MIDI 60 must be octave 3');
                }
                t += 500;
                for (const m of chord) s.noteOff(m, { t });
            }
        }
    });

    test('getSpelling round-trips on every curated fixture (Core, RT, LA)', () => {
        const bad: string[] = [];
        let n = 0;
        for (const id of FIXTURES) {
            const ev = loadEvents(id);
            const midis = ev.filter(e => e.type === 'on').map(e => e.midi);
            for (const [name, s] of [['core', new CoreSpeller()], ['rt', new Speller()], ['la', new Speller({ lookAhead: true })]] as const) {
                const out = drive(s, ev);
                out.forEach((p, i) => { n++; const err = roundTrips(p, midis[i]!); if (err && bad.length < 5) bad.push(`${id} ${name} #${i}: ${err}`); });
            }
        }
        assertEq(bad, [], `${bad.length} octave errors in ${n} notes`);
    });

    test('expected spellings round-trip through pitchAt on every fixture (B♯/C♭ present)', () => {
        let boundary = 0;
        for (const id of readdirSync(join(REPO_ROOT, 'fixtures'))) {
            if (!existsSync(join(REPO_ROOT, 'fixtures', id, 'expected.json'))) continue;
            const midis = loadEvents(id).filter(e => e.type === 'on').map(e => e.midi);
            loadExpected(id).forEach((x, i) => {
                if (!x) return;
                const p = pitchAt({ step: x.step as Letter, alter: x.alter as Accidental }, midis[i]!);
                assertEq(roundTrips(p, midis[i]!), null, `${id} #${i}`);
                if ((x.step === 'B' && x.alter > 0) || (x.step === 'C' && x.alter < 0)) boundary++;
            });
        }
        assert(boundary > 100, `only ${boundary} B♯/C♭ notes: the boundary is not being exercised`);
    });
});
