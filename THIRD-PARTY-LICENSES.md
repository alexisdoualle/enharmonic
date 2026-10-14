# Third-Party Licenses

`enharmonic` is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It incorporates
one algorithm adapted from an MIT-licensed project, and the viz ships piano samples
under CC BY 3.0, both attributed below.

## meantonal (Brian Bowman)

The chroma-based interval-quality formula in `qualityFromChroma`
(`src/interval.ts`) is adapted from Brian Bowman's [meantonal](https://github.com/meantonal/meantonal-js)
project, applied directly to chroma computed from (letter, alter) instead of
meantonal's (whole-step, half-step) vector representation.

- Source: https://github.com/meantonal/meantonal-js
- License: MIT

```
MIT License

Copyright (c) 2025 Meantonal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Salamander Grand Piano (Alexander Holm)

The viz plays notes on samples from the Salamander Grand Piano V3, a Yamaha C5
recorded by Alexander Holm (`viz/public/samples/piano/`). They are not part of the
library package.

- Source: https://archive.org/details/SalamanderGrandPianoV3
- License: CC BY 3.0, https://creativecommons.org/licenses/by/3.0/
- Changes: one velocity layer, one sample every minor third (A0 to C8), transcoded
  to 128 kbps MP3. Taken from the Tone.js copy at https://tonejs.github.io/audio/salamander/.
