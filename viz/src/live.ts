import { Speller, type Pitch } from '../../src/index.js';
import { enable as enableAudio, playMidi } from './audio.js';
import { selectSevenNodeLoF } from './tonnetzLine.js';
import './tonnetz3d/types.js';

export interface LiveState {
    heldMidi: number[];
    heldPCs: number[];
    heldSpellings: string[];
    scaleSpellings: ScaleSpelling[];
    filledCells: string[];
    backboneCells: string[];
    lastMidi: number | null;
    lastSpelling: Pitch | null;
    midiStatus: string;
}

type Listener = (state: LiveState) => void;

const pcOf = (midi: number) => ((midi % 12) + 12) % 12;
const spellingKey = (p: { step: string; alter: number }) => `${p.step}:${p.alter}`;
const fifthsOf = (p: { step: string; alter: number }) => ({ F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 }[p.step]! + 7 * p.alter);
const LOF_LETTERS = ['C', 'G', 'D', 'A', 'E', 'B', 'F'];
const spellingAtFifths = (n: number): { step: string; alter: number } => {
    const step = LOF_LETTERS[((n % 7) + 7) % 7]!;
    return { step, alter: (n - fifthsOf({ step, alter: 0 })) / 7 };
};
const cellKey = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
const SCALE_STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
type ScaleSpelling = { step: string; alter: number };

