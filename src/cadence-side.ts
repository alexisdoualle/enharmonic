/**
 * CADENCE-SIDE (research option, default OFF): a causal rule that moves the diatonic frame one comma
 * when a key that LASTS is better written on its other side.
 *
 * Theory: the key-signature convention (fewest accidentals) applies to a key that lasts; a brief
 * tonicization keeps the home letters. So a cadence into a key K whose convention side differs from the
 * frame's current side only becomes PENDING; it fires once K has lasted (>= minBars after the cadence,
 * K's tonic chord or another V->K appears again, and no cadence to any other key came between).
 *
 * Everything here is pitch-class level (roots, not spellings): complete major/minor triads and dominant
 * sevenths, read from the sounding notes plus the short recent span. No import from viz/.
 */

export interface CadenceSideOptions {
    /** Length of a bar in the engine's `t` units; used only when the caller supplies no bar index. */
    barLen?: number;
    /** Arpeggio look-back for a chord reading, in `t` units (default 2000). */
    spanLen?: number;
    /** Arpeggio look-back cap in notes (default 12). */
    spanNotes?: number;
    /** Bars K must outlast its cadence before it may fire (default 4). */
    minBars?: number;
}

type ChordType = 'maj' | 'min' | 'dom7';
export interface Chord { type: ChordType; root: number; }

const SHAPES: Record<ChordType, number[]> = { maj: [0, 4, 7], min: [0, 3, 7], dom7: [0, 4, 7, 10] };
const TEMPLATES: { mask: number; chord: Chord }[] = [];
for (const type of ['maj', 'min', 'dom7'] as const) {
    for (let root = 0; root < 12; root++) {
        TEMPLATES.push({ mask: SHAPES[type].reduce((m, s) => m | (1 << ((root + s) % 12)), 0), chord: { type, root } });
    }
}
const exact = (mask: number): Chord | null => TEMPLATES.find(t => t.mask === mask)?.chord ?? null;
const subsetOfTemplate = (mask: number): boolean => TEMPLATES.some(t => (mask & t.mask) === mask);
const pcMask = (midi: number): number => 1 << (((midi % 12) + 12) % 12);

/** Key-signature spelling of a tonic pc: the relative-major line-of-fifths position t (C=0) nearest 0
 *  whose pitch class is `majorPc`; null on a tie (F#/Gb major, D#/Eb minor). */
function conventionT(majorPc: number): number | null {
    let best = 99, bt: number | null = null, tie = false;
    for (let t = -11; t <= 11; t++) {
        if ((((t * 7) % 12) + 12) % 12 !== majorPc) continue;
        if (Math.abs(t) < best) { best = Math.abs(t); bt = t; tie = false; } else if (Math.abs(t) === best) tie = true;
    }
    return tie ? null : bt;
}

export interface CadenceLogEntry {
    kind: 'pending' | 'fire' | 'cancel' | 'drop';
    onset: number; bar: number; key: string; keyPc: number; minor: boolean;
    cadenceOnset: number; cadenceBar: number; shift: number;
}

interface Pending { keyPc: number; minor: boolean; t: number; cadenceOnset: number; cadenceBar: number; }

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export class CadenceSide {
    private readonly spanLen: number;
    private readonly spanNotes: number;
    private readonly minBars: number;
    private recent: { midi: number; t: number }[] = [];
    private lastChord: Chord | null = null;
    private pending: Pending | null = null;
    readonly log: CadenceLogEntry[] = [];

    constructor(opts: CadenceSideOptions = {}) {
        this.spanLen = opts.spanLen ?? 2000;
        this.spanNotes = opts.spanNotes ?? 12;
        this.minBars = opts.minBars ?? 4;
    }

    reset(): void { this.recent = []; this.lastChord = null; this.pending = null; }

    /** Record a struck note (called for every noteOn, after the previous onset has been processed). */
    note(midi: number, t: number): void {
        this.recent.push({ midi, t });
        if (this.recent.length > this.spanNotes) this.recent.shift();
    }

    /** The chord read at the end of an onset: the sounding notes plus the longest chord-pure suffix of
     *  the recent span (pc-exact: no extras, no partial chords). */
    private read(sounding: Iterable<number>, tNow: number): Chord | null {
        let sMask = 0; for (const m of sounding) sMask |= pcMask(m);
        let span = 0;
        for (let k = this.recent.length - 1; k >= 0; k--) {
            const n = this.recent[k]!;
            if (tNow - n.t > this.spanLen) break;
            const m = span | pcMask(n.midi);
            if (!subsetOfTemplate(m)) break;
            span = m;
        }
        return exact(sMask | span) ?? exact(span) ?? exact(sMask);
    }

    /**
     * Called when an onset has ended. `frameT` is the frame's current relative-major tonic position
     * (frameCentre - 2). Returns the comma shift (a multiple of 12, in line-of-fifths units) to apply to
     * the frame now, or 0.
     */
    onsetEnd(sounding: Iterable<number>, tNow: number, bar: number, onset: number, frameT: number): number {
        const Y = this.read(sounding, tNow);
        if (!Y || (this.lastChord && this.lastChord.type === Y.type && this.lastChord.root === Y.root)) return 0;
        const X = this.lastChord;
        this.lastChord = Y;
        const pend = this.pending;

        const cadence = X !== null && (X.type === 'maj' || X.type === 'dom7') && (Y.type === 'maj' || Y.type === 'min')
            && ((X.root - Y.root) % 12 + 12) % 12 === 7;
        const minor = Y.type === 'min';
        const keyPc = Y.root;

        // A tonic chord of the pending key (renewal) is the chord itself, or a V->K cadence.
        const isTonicOfPending = pend !== null && Y.root === pend.keyPc && (Y.type === (pend.minor ? 'min' : 'maj'));
        if (pend && cadence && !(keyPc === pend.keyPc && minor === pend.minor)) {
            this.log.push({ kind: 'cancel', onset, bar, key: NAMES[keyPc]! + (minor ? 'm' : ''), keyPc, minor,
                cadenceOnset: pend.cadenceOnset, cadenceBar: pend.cadenceBar, shift: 0 });
            this.pending = null;
        }
        const live = this.pending;
        if (live && isTonicOfPending && bar - live.cadenceBar >= this.minBars) {
            this.pending = null;
            // Recompute against the frame as it is now; the frame may have moved on its own.
            let tp = live.t;
            tp += 12 * Math.round((frameT - live.t) / 12);
            const shift = live.t - tp;
            const e = { onset, bar, key: NAMES[live.keyPc]! + (live.minor ? 'm' : ''), keyPc: live.keyPc, minor: live.minor,
                cadenceOnset: live.cadenceOnset, cadenceBar: live.cadenceBar };
            if (shift === 0) { this.log.push({ kind: 'drop', ...e, shift: 0 }); return 0; }
            this.log.push({ kind: 'fire', ...e, shift });
            return shift;
        }
        if (cadence) {
            const majorPc = (keyPc + (minor ? 3 : 0)) % 12;
            const t = conventionT(majorPc);
            if (t !== null && !(this.pending && this.pending.keyPc === keyPc && this.pending.minor === minor)) {
                const near = t + 12 * Math.round((frameT - t) / 12);
                if (near !== t) {
                    this.pending = { keyPc, minor, t, cadenceOnset: onset, cadenceBar: bar };
                    this.log.push({ kind: 'pending', onset, bar, key: NAMES[keyPc]! + (minor ? 'm' : ''), keyPc, minor,
                        cadenceOnset: onset, cadenceBar: bar, shift: t - near });
                }
            }
        }
        return 0;
    }
}
