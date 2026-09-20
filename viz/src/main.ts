/** Entry point: load a fixture, drive the real shipped speller, and step through it. */
import { buildReplay, withSectionAutoResets, type Mode, type RawEvent, type Expected, type Replay } from './replay.js';
import {
    initialState, clampStep, current, clampRange, clampCenter,
    SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, SPIRAL_EVEN_DEFAULT,
    sideOverridesFromSearch, writeSideOverrides, readableSearch, stepFromSearch, type AppState,
} from './state.js';
import { renderWheel } from './panels/wheel.js';
import { renderScoring } from './panels/scoring.js';
import { initPianoRoll, renderPianoRoll } from './music/pianoroll.js';
import { renderStaff } from './music/staff.js';
import { initLiveTonnetz } from './panels/liveTonnetz.js';
import { enable as audioEnable, whenPlaying as audioReady, playMidi, allNotesOff, audioNow, scheduleAnchor } from './audio.js';
import { contextReport, runReport, copyText, flash } from './copy.js';
import { label } from './format.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state: AppState = { ...initialState };
let liveTonnetz: ReturnType<typeof initLiveTonnetz>;

// 3D tonnetz: a whole-panel swap for the right column (the coiled Tonnetz ⇄ the 3D lattice). The 3D
// panel pulls in three.js, so `panels/tonnetz.js` is LAZY-loaded on first activation and its render loop
// only spins up then. Toggled from the transport bar (#tonnetz3d), persisted per-browser.
const TONNETZ3D_KEY = 'viz.tonnetz3d';
let tonnetz3dOn = (() => { try { return localStorage.getItem(TONNETZ3D_KEY) === '1'; } catch { return false; } })();
let tonnetz3d: typeof import('./panels/tonnetz.js') | null = null;
let tonnetz3dLoading = false;

/** Show either the coiled-Tonnetz panel or the 3D lattice panel in the right column, lazy-building the
 *  3D scene the first time it is shown. Feeding the visible view its snapshot is left to `render()`. */
function applyTonnetz3d() {
    $('live-tonnetz').style.display = tonnetz3dOn ? 'none' : '';
    $('tonnetz').style.display = tonnetz3dOn ? 'flex' : 'none';
    $<HTMLInputElement>('tonnetz3d').checked = tonnetz3dOn;
    if (!tonnetz3dOn) return;
    if (tonnetz3d) { tonnetz3d.initTonnetz($('tonnetz-canvas')); return; }   // initTonnetz is a no-op once built
    if (tonnetz3dLoading) return;
    tonnetz3dLoading = true;
    void import('./panels/tonnetz.js').then(mod => {
        tonnetz3dLoading = false;
        tonnetz3d = mod;
        if (!tonnetz3dOn) return;              // toggled back off while the chunk was loading
        mod.initTonnetz($('tonnetz-canvas'));
        render();                              // paint the current onset onto the freshly built lattice
    }).catch(err => {
        tonnetz3dLoading = false;
        console.error('3D tonnetz failed to load', err);
        setTonnetz3d(false);
    });
}