/** Live bridge: raw MIDI enters here, the shipped Speller supplies the spelling. */
export class LiveSpeller {
    private speller = new Speller();
    private held = new Map<number, Pitch>();
    private selectedSpellings = new Map<string, Pitch>();
    private manualScale: ScaleSpelling[] | null = null;
    private filledCells = new Set<string>();
    private previousBackbone: Set<string> | null = null;
    private listeners = new Set<Listener>();
    private midiStatus = 'computer keyboard ready';

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        listener(this.state());
        return () => this.listeners.delete(listener);
    }

    state(): LiveState {
        const resolved = this.currentScale();
        return {
            heldMidi: [...this.held.keys()].sort((a, b) => a - b),
            heldPCs: [...new Set([...this.held.keys()].map(pcOf))].sort((a, b) => a - b),
            heldSpellings: [...new Set([...this.held.values()].map(spellingKey))],
            scaleSpellings: resolved.map(({ step, alter }) => ({ step, alter })),
            filledCells: [...this.filledCells],
            backboneCells: [...this.previousBackbone ?? []],
            lastMidi: this.lastMidi,
            lastSpelling: this.lastSpelling,
            midiStatus: this.midiStatus,
        };
    }

    private lastMidi: number | null = null;
    private lastSpelling: Pitch | null = null;

    private emit() { const s = this.state(); this.listeners.forEach(listener => listener(s)); }

    private currentScale(): ScaleSpelling[] {
        return this.manualScale?.map(p => ({ ...p }))
            ?? (this.speller.getResolvedScale() ?? []).map(({ step, alter }) => ({ step, alter }));
    }

    /** Manually pin one letter of the current seven-letter surface, within double accidentals. */
    setScaleAlter(step: string, delta: number): void {
        const current = this.currentScale().length
            ? this.currentScale()
            : SCALE_STEPS.map(step => ({ step, alter: 0 }));
        const old = current.find(p => p.step === step);
        if (!old) return;
        const alter = Math.max(-2, Math.min(2, old.alter + delta));
        if (alter === old.alter) return;
        const next = current.map(p => p.step === step ? { step: p.step, alter } : { ...p });
        this.manualScale = next;
        this.selectedSpellings.delete(spellingKey(old));
        this.selectedSpellings.set(spellingKey({ step, alter }), { step, alter, octave: 4 });
        for (const [midi, spelling] of this.held) {
            if (spelling.step === step && spelling.alter === old.alter) {
                this.held.set(midi, { ...spelling, alter });
            }
        }
        this.syncSurface();
        this.emit();
    }

    /** Replace the interactive surface with one snapshot from the fixture player. */
    setPlaybackState(
        scale: ReadonlyArray<{ step: string; alter: number }>,
        sounding: ReadonlyArray<{ midi: number; pitch: Pitch }>,
        lastMidi: number | null = null,
        lastSpelling: Pitch | null = null,
    ): void {
        this.manualScale = scale.map(p => ({ step: p.step, alter: p.alter }));
        this.selectedSpellings.clear();
        for (const spelling of this.manualScale) {
            this.selectedSpellings.set(spellingKey(spelling), {
                step: spelling.step as Pitch['step'], alter: spelling.alter as Pitch['alter'], octave: 4,
            });
        }
        this.held = new Map(sounding.map(note => [note.midi, note.pitch]));
        this.lastMidi = lastMidi;
        this.lastSpelling = lastSpelling;
        this.syncSurface();
        this.emit();
    }

    /** Project the selected spellings onto the currently resolved seven-letter surface. */
    private syncSurface(): void {
        const resolved = this.currentScale();
        const previousBackbone = this.previousBackbone ?? selectSevenNodeLoF(this.filledCells);
        const allowed = resolved ? new Set(resolved.map(spellingKey)) : null;
        const active = [...this.selectedSpellings.entries()]
            .filter(([key]) => !allowed || allowed.has(key));
        this.filledCells.clear();
        for (const [, spelling] of active) this.filledCells.add(cellKey(fifthsOf(spelling), 0, 0));

        // An altered spelling can stay in the previous LoF column as a z deformation. This is
        // a candidate, not a forced compact-line rule: the seven-node selector weighs it against
        // the direct LoF position using continuity cost.
        if (previousBackbone) {
            const previousHomes = new Set([...previousBackbone]
                .map(key => key.split(':').map(Number) as [number, number, number])
                .filter(([, y, z]) => y === 0 && z === 0)
                .map(([x]) => x));
            for (const [, spelling] of active) {
                if (spelling.alter === 0) continue;
                const n = fifthsOf(spelling);
                for (const [x, z] of [[n - 7, 1], [n + 7, -1]] as [number, number][]) {
                    if (previousHomes.has(x) && !this.filledCells.has(cellKey(x, 0, 0))) {
                        this.filledCells.add(cellKey(x, 0, z));
                    }
                }
            }
        }

        // Repair a broken central line of fifths with the active spelling's z sibling. If an altered
        // spelling is seven fifths away from a missing central position that is bracketed by active
        // neighbors, its z copy is the intended bridge: D# at n=9 supplies (2,0,1) between G=(1,0,0)
        // and A=(3,0,0). Restrict this to a bracketed one-position gap so unrelated enharmonic copies
        // (including the special aug6 F=(2,1,-1)) are not lit just because they exist geometrically.
        const centralPositions = new Set([...this.filledCells].map(key => Number(key.split(':')[0])));
        for (const [, spelling] of active) {
            if (spelling.alter === 0) continue;
            const n = fifthsOf(spelling);
            for (const [x, z] of [[n - 7, 1], [n + 7, -1]] as [number, number][]) {
                if (!centralPositions.has(x) && centralPositions.has(x - 1) && centralPositions.has(x + 1)) {
                    this.filledCells.add(cellKey(x, 0, z));
                    // Also expose the active thirds-line companions that complete the bridge faces
                    // around this repaired node: for D# at (2,0,1), these are B=(1,1,0) and
                    // F=(3,-1,0), alongside G=(1,0,0) and A=(3,0,0).
                    if (z === 1 && centralPositions.has(x + 3)) this.filledCells.add(cellKey(x - 1, 1, 0));
                    if (z === 1 && centralPositions.has(x - 3)) this.filledCells.add(cellKey(x + 1, -1, 0));
                    // The upper thirds-line companion completes the other side of the same gap:
                    // F#=(2,1,0) is needed for both B–D#–F# and D#–F#–A.
                    if (z === 1 && centralPositions.has(x + 4)) this.filledCells.add(cellKey(x, 1, 0));
                    break;
                }
            }
        }

        // Recompute one thirds-line copy from the selected LoF backbone.  The direct spelling of an
        // altered note can also sit seven fifths away as a detached central island (C# at x=7 in
        // D melodic minor); it must not be allowed to choose remote thirds copies merely because it
        // happened to be inserted before the compact z bridge.  This is deliberately graph-based,
        // rather than dependent on selectedSpellings/Map insertion order.
        const centralXs = new Set([...this.filledCells].map(key => key.split(':').map(Number))
            .filter(([, y, z]) => y === 0 && z === 0).map(([x]) => x!));
        const lofXs = new Set(centralXs);
        for (const key of this.filledCells) {
            const [x, y, z] = key.split(':').map(Number) as [number, number, number];
            if (y === 0 && z !== 0 && !centralXs.has(x)
                && centralXs.has(x - 1) && centralXs.has(x + 1)) lofXs.add(x);
        }
        const components: number[][] = [];
        const unseen = new Set(lofXs);
        while (unseen.size) {
            const start = unseen.values().next().value as number;
            const component: number[] = [];
            const queue = [start];
            unseen.delete(start);
            while (queue.length) {
                const x = queue.shift()!;
                component.push(x);
                for (const next of [x - 1, x + 1]) if (unseen.delete(next)) queue.push(next);
            }
            components.push(component);
        }
        const backboneXs = components.reduce<number[]>((largest, component) =>
            component.length > largest.length ? component : largest, []);
        // Only real central cells generate third-row copies.  z positions can complete the backbone,
        // but they are not a second central row from which to project a duplicate.
        const mainXs = backboneXs.filter(x => centralXs.has(x)).sort((a, b) => a - b);
        const backboneMin = Math.min(...backboneXs);
        const backboneMax = Math.max(...backboneXs);
        for (const [, spelling] of active) {
            const x = fifthsOf(spelling);
            const neighbor = mainXs.flatMap(mainX => [
                [mainX - 1, 1, 0], [mainX, 1, 0], [mainX, -1, 0], [mainX + 1, -1, 0],
            ] as [number, number, number][])
                .filter(([candidateX, y, z]) => candidateX + 4 * y + 7 * z === x)
                // Prefer a copy within the backbone span, then the closest one to the spelling's
                // direct fifths position.  These tie-breakers are geometric and stable.
                .sort(([a], [b]) => {
                    const aOutside = Math.max(0, backboneMin - a) + Math.max(0, a - backboneMax);
                    const bOutside = Math.max(0, backboneMin - b) + Math.max(0, b - backboneMax);
                    return aOutside - bOutside || Math.abs(a - x) - Math.abs(b - x) || a - b;
                })[0];
            if (neighbor) this.filledCells.add(cellKey(...neighbor));
        }

        // A z twin may become visible as a derived spelling when it completes a cross-layer
        // triangle. The spelling itself must still be active on the seven-letter surface: in C major,
        // active F is rendered at the small z=-1 cell beside F♯; when F♯ replaces F, that F cell goes
        // dark. This keeps the z axis structural without making a second spelling decision.
        //
        // Do not rely on the canonical backbone copy having already supplied the required thirds
        // vertex. A valid face can span a secondary LoF component (C–E–A♭ in C double harmonic
        // major); it is structural geometry and may be faint, but it must still be drawable.
        const activeSpellings = new Set(active.map(([key]) => key));
        const hasActiveAt = (x: number, y: number, z: number): boolean =>
            activeSpellings.has(spellingKey(spellingAtFifths(x + 4 * y + 7 * z)));
        for (const [, spelling] of active) {
            const n = fifthsOf(spelling);
            const flatTwinX = n + 7; // cell (x, 0, -1) has spelling position x - 7 = n
            if (this.filledCells.has(cellKey(flatTwinX - 1, 0, 0))
                && hasActiveAt(flatTwinX, -1, 0)) {
                this.filledCells.add(cellKey(flatTwinX, -1, 0));
                this.filledCells.add(cellKey(flatTwinX, 0, -1));
            }
            if (this.filledCells.has(cellKey(flatTwinX + 1, 0, 0))
                && hasActiveAt(flatTwinX + 1, -1, 0)) {
                this.filledCells.add(cellKey(flatTwinX + 1, -1, 0));
                this.filledCells.add(cellKey(flatTwinX, 0, -1));
            }
            const sharpTwinX = n - 7; // cell (x, 0, +1) has spelling position x + 7 = n
            if (this.filledCells.has(cellKey(sharpTwinX - 1, 0, 0))
                && hasActiveAt(sharpTwinX - 1, 1, 0)) {
                this.filledCells.add(cellKey(sharpTwinX - 1, 1, 0));
                this.filledCells.add(cellKey(sharpTwinX, 0, 1));
            }
            if (this.filledCells.has(cellKey(sharpTwinX + 1, 0, 0))
                && hasActiveAt(sharpTwinX, 1, 0)) {
                this.filledCells.add(cellKey(sharpTwinX, 1, 0));
                this.filledCells.add(cellKey(sharpTwinX, 0, 1));
            }

            // The cross-layer flat bridge needed by consecutive altered fifths:
            //   main(x) + thirds(x) + z-flat(x+1)  → dim5 / flat5
            const flatBridgeX = n + 7;
            if (this.filledCells.has(cellKey(flatBridgeX - 1, 0, 0))
                && this.filledCells.has(cellKey(flatBridgeX - 1, 1, 0))) {
                this.filledCells.add(cellKey(flatBridgeX, 0, -1));
            }

        }

        // The renderer and the live surface share one definition of the tonal backbone: seven
        // adjacent fifth positions with seven distinct active spellings.  Run a second thirds
        // projection after z bridges exist, because an altered member can supply a middle position
        // of that line.  For C–D♭–E–F–G–A♭–B, D♭ and A♭ occupy z-flat positions 2 and 3, so
        // the resulting line is F–C–G–D♭–A♭–E–B at x=-1…5.  E at x=4 then correctly exposes
        // the G copy at (5,-1,0), even though the direct D♭/A♭ cells at -5/-4 stay faint islands.
        const canonicalLine = selectSevenNodeLoF(this.filledCells, { previous: previousBackbone ?? undefined });
        if (canonicalLine) {
            const cells = [...canonicalLine].map(key => key.split(':').map(Number) as [number, number, number]);
            const canonicalXs = cells.map(([x]) => x);
            const canonicalCentralXs = cells
                .filter(([, y, z]) => y === 0 && z === 0)
                .map(([x]) => x)
                .sort((a, b) => a - b);
            const canonicalMin = Math.min(...canonicalXs);
            const canonicalMax = Math.max(...canonicalXs);
            for (const [, spelling] of active) {
                const x = fifthsOf(spelling);
                const neighbor = canonicalCentralXs.flatMap(mainX => [
                    [mainX - 1, 1, 0], [mainX, 1, 0], [mainX, -1, 0], [mainX + 1, -1, 0],
                ] as [number, number, number][])
                    .filter(([candidateX, y, z]) => candidateX + 4 * y + 7 * z === x)
                    .sort(([a], [b]) => {
                        const aOutside = Math.max(0, canonicalMin - a) + Math.max(0, a - canonicalMax);
                        const bOutside = Math.max(0, canonicalMin - b) + Math.max(0, b - canonicalMax);
                        return aOutside - bOutside || Math.abs(a - x) - Math.abs(b - x) || a - b;
                    })[0];
                if (neighbor) this.filledCells.add(cellKey(...neighbor));
            }
        }

        // Keep the normal F–A♭–C face lit in the altered C-major surface. The active
        // spellings already light F=(-1,0,0), A♭=(-4,0,0), and C=(0,0,0), but the
        // face uses the thirds-line copy F=(3,-1,0); add that structural copy without
        // substituting the hidden aug6 F=(2,1,-1).
        if (this.filledCells.has(cellKey(-1, 0, 0))
            && this.filledCells.has(cellKey(-4, 0, 0))
            && this.filledCells.has(cellKey(0, 0, 0))) {
            this.filledCells.add(cellKey(3, -1, 0));
        }

        // Run this only after every z-flat bridge above has been derived.  A spelling adjusted
        // through the badges is inserted at the end of selectedSpellings; doing this in the loop
        // above could therefore inspect F before that later D♭ had created its bridge.  Keeping
        // the dependent face in a second pass makes the geometry independent of input order.
        for (const [, spelling] of active) {
            // Sparse, translation-invariant aug6 face adjacent to a dim5/flat5 bridge. For an
            // active third at fifths position n, reveal its hidden z-flat/thirds instance only when
            // the adjacent B–D♭ edge is active: (n+2,1,0), (n+3,0,-1), (n+3,1,-1).
            const aug6Fx = fifthsOf(spelling) + 3;
            if (this.filledCells.has(cellKey(aug6Fx - 1, 1, 0))
                && this.filledCells.has(cellKey(aug6Fx, 0, -1))) {
                this.filledCells.add(cellKey(aug6Fx, 1, -1));
            }
        }

        this.previousBackbone = selectSevenNodeLoF(this.filledCells, { previous: previousBackbone ?? undefined });
    }

    noteOn(midi: number, sound = true): void {
        if (this.held.has(midi)) return;
        this.speller.noteOn(midi, { t: performance.now() });
        const spelling = this.speller.getSpelling(midi);
        if (!spelling) return;
        this.held.set(midi, spelling);
        this.selectedSpellings.set(spellingKey(spelling), spelling);
        this.syncSurface();
        this.lastMidi = midi;
        this.lastSpelling = spelling;
        if (sound) { void enableAudio(); playMidi(midi, 0.75); }
        this.emit();
    }

    noteOff(midi: number): void {
        if (!this.held.has(midi)) return;
        this.speller.noteOff(midi);
        this.held.delete(midi);
        this.syncSurface();
        this.emit();
    }

    reset(): void {
        this.speller = new Speller();
        this.held.clear();
        this.selectedSpellings.clear();
        this.manualScale = null;
        this.filledCells.clear();
        this.previousBackbone = null;
        this.lastMidi = null;
        this.lastSpelling = null;
        this.emit();
    }

    setMidiStatus(status: string): void {
        this.midiStatus = status;
        this.emit();
    }
}

