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
s.noteOff(60); s.noteOff(64); s.noteOff(67);

// Near-real-time: feed resolveDir from a small forward buffer
const nrt = new Speller({ lookAhead: true });
nrt.noteOn(61, { t: 0, resolveDir: 1 }); // e.g. resolves up → prefer C♯ over D♭

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
| `new Speller({ lookAhead: true })` | near-real-time | + letter-aware look-ahead + vertical guard |
| `spellTwoPass(notes)` | offline | Forward + backward, reconciled at modulation boundaries |

Frameless and key-signature-free: the side a passage settles on is a statistic of the notes
committed so far, never a detected key.

### Timing

The speller is onset-based, not wall-clock-based. Each note's `t` groups co-struck notes: notes
sharing a `t` are one onset (a chord), and a new `t` starts a new onset. Omit `t` and every call is
its own onset, which is fine for a purely melodic stream.

```ts
s.noteOn(60, { t: 0 }); s.noteOn(64, { t: 0 }); s.noteOn(67, { t: 0 }); // one chord (same t)
s.noteOn(69, { t: 500 });                                               // next onset
```

For live input pass real timestamps; for batch replay pass an increasing `t` per onset.

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
| [Core](examples/core-speller.ts) (four principles) | 99.37% | 99.46% | 99.29% | 99.47% |
| Real-time | 99.53% | 99.58% | 99.55% | 99.58% |
| + look-ahead | 99.67% | 99.72% | 99.61% | 99.72% |
| + two-pass | 99.86% | 99.86% | 99.79% | 99.80% |

The gap between coherent and exact is the *side*: a whole passage settled on the other side of the
comma (D♭–F–A♭ for C♯–E♯–G♯), a coherent transposition, not an incoherent error.

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
conventional side of the spiral: **99.46% coherent** and **99.37% exact** on Meredith, **97.99%** coherent
and **91.29%** exact on the harder, less-overfit curated corpus. The remaining gap between coherent and
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
