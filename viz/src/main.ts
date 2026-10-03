/** Entry point: load a fixture, drive the real shipped speller, and step through it. */
import { buildReplay, withSectionAutoResets, type Mode, type RawEvent, type Expected, type Replay } from './replay.js';
import {
    initialState, clampStep, current, clampRange, clampCenter,
    SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, SPIRAL_EVEN_DEFAULT,
    sideOverridesFromSearch, writeSideOverrides, readableSearch, stepFromSearch, type AppState,
} from './state.js';
import { renderWheel } from './panels/wheel.js';
import { renderScoring } from './panels/scoring.js';
import { initPianoRoll, renderPianoRoll, setTimeLine, setPlayheadHidden, setPlayheadTime } from './music/pianoroll.js';
import { renderStaff, renderLiveStaff, resetStaffScroll } from './music/staff.js';
import { initLiveTonnetz } from './panels/liveTonnetz.js';
import { connectMidi, midiAvailable } from './live.js';
import { enable as audioEnable, whenPlaying as audioReady, playMidi, releaseVoice, allNotesOff, audioNow, scheduleAnchor, ctxTimeAt, setVolume as audioSetVolume, type Voice } from './audio.js';
import { contextReport, runReport, copyText, flash } from './copy.js';
import { initHelp, mountInfoButtons, isHelpOpen } from './help.js';
import { label } from './format.js';
import { parseMusicXml, readMxl } from './import/musicxml.js';
import { Metronome, clicksPerBar, clickMs, barMs, COUNT_IN, type Grid } from './metronome.js';
import { layoutTake, toMusicXml } from './export/musicxml.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state: AppState = { ...initialState };
let liveTonnetz: ReturnType<typeof initLiveTonnetz>;

// 3D tonnetz: a whole-panel swap for the right column (the 3D lattice ⇄ the coiled Tonnetz). The 3D
// panel pulls in three.js, so `panels/tonnetz.js` is LAZY-loaded on first activation and its render loop
// only spins up then. Toggled from the small overlay button on each panel, persisted per-browser. Default
// is the 3D lattice: only an explicit switch to 2D is stored as '0'.
const TONNETZ3D_KEY = 'viz.tonnetz3d';
let tonnetz3dOn = (() => { try { return localStorage.getItem(TONNETZ3D_KEY) !== '0'; } catch { return true; } })();
let tonnetz3d: typeof import('./panels/tonnetz.js') | null = null;
let tonnetz3dLoading = false;

// Staff visibility: a toolbar toggle to hide the sheet-music band (handy on phones), persisted per-browser.
const SHOW_STAFF_KEY = 'viz.showStaff';
let staffVisible = (() => { try { return localStorage.getItem(SHOW_STAFF_KEY) !== '0'; } catch { return true; } })();
function applyStaffVisible() {
    $('staff').style.display = staffVisible ? '' : 'none';
    $<HTMLInputElement>('show-staff').checked = staffVisible;
}
function setStaffVisible(v: boolean) {
    staffVisible = v;
    try { localStorage.setItem(SHOW_STAFF_KEY, v ? '1' : '0'); } catch { /* storage blocked */ }
    applyStaffVisible();
    if (v) render();   // re-fit the staff to the (now-restored) band
}

// On phones the three side panels don't fit side by side, so only one shows at a time and a small tab
// bar switches between them (scoring / spiral / tonnetz). On wider screens all three show and the tab
// bar is hidden. `mobileTab` is which one is active in the narrow layout.
const MOBILE_MQ = window.matchMedia('(max-width: 720px)');
type PanelTab = 'scoring' | 'spiral' | 'tonnetz';
let mobileTab: PanelTab = 'tonnetz';

/** Set every side panel's visibility from the layout (all three on wide screens; only the active tab on
 *  phones) and the 3D/2D choice within the tonnetz slot; reflect the active tab; and lazy-build the 3D
 *  scene once its panel is actually on screen. Feeding the visible view its snapshot is left to render(). */
function applyPanelVisibility() {
    const mobile = MOBILE_MQ.matches;
    const showScoring = !mobile || mobileTab === 'scoring';
    const showSpiral = !mobile || mobileTab === 'spiral';
    const showTonnetz = !mobile || mobileTab === 'tonnetz';
    $('scoring').style.display = showScoring ? '' : 'none';
    $('wheel').style.display = showSpiral ? '' : 'none';
    $('live-tonnetz').style.display = showTonnetz && !tonnetz3dOn ? '' : 'none';
    $('tonnetz').style.display = showTonnetz && tonnetz3dOn ? 'flex' : 'none';
    for (const t of ['scoring', 'spiral', 'tonnetz'] as PanelTab[]) $(`tab-${t}`).classList.toggle('active', mobileTab === t);
    if (showTonnetz && tonnetz3dOn) ensureTonnetz3d();
}

