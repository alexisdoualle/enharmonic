/**
 * Zero-dependency Web Audio playback so a passage can be audited by ear. The default voice is a sampled
 * grand piano (Salamander Grand Piano, CC-BY 3.0, `viz/public/samples/piano/`): one sample every minor
 * third, each note played from the nearest one at a shifted rate. The samples load and decode as the page
 * opens (an offline context needs no gesture), and the first play waits for them; if they fail, the FM
 * voice below plays instead.
 *
 * The FM voice is a warm electric piano (Rhodes-ish): a sine CARRIER frequency-modulated by two sine operators: a 1:1 "body"
 * modulator for the round, slightly-hollow EP warmth, and a fast-decaying high-ratio "tine" modulator
 * for the bell-like attack bark before it settles. The modulation index is largest at onset and decays
 * quickly, so each note barks then mellows the way a struck tine does. An attack/decay/SUSTAIN/release
 * amp envelope keeps the note ringing for its whole length, a gentle lowpass rounds the top, and a
 * master compressor/limiter glues dense chords so a Bach tutti doesn't clip into harshness.
 *
 * The held voices (no decay while a key is down): sampled winds (a clarinet, a bassoon for the bass; VSCO 2
 * CE, CC0) and, while those load, a synth string ensemble. See their sections below.
 *
 * The AudioContext is created lazily and resumed on a user gesture (browsers require that), so
 * {@link enable} must be called from a click/keypress handler.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let masterVolume = 0.9;   // 0..1, set by the volume slider; applied to the master bus.
// Every voice currently scheduled or ringing, so allNotesOff() can silence them ("all notes off").
export type Instrument = 'piano' | 'epiano' | 'strings' | 'winds';
export interface Voice { sources: AudioScheduledSourceNode[]; gain: GainNode; kind: Instrument; }
const voices = new Set<Voice>();

let instrument: Instrument = 'piano';
/** Pick the voice for notes played from now on: the sampled piano, the FM electric piano, the sampled
 *  winds (clarinet, bassoon in the bass), or the synth strings. Winds and strings do not decay while held. */
export function setInstrument(i: Instrument): void {
    instrument = i;
    if (i === 'piano') loadPiano();
    if (i === 'winds') loadWinds();
}
export function getInstrument(): Instrument { return instrument; }

// Salamander sample names, one every minor third from A0 (midi 21) to C8 (midi 108).
const SAMPLE_NAMES = ['C', 'Ds', 'Fs', 'A'];
const SAMPLE_MIDIS = Array.from({ length: 30 }, (_, i) => 21 + 3 * i);
const sampleFile = (midi: number) => `samples/piano/${SAMPLE_NAMES[(midi % 12) / 3]}${Math.floor(midi / 12) - 1}.mp3`;
const pianoBuffers = new Map<number, AudioBuffer>();
let pianoLoad: Promise<void> | null = null;

/** Fetch and decode every sample once. A failed file is skipped; its notes borrow the next nearest. The
 *  decode runs on an offline context, so it needs no user gesture; the buffers play in the live one. */
function loadPiano(): void {
    if (pianoLoad || typeof OfflineAudioContext === 'undefined') return;
    const c = new OfflineAudioContext(2, 1, 44100);   // the samples' own rate, so decoding does not resample
    pianoLoad = Promise.all(SAMPLE_MIDIS.map(async m => {
        try {
            const res = await fetch(sampleFile(m));
            if (res.ok) pianoBuffers.set(m, await c.decodeAudioData(await res.arrayBuffer()));
        } catch { /* missing or undecodable: fall back */ }
    })).then(() => undefined);
}
loadPiano();

// The longest the first play waits for the samples before starting on the FM voice.
const PIANO_WAIT_MS = 4000;

/** Set the master output volume (0..1). Works before or after the AudioContext exists. */
export function setVolume(v: number): void {
    masterVolume = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = masterVolume;
}

