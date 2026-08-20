# Fixtures

Each `fixtures/<id>/` is one curated test piece — a MIDI-like event stream plus the composer's
notated spelling — scored by the parity bench (`test/eval/run.ts`) and replayed by the viz.

## Files

**`events.json`** — the speller-facing input, in time order. No ground truth (the speller must not
see spellings). Three event types:

```jsonc
{ "t_ms": 0,   "type": "respell", "scale": [ {"letter":"C","accidental":0}, … ] }  // key signature (7 letters)
{ "t_ms": 0,   "type": "on",  "midi": 49 }                                          // note on
{ "t_ms": 250, "type": "off", "midi": 49 }                                          // note off
```

The no-keys presets **ignore** `respell` events; they exist only so the stream is self-describing.

**`expected.json`** — the ground truth, one entry per `on` event, **same order, same length**:

```jsonc
{ "step": "C", "alter": -1, "measure": 13, "beat": 2.0 }   // C♭ in bar 13
```

`alter` is signed accidentals (−1 = flat, +2 = double-sharp). `measure`/`beat` come from the score
and are used only for engraving in the viz staff.

## Invariants (must hold)

- **Positional pairing.** `expected[i]` corresponds to the *i*-th `on` event encountered when reading
  `events.json` top to bottom. Never reorder one array without the other.
- **Bass-first.** Within a chord (on-events sharing a `t_ms`), on-events ascend by midi — the bass is
  committed first so it sets harmonic context for the upper voices.
- **One spelling per pitch-class per instant.** Co-sounding notes of the same pitch class share one
  spelling. A doubling spelled two ways is a notation slip to resolve, not ground truth.

Ground truth is the **composer's notation**, which is not always "correct" — MusicXML sources carry
engraving slips and transposing-instrument artifacts. Audit new fixtures by harmonic coherence against
the original manuscript before trusting `expected.json` (see the `fixture-qa` skill).

## Adding a fixture

The clean repo has **no fixture-generation tooling** (kept zero-dep); fixtures are generated in the lab
(`~/JavaScript/enharmonic-lab`, which has `generate.py` + a music21 `.venv`) and the JSON copied in.

1. **Extract** the passage to a standalone MusicXML if it's part of a larger score (music21 measure
   slice), then generate:
   ```
   cd ~/JavaScript/enharmonic-lab
   .venv/bin/python tools/fixtures/generate.py <score.mxl> <id>
   ```
   This writes `events.json` + `expected.json` under the lab's `fixtures/<id>/` (bass-first ordering and
   doubling resolution applied).
2. **Copy in** just the two JSON files:
   ```
   cp ~/JavaScript/enharmonic-lab/fixtures/<id>/{events,expected}.json fixtures/<id>/
   ```
3. **Audit** the ground truth (harmonic coherence, no same-pc clashes) — the `fixture-qa` skill.
4. **Register** the `id` in the `FIXTURES` list in `test/eval/fixtures.ts` (order is stable/arbitrary).
5. **Rebless + verify:**
   ```
   npm run bench:update      # snapshots the new fixture's {correct,flipped,wrong} into baseline.json
   npm test                  # 3-mode parity + the viz↔bench guard must be green
   npm run viz:build         # picks up the new fixture (auto-copied from fixtures/)
   ```

The viz enumerates `fixtures/` automatically — no viz-side registration needed.