function setTonnetz3d(on: boolean) {
    tonnetz3dOn = on;
    try { localStorage.setItem(TONNETZ3D_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
    applyTonnetz3d();
    render();
}

const MODE_NAME: Record<Mode, string> = {
    core: '① Core speller',
    rt: '② real-time',
    la: '③ + look-ahead',
    tp: '④ two-pass (offline)',
    control: '⊘ control — fixed-LoF window (music21)',
};

async function listFixtures(): Promise<string[]> {
    return (await (await fetch('fixtures/manifest.json')).json()) as string[];
}
async function loadFixture(id: string): Promise<{ events: RawEvent[]; expected: Expected[] }> {
    const [events, expected] = await Promise.all([
        fetch(`fixtures/${id}/events.json`).then(r => r.json()),
        fetch(`fixtures/${id}/expected.json`).then(r => r.json()),
    ]);
    const norm: RawEvent[] = (events as any[]).map(e => ({
        t_ms: e.t_ms, type: e.type, midi: e.midi, scale: e.scale,
    }));
    return { events: norm, expected: expected as Expected[] };
}

let rawEvents: RawEvent[] = [];
let rawExpected: Expected[] = [];

/** Look-ahead is an OPTION of the real-time speller (`Speller({ lookAhead })`), surfaced as a toolbar
 *  toggle rather than a separate dropdown mode. Internally that is the `la` replay mode. */
function effMode(): Mode {
    return state.mode === 'rt' && state.lookAhead ? 'la' : state.mode;
}

function recompute() {
    if (!state.fixtureId) return;
    state.replay = buildReplay(effMode(), rawEvents, rawExpected,
        { spiralRange: state.spiralRange, spiralCenter: state.spiralCenter, spiralEven: state.spiralEven },
        state.mode === 'tp', effectiveSideOverrides());
    state.step = clampStep(state, state.step);
    renderStatus();
    render();
}

/** The stitched-score viz stays one stream, but a movement boundary always releases an editorial side
 * hint. A manual marker at that exact onset takes precedence over the automatic `auto` marker. */
function effectiveSideOverrides() {
    return withSectionAutoResets(rawExpected, state.sideOverrides);
}

function setSideOverride(comma: number) {
    state.sideOverrides = state.sideOverrides.filter(o => o.from !== state.step);
    state.sideOverrides.push({ from: state.step, comma });
    state.sideOverrides.sort((a, b) => a.from - b.from);
    recompute(); syncUrl();
}

/** Change the spiral what-if params (from the wheel steppers), rebuild, and persist to the URL. */
function setSpiral(range: number, center: number, even: boolean) {
    state.spiralRange = clampRange(range);
    state.spiralCenter = clampCenter(center);
    state.spiralEven = even;
    recompute();
    syncUrl();
}

function renderStatus() {
    const r = state.replay;
    if (!r) { $('status').textContent = ''; return; }
    const t = r.tally;
    const pc = (x: number) => t.total ? (100 * x / t.total).toFixed(1) : '0.0';
    // "correct" = exact + flipped (right pitch-class / coherent side); exact & flipped break it down.
    const modeName = MODE_NAME[state.mode] + (state.mode === 'rt' && state.lookAhead ? ' + look-ahead' : '');
    $('status').innerHTML = `${state.fixtureId} · ${modeName} · ${r.snapshots.length} onsets · `
        + `<span class="correct">${pc(t.correct + t.flipped)}% correct</span>`
        + ` (<span class="exact">exact: ${pc(t.correct)}%</span>, <span class="flipped">flipped: ${pc(t.flipped)}%</span>) · `
        + `<span class="wrong">${pc(t.wrong)}% wrong (${t.wrong})</span>`
        + (t.unread ? ` · <span class="dim">${t.unread} unread</span>` : '');
}

function render() {
    const snap = current(state);
    $('look-ahead-ctl').style.display = state.mode === 'rt' ? '' : 'none';
    renderScoring($('scoring'), snap, effMode() === 'la');
    renderWheel($('wheel'), snap, {
        range: state.spiralRange, center: state.spiralCenter, even: state.spiralEven,
        streaming: state.mode === 'rt' || state.mode === 'la',
        control: state.mode === 'control',
        showKeyLanes: state.showKeyLanes, onChange: setSpiral,
    });
    if (tonnetz3dOn && tonnetz3d) tonnetz3d.renderTonnetz(snap);
    else liveTonnetz?.renderPlaybackSnapshot(snap);
    if (state.replay) {
        renderStaff(state.replay, state.step);
        renderPianoRoll(state.replay, state.step, state.showKeyLanes);
    }
    renderStrip();
    $('scrub').setAttribute('max', String(Math.max(0, (state.replay?.snapshots.length ?? 1) - 1)));
    ($('scrub') as HTMLInputElement).value = String(state.step);
    $('pos').textContent = `${state.step + 1} / ${state.replay?.snapshots.length ?? 0}`;
    const active = effectiveSideOverrides().filter(o => o.from <= state.step).at(-1);
    const manual = state.sideOverrides.filter(o => o.from <= state.step).at(-1);
    const symbol = active?.comma === 1 ? '♯' : active?.comma === -1 ? '♭' : 'auto';
    const stateEl = $('side-state');
    stateEl.textContent = `@${active?.from ?? 0} ${symbol}`;
    stateEl.title = manual
        ? `manual marker at onset ${manual.from + 1}: ${manual.comma > 0 ? 'sharp' : manual.comma < 0 ? 'flat' : 'automatic'}`
        : active ? `automatic release at onset ${active.from + 1} (stitched-score boundary)` : 'automatic spelling';
    for (const [id, comma] of [['side-sharp', 1], ['side-flat', -1], ['side-auto', 0]] as const) {
        $(id).classList.toggle('active', active?.comma === comma);
    }
}

/** A thin ribbon of every onset, coloured by tier, with the cursor marked — click to seek. */
function renderStrip() {
    return;
    const strip = $('strip');
    if (strip.childElementCount !== (state.replay?.snapshots.length ?? 0)) {
        strip.innerHTML = '';
        state.replay?.snapshots.forEach((s, i) => {
            const cell = document.createElement('button');
            cell.className = `strip-cell tier-${s.tier}`;
            cell.title = `${i}: ${label(s.committed)}${s.expected ? ' / exp ' + label(s.expected) : ''}`;
            cell.addEventListener('click', () => seek(i));
            strip.appendChild(cell);
        });
    }
    const cells = strip.children;
    for (let i = 0; i < cells.length; i++) cells[i]!.classList.toggle('cursor', i === state.step);
    // Keep the cursor cell visible by scrolling the STRIP itself. scrollIntoView() would scroll the
    // PAGE too, jumping back up to the strip whenever a re-render fires while reading the panels below.
    const cur = cells[state.step] as HTMLElement | undefined;
    if (cur) {
        const c = cur.getBoundingClientRect(), s = strip.getBoundingClientRect(), pad = 8;
        if (c.left < s.left + pad) strip.scrollLeft -= (s.left + pad) - c.left;
        else if (c.right > s.right - pad) strip.scrollLeft += c.right - (s.right - pad);
    }
}

/** Move the playhead. Seeking WHILE PLAYING relocates the playhead and keeps rolling from there —
 *  the transport clock is re-anchored by `play()`, so nothing drifts. `resume` is off for the scrub
 *  slider, which seeks continuously while dragged and resumes once on release instead. */
function seek(i: number, audible = false, resume = true) {
    const wasPlaying = raf !== 0 || pending;
    stopPlay();
    allNotesOff();       // silence whatever was ringing, so the new position starts clean
    state.step = clampStep(state, i);
    render();
    syncUrl();
    if (wasPlaying && resume) {
        // Landing on the last onset is the natural end of the piece; don't loop back to the top.
        if (state.step < (state.replay?.notes.length ?? 0) - 1) play();
        return;
    }
    if (audible && soundOn) {   // arrow-key stepping auditions the landed note
        const n = state.replay?.notes[state.step];
        if (n) { audioEnable(); playMidi(n.midi); }
    }
}

// --- playback: a real wall-clock MIDI player -----------------------------------------------------
// The playhead is driven by performance.now() and audio is scheduled AHEAD on the AudioContext clock,
// so timing stays sample-accurate and doesn't drift when a dense texture makes rendering lag — under
// load the visual playhead simply skips events (drops frames) instead of falling behind, while every
// note still rings on time. Adapted from the lab viz's player.
let soundOn = true;
let tempoRate = 1;                 // playback speed multiplier (tempo slider); >1 faster
// Extra playhead delay (ms) ADDED on top of the auto-measured output latency, for setups the browser
// under-reports — chiefly Bluetooth headphones, whose latency getOutputTimestamp misses. Applied to
// the VISUAL playhead only (never to when audio is scheduled), so raising it lets sight catch up to
// late sound. Persisted per-browser.
const LATENCY_KEY = 'viz.audioOffsetMs';
let audioOffsetMs = (() => { try { const v = Number(localStorage.getItem(LATENCY_KEY)); return Number.isFinite(v) ? v : 0; } catch { return 0; } })();
const MAX_GAP_MS = 1800;           // cap a long held note / big rest so playback doesn't stall on silence
const LOOKAHEAD_MS = 150;          // schedule audio this far ahead of the playhead (covers a dropped frame)
const MIN_NOTE_SEC = 0.12, MAX_NOTE_SEC = 8;   // floor / ceiling on a single note's ring
// The tempo slider is LOGARITHMIC: position p ∈ [-1,1] → rate = SPAN^p, so p=0 is 1× dead-centre and
// equal slider travel = equal ratio.
const TEMPO_SPAN = 4;
const posToRate = (p: number) => Math.pow(TEMPO_SPAN, p);
const rateToPos = (r: number) => Math.log(r) / Math.log(TEMPO_SPAN);

// Per-note cumulative playback time (ms), each inter-onset gap capped at MAX_GAP_MS — honours the
// score's rhythm but never lets a huge rest stall the player. Rebuilt only when the replay changes.
let timeline: number[] = [];
let noteDurMs: number[] = [];
let timelineFor: Replay | null = null;
function ensureTimeline(replay: Replay): number[] {
    if (timelineFor === replay) return timeline;
    const notes = replay.notes;
    timeline = new Array(notes.length);
    noteDurMs = new Array(notes.length);
    let acc = 0;
    for (let i = 0; i < notes.length; i++) {
        timeline[i] = acc;
        noteDurMs[i] = Math.max(0, notes[i]!.offT - notes[i]!.onT);
        const next = notes[i + 1];
        if (next) acc += Math.min(MAX_GAP_MS, Math.max(0, next.onT - notes[i]!.onT));
    }
    timelineFor = replay;
    return timeline;
}

const START_LEAD_MS = 120;         // schedule the first onset this far ahead so it lands cleanly
let raf = 0, pending = false, t0Perf = 0, t0Ctx = 0, basePlay = 0, audioIdx = 0;
// `silence` cuts the notes already committed to the audio clock (the LOOKAHEAD buffer keeps ringing
// otherwise, so a pause would let sound run on past the stopped playhead). The natural end of the
// piece passes false so the final chord rings out instead of being clipped.
function stopPlay(silence = true) { pending = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } if (silence && soundOn) allNotesOff(); updatePlayBtn(); }
function updatePlayBtn() { $('play').textContent = (raf || pending) ? '⏸' : '▶'; }

function play() {
    if (!state.replay || !state.replay.notes.length) return;
    const notes = state.replay.notes;
    if (state.step >= notes.length - 1) state.step = 0;   // restart from the top if parked at the end
    ensureTimeline(state.replay);
    pending = true;
    updatePlayBtn();
    // On the very first play the AudioContext must resume AND its render thread must actually start
    // producing output before its clock advances; wait for both, then anchor the clocks together (see
    // startClocks). On later plays the context is already running, so this resolves immediately.
    if (soundOn) void audioEnable().then(audioReady).then(startClocks);
    else startClocks();
}
function startClocks() {
    if (!pending || !state.replay) return;   // a pause during the async resume cancels the start
    pending = false;
    basePlay = timeline[state.step]!;
    audioIdx = state.step;
    if (soundOn) {
        // Schedule the first onset START_LEAD_MS ahead on the audio clock (future → never clamped), and
        // anchor the visual playhead to when that onset actually reaches the SPEAKERS — scheduleAnchor
        // folds in the output latency, so sight and sound start together even on the cold first play.
        const a = scheduleAnchor(START_LEAD_MS / 1000);
        t0Ctx = a.ctx;
        t0Perf = a.perf;
    } else {
        t0Perf = performance.now();
    }
    updatePlayBtn();
    frame();
}

function frame() {
    const notes = state.replay!.notes;
    const tl = timeline;
    const nowPlay = basePlay + (performance.now() - t0Perf) * tempoRate;
    // Schedule every not-yet-scheduled note whose onset falls within the look-ahead window onto the
    // audio clock; each rings for its own length (from its note-off), floored/capped for musicality.
    if (soundOn) {
        const horizon = nowPlay + LOOKAHEAD_MS;
        while (audioIdx < notes.length && tl[audioIdx]! <= horizon) {
            const when = t0Ctx + (tl[audioIdx]! - basePlay) / 1000 / tempoRate;
            const dur = Math.min(MAX_NOTE_SEC, Math.max(MIN_NOTE_SEC, noteDurMs[audioIdx]! / tempoRate / 1000));
            playMidi(notes[audioIdx]!.midi, dur, undefined, when);
            audioIdx++;
        }
    }
    // The playhead trails the audio position by the user's extra offset (sound arrives that much later
    // than the browser reports, e.g. Bluetooth) so sight and sound line up. Audio scheduling above is
    // untouched — only the visual cursor is delayed.
    const nowVisual = nowPlay - (soundOn ? audioOffsetMs : 0) * tempoRate;
    // Advance the visual playhead to the latest onset whose time has arrived (may jump several under load).
    let i = state.step;
    while (i < notes.length - 1 && tl[i + 1]! <= nowVisual) i++;
    if (i !== state.step) { state.step = i; render(); }
    // Stop once the playhead reached the end AND all audio has been handed off to the clock.
    if (state.step >= notes.length - 1 && (!soundOn || audioIdx >= notes.length)) { stopPlay(false); render(); return; }
    raf = requestAnimationFrame(frame);
}

function togglePlay() { if (raf || pending) stopPlay(); else play(); }

function setTempo(rate: number) {
    if (raf) {   // re-anchor the clock at the CURRENT position (old rate) before applying the new rate,
        // else the whole elapsed span rescales and the playhead LEAPS. A moving playhead can't be
        // delayed to the speaker instant without stalling, so re-anchor now-to-now (playhead and audio
        // both continue from this instant); the small output-latency offset is imperceptible mid-play.
        basePlay = basePlay + (performance.now() - t0Perf) * tempoRate;
        t0Perf = performance.now();
        if (soundOn) t0Ctx = audioNow();
    }
    tempoRate = rate;
    ($('tempo') as HTMLInputElement).value = String(rateToPos(rate));
    $('tempo-val').textContent = `${rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
}

// A backgrounded tab freezes requestAnimationFrame but not performance.now(); resuming would fire one
// frame with a huge elapsed time and dump the whole backlog of past-due notes at once. So just pause.
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPlay(); });

/** ⌘/Ctrl+C dumps the current onset (⇧ adds the whole run) as agent-pasteable text. A real text
 *  selection still copies natively — the shortcut only claims the keystroke when nothing is selected. */
function copyContext(ev: KeyboardEvent) {
    if (!state.replay) return;
    if ((window.getSelection()?.toString() ?? '').trim()) return;
    ev.preventDefault();
    const whole = ev.shiftKey;
    const text = whole ? runReport(state) : contextReport(state);
    void copyText(text).then(ok => flash(ok ? (whole ? 'run copied' : 'copied') : 'copy failed'));
}

function syncUrl() {
    if (!state.fixtureId) return;
    const u = new URL(location.href);
    u.searchParams.set('fixture', state.fixtureId);
    u.searchParams.set('mode', state.mode);
    u.searchParams.set('step', String(state.step + 1));
    // spiral what-if params: omit when at the shipped default so a plain view keeps a clean URL
    if (state.spiralRange !== SPIRAL_RANGE_DEFAULT) u.searchParams.set('sr', String(state.spiralRange));
    else u.searchParams.delete('sr');
    if (state.spiralCenter !== SPIRAL_CENTER_DEFAULT) u.searchParams.set('sc', String(state.spiralCenter));
    else u.searchParams.delete('sc');
    if (state.spiralEven !== SPIRAL_EVEN_DEFAULT) u.searchParams.set('sk', '1');
    else u.searchParams.delete('sk');
    // experimental key lanes are off by default; only record when enabled
    if (state.lookAhead) u.searchParams.set('la', '1');
    if (state.showKeyLanes) u.searchParams.set('keys', '1');
    else u.searchParams.delete('keys');
    u.searchParams.delete('so');   // drop the retired packed-marker param if an old link is pasted in
    writeSideOverrides(u.searchParams, state.sideOverrides);
    history.replaceState(null, '', `${u.pathname}${readableSearch(u.searchParams)}${u.hash}`);
}

async function pickFixture(id: string, step = 0, preserveMarkers = false) {
    if (state.fixtureId !== id && !preserveMarkers) state.sideOverrides = [];
    state.fixtureId = id;
    const f = await loadFixture(id);
    rawEvents = f.events; rawExpected = f.expected;
    state.step = step;
    recompute();
    syncUrl();
}

function wire() {
    initPianoRoll(seek);
    liveTonnetz = initLiveTonnetz($('live-tonnetz'));
    $<HTMLSelectElement>('fixture').addEventListener('change', e => pickFixture((e.target as HTMLSelectElement).value));
    $<HTMLSelectElement>('mode').addEventListener('change', e => { state.mode = (e.target as HTMLSelectElement).value as Mode; recompute(); syncUrl(); });
    // Dragging the scrub fires a stream of `input`s; restarting playback on each would machine-gun the
    // look-ahead scheduler, so playback pauses for the drag and picks up once at `change` (release).
    let resumeAfterScrub = false;
    $<HTMLInputElement>('scrub').addEventListener('input', e => {
        if (raf) resumeAfterScrub = true;
        seek(Number((e.target as HTMLInputElement).value), false, false);
    });
    $<HTMLInputElement>('scrub').addEventListener('change', () => {
        if (!resumeAfterScrub) return;
        resumeAfterScrub = false;
        if (state.step < (state.replay?.notes.length ?? 0) - 1) play();
    });
    $('prev').addEventListener('click', () => seek(state.step - 1, true));
    $('next').addEventListener('click', () => seek(state.step + 1, true));
    $('side-sharp').addEventListener('click', () => setSideOverride(1));
    $('side-flat').addEventListener('click', () => setSideOverride(-1));
    $('side-auto').addEventListener('click', () => setSideOverride(0));
    $('side-clear').addEventListener('click', () => { state.sideOverrides = []; recompute(); syncUrl(); });
    $('play').addEventListener('click', () => togglePlay());
    $<HTMLInputElement>('sound').addEventListener('change', e => {
        soundOn = (e.target as HTMLInputElement).checked;
        if (soundOn) audioEnable(); else allNotesOff();
    });
    $<HTMLInputElement>('look-ahead').addEventListener('change', e => {
        state.lookAhead = (e.target as HTMLInputElement).checked;
        recompute(); syncUrl();   // changes the speller preset, so rebuild
    });
    $<HTMLInputElement>('key-lanes').addEventListener('change', e => {
        state.showKeyLanes = (e.target as HTMLInputElement).checked;
        render(); syncUrl();   // display-only: no recompute, just re-render the panels/lanes
    });
    $<HTMLInputElement>('tonnetz3d').addEventListener('change', e => setTonnetz3d((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('tempo').addEventListener('input', e => setTempo(posToRate(Number((e.target as HTMLInputElement).value))));
    const latencyEl = $<HTMLInputElement>('latency');
    latencyEl.value = String(audioOffsetMs);
    $('latency-val').textContent = `${audioOffsetMs}ms`;
    latencyEl.addEventListener('input', e => {
        audioOffsetMs = Number((e.target as HTMLInputElement).value);
        $('latency-val').textContent = `${audioOffsetMs}ms`;
        try { localStorage.setItem(LATENCY_KEY, String(audioOffsetMs)); } catch { /* storage blocked */ }
    });
    // The staff scales to fit its panel width, so re-render (debounced) when the window resizes.
    let resizeT = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = window.setTimeout(render, 120); });
    window.addEventListener('keydown', ev => {
        const tag = (ev.target as HTMLElement)?.tagName ?? '';
        if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'c' || ev.key === 'C')) { copyContext(ev); return; }
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;   // leave every other browser shortcut alone
        // Spacebar always plays/pauses — even while a <select> (e.g. the fixture picker) holds
        // focus after a change — except in real text fields where a space is literal input.
        if (ev.key === ' ' && !/INPUT|TEXTAREA/.test(tag)) { ev.preventDefault(); togglePlay(); return; }
        if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
        if (ev.key === 'ArrowRight') { ev.preventDefault(); seek(state.step + 1, true); }
        else if (ev.key === 'ArrowLeft') { ev.preventDefault(); seek(state.step - 1, true); }
        else if (ev.key === 'Home') { ev.preventDefault(); seek(0); }
        else if (ev.key === 'End') { ev.preventDefault(); seek((state.replay?.snapshots.length ?? 1) - 1); }
        else if (state.mode === 'tp' && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); setSideOverride(1); }
        else if (state.mode === 'tp' && (ev.key === 'f' || ev.key === 'F')) { ev.preventDefault(); setSideOverride(-1); }
        else if (state.mode === 'tp' && (ev.key === 'a' || ev.key === 'A')) { ev.preventDefault(); setSideOverride(0); }
        else if (state.mode === 'tp' && (ev.key === 'x' || ev.key === 'X')) { ev.preventDefault(); state.sideOverrides = []; recompute(); syncUrl(); }
    });
}

async function boot() {
    wire();
    setTempo(1);
    updatePlayBtn();
    const ids = await listFixtures();
    $<HTMLSelectElement>('fixture').innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
    const p = new URLSearchParams(location.search);
    const urlFixture = p.get('fixture');
    const urlMode = p.get('mode');
    const urlStep = p.get('step');
    if (urlMode === 'core' || urlMode === 'rt' || urlMode === 'tp' || urlMode === 'control') state.mode = urlMode;
    // Look-ahead is now the toolbar toggle on the real-time speller; migrate an old `?mode=la` link.
    if (urlMode === 'la') { state.mode = 'rt'; state.lookAhead = true; }
    if (p.get('la') === '1') state.lookAhead = true;
    if (p.get('sr')) state.spiralRange = clampRange(Number(p.get('sr')));
    if (p.get('sc')) state.spiralCenter = clampCenter(Number(p.get('sc')));
    if (p.get('sk')) state.spiralEven = p.get('sk') === '1';
    if (p.get('keys') === '1') state.showKeyLanes = true;
    state.sideOverrides = sideOverridesFromSearch(p);
    $<HTMLSelectElement>('mode').value = state.mode;
    $<HTMLInputElement>('look-ahead').checked = state.lookAhead;
    $<HTMLInputElement>('key-lanes').checked = state.showKeyLanes;
    const id = (urlFixture && ids.includes(urlFixture)) ? urlFixture : ids[0];
    if (id) {
        $<HTMLSelectElement>('fixture').value = id;
        await pickFixture(id, stepFromSearch(urlStep), true);
    }
    // Restore the persisted 3D-tonnetz choice now that a fixture (and its first snapshot) is loaded.
    applyTonnetz3d();
    if (tonnetz3dOn) render();
}

boot().catch(err => { $('status').textContent = 'ERROR: ' + err.message; console.error(err); });
