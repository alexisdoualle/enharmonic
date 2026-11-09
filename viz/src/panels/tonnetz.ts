/**
 * 3D Tonnetz panel: the harmonic space the shipped speller reasons about, drawn as a lattice of
 * fifths (x), major/minor thirds (y) and accidental layers (z). Ported from the standalone tonnetz app
 * (`TonnetzSceneV2`, vendored under `viz/src/tonnetz3d/`), driven here purely by the enharmonic engine's
 * per-onset output: the resolved 7-letter surface becomes the lit scale, and the notes ringing at the
 * onset (spelled exactly as the library committed them) light their lattice nodes. So the Tonnetz is a
 * DISPLAY of the speller's choices (every spelling still comes from `src/`), not a second speller.
 *
 * Unlike the SVG panels, a WebGL scene is expensive to build and must persist across steps, so this
 * panel uses an init-once / update-per-step lifecycle (like the piano roll): `initTonnetz(container)`
 * builds the scene and starts a render loop; `renderTonnetz(snap)` retargets the lit nodes each onset.
 * The scene smooths activations over wall-clock time, so the loop runs continuously while mounted.
 */
import type { Snapshot } from '../replay.js';
import { pcOf } from '../replay.js';
import type { LiveState } from '../live.js';
import { TonnetzSceneV2, type TonnetzSceneConfig } from '../tonnetz3d/TonnetzSceneV2.js';
import { PitchClass } from '../tonnetz3d/core/PitchClass.js';
import { triadColor as sharedTriadColor } from '../music/triadColor.js';
import type { LetterName } from '../tonnetz3d/types.js';
import { allSymClasses, symClassesIn, type SymClass, type SymPlaneSpec } from '../tonnetz3d/symmetricPlanes.js';

// Grid footprint: wide enough along the fifths chain to hold a key's neighbourhood, a few third-rows
// deep so triads read as triangles. Kept modest: this is a debugger panel, not the full app's lattice.
const COLS = 15;
const ROWS = 5;

// C-major naturals, used before the first onset and in batch mode when there is no streaming surface.
const DEFAULT_SCALE_SPEC: [LetterName, number][] = [
    ['C', 0], ['D', 0], ['E', 0], ['F', 0], ['G', 0], ['A', 0], ['B', 0],
];
const defaultScale = (): PitchClass[] => DEFAULT_SCALE_SPEC.map(([l, a]) => new PitchClass(l, a));

// Triangle colouring lives in ../music/triadColor.ts (shared with the piano-roll chord lane); this
// binds it to the panel's current surface.
const triadColor = (type: string, notes?: PitchClass[]): string => sharedTriadColor(type, notes, scale);

// A lightweight stand-in for the tonnetz app's accumulator, enough to keep the harmony readable without
// porting the real thing. Two decays feed `getNoteActivation(pc)`:
//   • SCALE FLOOR: the 7 surface pitch-classes idle at a baseline so their triangles always tile the
//     lattice (the "scale shape"), instead of flashing only when a full triad happens to sound.
//   • CHORD DECAY: a note that stops sounding fades over CHORD_DECAY_TAU seconds rather than snapping
//     off, so a struck chord lingers as a glowing triad (the app's "chord decay").
const SCALE_FLOOR = 0.3;       // idle activation of an in-scale pitch-class (0..1)
const CHORD_DECAY_TAU = 1.8;   // seconds; larger = chords linger longer after release
// Diatonic-STEP lateral inhibition on the RESONANCE channel (fill brightness only, not node activation).
// The tonnetz app's accumulator suppresses a note by a stronger neighbour a scale STEP away: adjacent
// LETTERS, so A–B and B–C both count (a step, whole or half), not a chromatic semitone. So a lingering/
// floor note can't team up with a strong onset a step away to light spurious triangles. We mimic just that:
// res[pc] loses STEP_INHIBIT × (how much its loudest step-neighbour outweighs it). A note as loud as its
// step-neighbours is untouched; a faint one beside a loud one is pushed toward zero and its triads dim.
const STEP_INHIBIT = 1.0;      // 0 = off (every triad lights); 1 = a full-strength step-neighbour fully mutes a floor note
const LETTER_ORDER = 'CDEFGAB'; // scale-step adjacency: index±1 (mod 7) are the neighbouring letters