/** Lazy-load and build the 3D lattice the first time its panel is shown (it pulls in three.js). */
function ensureTonnetz3d() {
    if (tonnetz3d) { tonnetz3d.initTonnetz($('tonnetz-canvas')); return; }   // initTonnetz is a no-op once built
    if (tonnetz3dLoading) return;
    tonnetz3dLoading = true;
    void import('./panels/tonnetz.js').then(mod => {
        tonnetz3dLoading = false;
        tonnetz3d = mod;
        if (!(tonnetz3dOn && (!MOBILE_MQ.matches || mobileTab === 'tonnetz'))) return;   // no longer visible
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
    applyPanelVisibility();
    render();
}

/** Switch the active panel in the narrow (phone) layout. */
function setMobileTab(tab: PanelTab) {
    mobileTab = tab;
    applyPanelVisibility();
    render();   // the newly shown panel needs the current snapshot (staff re-fit, 3D paint, …)
}

/** Append the corner overlay button that swaps this panel for the other tonnetz view. Its own panel
 *  hides when inactive, so the visible panel always shows exactly one switch (to the other view). */
function addViewSwitch(panelId: string, labelText: string, to3d: boolean) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'view-switch';
    btn.textContent = labelText;
    btn.title = to3d ? 'switch to the 3D tonnetz lattice (drag to orbit, scroll to zoom)'
                     : 'switch to the coiled 2D tonnetz';
    btn.addEventListener('click', () => setTonnetz3d(to3d));
    $(panelId).appendChild(btn);
}

/** Top-toolbar MIDI button. Web MIDI is requested only on this explicit click (never on load); the
 *  button then reflects the shared model's connection status. Hidden when the browser has no Web MIDI. */
function wireMidiButton() {
    const btn = $<HTMLButtonElement>('midi-enable');
    if (!midiAvailable()) { btn.hidden = true; return; }
    btn.addEventListener('click', () => {
        if (btn.classList.contains('connected')) { flash(btn.title); return; }
        btn.textContent = 'connecting…';
        void connectMidi(liveTonnetz.model);
    });
    // Green while a MIDI keyboard is connected; its name is the tooltip.
    liveTonnetz.model.subscribe(s => {
        const names = /^MIDI: (.*)/.exec(s.midiStatus)?.[1];
        btn.classList.toggle('connected', !!names);
        btn.textContent = '🎹 MIDI';
        btn.title = names ? `MIDI keyboard: ${names}`
            : /MIDI ready/.test(s.midiStatus) ? 'MIDI allowed, no keyboard detected (plug one in)'
            : /denied/.test(s.midiStatus) ? 'MIDI permission denied: click to ask again'
            : 'connect a MIDI keyboard (asks for permission on click)';
    });
    // Once the browser has granted MIDI, connect on load without asking again.
    void navigator.permissions?.query({ name: 'midi' as PermissionName })
        .then(p => { if (p.state === 'granted') void connectMidi(liveTonnetz.model); })
        .catch(() => { /* no permissions API for midi: the button still works */ });
}

const MODE_NAME: Record<Mode, string> = {
    core: '① Core speller',
    rt: '② real-time',
    la: '③ + look-ahead',
    tp: '④ two-pass (offline)',
    control: '⊘ control (fixed LoF)',
};

async function listFixtures(): Promise<string[]> {
    return (await (await fetch('fixtures/manifest.json')).json()) as string[];
}
async function loadFixture(id: string): Promise<{ events: RawEvent[]; expected: Expected[] }> {
    if (id === IMPORTED_ID && imported) return { events: imported.events, expected: imported.expected };
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

// An imported MusicXML score is a session-only fixture: it carries its own ground-truth spelling, so
// it grades exactly like a committed fixture. It lives in memory under one reserved dropdown slot
// (never fetched from disk, never written to the URL), replaced each time a new file is imported.
const IMPORTED_ID = '__imported__';
let imported: { events: RawEvent[]; expected: Expected[]; name: string } | null = null;
/** Friendly name for the currently loaded fixture (the imported piece's name, else its corpus id). */
function fixtureLabel(): string {
    const tk = shown();
    if (tk) return tk.name;
    return state.fixtureId === IMPORTED_ID && imported ? `↥ ${imported.name}` : (state.fixtureId ?? '');
}

// LIVE TAKES: session-only fixtures played on the computer keyboard or MIDI. They have no ground truth, so
// nothing is graded. Each note rebuilds the replay, so every panel follows the same engine the fixtures
// run on. There are two, side by side in the menu:
//  - FREE: whatever is played, in free time (a silence runs to the end of the bar and stops).
//    Playing always goes here, from a piece or from the metronome take.
//  - METRONOME: made by ● record, on a metronome grid. Recording again in its view adds notes from the red
//    time line; from anywhere else it starts a new recording (the old one can be undone).
interface Take {
    id: string; name: string; key: string;   // menu value, menu label, storage key
    events: RawEvent[];
    grid: Grid | null;                       // the metronome take's grid (always null for the free take)
    held: Set<number>;                       // keys down, recorded but not yet released
    t: number; wall: number; anchored: boolean;   // the take's clock: time at the last event, its input timeStamp
    parked: boolean;                         // the free take: Space stopped the write head; the next note lands at t
    recHead: number;                         // the metronome take: where ● record starts (a bar line), the red line
}
const newTake = (id: string, name: string, key: string): Take =>
    ({ id, name, key, events: [], grid: null, held: new Set(), t: 0, wall: 0, anchored: false, parked: false, recHead: 0 });
const freeTake = newTake('__free__', '🎹 free', 'viz.liveTake');
const recTake = newTake('__rec__', '🎹 metronome', 'viz.recTake');
const TAKES = [freeTake, recTake];

const LIVE_ONSET_TOLERANCE = 50;   // ms: keys pressed together for a chord arrive this spread out
const LIVE_GAP_CAP = 2000;         // ms: the longest silence kept by a take that is not shown against a bar grid
const LIVE_SETTLE = 1000;          // ms after the last release before look-ahead / two-pass re-spell the take
const LIVE_HOLD_SEC = 30;          // a held synth note sustains up to this long
const LEAD_MS = 120;               // ms before the first countdown click, so it is never scheduled late
const metro = new Metronome();
let rec: 'off' | 'countdown' | 'recording' = 'off';
let recFrom = 0;                   // where the current recording started
let recNotes = 0;                  // notes played in the current recording
let takeSettled = true;            // false while playing: look-ahead and two-pass wait for the pause
let settleTimer = 0;
let liveFrame = 0;                 // one rebuild per animation frame, however many notes arrived
let followStep = 0;                // the playhead follows the note just played
let holdTimer = 0;                 // while keys are held, the take refreshes so held notes grow
const liveVoices = new Map<number, Voice>();   // held computer-keyboard notes, released on key up
const undoStack: { tk: Take; events: RawEvent[]; grid: Grid | null }[] = [];
let backing: Voice[] = [];         // the metronome take's notes playing under a new pass
let backingTimer = 0;
let timeLineFrame = 0;
let writeHeadFrame = 0;

/** The take in view, or null on a piece. */
const shown = (): Take | null => TAKES.find(tk => tk.id === state.fixtureId) ?? null;
const isLive = () => shown() !== null;
const onRecording = () => state.fixtureId === recTake.id;

/** Insert an event in time order (after events at the same time); returns its index. Recording over a
 *  take puts notes mid-take, and the speller needs the stream in time order. */
function insertEvent(tk: Take, e: RawEvent): number {
    let i = tk.events.length;
    while (i > 0 && tk.events[i - 1]!.t_ms > e.t_ms) i--;
    tk.events.splice(i, 0, e);
    return i;
}

/** Time is real while a key is down or the metronome runs; only a free silence is shortened. */
const clockIsReal = (tk: Take) => tk.held.size > 0 || (tk === recTake && metro.running);

/** A take's clock now (provisional: for held notes and the time line). */
function takeClock(tk: Take, now = performance.now()): number {
    if (tk.parked) return tk.t;
    if (!tk.anchored) return !tk.events.length ? 0 : tk === freeTake ? beatEnd(tk.t) : tk.t + LIVE_GAP_CAP;
    const gap = Math.max(0, now - tk.wall);
    if (clockIsReal(tk)) return tk.t + gap;
    // The free take's silence runs on to the end of the bar and stops there.
    return tk === freeTake ? Math.min(tk.t + gap, beatEnd(tk.t)) : tk.t + Math.min(gap, LIVE_GAP_CAP);
}

/** Where the free take's silence stops after a release at `t`: the next bar line of the guide (tempo and time
 *  signature fields, from 0). Rests inside a bar keep their length; a pause ends on a downbeat. */
function beatEnd(t: number): number {
    const g = rollGridFor(freeTake)!, bar = barMs(g);
    return Math.ceil(t / bar - 1e-6) * bar;
}

/** Move a take's clock to `now` (an input timeStamp). */
function advanceClock(tk: Take, now: number) {
    tk.t = takeClock(tk, now);
    tk.wall = now;
    tk.anchored = true;
    tk.parked = false;
}

/** Is the free take's write head still moving (shown, after a note, before the bar line it stops on)? */
function writeHeadMoving(now = performance.now()): boolean {
    const tk = freeTake;
    return shown() === tk && tk.events.length > 0 && !tk.parked && tk.anchored && !tk.held.size
        && tk.t + (now - tk.wall) < beatEnd(tk.t);
}

/** Stop the free take's write head where it is: the next note lands right there. */
function parkWriteHead() {
    const now = performance.now();
    freeTake.t = takeClock(freeTake, now);
    freeTake.wall = now;
    freeTake.parked = true;
    syncTimeLine();
}

/** A take's events, with keys still held given a provisional release at its clock (so they read back
 *  like a released note), in time order. */
function liveEvents(tk: Take): RawEvent[] {
    if (!tk.held.size) return tk.events;
    const t = Math.round(takeClock(tk));
    const evs = tk.events.slice();
    let i = evs.length;
    while (i > 0 && evs[i - 1]!.t_ms > t) i--;   // mid-take when recording over it
    evs.splice(i, 0, ...[...tk.held].map(midi => ({ t_ms: t, type: 'off' as const, midi })));
    return evs;
}

/** The start of the metronome take's bar containing take time `t` (a note up to a 16th early belongs to the
 *  bar it was aiming at). */
function barStart(t: number, early = 0): number {
    const g = recTake.grid!, bar = barMs(g);
    return g.t0 + Math.max(0, Math.floor((t - g.t0 + early) / bar)) * bar;
}

/** The speller that spells the take right now: while playing, look-ahead and two-pass need a future
 *  that does not exist yet, so the real-time speller stands in until the pause. */
function liveMode(): Mode {
    const m = effMode();
    return !takeSettled && (m === 'la' || m === 'tp') ? 'rt' : m;
}

function resetTake(tk: Take) {
    tk.events = []; tk.grid = null; tk.held.clear(); tk.t = 0; tk.anchored = false; tk.parked = false; tk.recHead = 0;
}

/** Show a take (creating its menu entry). */
function enterTake(tk: Take) {
    stopPlay();
    if (shown() !== tk) resetStaffScroll();
    addTakeOption(tk);
    $<HTMLSelectElement>('fixture').value = tk.id;
    state.fixtureId = tk.id;
    state.sideOverrides = [];
    rawEvents = tk.events; rawExpected = [];
    $('take-clear').hidden = $('take-export-xml').hidden = false;
    syncRecUi();
    if (tk === freeTake) runWriteHead();
}

/** One keyboard or MIDI event: into the metronome take while recording, else into the free take. */
function liveInput(type: 'on' | 'off', midi: number, sound: boolean, now: number, velocity = 100) {
    // A press goes where notes go now; a release to the take that holds that key (it may have changed since).
    const tk = type === 'on' ? (rec !== 'off' ? recTake : freeTake) : TAKES.find(x => x.held.has(midi)) ?? freeTake;
    if (type === 'on') {
        // Only sounding: the help page's keyboard map, and the countdown before the recording starts.
        const recorded = !tk.held.has(midi) && !isHelpOpen() && !inCountdown(now);
        // Switch views and stop playback BEFORE the note sounds: both silence everything ringing.
        if (recorded && shown() !== tk) enterTake(tk);   // playing shows the free take, from a piece or the metronome take
        else if (recorded && (raf || pending)) stopPlay();
        if (!liveVoices.has(midi) && sound && soundOn) {   // a key sounds while held, recorded or not
            audioEnable();
            liveVoices.set(midi, playMidi(midi, LIVE_HOLD_SEC, 0.28 * Math.max(1, Math.min(127, velocity)) / 127));
        }
        if (!recorded) return;
        setPlayheadTime(null);   // a playhead left at the end of a finished playback goes
        if (rec !== 'off') recNotes++;
    } else {
        const v = liveVoices.get(midi);
        if (v) { releaseVoice(v); liveVoices.delete(midi); }
        if (!tk.held.has(midi)) return;
    }
    advanceClock(tk, now);
    if (tk === freeTake) runWriteHead();
    const at = insertEvent(tk, { t_ms: Math.round(tk.t), type, midi });
    if (type === 'on') followStep = tk.events.slice(0, at).filter(e => e.type === 'on').length;
    if (type === 'on') tk.held.add(midi); else tk.held.delete(midi);
    takeSettled = false;
    clearTimeout(settleTimer);
    if (tk.held.size === 0) {
        saveTake(tk);
        scheduleSettle();
    }
    clearInterval(holdTimer);
    if (tk.held.size) holdTimer = window.setInterval(() => {
        if (!tk.held.size) { clearInterval(holdTimer); return; }
        if (shown() === tk && !liveFrame) recompute();
    }, 100);
    if (shown() !== tk || liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
        liveFrame = 0;
        recompute();
        state.step = followStep;   // follow the note just played (mid-take when recording over it)
        render();
    });
}

/** Look-ahead and two-pass re-spell the take once every key has been up a moment. */
function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => { takeSettled = true; if (isLive()) recompute(); }, LIVE_SETTLE);
}