// The same compact two-row piano layout used by the standalone tonnetz app.
const COMPUTER_KEYS: Record<string, number> = {
    KeyQ: 60, KeyW: 62, KeyE: 64, KeyR: 65, KeyT: 67, KeyY: 69, KeyU: 71,
    KeyI: 72, KeyO: 74, KeyP: 76, BracketLeft: 77, BracketRight: 79,
    Digit2: 61, Digit3: 63, Digit5: 66, Digit6: 68, Digit7: 70,
    Digit9: 73, Digit0: 75, Minus: 78, Equal: 80,
    KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
    Comma: 60, Period: 62, Slash: 64,
    KeyS: 49, KeyD: 51, KeyG: 54, KeyH: 56, KeyJ: 58,
};

export function connectLiveInput(model: LiveSpeller): void {
    const down = new Set<string>();
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        const midi = COMPUTER_KEYS[event.code];
        if (midi === undefined || down.has(event.code)) return;
        const tag = (event.target as HTMLElement)?.tagName ?? '';
        if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
        event.preventDefault();
        down.add(event.code);
        model.noteOn(midi);
    };
    const onKeyUp = (event: KeyboardEvent) => {
        const midi = COMPUTER_KEYS[event.code];
        if (midi === undefined) return;
        down.delete(event.code);
        model.noteOff(midi);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    if (!navigator.requestMIDIAccess) {
        model.setMidiStatus('Web MIDI unavailable · computer keyboard ready');
        return;
    }
    void navigator.requestMIDIAccess({ sysex: false }).then(access => {
        const attach = (input: WebMidi.MIDIInput) => {
            input.addEventListener('midimessage', event => {
                const [status, midi, velocity] = event.data;
                const command = status! & 0xf0;
                if (command === 0x90 && velocity! > 0) model.noteOn(midi!, false);
                else if (command === 0x80 || (command === 0x90 && velocity === 0)) model.noteOff(midi!);
            });
        };
        access.inputs.forEach(attach);
        const names = [...access.inputs.values()].map(input => input.name).filter(Boolean);
        model.setMidiStatus(names.length ? `MIDI: ${names.join(', ')}` : 'MIDI ready · computer keyboard ready');
        access.addEventListener('statechange', event => {
            if (event.port.type === 'input' && event.port.state === 'connected') attach(event.port as WebMidi.MIDIInput);
            const current = [...access.inputs.values()].map(input => input.name).filter(Boolean);
            model.setMidiStatus(current.length ? `MIDI: ${current.join(', ')}` : 'MIDI ready · computer keyboard ready');
        });
    }).catch(() => model.setMidiStatus('MIDI permission denied · computer keyboard ready'));
}