function ensure(): AudioContext {
    if (!ctx) {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.gain.value = masterVolume;
        // Soft-knee bus compressor: tames dense tuttis and stops peaks clipping into buzz, so sparse
        // solo lines and 20-voice chords both sit at a comfortable level without per-note gain fiddling.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 24;
        comp.ratio.value = 3;
        comp.attack.value = 0.005;
        comp.release.value = 0.18;
        master.connect(comp).connect(ctx.destination);
        // Warm the render thread with a one-sample silent buffer so its FIRST real output isn't delayed
        // by cold-start spin-up (which let the playhead start moving before any sound was heard).
        const warm = ctx.createBufferSource();
        warm.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        warm.connect(ctx.destination);
        warm.start();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
}

/** Call from a user gesture (e.g. the sound toggle / play button) to unlock audio. The returned
 *  promise resolves once the AudioContext is actually running; on first unlock its clock stays at 0
 *  until the resume lands, so callers that anchor a clock should wait for this before reading now(). */
export function enable(): Promise<void> {
    const c = ensure();
    return c.state === 'running' ? Promise.resolve() : c.resume();
}

/** Resolves once the audio clock is actually PRODUCING OUTPUT and the piano samples are in. resume() can
 *  resolve while the render thread is still spinning up (currentTime / getOutputTimestamp not yet
 *  advancing), which on the first play let the playhead start before any sound. Polls until the output
 *  clock moves (or a short safety cap), so callers can anchor the visual clock against a clock that has
 *  truly started. The sample wait is capped too, so a slow network starts on the FM voice instead. */
export async function whenPlaying(): Promise<void> {
    const c = ensure();
    const load = instrument === 'piano' ? pianoLoad : instrument === 'winds' ? windLoad : null;
    if (load) await Promise.race([load, new Promise(r => setTimeout(r, PIANO_WAIT_MS))]);
    const clock = () => c.getOutputTimestamp?.().contextTime || c.currentTime;
    return new Promise(resolve => {
        const started = performance.now();
        const t0 = clock();
        const tick = () => {
            if (clock() > t0 || performance.now() - started > 500) resolve();
            else requestAnimationFrame(tick);
        };
        tick();
    });
}

/** The AudioContext's monotonic clock (seconds): schedule notes AHEAD of the playhead so timing is
 *  sample-accurate and immune to main-thread render jank. */
export function audioNow(): number { return ensure().currentTime; }

/** Anchor for starting playback `leadSec` from now. `ctx` is the audio-clock time to schedule the
 *  first onset at, always in the future (currentTime + lead), so it is never clamped. `perf` is the
 *  performance-clock time at which that onset actually reaches the SPEAKERS: it folds in the output
 *  latency via getOutputTimestamp's ctx→perf mapping, so anchoring the visual playhead to it keeps
 *  sight and sound together, even on the cold first play when output latency is largest. Without a
 *  timestamp (unsupported), falls back to assuming zero output latency. */
export function scheduleAnchor(leadSec: number): { ctx: number; perf: number } {
    const c = ensure();
    const startCtx = c.currentTime + leadSec;
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime != null) {
        return { ctx: startCtx, perf: ts.performanceTime + (startCtx - ts.contextTime) * 1000 };
    }
    return { ctx: startCtx, perf: performance.now() + leadSec * 1000 };
}

const freqOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** `when` (audio-clock seconds) schedules the onset in the future; omit it to play immediately. Returns
 *  the voice so a held note can be cut short with `releaseVoice`. */
export function playMidi(midi: number, durSec = 0.5, gain = 0.28, when?: number): Voice {
    const c = ensure();
    const t0 = when != null ? Math.max(when, c.currentTime) : c.currentTime;
    const sample = instrument === 'piano' ? nearestSample(midi) : null;
    const wind = instrument === 'winds' ? windSample(midi) : null;
    const voice = wind ? windVoice(c, midi, wind, durSec, gain, t0)
        : instrument === 'winds' || instrument === 'strings' ? stringsVoice(c, midi, durSec, gain, t0)   // winds still loading
        : sample != null ? pianoVoice(c, midi, sample, durSec, gain, t0) : fmVoice(c, midi, durSec, gain, t0);
    voices.add(voice);
    voice.sources[0]!.onended = () => voices.delete(voice);
    return voice;
}