/** Release every key a take still holds, at its clock (a stop, or a switch of take, while keys are down). */
function closeHeld(tk: Take, at = performance.now()) {
    if (!tk.held.size) return;
    advanceClock(tk, at);
    const t = Math.round(tk.t);
    for (const midi of tk.held) insertEvent(tk, { t_ms: t, type: 'off', midi });
    tk.held.clear();
    saveTake(tk);
    scheduleSettle();
}

// The takes survive a reload in this browser (a convenience; they are never uploaded).
function saveTake(tk: Take) {
    try {
        if (tk.events.length || tk.grid) localStorage.setItem(tk.key, JSON.stringify({ events: tk.events, grid: tk.grid }));
        else localStorage.removeItem(tk.key);
    } catch { /* storage blocked */ }
}
/** Restore the saved takes into the menu without switching to them. An older single saved take that has a
 *  grid becomes the metronome take. */
function restoreTakes() {
    const read = (key: string): { events: RawEvent[]; grid: Grid | null } | null => {
        try {
            const raw = JSON.parse(localStorage.getItem(key) ?? 'null');
            if (!raw) return null;
            const events = (Array.isArray(raw) ? raw : (raw.events ?? []) as RawEvent[])
                .filter((e: RawEvent) => (e.type === 'on' || e.type === 'off') && typeof e.midi === 'number' && typeof e.t_ms === 'number');
            return { events, grid: Array.isArray(raw) ? null : (raw.grid ?? null) };
        } catch { return null; }
    };
    const free = read(freeTake.key), recd = read(recTake.key);
    if (free?.grid && !recd) { load(recTake, free); saveTake(recTake); free.events = []; free.grid = null; saveTake(freeTake); }
    else if (free) load(freeTake, { events: free.events, grid: null });
    if (recd) load(recTake, recd);
    function load(tk: Take, d: { events: RawEvent[]; grid: Grid | null }) {
        tk.events = d.events; tk.grid = d.grid;
        tk.t = tk.events.at(-1)?.t_ms ?? 0;
        tk.recHead = tk.grid ? (tk.grid.t1 ?? tk.grid.t0) : 0;
        if (tk.events.length) addTakeOption(tk);
    }
}
function addTakeOption(tk: Take) {
    const sel = $<HTMLSelectElement>('fixture');
    if (sel.querySelector(`option[value="${tk.id}"]`)) return;
    const opt = document.createElement('option');
    opt.value = tk.id; opt.textContent = tk.name;
    if (tk === recTake && sel.querySelector(`option[value="${freeTake.id}"]`)) sel.querySelector(`option[value="${freeTake.id}"]`)!.after(opt);
    else sel.prepend(opt);
}

