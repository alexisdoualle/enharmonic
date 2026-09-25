# enharmonic

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
| [Core](examples/core-speller.ts) (three principles) | 97.56% | 99.44% | 96.25% | 99.44% |
| Real-time | 99.53% | 99.58% | 99.55% | 99.58% |
| + look-ahead | 99.67% | 99.72% | 99.61% | 99.72% |
| + two-pass | 99.86% | 99.86% | 99.79% | 99.80% |

The gap between coherent and exact is the *side*: a whole passage settled on the other side of the
comma (D♭–F–A♭ for C♯–E♯–G♯), a coherent transposition, not an incoherent error.

## The three principles

The smallest form of the model is [`examples/core-speller.ts`](examples/core-speller.ts): the speller in
~100 lines, zero imports, built from three principles and nothing else.

1. **The seven-letter limit.** A running resolved scale holds one spelling per letter A–G. Spelling a
   note is choosing which letter it claims.
2. **Interval scoring.** Among a pitch's enharmonic candidates, pick the one that forms the most
   consonant intervals with the rest of the scale. The scale drifts into key with no key detection.
3. **The recency guard.** Dock a candidate whose letter was last committed at a different accidental a
   few onsets ago, so a slot cannot flicker against its recent self.

These alone all but solve *coherence* (intervals right, flicker-free): **99.44% coherent** on Meredith,
**97.69%** on the harder, less-overfit curated corpus. The lower **exact** rate (**97.56%** on Meredith,
**68.04%** on the curated corpus) is the gap the three principles leave open, and it is almost entirely
the *side*, not incoherence: with no key prior a passage can settle on the other side of the spiral. The
shipped `Speller` adds the side correction that closes it.

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