/** The loaded sample closest in pitch to `midi`, or null before any has loaded. */
function nearestSample(midi: number): number | null {
    let best: number | null = null;
    for (const m of pianoBuffers.keys()) if (best == null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
    return best;
}

// The samples peak near −8 dB; this brings a note to about the FM voice's attack level.
const PIANO_GAIN = 2.2;
// Fade-in over the first samples: playing from the file start is already silent, this guards any file
// whose sound starts at once (skipping into a sample starts it mid-wave, heard as a tap).
const FADE_IN = 0.002;
// Damper fade after the key comes up (time constant of the exponential approach to silence).
const DAMPER = 0.08;

/** A piano note: the sample rings with its own decay until the key comes up, then the damper fades it. */
function pianoVoice(c: AudioContext, midi: number, sample: number, durSec: number, gain: number, t0: number): Voice {
    const src = c.createBufferSource();
    src.buffer = pianoBuffers.get(sample)!;
    src.playbackRate.value = Math.pow(2, (midi - sample) / 12);
    const g = c.createGain();
    const off = t0 + Math.max(0.05, durSec);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain * PIANO_GAIN, t0 + FADE_IN);
    g.gain.setValueAtTime(gain * PIANO_GAIN, off);
    g.gain.setTargetAtTime(0, off, DAMPER);
    src.connect(g).connect(master!);
    src.start(t0);
    src.stop(off + DAMPER * 8);
    return { sources: [src], gain: g, kind: 'piano' };
}

/** An FM electric-piano note. */
function fmVoice(c: AudioContext, midi: number, durSec: number, gain: number, t0: number): Voice {
    const f = freqOf(midi);

    // Soft lowpass that tracks the note (brighter up high) so FM sidebands don't get glassy at the top.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(7000, f * 5 + 900);
    lp.Q.value = 0.4;

    // Sine carrier at the fundamental; everything below modulates ITS frequency.
    const carrier = c.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = f;

    // Body modulator, ratio 1:1: the warm Rhodes core. Depth starts wide for a vocal attack, then eases
    // back so the held tone is rounder than the onset.
    const modBody = c.createOscillator();
    modBody.type = 'sine';
    modBody.frequency.value = f;
    const modBodyGain = c.createGain();
    modBodyGain.gain.setValueAtTime(f * 1.4, t0);
    modBodyGain.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.35), t0 + 0.22);
    modBody.connect(modBodyGain).connect(carrier.frequency);

    // Tine modulator, high ratio, the bell-like "bark" of the struck tine: a deep index that decays
    // fast (~70ms) so it's an attack transient, not a sustained ring.
    const modTine = c.createOscillator();
    modTine.type = 'sine';
    modTine.frequency.value = f * 6;
    const modTineGain = c.createGain();
    modTineGain.gain.setValueAtTime(f * 1.1, t0);
    modTineGain.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.02), t0 + 0.07);
    modTine.connect(modTineGain).connect(carrier.frequency);

    // Attack → decay → sustain hold → release. The plateau starts at bodyEnd (clamped ≥ decay end) so a
    // short note never jumps the gain mid-decay (heard as a per-note "tick"); the release ends on a
    // LINEAR ramp to true zero (an exponential only reaches ~0.0008; stopping while audible is a click).
    const attack = 0.006, decay = 0.09, release = 0.18;
    const sustain = Math.max(0.0002, gain * 0.55);
    const decayEnd = t0 + attack + decay;
    const bodyEnd = Math.max(decayEnd, t0 + durSec - release);
    const end = bodyEnd + release;

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(sustain, decayEnd);
    g.gain.setValueAtTime(sustain, bodyEnd);
    g.gain.exponentialRampToValueAtTime(0.0008, end);
    g.gain.linearRampToValueAtTime(0.0, end + 0.006);

    carrier.connect(lp).connect(g).connect(master!);
    carrier.start(t0); modBody.start(t0); modTine.start(t0);
    carrier.stop(end + 0.03); modBody.stop(end + 0.03); modTine.stop(end + 0.03);

    return { sources: [carrier, modBody, modTine], gain: g, kind: 'epiano' };
}

