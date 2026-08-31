/** Entry point: load a fixture, drive the real shipped speller, and step through it. */
import { buildReplay, type Mode, type RawEvent, type Expected, type Replay } from './replay.js';
import {
    initialState, clampStep, current, clampRange, clampCenter,
    SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, type AppState,
} from './state.js';
import { renderWheel } from './panels/wheel.js';
import { renderStateTable } from './panels/stateTable.js';
import { renderScoring } from './panels/scoring.js';
import { initPianoRoll, renderPianoRoll } from './music/pianoroll.js';
import { renderStaff } from './music/staff.js';
import { enable as audioEnable, playMidi, allNotesOff, audioNow } from './audio.js';
import { contextReport, runReport, copyText, flash } from './copy.js';
import { label } from './format.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state: AppState = { ...initialState };

const MODE_NAME: Record<Mode, string> = {
    rt: '② real-time (diatonic anchor)',
    la: '③ + look-ahead',
    tp: '④ two-pass (offline)',
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

function recompute() {
    if (!state.fixtureId) return;
    state.replay = buildReplay(state.mode, rawEvents, rawExpected,
        { spiralRange: state.spiralRange, spiralCenter: state.spiralCenter });
    state.step = clampStep(state, state.step);
    renderStatus();
    render();
}

/** Change the spiral what-if params (from the wheel steppers), rebuild, and persist to the URL. */
function setSpiral(range: number, center: number) {
    state.spiralRange = clampRange(range);
    state.spiralCenter = clampCenter(center);
    recompute();
    syncUrl();
}

function renderStatus() {
    const r = state.replay;
    if (!r) { $('status').textContent = ''; return; }
    const t = r.tally;
    const pc = (x: number) => t.total ? (100 * x / t.total).toFixed(1) : '0.0';
    // "correct" = exact + flipped (right pitch-class / coherent side); exact & flipped break it down.
    $('status').innerHTML = `${state.fixtureId} · ${MODE_NAME[state.mode]} · ${r.snapshots.length} onsets · `
        + `<span class="correct">${pc(t.correct + t.flipped)}% correct</span>`
        + ` (<span class="exact">exact: ${pc(t.correct)}%</span>, <span class="flipped">flipped: ${pc(t.flipped)}%</span>) · `
        + `<span class="wrong">${pc(t.wrong)}% wrong (${t.wrong})</span>`
        + (t.unread ? ` · <span class="dim">${t.unread} unread</span>` : '');
}

function render() {
    const snap = current(state);
    renderScoring($('scoring'), snap);
    renderWheel($('wheel'), snap, {
        range: state.spiralRange, center: state.spiralCenter,
        streaming: state.mode !== 'tp', onChange: setSpiral,
    });
    renderStateTable($('stateTable'), snap);
    if (state.replay) {
        renderStaff(state.replay, state.step);
        renderPianoRoll(state.replay, state.step);
    }
    renderStrip();
    $('scrub').setAttribute('max', String(Math.max(0, (state.replay?.snapshots.length ?? 1) - 1)));
    ($('scrub') as HTMLInputElement).value = String(state.step);
    $('pos').textContent = `${state.step + 1} / ${state.replay?.snapshots.length ?? 0}`;
}

/** A thin ribbon of every onset, coloured by tier, with the cursor marked — click to seek. */
function renderStrip() {
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
    const wasPlaying = raf !== 0;
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

let raf = 0, t0Perf = 0, t0Ctx = 0, basePlay = 0, audioIdx = 0;
function stopPlay() { if (raf) { cancelAnimationFrame(raf); raf = 0; updatePlayBtn(); } }
function updatePlayBtn() { $('play').textContent = raf ? '⏸' : '▶'; }

function play() {
    if (!state.replay || !state.replay.notes.length) return;
    const notes = state.replay.notes;
    if (state.step >= notes.length - 1) state.step = 0;   // restart from the top if parked at the end
    const tl = ensureTimeline(state.replay);
    t0Perf = performance.now();
    basePlay = tl[state.step]!;
    audioIdx = state.step;
    if (soundOn) { audioEnable(); t0Ctx = audioNow(); }
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
    // Advance the visual playhead to the latest onset whose time has arrived (may jump several under load).
    let i = state.step;
    while (i < notes.length - 1 && tl[i + 1]! <= nowPlay) i++;
    if (i !== state.step) { state.step = i; render(); }
    // Stop once the playhead reached the end AND all audio has been handed off to the clock.
    if (state.step >= notes.length - 1 && (!soundOn || audioIdx >= notes.length)) { stopPlay(); render(); return; }
    raf = requestAnimationFrame(frame);
}

function togglePlay() { if (raf) stopPlay(); else play(); }

function setTempo(rate: number) {
    if (raf) {   // re-anchor the clock at the CURRENT position (old rate) before applying the new rate,
        basePlay = basePlay + (performance.now() - t0Perf) * tempoRate;   // else the whole elapsed span
        t0Perf = performance.now();                                       // rescales and the playhead LEAPS
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
    u.searchParams.set('step', String(state.step));
    // spiral what-if params: omit when at the shipped default so a plain view keeps a clean URL
    if (state.spiralRange !== SPIRAL_RANGE_DEFAULT) u.searchParams.set('sr', String(state.spiralRange));
    else u.searchParams.delete('sr');
    if (state.spiralCenter !== SPIRAL_CENTER_DEFAULT) u.searchParams.set('sc', String(state.spiralCenter));
    else u.searchParams.delete('sc');
    history.replaceState(null, '', u);
}

async function pickFixture(id: string, step = 0) {
    state.fixtureId = id;
    const f = await loadFixture(id);
    rawEvents = f.events; rawExpected = f.expected;
    state.step = step;
    recompute();
    syncUrl();
}

function wire() {
    initPianoRoll(seek);
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
    $('play').addEventListener('click', () => togglePlay());
    $<HTMLInputElement>('sound').addEventListener('change', e => {
        soundOn = (e.target as HTMLInputElement).checked;
        if (soundOn) audioEnable(); else allNotesOff();
    });
    $<HTMLInputElement>('tempo').addEventListener('input', e => setTempo(posToRate(Number((e.target as HTMLInputElement).value))));
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
    if (urlMode === 'rt' || urlMode === 'la' || urlMode === 'tp') state.mode = urlMode;
    if (p.get('sr')) state.spiralRange = clampRange(Number(p.get('sr')));
    if (p.get('sc')) state.spiralCenter = clampCenter(Number(p.get('sc')));
    $<HTMLSelectElement>('mode').value = state.mode;
    const id = (urlFixture && ids.includes(urlFixture)) ? urlFixture : ids[0];
    if (id) {
        $<HTMLSelectElement>('fixture').value = id;
        await pickFixture(id, urlStep && /^\d+$/.test(urlStep) ? Number(urlStep) : 0);
    }
}

boot().catch(err => { $('status').textContent = 'ERROR: ' + err.message; console.error(err); });
