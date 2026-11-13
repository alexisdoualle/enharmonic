# enharmonic

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23023002.svg)](https://doi.org/10.5281/zenodo.23023002)

**Real-time enharmonic pitch-spelling for MIDI input.**

Given a stream of MIDI note numbers, decides whether `61` should be spelled `C♯` or `D♭`
from musical context. Zero runtime dependencies. ESM / TypeScript. Apache-2.0.

```bash
npm install enharmonic
```

## Quickstart

```ts
import { Speller, spellTwoPass } from 'enharmonic';

// Real-time (zero look-ahead)
const s = new Speller();
s.noteOn(60, { t: 0 });
s.noteOn(64, { t: 0 });
s.noteOn(67, { t: 0 });
console.log(s.getSpelling(64)); // { step: 'E', alter: 0, octave: 4 }
s.noteOff(60, { t: 500 }); s.noteOff(64, { t: 500 }); s.noteOff(67, { t: 500 });

// Near-real-time: feed resolveDir (and resolveExact) from a small forward buffer
const nrt = new Speller({ lookAhead: true });
nrt.noteOn(61, { t: 0, resolveDir: 1, resolveExact: 1 }); // resolves up to 62 → prefer C♯ over D♭

// Offline ceiling (whole piece in hand)
const spelled = spellTwoPass([
  { midi: 60, tOn: 0, tOff: 500 },
  { midi: 64, tOn: 0, tOff: 500 },
]);
```

## API

| Call | Latency | Role |
|---|---|---|
| `new Speller()` | real-time | Recency guard + spiral fold + diatonic-anchor leash |
| `new Speller({ lookAhead: true })` | near-real-time | + letter-aware look-ahead + vertical guard + aug6 outward rule + leading-tone gate |
| `spellTwoPass(notes)` | offline | Forward + backward, reconciled at modulation boundaries (aug6 rule and leading-tone gate in both passes) |

Frameless and key-signature-free: the side a passage settles on is a statistic of the notes
committed so far, never a detected key. (A local key, read from the notes around each note, is used
only to name a falling leading tone; see below.)

### Timing

The speller is onset-based, not wall-clock-based. Each note's `t` groups co-struck notes: notes
sharing a `t` are one onset (a chord), and a new `t` starts a new onset. Omit `t` and every call is
its own onset, which is fine for a purely melodic stream.

```ts
s.noteOn(60, { t: 0 }); s.noteOn(64, { t: 0 }); s.noteOn(67, { t: 0 }); // one chord (same t)
s.noteOn(69, { t: 500 });                                               // next onset
```

For live input pass real timestamps; for batch replay pass an increasing `t` per onset.

Within an onset, notes arrive one by one (bass first in a score). When a later note of the same onset
arrives, the earlier ones are decided again with it sounding, so a bass can follow the chord above it.
A note's spelling can therefore change until its onset is complete.

Pass `t` to `noteOff` too. A chromatic note that ends within 80 ms of its onset (a grace note) does not
shape how later notes are spelled; without `t` every note counts.

### Look-ahead context

`resolveDir` is the first semitone step from the note to an upcoming note in any octave (+1 up, −1 down,
0 none); `resolveExact` is the same at the exact pitch, the note's own line. `resolveStep` and
`resolveExactStep` compute each from a pair of midi numbers. The exact one lets a rising chromatic line
(B, B♯, C♯) through the recency guard.

`outwardPartner` and `outwardRole` name an augmented sixth by where its tones go: two tones ten semitones
apart that move outward onto one pitch class (A♭–C–E♭–F♯ → G) make the rising tone the ♯4, spelled F♯
against A♭, not G♭. `outwardPairs(notes)` finds the pairs from `{ midi, tOn, tOff }` notes sorted by onset;
the tones meet when one of the next 8 onsets strikes both goals, or when their first moves (re-strikes skipped)
land on one onset, so a German sixth repeated across a bar still pairs (`{ firstMoveMeet: false }` turns that
off; in `spellTwoPass`, `aug6FirstMoveMeet: false`). Pass each note's partner midi and role (+1 rising, −1 falling) when it has one. The engine applies the rule
only when the meeting pitch is in the key and the rising tone is not, so a dominant seventh whose diatonic
seventh rises chromatically (D→D♯ in E7) keeps its spelling. `spellTwoPass` does this itself (`aug6Outward: false` turns it off).

`localKey` names a leading tone of the local key (its ♯4 leading to the dominant; in minor also the raised
6th and 7th): a falling chromatic line from it cancels it, so C♯→C in D minor stays C♯ instead of the
look-ahead's letter step D♭→C. `localKeys(notes)` reads each note's key from `{ midi, tOn }` notes, on the
onsets from 6 before to 6 after the note's own, by correlation with Temperley's key profiles (*Music and
Probability*, 2007); pass it as `localKey`. Rising notes are untouched. `spellTwoPass` does this itself with a
key table from theory instead (a key is its tonic triad inside its seven-note collection, no fitted numbers)
on ±12 onsets (`leadingToneGate: false` turns it off).

### Optional key hint (experimental)

Keyless, the speller parks its spiral fold on the sharp side, so a genuinely flat piece can drift to its
sharp enharmonic (D♭ to C♯). Passing the key re-centres the fold and holds the notated side:

```ts
const s = new Speller({ keyTonic: -5 });   // D♭ major: signed line-of-fifths of the MAJOR tonic
s.setKey(2);                                // re-centre mid-stream at a key change (here, D major)
```

`keyTonic` is the signed line-of-fifths of the major tonic (C=0, G=+1, F=−1, D♭=−5; for a minor key pass
its relative major, A minor to C=0). Experimental; omit it for the default keyless behaviour above.

## Status

The shipped library is the speller above: the real-time `Speller`, its look-ahead setting, and the
offline `spellTwoPass`.

Held-out Meredith (216 movements, 195,972 notes), the standard pitch-spelling benchmark, level with the
best deterministic and neural spellers (ps13, Temperley, Chew & Chen, PKSpell, scored on the same notes
in `test/eval/meredith-baselines.json`). `exact` is a strict composer-spelling match; `coherent` also
counts a contextually coherent enharmonic flip (the other, equally-correct side of the comma):

| Mode | clean exact | clean coherent | noisy exact | noisy coherent |
|---|--:|--:|--:|--:|
| [Core](examples/core-speller.ts) (four principles) | 99.37% | 99.46% | 99.28% | 99.46% |
| Real-time | 99.57% | 99.62% | 99.55% | 99.59% |
| + look-ahead | 99.80% | 99.85% | 99.74% | 99.77% |
| + two-pass | 99.89% | 99.89% | 99.84% | 99.86% |

The gap between coherent and exact is the *side*: a whole passage settled on the other side of the
comma (D♭–F–A♭ for C♯–E♯–G♯), a coherent transposition, not an incoherent error.

## Performance

Node v23.9 on an Apple M1 Pro, Meredith corpus (195,972 notes per variant), median of 3 runs, spelling
time only (driver and speller; parsing and scoring excluded):

| mode | clean | notes/s (clean) | noisy | notes/s (noisy) |
|---|--:|--:|--:|--:|
| core | 0.14 s | 1,400,000 | 0.14 s | 1,400,000 |
| real-time | 0.92 s | 213,000 | 0.75 s | 261,000 |
| look-ahead | 1.21 s | 162,000 | 1.03 s | 190,000 |
| two-pass | 2.08 s | 94,000 | 2.08 s | 94,000 |

Look-ahead and two-pass include finding the aug6 outward pairs (`outwardPairs`) and the local keys
(`localKeys`). Timings vary by CPU and
machine load; reproduce with `npm run meredith -- --time` (add `--noisy` for the
noisy set).

## The four principles

The smallest form of the model is [`examples/core-speller.ts`](examples/core-speller.ts): the speller in
~100 lines, zero imports, built from four principles and nothing else.

1. **Interval scoring.** Among a pitch's enharmonic candidates, pick the one that forms the most
   consonant intervals with the running scale. The scale drifts into key with no key detection.
2. **The seven-letter limit.** The running scale holds one spelling per letter A–G. Spelling a note is
   choosing which letter it claims.
3. **The recency guard.** Dock a candidate whose letter was last committed at a different accidental a
   few onsets ago, so a slot cannot flicker against its recent self.
4. **The spiral fold.** Interval scoring is relative, so it cannot tell D♭ from C♯: a run of sharp choices
   can walk the whole scale a comma sharp (C𝄪 D♯ E♯ F𝄪 G♯ A♯ B♯). When the scale's average
   line-of-fifths position drifts more than 8 fifths from D, every slot moves one comma back (E♯ becomes
   F, B♯ becomes C).

The first three all but solve *coherence* (intervals right, flicker-free). The fold keeps the scale on the
conventional side of the spiral: **99.46% coherent** and **99.37% exact** on Meredith, **98.16%** coherent
and **91.34%** exact on the harder, less-overfit curated corpus. The remaining gap between coherent and
exact is the *side* of single passages, which the fold only catches on a large drift. The shipped
`Speller` tracks the side more closely.

## Reproducing the Meredith benchmark

```bash
scripts/fetch-meredith.sh        # download the corpus (gitignored; ~2 MB from titanmusic.com)
npm run meredith                 # score the clean corpus
npm run meredith -- --noisy      # the noisy (human-MIDI-like) variant
npm run meredith -- --check      # assert exact% >= published thresholds
```

`exact` = strict composer-spelling match (ps13's metric); `coherent` = exact + contextually coherent enharmonic flip.

## Citing

Cite the archived release on Zenodo: [10.5281/zenodo.23023002](https://doi.org/10.5281/zenodo.23023002)
(all versions). Each release also has its own DOI on the Zenodo record. GitHub's "Cite this repository"
button gives the full reference from [CITATION.cff](CITATION.cff).

## License

Apache-2.0

See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for third-party attributions.