// --- Sampled winds: a clarinet, with a bassoon for the bass ---------------------------------------------
// Real sustained recordings from VSCO 2 Community Edition (Versilian Studios, CC0), one dynamic, a sample
// every three or four semitones (`viz/public/samples/{clarinet,bassoon}/<midi>.mp3`). The clarinet covers
// its own range (D3 up); below it the bassoon takes over, so a bass line sounds like a bass instrument
// instead of a clarinet pitched down. Each file is the attack plus ~3.5 s of steady tone, levelled to the
// same loudness. A note longer than the file holds by CROSSFADING fresh copies of the steady part over
// each other (equal-power, 0.3 s), so the tone never decays and no sample-exact loop point is needed
// (an MP3's encoder padding shifts it differently per browser).
const CLARINET_MIDIS = [50, 53, 58, 62, 65, 70, 74, 77, 82, 86, 89];
const BASSOON_MIDIS = [34, 37, 41, 45, 46, 48];
const CLARINET_LOW = 50;            // the clarinet's lowest sample; below it, the bassoon
const WIND_ATTACK_END = 3.8;        // buffer seconds of the first, attack-bearing copy (the file fades at ~3.94 s)
const WIND_STEADY = [0.7, 3.8] as const;   // buffer seconds of steady tone the held copies repeat
const WIND_XFADE = 0.3;             // buffer seconds of each crossfade
const WIND_RELEASE = 0.14;          // the breath stopping
const WIND_GAIN = 2.0;              // the files sit at -20 dB RMS; this brings them near the piano's level
const windBuffers = new Map<string, AudioBuffer>();   // "clarinet/62" → buffer
let windLoad: Promise<void> | null = null;

function loadWinds(): void {
    if (windLoad || typeof OfflineAudioContext === 'undefined') return;
    const c = new OfflineAudioContext(1, 1, 44100);
    const files = [...CLARINET_MIDIS.map(m => `clarinet/${m}`), ...BASSOON_MIDIS.map(m => `bassoon/${m}`)];
    windLoad = Promise.all(files.map(async f => {
        try {
            const res = await fetch(`samples/${f}.mp3`);
            if (res.ok) windBuffers.set(f, await c.decodeAudioData(await res.arrayBuffer()));
        } catch { /* missing or undecodable: that note borrows the nearest loaded one */ }
    })).then(() => undefined);
}

/** The loaded wind sample to play `midi` from (clarinet from D3 up, else bassoon), or null before any loads. */
function windSample(midi: number): { key: string; midi: number } | null {
    const pick = (inst: string, set: number[]) => {
        let best: number | null = null;
        for (const m of set) if (windBuffers.has(`${inst}/${m}`) && (best == null || Math.abs(m - midi) < Math.abs(best - midi))) best = m;
        return best == null ? null : { key: `${inst}/${best}`, midi: best };
    };
    return midi >= CLARINET_LOW ? pick('clarinet', CLARINET_MIDIS) ?? pick('bassoon', BASSOON_MIDIS)
        : pick('bassoon', BASSOON_MIDIS) ?? pick('clarinet', CLARINET_MIDIS);
}

/** Equal-power fade curves for the crossfades. */
const FADE_STEPS = 32;
const fadeIn = Float32Array.from({ length: FADE_STEPS }, (_, i) => Math.sin((i / (FADE_STEPS - 1)) * Math.PI / 2));
const fadeOut = Float32Array.from({ length: FADE_STEPS }, (_, i) => Math.cos((i / (FADE_STEPS - 1)) * Math.PI / 2));