// Live state the scene's config getters read (the scene pulls; we push into these).
let scale: PitchClass[] = defaultScale();
let lastPcSig = '';                     // MIDI-pc set of the surface; a change means a new chord (full rebuild)
let scalePCs = new Set<number>();       // pitch-classes of the current surface (for the scale floor)
let soundingPCs = new Set<number>();    // pitch-classes ringing at the current onset
const level = new Float32Array(12);     // decaying per-PC activation returned by getNoteActivation
const res = new Float32Array(12);       // level after semitone inhibition: drives triad fill brightness
let lastTick = 0;

let scene: TonnetzSceneV2 | null = null;
let raf = 0;
let lastScaleSig = '';

// Two display toggles, both off by default (off = the panel exactly as before). Read from / written to the
// page URL (`planes=sounding|aug|dim7`, `ghosts=1`) so a view can be linked; nothing is stored.
//   • PLANES: the sheet a symmetric chord's enharmonic continuation forms in the lattice (symmetricPlanes.ts).
//     `sounding` = the sheets of any augmented triad / dim7 whose pitch classes are all ringing (the main
//     sheet bright, its parallel copies faint); `aug` / `dim7` = every sheet of every such chord at once,
//     one hue per chord: the lattice sliced into 4 (or 3) interleaved diagonal sheets.
//   • GHOSTS: the scene's "All Notes" mode: every lattice cell in the window, not only the 7-note surface.
type PlanesMode = 'off' | 'sounding' | 'aug' | 'dim7';
const PLANES_MODES: PlanesMode[] = ['off', 'sounding', 'aug', 'dim7'];
let planesMode: PlanesMode = 'off';
let showGhosts = false;
let soundingSpelled = new Set<string>();   // `letter:accidental` of the ringing notes, as committed
let lastPlanesSig = '';
let captionEl: HTMLElement | null = null;

/** Signature of the 7-letter surface, so we only pay for a geometry rebuild when the spelling changes. */
function scaleSig(s: PitchClass[]): string {
    return s.map(p => `${p.letterName}${p.accidental}`).join(',');
}

