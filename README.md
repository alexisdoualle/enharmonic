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
| `new Speller()` | real-time | Diatonic base + keep-alive (default) |
| `new Speller({ lookAhead: true })` | near-real-time | + letter-aware look-ahead |
| `spellTwoPass(notes)` | offline | Forward + backward + boundary resolve |

Pass `clock: () => ms` (and per-event `t`) for deterministic / batch replay.

### Timing

Every mode from the real-time default (diatonic base + keep-alive) onward is **clock-driven**: a note's
`t` (or `clock()` when `t` is omitted, defaulting to `Date.now()`) feeds three time windows —

| Window | Default | Role |
|---|--:|---|
| Frame window | 16000 ms | how long a struck pitch-class stays in the diatonic collection |
| Neighbour window | 1500 ms | horizon for the step/neighbour disambiguation |
| Co-onset grouping | `t` equality | notes sharing a `t` are one chord (keep-alive / vertical tie-break) |

For **genuine live input** (notes arriving over wall-clock time) `t` may be omitted; `Date.now()`
supplies real spacing. For **programmatic replay** (feeding a sequence in a loop) `t` is required —
without it every note collapses to one instant and the windows never advance.

These durations are corpus-averaged constants, not first principles: they approximate primitives a
future version could detect directly (e.g. a cadence firing a frame **reset** so the collection turns
over on the beat the ear hears it, instead of lagging the key by several measures).

## Status

Private pre-release. Algorithm development and the full benchmark corpus live in the
companion lab repo. Headline figures (shared-50 fixtures, no-keys, three-tier scorer):

| Mode | wrong % | flip % |
|---|--:|--:|
| Real-time | 1.94 | 1.91 |
| + look-ahead | 1.44 | 2.05 |
| + two-pass | 1.19 | 0.73 |

Held-out Meredith (216 movements, 195,972 notes): look-ahead **99.54%** / two-pass
**99.72%** exact (clean) — the literature-standard benchmark ps13 / Temperley / Chew report on.

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
