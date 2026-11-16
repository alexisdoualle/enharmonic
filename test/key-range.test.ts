/**
 * KEY RANGE: a key signature transposes the spelling, at every signature from seven flats to seven sharps.
 *
 * Proposition: under a notated key signature, a tonal passage is spelled the same way in every key. Transposing the
 * MIDI and the signature together by k fifths moves every spelling k places along the line of fifths, whatever k: in
 * C major the dominant's leading tone is F♯, under seven sharps (C♯ major) it is F𝄪, and under seven flats (C♭ major)
 * the subdominant's fourth is B♭♭. A seven-accidental limit belongs to the signatures a key reader may invent, never
 * to the keys next to a notated signature, which run to ±8 (G♯ major from C♯ major, F♭ major from C♭ major) and their
 * secondary dominants further (C𝄪 in C♯ major's V/ii).
 *
 * Guards the bug class of prod 0.2.0: the two-pass `anchoredSideKeys` read a local key only within ±7, so G♯ major
 * (+8) under seven sharps became A♭ (−4) and both passes wrote A♭, E♭, C (fixed in 0.2.1, `1381b38`); the
 * look-ahead's `SpellingEngine.sideKey` had the same ±7 limit (G♯ major under seven sharps re-centred the fold on A♭).
 *
 * What is asserted, per mode (two-pass with `keySignatures`, real time and look-ahead with `keyTonic`/`setKey`): each
 * passage, spelled in C with no accidental beyond the chromatic notes named below, comes out spelled exactly that way
 * transposed by k fifths, for k = −7..+7. The passages are long enough for the key readers' windows (±48 onsets) to
 * read the new key. NOT asserted, by design:
 *   - keys two or more fifths from the signature (D major under C major's signature, i.e. D♯ major under seven
 *     sharps): there the side is the one read from the notes (`SIGNATURE_NEIGHBOURHOOD`, the open `tp-keysig`
 *     let-go question), and that reader keeps the conventional ±7 limit;
 *   - keyless runs: the cold start and the fold basin are parked on a convention (C, and the sharp-side basin), so
 *     a keyless passage is not expected to transpose.
 */

import { assertEq, suite, test } from './framework.js';
import { Speller, spellTwoPass, type Pitch, type PitchClass } from '../src/index.js';
import { drive, onNotes, type BatchEv } from './eval/fixtures.js';

const SLOT: Record<string, number> = { F: 0, C: 1, G: 2, D: 3, A: 4, E: 5, B: 6 };
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LOF_STEP = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
/** Line of fifths of a spelling (C = 0, G = +1, F♯ = +6, B♭ = −2). */
const lof = (p: PitchClass | Pitch | null): number => (p ? SLOT[p.step]! - 1 + 7 * p.alter : NaN);
const nameOf = (n: number): string => { const a = Math.floor((n + 1) / 7); return LOF_STEP[n + 1 - 7 * a]! + (a > 0 ? '#'.repeat(a) : 'b'.repeat(-a)); };

