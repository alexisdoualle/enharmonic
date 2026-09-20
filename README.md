# enharmonic

**Real-time enharmonic pitch-spelling for MIDI input.**

Given a stream of MIDI note numbers, decides whether `61` should be spelled `C♯` or `D♭`
from musical context. Zero runtime dependencies. ESM / TypeScript. Apache-2.0.

```bash
npm install enharmonic   # not yet published
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

// Near-real-time — feed resolveDir from a small forward buffer
const nrt = new Speller({ lookAhead: true });
nrt.noteOn(61, { t: 0, resolveDir: 1 }); // e.g. resolves up → prefer E♯ over F

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

For live input pass real timestamps; for batch replay pass an increasing `t` per onset. `SpellerOptions`
still accepts `clock` and `baseWindowMs`, but they are no-ops: they parameterised an earlier
time-windowed design and are kept only so existing callers compile.

## Status

Extracted from a larger research codebase; the algorithm's development history and the full
benchmark corpora live in a separate research repository. The shipped library is the two spellers above.

Held-out Meredith (216 movements, 195,972 notes), exact composer-spelling match, the
literature-standard benchmark ps13 / Temperley / Chew & Chen / PKSpell report on:

| Mode | clean | noisy |
|---|--:|--:|
| Real-time | 99.52% | 99.44% |
| + look-ahead | 99.70% | 99.70% |
| + two-pass | 99.86% | 99.79% |

The remaining gap is mostly coherent enharmonic flips: the other, equally-correct side of the
comma (D♭–F–A♭ for C♯–E♯–G♯), not incoherent errors.

## Reproducing the Meredith benchmark

```bash
scripts/fetch-meredith.sh        # download the corpus (gitignored; ~2 MB from titanmusic.com)
npm run meredith                 # score the clean corpus
npm run meredith -- --noisy      # the noisy (human-MIDI-like) variant
npm run meredith -- --check      # assert exact% >= published thresholds
```

`exact` = strict composer-spelling match (ps13's metric); `coherent` = exact + contextually coherent enharmonic flip.

## License

Apache-2.0

See [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for third-party attributions.