/** Build the scene once and start the smoothing/render loop. Safe to call repeatedly (no-op if built). */
export function initTonnetz(container: HTMLElement): void {
    if (scene) return;
    const config: TonnetzSceneConfig = {
        getThirds: () => scale,
        getTriadColor: triadColor,
        getActivePCs: () => soundingPCs,
        getHeldPCs: () => soundingPCs,
        getNoteActivation: pc => level[pc] ?? 0,
        // Resonance drives the triad FILL brightness: a triangle interpolates from a dim floor toward full
        // opacity by the (squared) min resonance of its three vertices. Feeding the same decaying `level`
        // makes a full triad flare bright the instant all three notes sound, then fade over CHORD_DECAY_TAU
        // as the chord decays, while a diatonic triad whose notes only idle at the scale floor stays faint.
        getResonanceActivation: pc => res[pc] ?? 0,
        freeMode: () => false,
        cols: () => COLS,
        rows: () => ROWS,
    };
    scene = new TonnetzSceneV2(container, config);
    scene.setVisible(true);
    // Pull the camera back from the scene's default framing so the whole lattice neighbourhood is in view
    // on load: the panel is smaller than the standalone app's full-window canvas, so the default sits too
    // close. The user can still orbit/scroll to taste; this only sets the initial distance.
    // Pull further back on a phone-sized panel so the lattice neighbourhood fits the smaller viewport.
    scene.setCameraDistance(window.matchMedia('(max-width: 720px)').matches ? 2.7 : 1.7);
    // The scene's default z-gap (0.1) is tiny next to the in-plane grid (~1.4), so the accidental layers
    // stack almost flat. Spread them to distinct depths: 0.8 matches the tonnetz app's default.
    scene.setZSpacing(0.8);
    // Match the tonnetz app's look: bent (tilted, cross-layer chromatic) triads render with the hatched
    // "chickenwire" mesh texture instead of a solid fill, while flat diatonic triads stay solid. This is
    // the app's default (showTrianglePattern + meshTiltedNonPerfect on, meshAll off), so a chromatic chord
    // reads as a mesh triangle bridging accidental layers: the depth cue, no ghost nodes needed.
    scene.setTrianglePattern(true);
    scene.setMeshTiltedNonPerfect(true);
    // Hide the leading-tone / semitone resolution arrows: that overlay is driven by the app's
    // accumulator (note-on timestamps + resolved-midi logic) we don't feed, so it isn't meaningful here.
    scene.setShowArrows(false);
    // The vendored scene hardcodes a debug (x, y, z) label under every node; hide them: the note names
    // are the labels that matter here.
    scene.setShowCoords(false);
    mountLatticeControls(container);
    if (showGhosts) scene.setShowGhostNodes(true);
    lastScaleSig = scaleSig(scale);
    // Render loop: advance the decay accumulator on the wall clock, then let the scene smooth toward it.
    const loop = () => {
        const now = performance.now() * 0.001;
        const dt = lastTick ? Math.min(now - lastTick, 0.1) : 0;
        lastTick = now;
        const decay = dt ? Math.exp(-dt / CHORD_DECAY_TAU) : 1;
        for (let pc = 0; pc < 12; pc++) {
            const floor = scalePCs.has(pc) ? SCALE_FLOOR : 0;
            // Sounding → full; otherwise decay toward the scale floor (0 for out-of-scale PCs).
            level[pc] = soundingPCs.has(pc) ? 1 : Math.max(floor, level[pc]! * decay);
        }
        // Step inhibition: dock each surface note by how much its louder scale-STEP neighbour (adjacent
        // letter) outweighs it, so a strong onset mutes the faint/decaying notes a step away (and their
        // triads). Map the 7 surface letters → pcs, then compete adjacent letters. res defaults to level
        // for any pc not on the surface (out-of-scale notes idle at 0 anyway).
        for (let pc = 0; pc < 12; pc++) res[pc] = level[pc]!;
        const letterPc: number[] = [-1, -1, -1, -1, -1, -1, -1];
        for (const p of scale) letterPc[LETTER_ORDER.indexOf(p.letterName)] = ((p.midiValue % 12) + 12) % 12;
        for (let i = 0; i < 7; i++) {
            const pc = letterPc[i]!; if (pc < 0) continue;
            const up = letterPc[(i + 1) % 7]!, dn = letterPc[(i + 6) % 7]!;
            const nb = Math.max(up >= 0 ? level[up]! : 0, dn >= 0 ? level[dn]! : 0);
            res[pc] = Math.max(0, level[pc]! - STEP_INHIBIT * Math.max(0, nb - level[pc]!));
        }
        scene?.updateActivations();
        raf = requestAnimationFrame(loop);
    };
    loop();
}

/** Retarget the lattice to one onset: the resolved surface becomes the scale, the ringing notes light
 *  their nodes at the library's committed spellings. Geometry only rebuilds when the surface respells. */
/** Playback: retarget the lit nodes from a captured onset snapshot. */
export function renderTonnetz(snap: Snapshot | null): void {
    if (!scene) return;
    // The resolved 7-letter surface (streaming modes) is the harmonic frame; batch two-pass has none, so
    // fall back to C-major naturals: the notes still light at their committed spellings on that grid.
    const surface = snap?.resolvedScale && snap.resolvedScale.length === 7
        ? snap.resolvedScale.map(p => new PitchClass(p.step as LetterName, p.alter))
        : defaultScale();
    applyScene(surface, new Set((snap?.sounding ?? []).map(s => pcOf(s.pitch))),
        new Set((snap?.sounding ?? []).map(s => `${s.pitch.step}:${s.pitch.alter}`)));
}