/** A spelled note in C: 'F#4' → its MIDI and line of fifths. */
function note(s: string): { midi: number; n: number } {
    const m = /^([A-G])(#*|b*)(-?\d)$/.exec(s)!;
    const alter = m[2]!.startsWith('#') ? m[2]!.length : -m[2]!.length;
    return { midi: 12 * (+m[3]! + 1) + SEMI[m[1]!]! + alter, n: SLOT[m[1]!]! - 1 + 7 * alter };
}
type Chord = string;   // 'C3 E4 G4 C5', bass first
const rep = (cs: Chord[], k: number): Chord[] => Array.from({ length: k }, () => cs).flat();

// Chords spelled in C major / A minor.
const C = 'C3 E4 G4 C5', F = 'F3 F4 A4 C5', G7 = 'G2 F4 B4 D5', G = 'G2 D4 G4 B4', Am = 'A2 E4 A4 C5', Dm = 'D3 D4 F4 A4';
const D7 = 'D3 F#4 A4 C5', A7 = 'A2 C#4 E4 G4', E7 = 'E3 D4 G#4 B4', C7 = 'C3 E4 G4 Bb4', B7 = 'B2 D#4 F#4 A4', Em = 'E3 E4 G4 B4';
const inG = ['G2 D4 G4 B4', 'C3 E4 G4 C5', 'D3 C4 F#4 A4', 'G2 D4 G4 B4'];         // I–IV–V7–I in G
const inF = ['F2 C4 F4 A4', 'Bb2 D4 F4 Bb4', 'C3 Bb3 E4 G4', 'F2 C4 F4 A4'];       // I–IV–V7–I in F
const cad = [C, F, G7, C];

/** The passages, in C (signature 0). Each `sig` lists the signature per chord as an offset from the passage's key. */
const PASSAGES: { name: string; chords: Chord[]; resign?: number }[] = [
    { name: 'I–IV–V7–I cadences', chords: rep(cad, 16) },
    // The dominant as a key: G major with F♯ in C; G♯ major with F𝄪 under seven sharps (+8 on the line of fifths).
    { name: 'modulation to the dominant and back', chords: [...rep(cad, 8), C, Am, D7, G, ...rep(inG, 30), G7, C, ...rep(cad, 8)] },
    // The subdominant as a key: F major with B♭ in C; F♭ major with B♭♭ under seven flats (−8).
    { name: 'modulation to the subdominant and back', chords: [...rep(cad, 8), C, C7, F, ...rep(inF, 30), G7, C, ...rep(cad, 8)] },
    // V/ii, V/vi, V/V as chords: C♯, G♯, F♯ in C; B♯, F𝄪, E♯ … under seven sharps; E♭♭-side mirrors under seven flats.
    { name: 'secondary dominants', chords: rep([C, A7, Dm, E7, Am, D7, G, G7, C, F, G7, C], 8) },
    // A minor with V/iv, V/V and V: D♯ and G♯ in A minor; under seven sharps (A♯ minor) B♯–D𝄪–F𝄪 and E♯–G𝄪–B♯.
    { name: 'minor key with secondary dominants', chords: [...rep([Am, Dm, E7, Am], 2), ...rep([Am, Dm, B7, E7, Am, A7, Dm, E7, Am], 8)] },
    // The composer writes the dominant's signature for the G-major section (one sharp more), then the tonic's again.
    { name: 'modulation to the dominant under its own signature', chords: [...rep(cad, 8), C, Am, D7, G, ...rep(inG, 30), G7, C, ...rep(cad, 8)], resign: 1 },
];
// The section of the re-signed passage under the dominant's signature (chord indices).
const RESIGN_FROM = 36, RESIGN_TO = 36 + 120;

/** MIDI shift (−5..+6 semitones) that takes C to the major tonic k fifths away. */
const shiftFor = (k: number): number => { const s = (((7 * k) % 12) + 12) % 12; return s > 6 ? s - 12 : s; };

/** The passage transposed to signature k: events, the expected line of fifths per note, and each note's signature. */
function build(p: (typeof PASSAGES)[number], k: number) {
    const ev: BatchEv[] = [], want: number[] = [], sigs: number[] = [], sigAtOn: number[] = [];
    let t = 0;
    p.chords.forEach((ch, ci) => {
        const sig = k + (p.resign && ci >= RESIGN_FROM && ci < RESIGN_TO ? p.resign : 0);
        const ns = ch.split(' ').map(note).map(x => ({ midi: x.midi + shiftFor(k), n: x.n + k })).sort((a, b) => a.midi - b.midi);
        for (const x of ns) { ev.push({ t, type: 'on', midi: x.midi }); want.push(x.n); sigs.push(sig); }
        sigAtOn.push(sig);
        t += 500;
        for (const x of ns) ev.push({ t, type: 'off', midi: x.midi });
    });
    return { ev, want, sigs, sigAtOn };
}

type Mode = 'two-pass' | 'real-time' | 'look-ahead';
function spell(mode: Mode, b: ReturnType<typeof build>): number[] {
    if (mode === 'two-pass') return spellTwoPass(onNotes(b.ev), { keySignatures: b.sigs }).map(lof);
    // Streaming: keyTonic at the start, setKey before the first note of each chord whose signature changed.
    const s = new Speller({ keyTonic: b.sigAtOn[0]!, lookAhead: mode === 'look-ahead' });
    let chord = -1, lastT = NaN, cur = b.sigAtOn[0]!;
    const proxy = {
        lookAhead: s.lookAhead,
        noteOn: (m: number, ctx: Parameters<Speller['noteOn']>[1] = {}) => {
            if (ctx.t !== lastT) { chord++; lastT = ctx.t!; const sig = b.sigAtOn[chord]!; if (sig !== cur) { s.setKey(sig); cur = sig; } }
            s.noteOn(m, ctx);
        },
        noteOff: (m: number, ctx?: { t?: number }) => s.noteOff(m, ctx),
        getSpelling: (m: number) => s.getSpelling(m),
    };
    return drive(proxy, b.ev).map(lof);
}

/** The first note off its transposed spelling, or '' when every note is right. */
function firstMiss(mode: Mode, p: (typeof PASSAGES)[number], k: number): string {
    const b = build(p, k), got = spell(mode, b);
    const bad = got.map((n, i) => i).filter(i => got[i] !== b.want[i]);
    if (!bad.length) return '';
    const i = bad[0]!;
    return `signature ${k}: ${bad.length} notes off, first #${i} ${nameOf(got[i]!)} (want ${nameOf(b.want[i]!)})`;
}

for (const mode of ['two-pass', 'real-time', 'look-ahead'] as Mode[]) {
    suite(`key range: ${mode} transposes with the signature, seven flats to seven sharps`, () => {
        for (const p of PASSAGES) {
            test(p.name, () => {
                const misses: string[] = [];
                for (let k = -7; k <= 7; k++) {
                    if (p.resign && k + p.resign > 7) continue;   // no signature past seven sharps
                    const m = firstMiss(mode, p, k);
                    if (m) misses.push(m);
                }
                assertEq(misses, []);
            });
        }
    });
}