function windVoice(c: AudioContext, midi: number, sample: { key: string; midi: number }, durSec: number, gain: number, t0: number): Voice {
    const buf = windBuffers.get(sample.key)!;
    const rate = Math.pow(2, (midi - sample.midi) / 12);
    const noteEnd = t0 + Math.max(0.08, durSec);
    const end = noteEnd + WIND_RELEASE * 4;

    // The note's own envelope: a short ramp in (the recording carries the real attack), held flat, then the release.
    const level = gain * WIND_GAIN;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.004);
    g.gain.setValueAtTime(level, noteEnd);
    g.gain.setTargetAtTime(0, noteEnd, WIND_RELEASE);
    g.connect(master!);

    // Copies of the recording, in real (output) time: buffer seconds pass `rate` times faster.
    const real = (bufSec: number) => bufSec / rate;
    const xf = real(WIND_XFADE);
    const sources: AudioBufferSourceNode[] = [];
    const copy = (start: number, offset: number, bufLen: number, fadeInFirst: boolean) => {
        const src = c.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        const sg = c.createGain();
        const stop = start + real(bufLen);
        if (fadeInFirst) { sg.gain.setValueAtTime(0, start); sg.gain.setValueCurveAtTime(fadeIn, start, xf); }
        else sg.gain.setValueAtTime(1, start);
        if (stop < end) sg.gain.setValueCurveAtTime(fadeOut, stop - xf, xf);   // handing over to the next copy
        src.connect(sg).connect(g);
        src.start(start, offset);
        src.stop(Math.min(stop, end));
        sources.push(src);
        return stop;
    };
    let stop = copy(t0, 0, WIND_ATTACK_END, false);
    const steadyLen = WIND_STEADY[1] - WIND_STEADY[0];
    while (stop < end) stop = copy(stop - xf, WIND_STEADY[0], steadyLen, true);
    // The copy that ends last goes FIRST: playMidi retires the voice on sources[0]'s `onended`.
    sources.reverse();
    return { sources, gain: g, kind: 'winds' };
}

// --- Held strings: a small bowed ensemble that sustains at full level for as long as the note is held ---
// Four sawtooth voices a few cents apart (an ensemble, not one player), spread across the stereo field,
// plus a soft triangle at the fundamental for body. A lowpass that tracks the pitch rounds the saw's top
// and opens a little as the bow speeds up; vibrato fades in after the attack, as a player's does. No
// decay stage: the level holds until the key comes up, then a soft release. A shared room reverb (a
// synthetic decaying-noise impulse) adds air.
const STRING_DETUNE = [-11, -4, 4, 11];        // cents
const STRING_PAN = [-0.7, -0.25, 0.25, 0.7];
const STRING_ATTACK = 0.14, STRING_RELEASE = 0.45;
const STRING_LEVEL = 0.6;                       // per-voice gain multiplier, near the piano's loudness
let reverbIn: GainNode | null = null;

/** The room: a stereo impulse of decaying noise (about 2.4 s), built once on the live context. */
function reverbSend(c: AudioContext): GainNode {
    if (reverbIn) return reverbIn;
    const len = Math.floor(c.sampleRate * 2.4);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = c.createConvolver();
    conv.buffer = ir;
    const wet = c.createGain();
    wet.gain.value = 0.32;
    reverbIn = c.createGain();
    reverbIn.connect(conv).connect(wet).connect(master!);
    return reverbIn;
}