/** Live input: retarget from the shared live model's state (same grid, so both views track the keyboard).
 *  The surface is the stable 7-letter frame, but each SOUNDING note is drawn at its own committed
 *  spelling: a played chromatic (G♯ in C major) overrides its letter's slot (G→G♯) so it owns a lattice
 *  node to light. The frame itself is unchanged: this is a per-onset display overlay, not a frame flip. */
export function renderTonnetzLive(state: LiveState): void {
    if (!scene) return;
    const byLetter = new Map<string, { step: string; alter: number }>(
        (state.scaleSpellings.length === 7
            ? state.scaleSpellings
            : DEFAULT_SCALE_SPEC.map(([step, alter]) => ({ step, alter })))
            .map(p => [p.step, { step: p.step, alter: p.alter }]),
    );
    for (const key of state.heldSpellings) {
        const [step, alter] = key.split(':') as [string, string];
        byLetter.set(step, { step, alter: Number(alter) });
    }
    const surface = [...byLetter.values()].map(p => new PitchClass(p.step as LetterName, p.alter));
    applyScene(surface, new Set(state.heldPCs), new Set(state.heldSpellings));
}

/** Point the scene at a 7-letter surface and the pitch classes ringing on it, choosing the cheapest
 *  scene update. The RAF loop turns the sounding set into full activation and decays everything else
 *  toward the scale floor (see the accumulator above). */
function applyScene(surface: PitchClass[], sounding: Set<number>, spelled: Set<string>): void {
    if (!scene) return;
    soundingSpelled = spelled;
    const sig = scaleSig(surface);
    const scaleChanged = sig !== lastScaleSig;
    scale = surface;
    scalePCs = new Set(surface.map(p => ((p.midiValue % 12) + 12) % 12));
    lastScaleSig = sig;
    soundingPCs = sounding;

    // Choosing the scene update, mirroring the standalone app's syncScene3D (spellingOnly vs full rebuild):
    //   • surface PC-SET changed  → a genuinely new chord. The triangle SET must be recomputed, because the
    //     cross-layer "is this an exact triad?" cull (TonnetzSceneV2 ~line 1844) depends on the surface's
    //     spellings, e.g. Death of Åse's aug6 needs E# in the surface for its 3-layer G–B–E# triangle to
    //     survive the cull. rebuild() re-runs that cull; clearSmoothing() then forces a triangle-fill
    //     refresh (a paused step has no note stream to make the new triangles "dirty" on its own).
    //   • only the SPELLING changed (same pcs, e.g. Gb→F#) → topology is unchanged, so the fast path is safe.
    // The viz previously only ever took the fast path, so triangles were frozen from the C-major init build
    // and every later chromatic triad (the long-form aug6 included) stayed culled.
    const pcSig = [...scalePCs].sort((a, b) => a - b).join(',');
    const pcChanged = pcSig !== lastPcSig;
    lastPcSig = pcSig;

    if (pcChanged) { scene.rebuild(); scene.clearSmoothing(); }
    else if (scaleChanged) scene.updateSpellings();
    syncPlanes();
}

/** The symmetric chords to draw under the current mode and sounding notes. */
function planeClasses(): SymClass[] {
    switch (planesMode) {
        case 'off': return [];
        case 'sounding': return symClassesIn(soundingPCs);
        case 'aug': case 'dim7': return allSymClasses(planesMode);
    }
}

/** Point the scene at the planes for the current state; a no-op unless the chords or the struck
 *  spellings changed (the sheets are cheap, but stepping should not churn GPU buffers). */