/** Save `body` as a download named after the take and the time. */
function download(body: string, ext: string, type: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type }));
    const d = new Date(), z = (n: number) => String(n).padStart(2, '0');
    const what = onRecording() ? 'metronome' : 'free';
    a.download = `${what}-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Download the take in view as a fixture `events.json` (on/off events, ms). */
function exportTake() {
    const tk = shown();
    if (!tk?.events.length) { flash('nothing to export: play something first'); return; }
    download('[\n' + tk.events.map(e => `  ${JSON.stringify({ t_ms: e.t_ms, type: e.type, midi: e.midi })}`).join(',\n') + '\n]\n',
        'events.json', 'application/json');
}

/** Download the take in view as MusicXML: the shown speller's spellings on the metronome take's grid (or an
 *  estimated 4/4 for the free take), the key signature from the real-time speller's diatonic frame. */
function exportMusicXml() {
    const tk = shown();
    if (!tk?.events.length) { flash('nothing to export: play something first'); return; }
    if (rec !== 'off') endRecording(performance.now());
    clearTimeout(settleTimer);
    takeSettled = true;   // export the chosen speller's final spellings, not the real-time stand-in
    recompute();
    const r = state.replay!;
    const notes = r.notes.filter(n => n.committed)
        .map(n => ({ midi: n.midi, onT: n.onT, offT: n.offT, step: n.committed!.step, alter: n.committed!.alter }));
    const frame = buildReplay('rt', liveEvents(tk), [], { ...spiralOpts(), onsetTolerance: LIVE_ONSET_TOLERANCE });
    const keys = frame.snapshots.filter(s => s.frameLofTonic !== undefined).map(s => ({ t: s.t, fifths: s.frameLofTonic! }));
    const speller = MODE_NAME[state.mode] + (state.mode === 'rt' && state.lookAhead ? ' + look-ahead' : '');
    const input = { notes, grid: tk.grid, keys, title: onRecording() ? 'Metronome take' : 'Free take', speller, chordMs: LIVE_ONSET_TOLERANCE };
    const layout = layoutTake(input);
    download(toMusicXml(layout, input), 'musicxml', 'application/vnd.recordare.musicxml+xml');
    flash(`exported ${layout.bars} bar${layout.bars === 1 ? '' : 's'}${tk.grid ? '' : ' (free take: 4/4 and the tempo are estimated)'}`);
}

// UNDO: a recording pass, a deleted note and a clear can each be undone (⌘Z / Ctrl+Z).
function pushUndo(tk: Take) {
    undoStack.push({ tk, events: tk.events.slice(), grid: tk.grid && { ...tk.grid } });
    if (undoStack.length > 50) undoStack.shift();
}

/** Put a take back as it was before its last change, and show it. */
function restoreSnapshot(snap: { tk: Take; events: RawEvent[]; grid: Grid | null }) {
    const tk = snap.tk;
    tk.events = snap.events; tk.grid = snap.grid; tk.held.clear(); tk.anchored = false; tk.parked = false;
    clearInterval(holdTimer);
    tk.t = tk.events.at(-1)?.t_ms ?? 0;
    tk.recHead = tk.grid ? (tk.grid.t1 ?? tk.grid.t0) : 0;
    saveTake(tk);
    enterTake(tk);
    recompute();
    state.step = Math.max(0, Math.min(state.step, (state.replay?.snapshots.length ?? 1) - 1));
    render();
}

function undo() {
    if (rec !== 'off') return;
    const snap = undoStack.pop();
    if (!snap) { flash('nothing to undo'); return; }
    restoreSnapshot(snap);
    flash(`undone (${snap.tk.name})`);
}

// RECORDING: a 4-click countdown, then the downbeat. In the metronome take's view it starts at the red time line
// (a bar line: put there by clicking a note or empty space on the roll; after a recording it waits at the
// end) and ADDS to the metronome take, with its notes playing so you hear what you record over. From anywhere
// else it starts a new recording from bar 1 (the old one can be undone). While it runs the clock is real
// time, so a pause stays a pause. Stop ends it at once; the grid closes on the bar line after the last note
// (its `t1`).

/** For each note-on in `evs`, the index of its note-off (paired first-in first-out per pitch, as the replay does). */
function pairOffs(evs: readonly RawEvent[]): Map<number, number> {
    const open = new Map<number, number[]>(), pair = new Map<number, number>();
    evs.forEach((e, i) => {
        if (e.type === 'on') (open.get(e.midi!) ?? open.set(e.midi!, []).get(e.midi!)!).push(i);
        else if (e.type === 'off') { const q = open.get(e.midi!); if (q?.length) pair.set(q.shift()!, i); }
    });
    return pair;
}

function startRecording() {
    audioEnable();
    const now = performance.now();
    if (raf || pending) stopPlay();
    closeHeld(freeTake, now);   // keys held in the free take end there; new notes go to the metronome take
    if (liveFrame) { cancelAnimationFrame(liveFrame); liveFrame = 0; recompute(); }   // the replay must include every note
    const bpm = Math.max(30, Math.min(260, Number($<HTMLInputElement>('metro-bpm').value) || 90));
    const [num, den] = $<HTMLSelectElement>('metro-meter').value.split('/').map(Number) as [number, number];
    const tk = recTake;
    pushUndo(tk);
    let grid: Grid;
    if (onRecording() && tk.grid && tk.events.length) {
        grid = tk.grid;
        recFrom = tk.recHead;
        startBacking(recFrom - COUNT_IN * clickMs(grid), now + LEAD_MS);
    } else {
        // A new recording: bar 1 at 0 (where the guide lines already start, so nothing shifts); the
        // countdown runs at negative take time.
        clearTimeout(settleTimer); takeSettled = true;
        resetTake(tk);
        enterTake(tk);
        state.step = 0;
        grid = { bpm, num, den, t0: 0 };
        recFrom = 0;
        tk.grid = grid;
    }
    tk.t = recFrom - LEAD_MS - COUNT_IN * clickMs(grid);
    tk.wall = now;
    tk.anchored = true;
    recNotes = 0;
    const perBar = clicksPerBar(grid);
    const firstBar = Math.round((recFrom - grid.t0) / barMs(grid));   // bars before this recording starts
    rec = 'countdown';
    metro.start(grid.bpm, perBar, now + LEAD_MS, k => {
        const el = $('metro-beat');
        if (k < COUNT_IN) el.textContent = String(COUNT_IN - k);
        else {
            if (rec === 'countdown') rec = 'recording';
            const b = k - COUNT_IN;
            el.textContent = `● ${firstBar + Math.floor(b / perBar) + 1}.${(b % perBar) + 1}`;
        }
        el.classList.toggle('downbeat', k < COUNT_IN ? k === 0 : (k - COUNT_IN) % perBar === 0);
        el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
        syncRecUi();
    });
    const tick = () => { syncTimeLine(); timeLineFrame = requestAnimationFrame(tick); };
    timeLineFrame = requestAnimationFrame(tick);
    syncRecUi();
    recompute();
    render();
}

/** Play the metronome take's notes from take time `fromT` (heard at performance time `perfAt`), under a pass. */
function startBacking(fromT: number, perfAt: number) {
    stopBacking();
    if (!soundOn) return;
    const notes = (state.replay?.notes ?? []).filter(n => n.offT > fromT).slice().sort((a, b) => a.onT - b.onT);
    let i = 0;
    const tick = () => {
        const horizon = performance.now() + 200;
        while (i < notes.length) {
            const n = notes[i]!, start = Math.max(n.onT, fromT), at = perfAt + (start - fromT);
            if (at > horizon) break;
            i++;
            const when = ctxTimeAt(at);
            if (when >= audioNow()) backing.push(playMidi(n.midi, Math.max(0.05, (n.offT - start) / 1000), 0.18, when));
        }
        if (i >= notes.length) clearInterval(backingTimer);
    };
    tick();
    backingTimer = window.setInterval(tick, 50);
}

function stopBacking() {
    clearInterval(backingTimer);
    for (const v of backing) releaseVoice(v);
    backing = [];
}

/** The time line. In the metronome take: red, where recording starts, moving with the clock while it runs. In
 *  the free take: the grey write head, where the next note will land (it runs on after the last note and stops
 *  at the end of the bar). */
function syncTimeLine() {
    const tk = shown();
    if (tk === freeTake) { setTimeLine(tk.events.length ? takeClock(tk) : null, true, 'write'); return; }
    if (!onRecording() || !recTake.grid) { setTimeLine(null, false); return; }
    if (rec === 'off') setTimeLine(recTake.recHead, false);
    else setTimeLine(Math.max(recFrom, takeClock(recTake)), rec === 'recording');
}

/** Keep the free take's write head moving until it parks (at the bar line after the last note). */
function runWriteHead() {
    if (writeHeadFrame) return;
    const tick = () => {
        writeHeadFrame = 0;
        if (shown() !== freeTake) return;
        syncTimeLine();
        const parked = !freeTake.held.size && !writeHeadMoving();
        if (!parked) writeHeadFrame = requestAnimationFrame(tick);
    };
    writeHeadFrame = requestAnimationFrame(tick);
}

/** Is `now` still in the countdown? Decided by time, not by the click display: a downbeat played a little
 *  early (up to a 16th) belongs to the metronome take. */
function inCountdown(now: number): boolean {
    return rec !== 'off' && !!recTake.grid && takeClock(recTake, now) < recFrom - clickMs(recTake.grid) / 4;
}

/** Stop at once. A pass with no notes played (stopped in the countdown, say) is cancelled. */
function stopRecording() {
    if (rec !== 'off') endRecording(performance.now());
}

/** End the recording at `at` (performance clock). The grid closes on the bar line after the last note
 *  (its start, or its release less a 16th), so pressing stop just after the music ends adds no empty bar,
 *  and the time line waits there, ready to carry on. */
function endRecording(at: number) {
    const tk = recTake;
    advanceClock(tk, at);   // the time up to now was real
    closeHeld(tk, at);      // keys still down end at the stop
    metro.stop();
    stopBacking();
    cancelAnimationFrame(timeLineFrame);
    rec = 'off';
    $('metro-beat').textContent = '';
    if (!recNotes) {   // nothing played: as it was
        const snap = undoStack.pop();
        if (snap) restoreSnapshot(snap);
        flash('recording cancelled');
        return;
    }
    const g = tk.grid!, sixteenth = barMs(g) / (g.num * 16 / g.den);
    let last = -Infinity;
    for (const e of tk.events) last = Math.max(last, e.type === 'on' ? e.t_ms : e.t_ms - sixteenth);
    const bars = Math.max(1, Math.ceil((last - g.t0) / barMs(g) + 1e-6));
    g.t1 = g.t0 + bars * barMs(g);
    tk.recHead = g.t1;
    flash(`recorded · ${bars} bar${bars === 1 ? '' : 's'}`);
    tk.t = Math.max(tk.t, tk.events.at(-1)?.t_ms ?? 0);
    tk.wall = performance.now();
    syncRecUi();
    saveTake(tk);
    if (isLive()) {
        recompute();
        // The playhead goes to the start of what was just recorded, so Space plays it back.
        const from = recFrom - clickMs(g) / 4;
        const first = state.replay?.notes.findIndex(n => n.onT >= from) ?? -1;
        if (first >= 0) state.step = first;
        render();
    }
}

function syncRecUi() {
    setPlayheadHidden(rec !== 'off');   // while recording the red line is the head
    const btn = $('metro-toggle');
    btn.textContent = rec === 'off' ? '● record' : '■ stop';
    btn.classList.toggle('recording', rec !== 'off');
    // In the metronome take's view its tempo and time signature are shown, locked (clear unlocks them).
    const locked = onRecording() && !!recTake.grid && recTake.events.length > 0;
    if (locked) {
        $<HTMLInputElement>('metro-bpm').value = String(recTake.grid!.bpm);
        $<HTMLSelectElement>('metro-meter').value = `${recTake.grid!.num}/${recTake.grid!.den}`;
    }
    $<HTMLInputElement>('metro-bpm').disabled = rec !== 'off' || locked;
    $<HTMLSelectElement>('metro-meter').disabled = rec !== 'off' || locked;
    btn.title = rec !== 'off' ? 'stop recording (Space)'
        : locked ? 'record from the red line, adding to the metronome take (Enter)' : 'record a new take against the metronome (Enter)';
    syncTimeLine();
}

/** Remove the note at `step` from the take in view (Backspace / Delete). */
function deleteNote(step: number) {
    const tk = shown();
    if (!tk) return;
    const ons = tk.events.map((e, i) => e.type === 'on' ? i : -1).filter(i => i >= 0);
    const on = ons[step];
    if (on === undefined) return;
    const off = pairOffs(tk.events).get(on);
    if (off === undefined) { flash('release the key first'); return; }
    const spelled = state.replay?.notes[step]?.committed;
    pushUndo(tk);
    tk.events.splice(off, 1);
    tk.events.splice(on, 1);
    if (tk === freeTake) {   // the free take carries on from the last note still there, not from a deleted one
        tk.t = Math.max(0, ...tk.events.map(e => e.t_ms));
        tk.wall = performance.now();
        tk.anchored = true;
        tk.parked = false;
        runWriteHead();
    }
    recompute();
    state.step = Math.max(0, Math.min(step, (state.replay?.snapshots.length ?? 1) - 1));
    render();
    saveTake(tk);
    flash(`deleted ${spelled ? label(spelled) : 'note'}`);
}

/** Empty the take in view (undoable). */
function clearTake() {
    const tk = shown();
    if (!tk) return;
    if (rec !== 'off') endRecording(performance.now());
    pushUndo(tk);
    clearTimeout(settleTimer);
    clearInterval(holdTimer);
    for (const v of liveVoices.values()) releaseVoice(v);
    liveVoices.clear();
    takeSettled = true;
    resetTake(tk);
    saveTake(tk);
    enterTake(tk);
    state.step = 0;
    recompute();
}

/** Look-ahead is an OPTION of the real-time speller (`Speller({ lookAhead })`), surfaced as a toolbar
 *  toggle rather than a separate dropdown mode. Internally that is the `la` replay mode. */
function effMode(): Mode {
    return state.mode === 'rt' && state.lookAhead ? 'la' : state.mode;
}

/** The bar and beat lines on a take's roll: the metronome take's grid, else a guide from the tempo and time
 *  signature fields (the free take is not recorded against it). One object per setting, so the roll only
 *  rebuilds when it changes. */
let guideGrid: Grid | null = null;
function rollGrid(): Grid | null {
    const tk = shown();
    return tk ? rollGridFor(tk) : null;
}
function rollGridFor(tk: Take): Grid {
    if (tk.grid) return tk.grid;
    const bpm = Math.max(30, Math.min(260, Number($<HTMLInputElement>('metro-bpm').value) || 90));
    const [num, den] = $<HTMLSelectElement>('metro-meter').value.split('/').map(Number) as [number, number];
    if (!guideGrid || guideGrid.bpm !== bpm || guideGrid.num !== num || guideGrid.den !== den) guideGrid = { bpm, num, den, t0: 0 };
    return guideGrid;
}

/** The spiral what-if settings, as buildReplay takes them. */
function spiralOpts() {
    return { spiralRange: state.spiralRange, spiralCenter: state.spiralCenter, spiralEven: state.spiralEven, repair: state.repair, meanFrame: state.meanFrame };
}

function recompute() {
    if (!state.fixtureId) return;
    const live = isLive();
    state.replay = buildReplay(live ? liveMode() : effMode(), live ? liveEvents(shown()!) : rawEvents, rawExpected,
        { ...spiralOpts(), ...(live ? { onsetTolerance: LIVE_ONSET_TOLERANCE } : {}) },
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
function setRepair(v: boolean) {
    state.repair = v;
    recompute();
    syncUrl();
}

function setMeanFrame(v: boolean) {
    state.meanFrame = v;
    recompute();
    syncUrl();
}

function setSpiral(range: number, center: number, even: boolean) {
    state.spiralRange = clampRange(range);
    state.spiralCenter = clampCenter(center);
    state.spiralEven = even;
    recompute();
    syncUrl();
}

function renderStatus() {
    renderStatusText();
    $('status').title = $('status').textContent ?? '';   // the toolbar truncates it; the tooltip has it all
}
function renderStatusText() {
    const r = state.replay;
    if (!r) { $('status').textContent = ''; return; }
    const t = r.tally;
    const pc = (x: number) => t.total ? (100 * x / t.total).toFixed(1) : '0.0';
    // "correct" = exact + flipped (right pitch-class / coherent side); exact & flipped break it down.
    const modeName = MODE_NAME[state.mode] + (state.mode === 'rt' && state.lookAhead ? ' + look-ahead' : '');
    if (isLive()) {
        const waiting = liveMode() !== effMode();
        const g = shown()!.grid;
        $('status').innerHTML = `${fixtureLabel()}${g ? ` (${g.bpm} bpm ${g.num}/${g.den})` : ''} · ${modeName} · ${r.snapshots.length} onsets · <span class="dim">not graded`
            + (waiting ? ' · spelled real-time while you play, re-spelled when you pause' : '') + '</span>';
        return;
    }
    $('status').innerHTML = `${fixtureLabel()} · ${modeName} · ${r.snapshots.length} onsets · `
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
        repair: state.repair, onRepair: setRepair,
        meanFrame: state.meanFrame, onMeanFrame: setMeanFrame,
    });
    // Feed the shared live model always: the 2D panel subscribes, and so does the 3D panel (see the
    // subscription in the boot block), so whichever view is on tracks both playback and live input.
    liveTonnetz?.renderPlaybackSnapshot(snap);
    if (state.replay) {
        if (isLive()) renderLiveStaff(state.replay, state.step);
        else renderStaff(state.replay, state.step);
        renderPianoRoll(state.replay, state.step, state.showKeyLanes, rollGrid());
        syncTimeLine();
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
    mountInfoButtons();   // the panels wipe their innerHTML on render, so re-add each panel's help `i`
}

/** A thin ribbon of every onset, coloured by tier, with the cursor marked; click to seek. */
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

/** Move the playhead. Seeking WHILE PLAYING relocates the playhead and keeps rolling from there:
 *  the transport clock is re-anchored by `play()`, so nothing drifts. `resume` is off for the scrub
 *  slider, which seeks continuously while dragged and resumes once on release instead. */
function seek(i: number, audible = false, resume = true) {
    const wasPlaying = raf !== 0 || pending;
    stopPlay();
    allNotesOff();       // silence whatever was ringing, so the new position starts clean
    state.step = clampStep(state, i);
    // In the metronome take, picking a note puts the record start at the beginning of its bar.
    const picked = state.replay?.notes[state.step];
    if (onRecording() && recTake.grid && rec === 'off' && picked) recTake.recHead = barStart(picked.onT, clickMs(recTake.grid) / 4);
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
// so timing stays sample-accurate and doesn't drift when a dense texture makes rendering lag; under
// load the visual playhead simply skips events (drops frames) instead of falling behind, while every
// note still rings on time. Adapted from the lab viz's player.
let soundOn = true;
let tempoRate = 1;                 // playback speed multiplier (tempo slider); >1 faster
// Extra playhead delay (ms) ADDED on top of the auto-measured output latency, for setups the browser
// under-reports (chiefly Bluetooth headphones, whose latency getOutputTimestamp misses). Applied to
// the VISUAL playhead only (never to when audio is scheduled), so raising it lets sight catch up to
// late sound. Persisted per-browser.
const LATENCY_KEY = 'viz.audioOffsetMs';
const VOLUME_KEY = 'viz.volume';
let audioOffsetMs = (() => { try { const v = Number(localStorage.getItem(LATENCY_KEY)); return Number.isFinite(v) ? v : 0; } catch { return 0; } })();
const MAX_GAP_MS = 1800;           // cap a long held note / big rest so playback doesn't stall on silence
const LOOKAHEAD_MS = 150;          // schedule audio this far ahead of the playhead (covers a dropped frame)
const MIN_NOTE_SEC = 0.12, MAX_NOTE_SEC = 8;   // floor / ceiling on a single note's ring
// The tempo slider is LOGARITHMIC: position p ∈ [-1,1] → rate = SPAN^p, so p=0 is 1× dead-centre and
// equal slider travel = equal ratio.
const TEMPO_SPAN = 4;
const posToRate = (p: number) => Math.pow(TEMPO_SPAN, p);
const rateToPos = (r: number) => Math.log(r) / Math.log(TEMPO_SPAN);

// Per-note cumulative playback time (ms), each inter-onset gap capped at MAX_GAP_MS: honours the
// score's rhythm but never lets a huge rest stall the player. Rebuilt only when the replay changes.
let timeline: number[] = [];
let noteDurMs: number[] = [];
// Exact unison duplicate per on-index: the same MIDI already struck at this same instant (an earlier
// note shares its onset time and pitch). Orchestral/choral scores double a pitch across voices, so
// without this the player stacks N identical oscillators at one `when` — louder, phasey, "played twice".
// Octave doublings are a different pitch and are NOT flagged. Audio-only; the visuals show every note.
let dupOnset: boolean[] = [];
let timelineFor: Replay | null = null;
function ensureTimeline(replay: Replay): number[] {
    if (timelineFor === replay) return timeline;
    const notes = replay.notes;
    timeline = new Array(notes.length);
    noteDurMs = new Array(notes.length);
    dupOnset = new Array(notes.length);
    let acc = 0;
    let curOnT = NaN;
    const struck = new Set<number>();   // MIDIs already struck at the current onset (notes are onset-ordered)
    for (let i = 0; i < notes.length; i++) {
        const n = notes[i]!;
        if (n.onT !== curOnT) { curOnT = n.onT; struck.clear(); }
        dupOnset[i] = struck.has(n.midi);
        struck.add(n.midi);
        timeline[i] = acc;
        noteDurMs[i] = Math.max(0, n.offT - n.onT);
        const next = notes[i + 1];
        if (next) acc += Math.min(MAX_GAP_MS, Math.max(0, next.onT - n.onT));
    }
    timelineFor = replay;
    return timeline;
}

const START_LEAD_MS = 120;         // schedule the first onset this far ahead so it lands cleanly
let raf = 0, pending = false, t0Perf = 0, t0Ctx = 0, basePlay = 0, audioIdx = 0;
// `silence` cuts the notes already committed to the audio clock (the LOOKAHEAD buffer keeps ringing
// otherwise, so a pause would let sound run on past the stopped playhead). The natural end of the
// piece passes false so the final chord rings out instead of being clipped.
function stopPlay(silence = true, keepPlayhead = false) {
    pending = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!keepPlayhead) setPlayheadTime(null);   // a natural finish leaves it at the end of the last note
    if (silence && soundOn) allNotesOff();
    updatePlayBtn();
}
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
        // anchor the visual playhead to when that onset actually reaches the SPEAKERS: scheduleAnchor
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
            if (!dupOnset[audioIdx]) {   // a unison duplicate is already sounding at this instant; play once
                const when = t0Ctx + (tl[audioIdx]! - basePlay) / 1000 / tempoRate;
                const dur = Math.min(MAX_NOTE_SEC, Math.max(MIN_NOTE_SEC, noteDurMs[audioIdx]! / tempoRate / 1000));
                playMidi(notes[audioIdx]!.midi, dur, undefined, when);
            }
            audioIdx++;
        }
    }
    // The playhead trails the audio position by the user's extra offset (sound arrives that much later
    // than the browser reports, e.g. Bluetooth) so sight and sound line up. Audio scheduling above is
    // untouched; only the visual cursor is delayed.
    const nowVisual = nowPlay - (soundOn ? audioOffsetMs : 0) * tempoRate;
    // Advance the visual playhead to the latest onset whose time has arrived (may jump several under load).
    let i = state.step;
    while (i < notes.length - 1 && tl[i + 1]! <= nowVisual) i++;
    if (i !== state.step) { state.step = i; render(); }
    // The roll's playhead glides with time between onsets (the timeline shortens long gaps, so map back),
    // and through the last note to its end.
    const a = notes[i]!, b = notes[i + 1];
    const span = b ? tl[i + 1]! - tl[i]! : noteDurMs[i]!;
    const to = b ? b.onT : a.offT;
    const f = span > 0 ? Math.max(0, Math.min(1, (nowVisual - tl[i]!) / span)) : 1;
    setPlayheadTime(a.onT + f * (to - a.onT));
    // Stop once the playhead has reached the end of the last note AND all audio has been handed off; the
    // playhead stays there.
    if (state.step >= notes.length - 1 && f >= 1 && (!soundOn || audioIdx >= notes.length)) { stopPlay(false, true); render(); return; }
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
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    stopPlay();
    if (rec !== 'off') stopRecording();   // background timers are throttled: the clicks would drift
});

/** ⌘/Ctrl+C dumps the current onset (⇧ adds the whole run) as agent-pasteable text. A real text
 *  selection still copies natively; the shortcut only claims the keystroke when nothing is selected. */
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
    // An imported fixture is session-only (can't be reloaded from a URL), so keep it out of the link.
    if (state.fixtureId === IMPORTED_ID || isLive()) u.searchParams.delete('fixture');
    else u.searchParams.set('fixture', state.fixtureId);
    u.searchParams.set('mode', state.mode);
    u.searchParams.set('step', String(state.step + 1));
    // spiral what-if params: omit when at the shipped default so a plain view keeps a clean URL
    if (state.spiralRange !== SPIRAL_RANGE_DEFAULT) u.searchParams.set('sr', String(state.spiralRange));
    else u.searchParams.delete('sr');
    if (state.spiralCenter !== SPIRAL_CENTER_DEFAULT) u.searchParams.set('sc', String(state.spiralCenter));
    else u.searchParams.delete('sc');
    if (state.spiralEven !== SPIRAL_EVEN_DEFAULT) u.searchParams.set('sk', '1');
    else u.searchParams.delete('sk');
    if (state.repair) u.searchParams.set('rp', '1');
    else u.searchParams.delete('rp');
    if (state.meanFrame) u.searchParams.set('fm', '1');
    else u.searchParams.delete('fm');
    // look-ahead is on by default; only record when turned off
    if (state.lookAhead) u.searchParams.delete('la');
    else u.searchParams.set('la', '0');
    // experimental key lanes are off by default; only record when enabled
    if (state.showKeyLanes) u.searchParams.set('keys', '1');
    else u.searchParams.delete('keys');
    u.searchParams.delete('so');   // drop the retired packed-marker param if an old link is pasted in
    writeSideOverrides(u.searchParams, state.sideOverrides);
    history.replaceState(null, '', `${u.pathname}${readableSearch(u.searchParams)}${u.hash}`);
}

/**
 * Import a MusicXML file as a session-only fixture. The score's own notated spelling becomes the
 * ground truth, so it grades like any committed fixture. Reuses one reserved dropdown slot; a second
 * import replaces it. `.mxl` (zipped) is not read here.
 */
async function importMusicXmlFile(file: File) {
    const btn = $<HTMLButtonElement>('import-btn');
    const overlay = $('import-overlay');
    btn.disabled = true;
    overlay.hidden = false;
    // Let the loading wheel paint before the (possibly heavy, synchronous) parse blocks the main thread.
    // setTimeout, not requestAnimationFrame: rAF can stall in a backgrounded tab and hang the import.
    await new Promise<void>(res => setTimeout(res, 0));
    try {
        const xml = /\.mxl$/i.test(file.name) ? await readMxl(await file.arrayBuffer()) : await file.text();
        const r = parseMusicXml(xml, file.name);
        // File names run long (paths, encoding junk); cap the label and keep the full name as a tooltip.
        const short = r.name.length > 22 ? r.name.slice(0, 21).trimEnd() + '…' : r.name;
        imported = { events: r.events, expected: r.expected, name: short };
        const sel = $<HTMLSelectElement>('fixture');
        let opt = sel.querySelector<HTMLOptionElement>(`option[value="${IMPORTED_ID}"]`);
        if (!opt) { opt = document.createElement('option'); sel.appendChild(opt); opt.value = IMPORTED_ID; }
        opt.textContent = `↥ ${short} (imported)`;
        opt.title = r.name;
        sel.value = IMPORTED_ID;
        await pickFixture(IMPORTED_ID, 0);
        // A file our own exporter wrote carries the speller's spellings: grading the speller against them
        // proves nothing until a person has corrected them.
        if (xml.includes('<software>enharmonic viz</software>')) r.warnings.unshift('these spellings came from the speller itself: grading it against them proves nothing until they are corrected');
        const tail = r.warnings.length ? ` (${r.warnings.join('; ')})` : '';
        flash(`imported ${r.name} · ${r.expected.length} notes${tail}`);
    } catch (e) {
        flash(`import failed: ${(e as Error).message}`);
    } finally {
        overlay.hidden = true;
        btn.disabled = false;
    }
}

async function pickFixture(id: string, step = 0, preserveMarkers = false) {
    stopPlay();   // a new piece: stop playback so the old audio/playhead never runs on into it
    resetStaffScroll();
    const tk = TAKES.find(x => x.id === id);
    if (rec !== 'off' && id !== recTake.id) endRecording(performance.now());   // a cancelled pass re-shows its take
    $<HTMLSelectElement>('fixture').value = id;
    $('take-clear').hidden = $('take-export-xml').hidden = !tk;   // ⤓ events stays hidden (dev only)
    if (tk) {   // a take: land on its latest note
        enterTake(tk); recompute();
        state.step = (state.replay?.snapshots.length ?? 1) - 1;
        render(); syncUrl(); return;
    }
    if (state.fixtureId !== id && !preserveMarkers) state.sideOverrides = [];
    state.fixtureId = id;
    syncRecUi();
    const f = await loadFixture(id);
    rawEvents = f.events; rawExpected = f.expected;
    state.step = step;
    recompute();
    syncUrl();
}

function wire() {
    initPianoRoll(seek, t => {   // empty space on the roll: the record start goes to that bar
        if (onRecording() && recTake.grid && rec === 'off') { recTake.recHead = barStart(t); syncTimeLine(); }
    });
    liveTonnetz = initLiveTonnetz($('live-tonnetz'));
    liveTonnetz.model.setInputSink(liveInput);   // keyboard and MIDI notes go to the free take (or the metronome take)
    // Clear asks twice: the first click arms it for 3 s, the second clears.
    let clearArmed = 0;
    const disarmClear = () => { clearTimeout(clearArmed); clearArmed = 0; $('take-clear').textContent = 'clear'; $('take-clear').classList.remove('armed'); };
    $('take-clear').addEventListener('click', () => {
        if (clearArmed) { disarmClear(); clearTake(); return; }
        $('take-clear').textContent = 'click again to clear';
        $('take-clear').classList.add('armed');
        clearArmed = window.setTimeout(disarmClear, 3000);
    });
    $('take-export').addEventListener('click', exportTake);
    $('take-export-xml').addEventListener('click', exportMusicXml);
    $('metro-toggle').addEventListener('click', () => rec === 'off' ? startRecording() : stopRecording());
    // The guide lines on the free take follow the tempo and time signature fields.
    for (const id of ['metro-bpm', 'metro-meter']) $(id).addEventListener('input', () => { if (isLive()) { render(); runWriteHead(); } });
    // The panel's own reset belongs to its standalone page; here a fresh take is the toolbar's job.
    $('live-tonnetz').querySelector<HTMLElement>('.live-reset')!.hidden = true;
    // The 3D lattice subscribes to the same live model as the 2D panel, so it tracks live input and
    // playback identically; it only paints while it is the visible view and its scene has been built.
    liveTonnetz.model.subscribe(s => { if (tonnetz3dOn && tonnetz3d) tonnetz3d.renderTonnetzLive(s); });
    // Small overlay on each panel swaps to the other view (each button names the view it opens).
    addViewSwitch('tonnetz', '2D coiled', false);
    addViewSwitch('live-tonnetz', '3D lattice', true);
    wireMidiButton();
    // Mobile panel switcher + re-apply visibility when crossing the phone breakpoint.
    for (const t of ['scoring', 'spiral', 'tonnetz'] as PanelTab[]) $(`tab-${t}`).addEventListener('click', () => setMobileTab(t));
    MOBILE_MQ.addEventListener('change', () => { applyPanelVisibility(); render(); });
    $<HTMLSelectElement>('fixture').addEventListener('change', e => pickFixture((e.target as HTMLSelectElement).value));
    // Import a MusicXML score (button opens the picker; drop works anywhere on the app).
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $<HTMLInputElement>('import-file').addEventListener('change', e => {
        const el = e.target as HTMLInputElement;
        const f = el.files?.[0];
        if (f) void importMusicXmlFile(f);
        el.value = '';   // let the same file be re-imported
    });
    window.addEventListener('dragover', e => { e.preventDefault(); });
    window.addEventListener('drop', e => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) void importMusicXmlFile(f);
    });
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
    // Master output volume (0..100 -> 0..1), persisted per-browser.
    const volEl = $<HTMLInputElement>('volume');
    const savedVol = (() => { try { const v = localStorage.getItem(VOLUME_KEY); return v == null ? null : Number(v); } catch { return null; } })();
    if (savedVol != null && Number.isFinite(savedVol)) volEl.value = String(savedVol);
    const applyVolume = () => { const pct = Number(volEl.value); audioSetVolume(pct / 100); $('volume-val').textContent = `${pct}%`; };
    applyVolume();
    volEl.addEventListener('input', () => {
        applyVolume();
        try { localStorage.setItem(VOLUME_KEY, volEl.value); } catch { /* storage blocked */ }
    });
    $<HTMLInputElement>('show-staff').addEventListener('change', e => setStaffVisible((e.target as HTMLInputElement).checked));
    $<HTMLInputElement>('look-ahead').addEventListener('change', e => {
        state.lookAhead = (e.target as HTMLInputElement).checked;
        recompute(); syncUrl();   // changes the speller preset, so rebuild
    });
    $<HTMLInputElement>('key-lanes').addEventListener('change', e => {
        state.showKeyLanes = (e.target as HTMLInputElement).checked;
        render(); syncUrl();   // display-only: no recompute, just re-render the panels/lanes
    });
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
    // Transport keys are GLOBAL: space plays/pauses and the arrows move the playhead no matter which
    // control was last clicked: a focused button, checkbox or <select> must not swallow them (clicking
    // "look-ahead" then pressing space should play, not re-toggle the box). Only a genuine text field
    // (none in this app today) keeps a key as literal input.
    const isTextField = (el: HTMLElement | null): boolean => !!el && (el.isContentEditable
        || el.tagName === 'TEXTAREA'
        || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/i.test((el as HTMLInputElement).type)));
    window.addEventListener('keydown', ev => {
        if (isHelpOpen()) return;   // the help overlay owns the keyboard while it is up (Esc closes it)
        const target = ev.target as HTMLElement | null;
        if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'c' || ev.key === 'C')) { copyContext(ev); return; }
        if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z') && isLive() && !isTextField(target)) { ev.preventDefault(); undo(); return; }
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;   // leave every other browser shortcut alone
        if (isTextField(target)) return;                     // literal typing wins; otherwise keys are global
        // Space stops whatever is moving (a recording, playback, the free take's write head); otherwise it plays.
        if (ev.key === ' ') {
            ev.preventDefault();
            if (rec !== 'off') stopRecording();
            else if (raf || pending) togglePlay();
            else if (writeHeadMoving()) parkWriteHead();
            else togglePlay();
            return;
        }
        // Enter records (letters are notes); a focused button or menu keeps its own Enter.
        if (ev.key === 'Enter' && !(target instanceof HTMLButtonElement || target instanceof HTMLSelectElement)) {
            ev.preventDefault(); if (rec !== 'off') stopRecording(); else startRecording(); return;
        }
        if ((ev.key === 'Backspace' || ev.key === 'Delete') && isLive() && rec === 'off') { ev.preventDefault(); deleteNote(state.step); return; }
        // Shift+X is the clear button (letters alone are notes): the first press arms it, the second clears.
        if (ev.shiftKey && (ev.key === 'X' || ev.key === 'x') && isLive() && rec === 'off') { ev.preventDefault(); $('take-clear').click(); return; }
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
    restoreTakes();
    const p = new URLSearchParams(location.search);
    const urlFixture = p.get('fixture');
    const urlMode = p.get('mode');
    const urlStep = p.get('step');
    if (urlMode === 'core' || urlMode === 'rt' || urlMode === 'tp' || urlMode === 'control') state.mode = urlMode;
    // Look-ahead is now the toolbar toggle on the real-time speller; migrate an old `?mode=la` link.
    if (urlMode === 'la') { state.mode = 'rt'; state.lookAhead = true; }
    if (p.get('la')) state.lookAhead = p.get('la') !== '0';
    if (p.get('sr')) state.spiralRange = clampRange(Number(p.get('sr')));
    if (p.get('sc')) state.spiralCenter = clampCenter(Number(p.get('sc')));
    if (p.get('sk')) state.spiralEven = p.get('sk') === '1';
    if (p.get('rp')) state.repair = p.get('rp') === '1';
    if (p.get('fm')) state.meanFrame = p.get('fm') === '1';
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
    // Apply panel visibility (3D/2D choice + mobile tab) and the staff toggle now that a fixture is loaded.
    applyStaffVisible();
    applyPanelVisibility();
    render();
    initHelp();   // overlay + toolbar button + panel `i`s; opens itself on the first visit
}

boot().catch(err => { $('status').textContent = 'ERROR: ' + err.message; console.error(err); });