function stringsVoice(c: AudioContext, midi: number, durSec: number, gain: number, t0: number): Voice {
    const f = freqOf(midi);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    const cutoff = Math.min(6500, f * 3.2 + 800);
    lp.frequency.setValueAtTime(cutoff * 0.55, t0);
    lp.frequency.linearRampToValueAtTime(cutoff, t0 + STRING_ATTACK * 2);
    lp.Q.value = 0.5;

    // Vibrato: ~5.3 Hz, ±6 cents, eased in from silence after the attack.
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.3;
    const depth = c.createGain();
    depth.gain.setValueAtTime(0, t0);
    depth.gain.setValueAtTime(0, t0 + 0.25);
    depth.gain.linearRampToValueAtTime(f * (Math.pow(2, 6 / 1200) - 1), t0 + 0.9);
    lfo.connect(depth);

    const sources: AudioScheduledSourceNode[] = [];
    STRING_DETUNE.forEach((cents, k) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents;
        depth.connect(o.frequency);
        const og = c.createGain();
        og.gain.value = 0.25;
        const pan = c.createStereoPanner();
        pan.pan.value = STRING_PAN[k]!;
        o.connect(og).connect(pan).connect(lp);
        sources.push(o);
    });
    const body = c.createOscillator();
    body.type = 'triangle';
    body.frequency.value = f;
    const bodyGain = c.createGain();
    bodyGain.gain.value = 0.35;
    body.connect(bodyGain).connect(lp);
    sources.push(body);

    // Bowed attack → hold at level for the note's whole length → soft release. Ends on a linear ramp to
    // true zero (stopping while audible is a click).
    const level = gain * STRING_LEVEL;
    const bodyEnd = t0 + Math.max(STRING_ATTACK, durSec);
    const end = bodyEnd + STRING_RELEASE;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(level, t0 + STRING_ATTACK);
    g.gain.setValueAtTime(level, bodyEnd);
    g.gain.exponentialRampToValueAtTime(0.0008, end);
    g.gain.linearRampToValueAtTime(0, end + 0.006);
    lp.connect(g);
    g.connect(master!);
    g.connect(reverbSend(c));

    for (const o of [...sources, lfo]) { o.start(t0); o.stop(end + 0.03); }
    // The LFO goes LAST so sources[0] (whose `onended` retires the voice) is a sounding oscillator.
    return { sources: [...sources, lfo], gain: g, kind: 'strings' };
}

/** Release one voice now (a key coming up): the same click-free release tail a timed note ends on
 *  (the damper fade for the piano). */
export function releaseVoice(v: Voice): void {
    if (!ctx || !voices.has(v)) return;
    const t = ctx.currentTime;
    try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        if (v.kind === 'piano') {
            v.gain.gain.setTargetAtTime(0, t, DAMPER);
            for (const o of v.sources) o.stop(t + DAMPER * 8);
        } else {
            const release = v.kind === 'strings' ? STRING_RELEASE : v.kind === 'winds' ? WIND_RELEASE : 0.18;
            v.gain.gain.exponentialRampToValueAtTime(0.0008, t + release);
            v.gain.gain.linearRampToValueAtTime(0.0, t + release + 0.006);
            for (const o of v.sources) o.stop(t + release + 0.03);
        }
    } catch { /* voice already stopped */ }
}

/** "All notes off": fade out + stop every ringing voice with a short click-free release. Called on a
 *  seek so a new cursor position starts from silence instead of layering on the notes ringing before. */
export function allNotesOff(): void {
    if (!ctx) return;
    const t = ctx.currentTime;
    const REL = 0.03;   // 30ms fade, fast but clickless
    for (const v of voices) {
        try {
            v.gain.gain.cancelScheduledValues(t);
            v.gain.gain.setTargetAtTime(0.0001, t, REL / 3);
            for (const o of v.sources) o.stop(t + REL + 0.02);
        } catch { /* voice already stopped */ }
    }
    voices.clear();
}

/** Play several midis at once (a chord), softer per-voice so a dense stack doesn't clip. */
export function playChord(midis: number[], durSec = 0.9): void {
    if (!midis.length) return;
    const per = 0.28 / Math.sqrt(Math.max(1, midis.length));
    for (const m of midis) playMidi(m, durSec, per);
}

/** The audio-clock time at which a sound must be scheduled to REACH THE SPEAKERS at `perfMs` (the
 *  performance clock): getOutputTimestamp pairs the sample now being heard with its performance time,
 *  so output latency is folded in. Without it, falls back to the reported latency. */
export function ctxTimeAt(perfMs: number): number {
    const c = ensure();
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime != null) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return c.currentTime + (perfMs - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0);
}

/** A short metronome click at audio-clock time `when`; the downbeat is higher and louder. */
export function playClick(when: number, accent: boolean): void {
    const c = ensure();
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1320;
    const peak = accent ? 0.16 : 0.09;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0008, when + 0.035);
    g.gain.linearRampToValueAtTime(0, when + 0.04);
    o.connect(g).connect(master!);
    o.start(when); o.stop(when + 0.05);
}