function syncPlanes(force = false): void {
    if (!scene) return;
    const classes = planeClasses();
    const sig = `${planesMode}|${classes.map(c => c.kind + c.residue).join(',')}|${[...soundingSpelled].sort().join(',')}`;
    if (!force && sig === lastPlanesSig) return;
    lastPlanesSig = sig;
    const spec: SymPlaneSpec | null = classes.length
        ? { classes, mode: planesMode === 'sounding' ? 'focus' : 'all', emphasis: soundingSpelled }
        : null;
    const captions = scene.setSymmetricPlanes(spec);
    if (!captionEl) return;
    captionEl.hidden = captions.length === 0;
    captionEl.replaceChildren(...captions.map(c => {
        const row = document.createElement('div');
        const name = document.createElement('b');
        name.textContent = c.kind === 'aug' ? 'aug' : 'dim7';
        name.style.color = c.color;
        // The continuation in stacking order, struck spellings in bold. A long chain (all-sheets mode, or a
        // wide sheet) is cut to two spellings either side of the struck ones, so the caption stays one line.
        const hit = c.chain.map((x, i) => x.struck ? i : -1).filter(i => i >= 0);
        const lo = hit.length ? Math.max(0, hit[0]! - 2) : 0;
        const hi = hit.length ? Math.min(c.chain.length, hit[hit.length - 1]! + 3) : Math.min(c.chain.length, 8);
        row.append(name, ' ', lo > 0 ? '… ' : '');
        c.chain.slice(lo, hi).forEach((x, i) => {
            if (i) row.append(' – ');
            if (x.struck) { const s = document.createElement('b'); s.textContent = x.label; row.append(s); }
            else row.append(x.label);
        });
        if (hi < c.chain.length) row.append(' …');
        return row;
    }));
}

/** The two toggles, overlaid on the canvas's lower-left corner. State comes from the URL on first mount. */
function mountLatticeControls(container: HTMLElement): void {
    const params = new URLSearchParams(location.search);
    const p = params.get('planes') as PlanesMode | null;
    planesMode = p && PLANES_MODES.includes(p) ? p : 'off';
    showGhosts = params.get('ghosts') === '1';

    const box = document.createElement('div');
    box.className = 'lattice-ctrls';
    box.innerHTML = `
        <div class="lattice-caption" aria-live="polite" hidden></div>
        <label title="Draw the sheet a symmetric chord forms across the lattice: every cell on it is the same augmented triad (stacked major thirds) or diminished seventh (stacked minor thirds), spelled a comma further each cycle">chord planes
            <select class="lattice-planes">
                <option value="off">off</option>
                <option value="sounding">sounding aug / dim7</option>
                <option value="aug">all augmented triads</option>
                <option value="dim7">all diminished 7ths</option>
            </select></label>
        <label title="Show every lattice cell in view, not only the 7-note collection"><input type="checkbox" class="lattice-ghosts"> inactive nodes</label>`;
    container.appendChild(box);
    captionEl = box.querySelector<HTMLElement>('.lattice-caption');
    const sel = box.querySelector<HTMLSelectElement>('.lattice-planes')!;
    const chk = box.querySelector<HTMLInputElement>('.lattice-ghosts')!;
    sel.value = planesMode;
    chk.checked = showGhosts;
    // Keep orbit/zoom gestures on the canvas from starting when the controls are used.
    for (const ev of ['pointerdown', 'wheel'] as const) box.addEventListener(ev, e => e.stopPropagation());
    sel.addEventListener('change', () => {
        planesMode = sel.value as PlanesMode;
        writeParam('planes', planesMode === 'off' ? null : planesMode);
        syncPlanes(true);
    });
    chk.addEventListener('change', () => {
        showGhosts = chk.checked;
        writeParam('ghosts', showGhosts ? '1' : null);
        scene?.setShowGhostNodes(showGhosts);
    });
}

/** Record a toggle in the page URL without touching the other params (main.ts owns those). */
function writeParam(key: string, value: string | null): void {
    const u = new URL(location.href);
    if (value === null) u.searchParams.delete(key); else u.searchParams.set(key, value);
    const q = u.searchParams.toString().replace(/%2C/g, ',');
    history.replaceState(history.state, '', `${u.pathname}${q ? `?${q}` : ''}${u.hash}`);
}

/** Tear down the WebGL context and stop the loop, for completeness; the panel currently lives for the
 *  whole session, but this keeps the port from leaking a GL context if it is ever unmounted. */
export function disposeTonnetz(): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    scene?.dispose();
    scene = null;
    lastScaleSig = '';
    lastPlanesSig = '';
    captionEl?.parentElement?.remove();
    captionEl = null;
}
