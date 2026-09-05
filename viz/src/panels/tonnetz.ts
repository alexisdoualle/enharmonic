/**
 * 3D Tonnetz panel — the harmonic space the shipped speller reasons about, drawn as a lattice of
 * fifths (x), major/minor thirds (y) and accidental layers (z). Ported from the standalone tonnetz app
 * (`TonnetzSceneV2`, vendored under `viz/src/tonnetz3d/`), driven here purely by the enharmonic kernel's
 * per-onset output: the resolved 7-letter surface becomes the lit scale, and the notes ringing at the
 * onset — spelled exactly as the library committed them — light their lattice nodes. So the Tonnetz is a
 * DISPLAY of the speller's choices (every spelling still comes from `src/`), not a second speller.
 *
 * Unlike the SVG panels, a WebGL scene is expensive to build and must persist across steps, so this
 * panel uses an init-once / update-per-step lifecycle (like the piano roll): `initTonnetz(container)`
 * builds the scene and starts a render loop; `renderTonnetz(snap)` retargets the lit nodes each onset.
 * The scene smooths activations over wall-clock time, so the loop runs continuously while mounted.
 */
import type { Snapshot } from '../replay.js';
import { pcOf } from '../replay.js';
import { TonnetzSceneV2, type TonnetzSceneConfig } from '../tonnetz3d/TonnetzSceneV2.js';
import { PitchClass } from '../tonnetz3d/core/PitchClass.js';
import { extendedFifthsPos } from '../tonnetz3d/LatticeGeometry.js';
import type { LetterName } from '../tonnetz3d/types.js';

// Grid footprint: wide enough along the fifths chain to hold a key's neighbourhood, a few third-rows
// deep so triads read as triangles. Kept modest — this is a debugger panel, not the full app's lattice.
const COLS = 15;
const ROWS = 5;

// C-major naturals, used before the first onset and in batch mode when there is no streaming surface.
const DEFAULT_SCALE_SPEC: [LetterName, number][] = [
    ['C', 0], ['D', 0], ['E', 0], ['F', 0], ['G', 0], ['A', 0], ['B', 0],
];
const defaultScale = (): PitchClass[] => DEFAULT_SCALE_SPEC.map(([l, a]) => new PitchClass(l, a));

// Triangle colouring — ported verbatim from the tonnetz app's getTriadColor so the hues match. Major and
// minor triads take a hue GRADIENT along the fifths chain (the triad's mean fifths-position within the
// current scale range), which is the app's "hue offset" look; other qualities use fixed fallback colours.
const MAJOR_HUE_LOW = 65, MAJOR_HUE_HIGH = 10;   // major gradient endpoints
const MINOR_HUE_LOW = 197, MINOR_HUE_HIGH = 236; // minor gradient endpoints
const TRIAD_FALLBACK: Record<string, string> = {
    major: '#ffcc80', minor: '#abcefb', diminished: '#f8bbd9', augmented: '#c8e6c9',
    flat5: '#f295c4', aug6: '#f5be9e', aug3: '#b39ddb', dim3: '#80cbc4',
};

