import { Speller, type Pitch } from '../../src/index.js';
import { enable as enableAudio, playMidi } from './audio.js';
import './tonnetz3d/types.js';

export interface LiveState {
    heldMidi: number[];
    heldPCs: number[];
    heldSpellings: string[];
    scaleSpellings: ScaleSpelling[];
    filledCells: string[];
    lastMidi: number | null;
    lastSpelling: Pitch | null;
    midiStatus: string;
}

type Listener = (state: LiveState) => void;

const pcOf = (midi: number) => ((midi % 12) + 12) % 12;
const spellingKey = (p: { step: string; alter: number }) => `${p.step}:${p.alter}`;
const fifthsOf = (p: { step: string; alter: number }) => ({ F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 }[p.step]! + 7 * p.alter);
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

    /** Project the selected spellings onto the currently resolved seven-letter surface. */
    private syncSurface(): void {
        const resolved = this.currentScale();
        const allowed = resolved ? new Set(resolved.map(spellingKey)) : null;
        const active = [...this.selectedSpellings.entries()]
            .filter(([key]) => !allowed || allowed.has(key));
        this.filledCells.clear();
        for (const [, spelling] of active) this.filledCells.add(cellKey(fifthsOf(spelling), 0, 0));

        // Recompute the one adjacent third-row copy from the currently active main spine. This also
        // lets a note played before its neighbour acquire the local copy once that neighbour arrives.
        const mainXs = [...this.filledCells].map(k => k.split(':').map(Number)).map(([x, y, z]) => ({ x, y, z }))
            .filter(c => c.y === 0 && c.z === 0).map(c => c.x);
        for (const [, spelling] of active) {
            const x = fifthsOf(spelling);
            const neighbor = mainXs.flatMap(mainX => [[mainX!, 1, 0], [mainX! + 1, -1, 0] as [number, number, number]])
                .find(([candidateX, y, z]) => candidateX + 4 * y + 7 * z === x);
            if (neighbor) this.filledCells.add(cellKey(...neighbor));
        }

        // A z twin may become visible as a derived spelling when it completes a cross-layer
        // triangle. The spelling itself must still be active on the seven-letter surface: in C major,
        // active F is rendered at the small z=-1 cell beside F♯; when F♯ replaces F, that F cell goes
        // dark. This keeps the z axis structural without making a second spelling decision.
        for (const [, spelling] of active) {
            const n = fifthsOf(spelling);
            const flatTwinX = n + 7; // cell (x, 0, -1) has spelling position x - 7 = n
            if (this.filledCells.has(cellKey(flatTwinX - 1, 0, 0))
                && this.filledCells.has(cellKey(flatTwinX, -1, 0))) {
                this.filledCells.add(cellKey(flatTwinX, 0, -1));
            }
            const sharpTwinX = n - 7; // cell (x, 0, +1) has spelling position x + 7 = n
            if (this.filledCells.has(cellKey(sharpTwinX - 1, 0, 0))
                && this.filledCells.has(cellKey(sharpTwinX - 1, 1, 0))) {
                this.filledCells.add(cellKey(sharpTwinX, 0, 1));
            }
        }
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
