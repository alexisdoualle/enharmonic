# Lab ↔ viz parity notes

This note records details that affect whether benchmark numbers from the lab and
the browser viz are genuinely comparable.

## `(measure, beat)` onset keys (evaluation only)

An onset is a notated musical attack position, not necessarily one unique MIDI
timestamp. Every expected note carries a `measure` and `beat`. Notes belonging
to the same measure and beat are treated as one onset (one struck sonority),
even if their imported `t_ms` values differ slightly between voices.

For example:

```text
measure 76, beat 2:  C3  Eb3  G3
measure 76, beat 2:  G4             # same onset, another voice
measure 76, beat 2.5: A3             # next onset
```

The **offline scorer** converts the contiguous notes at each `(measure, beat)`
position to a compact onset key: `0, 0, 0, 0, 1, ...`. Its ±16 consensus
window then moves by musical onsets/chords, rather than by individual notes.
This matters in polyphonic music: using raw timestamps can split one notated
chord when voices have micro-different times, changing the local consensus and
inflating `wrong`.

Real live MIDI/audio input does not provide `(measure, beat)` keys. The live
speller must remain timestamp/event driven and use only information available at
that moment—currently the active frame, sounding notes, neighbour-step context,
and (in `la`) a bounded look-ahead. Measure/beat keys must therefore never leak
into the spelling decision.

For parity, the viz may use score-derived `(measure, beat)` keys when displaying
or rescoring a known fixture. A genuinely live evaluation needs a separate
policy, such as grouping attacks within a documented time tolerance, and should
report that approximation explicitly.

If measure/beat metadata is unavailable, raw onset time is the fallback. That
fallback is less reliable for dense orchestral or choral fixtures.

## Comparable denominators

- **Raw:** every `on` event is scored. This is the browser viz's current
  `20,096`-onset view.
- **Unique:** same-measure/same-beat unison duplicates with the same MIDI value
  are collapsed. In the Requiem example this is `20,005` notes instead of
  `20,096`; octave doublings remain distinct.

Always label which denominator is being reported. `unique` is useful for
measuring spelling information rather than ensemble doubling, but it is not the
same number as raw note accuracy.

## Shipped real-time (`rt`) mechanisms

The `rt`/diatonic-anchor preset currently includes:

- spiral frame, depth 6, centre +1;
- neighbour-step scoring (run gate 2, weight 2, vertical gate);
- sounding tiebreak over the previous five onsets;
- keep-alive frame entries, evicting the oldest;
- relative-minor leading-tone preference;
- 16-second base window.

It does **not** include look-ahead. Look-ahead is the separate `la` mode.

## Current parity warning

The lab scorer groups by contiguous `(measure, beat)` positions. The current
viz replay path groups scorer input by exact event time. For fixture parity, make
the viz's **scoring/display path** use the same `(measure, beat)` construction;
do not add those keys to the live spelling algorithm.