function hslToHex(h: number, s: number, l: number): string {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** getTriadColor for the scene config — matches the tonnetz app. `scale` (the current surface) sets the
 *  fifths range the major/minor gradient normalises against. */
function triadColor(type: string, notes?: PitchClass[]): string {
    if (notes && notes.length === 3 && (type === 'major' || type === 'minor') && scale.length >= 7) {
        const scalePos = scale.map(p => extendedFifthsPos(p.letterName, p.accidental));
        const min = Math.min(...scalePos), max = Math.max(...scalePos), range = max - min;
        if (range > 0) {
            const pos = notes.map(n => extendedFifthsPos(n.letterName, n.accidental));
            const t = Math.max(0, Math.min(1, ((pos[0]! + pos[1]! + pos[2]!) / 3 - min) / range));
            return type === 'major'
                ? hslToHex(MAJOR_HUE_LOW + t * (MAJOR_HUE_HIGH - MAJOR_HUE_LOW), 100, 75)
                : hslToHex(MINOR_HUE_LOW + t * (MINOR_HUE_HIGH - MINOR_HUE_LOW), 90, 80);
        }
    }
    return TRIAD_FALLBACK[type] ?? '#abcefb';
}

// A lightweight stand-in for the tonnetz app's accumulator, enough to keep the harmony readable without
// porting the real thing. Two decays feed `getNoteActivation(pc)`:
//   • SCALE FLOOR — the 7 surface pitch-classes idle at a baseline so their triangles always tile the
//     lattice (the "scale shape"), instead of flashing only when a full triad happens to sound.
//   • CHORD DECAY — a note that stops sounding fades over CHORD_DECAY_TAU seconds rather than snapping
//     off, so a struck chord lingers as a glowing triad (the app's "chord decay").
const SCALE_FLOOR = 0.3;       // idle activation of an in-scale pitch-class (0..1)
const CHORD_DECAY_TAU = 1.8;   // seconds; larger = chords linger longer after release
// Diatonic-STEP lateral inhibition on the RESONANCE channel (fill brightness only, not node activation).
// The tonnetz app's accumulator suppresses a note by a stronger neighbour a scale STEP away — adjacent
// LETTERS, so A–B and B–C both count (a step, whole or half) — not a chromatic semitone. So a lingering/
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
const res = new Float32Array(12);       // level after semitone inhibition — drives triad fill brightness
let lastTick = 0;

let scene: TonnetzSceneV2 | null = null;
let raf = 0;
let lastScaleSig = '';

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
        // as the chord decays — while a diatonic triad whose notes only idle at the scale floor stays faint.
        getResonanceActivation: pc => res[pc] ?? 0,
        freeMode: () => false,
        cols: () => COLS,
        rows: () => ROWS,
    };
    scene = new TonnetzSceneV2(container, config);
    scene.setVisible(true);
    // The scene's default z-gap (0.1) is tiny next to the in-plane grid (~1.4), so the accidental layers
    // stack almost flat. Spread them to distinct depths — 0.8 matches the tonnetz app's default.
    scene.setZSpacing(0.8);
    // Match the tonnetz app's look: bent (tilted, cross-layer chromatic) triads render with the hatched
    // "chickenwire" mesh texture instead of a solid fill, while flat diatonic triads stay solid. This is
    // the app's default (showTrianglePattern + meshTiltedNonPerfect on, meshAll off), so a chromatic chord
    // reads as a mesh triangle bridging accidental layers — the depth cue, no ghost nodes needed.
    scene.setTrianglePattern(true);
    scene.setMeshTiltedNonPerfect(true);
    // Hide the leading-tone / semitone resolution arrows — that overlay is driven by the app's
    // accumulator (note-on timestamps + resolved-midi logic) we don't feed, so it isn't meaningful here.
    scene.setShowArrows(false);
    // The vendored scene hardcodes a debug (x, y, z) label under every node; hide them — the note names
    // are the labels that matter here.
    scene.setShowCoords(false);
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
export function renderTonnetz(snap: Snapshot | null): void {
    if (!scene) return;

    // The resolved 7-letter surface (streaming rungs) is the harmonic frame; batch two-pass has none, so
    // fall back to C-major naturals — the notes still light at their committed spellings on that grid.
    const surface = snap?.resolvedScale && snap.resolvedScale.length === 7
        ? snap.resolvedScale.map(p => new PitchClass(p.step as LetterName, p.alter))
        : defaultScale();
    const sig = scaleSig(surface);
    const scaleChanged = sig !== lastScaleSig;
    scale = surface;
    scalePCs = new Set(surface.map(p => ((p.midiValue % 12) + 12) % 12));
    lastScaleSig = sig;

    // The notes ringing at this onset, spelled as the library committed them. The RAF loop turns these
    // into full activation and decays everything else toward the scale floor (see the accumulator above).
    soundingPCs = new Set((snap?.sounding ?? []).map(s => pcOf(s.pitch)));

    // Choosing the scene update, mirroring the standalone app's syncScene3D (spellingOnly vs full rebuild):
    //   • surface PC-SET changed  → a genuinely new chord. The triangle SET must be recomputed, because the
    //     cross-layer "is this an exact triad?" cull (TonnetzSceneV2 ~line 1844) depends on the surface's
    //     spellings — e.g. Death of Åse's aug6 needs E# in the surface for its 3-layer G–B–E# triangle to
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
}

/** Tear down the WebGL context and stop the loop — for completeness; the panel currently lives for the
 *  whole session, but this keeps the port from leaking a GL context if it is ever unmounted. */
export function disposeTonnetz(): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    scene?.dispose();
    scene = null;
    lastScaleSig = '';
}
