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
| `new Speller()` | real-time | Diatonic box + keep-alive (default) |
| `new Speller({ lookAhead: true })` | near-real-time | + letter-aware look-ahead |
| `spellTwoPass(notes)` | offline | Forward + backward + boundary resolve |

Pass `clock: () => ms` (and per-event `t`) for deterministic / batch replay.

## Status

Private pre-release. Algorithm development and the full benchmark corpus live in the
companion lab repo. Headline figures (shared-50 fixtures, no-keys, three-tier scorer):

| Mode | wrong % | flip % |
|---|--:|--:|
| Real-time | 1.94 | 1.91 |
| + look-ahead | 1.44 | 2.05 |
| + two-pass | 1.19 | 0.73 |

Held-out Meredith (216 movements): look-ahead **99.51%** / two-pass **99.72%** exact (clean).

## License

Apache-2.0
