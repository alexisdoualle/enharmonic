/**
 * "The chord the speller thinks is sounding": DISPLAY ONLY. Reads the notes ringing at an onset with
 * their COMMITTED spellings and names the best-matching chord. It never feeds back into the engine.
 *
 * Two questions are kept apart, as in the rest of the project:
 *   - IDENTITY is by pitch class (what chord is it?), so a struck D♯ G A♯ is an E♭ major triad.
 *   - NAME / COHERENCE is by the committed spellings: the chord's notes must stack in thirds by LETTER
 *     from the root's letter (F♭ A♭ C♭ does; D♯ G A♯ does not). An incoherent match is reported by pc and
 *     flagged, because the fault is the mix of spellings, not the side.
 *
 * Selection rule: most sounding pcs covered; then a COMPLETE chord over a PARTIAL one; then fewer
 * extra pcs; then the root being the bass; then list order. Augmented sixths are recognised from the
 * SPELLING (a ♭6 and a ♯4/♯6 a letter-correct augmented sixth apart), since pcs alone cannot tell
 * German from dominant 7: the same keys spelled with a minor seventh are a dominant 7.
 */
import type { Pitch, PitchClass } from '../../src/index.js';
import { triadColor, triadColorAt } from './music/triadColor.js';

export interface ChordNote { midi: number; pitch: Pitch; /** struck at this onset (false = held over from earlier) */ struck: boolean; }

type TypeId = 'maj' | 'min' | 'dim' | 'aug' | 'dom7' | 'maj7' | 'min7' | 'hdim7' | 'dim7' | 'it6' | 'fr6' | 'ger6';
interface ChordType {
    id: TypeId; name: string; short: (root: string) => string;
    /** [semitones above root, expected letters above root, role] */
    tones: [number, number, string][];
    symmetric?: boolean;
    seventh?: boolean;     // may match PARTIALLY (3 of 4 pcs, with third + seventh)
    aug6?: boolean;        // needs the augmented-sixth spelling
}

const CHORD_TYPES: ChordType[] = [
    { id: 'maj', name: 'major', short: r => r, tones: [[0, 0, 'root'], [4, 2, 'third'], [7, 4, 'fifth']] },
    { id: 'min', name: 'minor', short: r => `${r}m`, tones: [[0, 0, 'root'], [3, 2, 'third'], [7, 4, 'fifth']] },
    { id: 'dim', name: 'diminished', short: r => `${r}°`, tones: [[0, 0, 'root'], [3, 2, 'third'], [6, 4, 'fifth']] },
    { id: 'aug', name: 'augmented', short: r => `${r}+`, symmetric: true, tones: [[0, 0, 'root'], [4, 2, 'third'], [8, 4, 'fifth']] },
    { id: 'dom7', name: 'dominant 7', short: r => `${r}7`, seventh: true, tones: [[0, 0, 'root'], [4, 2, 'third'], [7, 4, 'fifth'], [10, 6, 'seventh']] },
    { id: 'maj7', name: 'major 7', short: r => `${r}maj7`, seventh: true, tones: [[0, 0, 'root'], [4, 2, 'third'], [7, 4, 'fifth'], [11, 6, 'seventh']] },
    { id: 'min7', name: 'minor 7', short: r => `${r}m7`, seventh: true, tones: [[0, 0, 'root'], [3, 2, 'third'], [7, 4, 'fifth'], [10, 6, 'seventh']] },
    { id: 'hdim7', name: 'half-diminished 7', short: r => `${r}ø7`, seventh: true, tones: [[0, 0, 'root'], [3, 2, 'third'], [6, 4, 'fifth'], [10, 6, 'seventh']] },
    { id: 'dim7', name: 'diminished 7', short: () => 'dim7', symmetric: true, tones: [[0, 0, 'root'], [3, 2, 'third'], [6, 4, 'fifth'], [9, 6, 'seventh']] },
    // Augmented sixths, rooted on the ♭6: aug6th above it is the ♯4 (here letter +5).
    { id: 'it6', name: 'Italian sixth', short: () => 'It+6', aug6: true, tones: [[0, 0, '♭6'], [4, 2, 'tonic'], [10, 5, '♯4']] },
    { id: 'fr6', name: 'French sixth', short: () => 'Fr+6', aug6: true, tones: [[0, 0, '♭6'], [4, 2, 'tonic'], [6, 3, '2'], [10, 5, '♯4']] },
    { id: 'ger6', name: 'German sixth', short: () => 'Ger+6', aug6: true, tones: [[0, 0, '♭6'], [4, 2, 'tonic'], [7, 4, '♭3'], [10, 5, '♯4']] },
];
const TYPE_ORDER = new Map(CHORD_TYPES.map((t, i) => [t.id, i]));

const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
/** Conventional pc names for a pitch-class identity (used only when the spelling is incoherent). */
const PC_NAMES: PitchClass[] = [
    { step: 'C', alter: 0 }, { step: 'D', alter: -1 }, { step: 'D', alter: 0 }, { step: 'E', alter: -1 },
    { step: 'E', alter: 0 }, { step: 'F', alter: 0 }, { step: 'F', alter: 1 }, { step: 'G', alter: 0 },
    { step: 'A', alter: -1 }, { step: 'A', alter: 0 }, { step: 'B', alter: -1 }, { step: 'B', alter: 0 },
];
const mod12 = (n: number) => ((n % 12) + 12) % 12;

export type ChordStatus = 'complete' | 'subset' | 'partial';
export interface ChordRead {
    /** null = no chord */
    type: ChordType['id'] | null;
    status: ChordStatus | null;
    /** the name spelling: the root as spelled (coherent) or by pc (incoherent / symmetric from lowest note) */
    root: PitchClass | null;
    coherent: boolean;
    symmetric: boolean;
    /** matched chord notes, ascending */
    chordNotes: PitchClass[];
    extras: PitchClass[];
    missing: string[];            // roles absent (partial)
    held: PitchClass[];                // matched notes that were NOT struck at this onset
    sounding: PitchClass[];            // every sounding note, ascending
    /** for none: the distinct-pc sounding notes (lowest first), to describe why */
    noneNotes: { pitch: PitchClass; midi: number }[];
    /** lane label ("F♭", "Cm", "G7", "Ger+6", "dim7") or "" for none; unicode */
    short: string;
}

const pcOf = (p: Pitch): PitchClass => ({ step: p.step, alter: p.alter });
const noteLetter = (p: PitchClass) => LETTER_IDX[p.step]!;

function intervalWords(a: PitchClass, b: PitchClass, midiA: number, midiB: number): string {
    const semis = mod12(midiB - midiA);
    const d = ((noteLetter(b) - noteLetter(a)) % 7 + 7) % 7;
    const NAMES = ['unison', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
    const BASE: number[] = [0, 2, 4, 5, 7, 9, 11];   // major/perfect semitones per letter distance
    const diff = semis - BASE[d]!;
    const perfect = d === 0 || d === 3 || d === 4;
    const q = perfect
        ? (diff === 0 ? 'perfect' : diff === 1 ? 'augmented' : diff === -1 ? 'diminished' : diff > 0 ? 'doubly augmented' : 'doubly diminished')
        : (diff === 0 ? 'major' : diff === -1 ? 'minor' : diff === 1 ? 'augmented' : diff < 0 ? 'diminished' : 'doubly augmented');
    return `a ${q} ${NAMES[d]}`;
}

/** Find the chord the committed spellings amount to. */
export function findChord(notesIn: readonly ChordNote[]): ChordRead {
    const notes = [...notesIn].sort((a, b) => a.midi - b.midi);
    const soundingPitches = notes.map(n => pcOf(n.pitch));
    const none = (why: ChordNote[]): ChordRead => ({
        type: null, status: null, root: null, coherent: true, symmetric: false, chordNotes: [], extras: [], missing: [],
        held: [], sounding: soundingPitches, noneNotes: why.map(n => ({ pitch: pcOf(n.pitch), midi: n.midi })), short: '',
    });
    if (notes.length === 0) return none([]);
    // lowest sounding note per pc: it carries that pc's committed spelling
    const byPc = new Map<number, ChordNote>();
    for (const n of notes) if (!byPc.has(mod12(n.midi))) byPc.set(mod12(n.midi), n);
    const pcs = [...byPc.keys()];
    const bassPc = mod12(notes[0]!.midi);

    interface Cand {
        t: ChordType; rootPc: number; present: number[]; missingRoles: string[]; extras: number[];
        covered: number; complete: boolean; coherent: boolean; rootSpelled: PitchClass;
    }
    const cands: Cand[] = [];
    const seenSym = new Set<string>();
    for (const t of CHORD_TYPES) {
        for (let rootPc = 0; rootPc < 12; rootPc++) {
            const tonePcs = t.tones.map(([s]) => mod12(rootPc + s));
            const present = tonePcs.filter(p => byPc.has(p));
            const covered = present.length;
            const complete = covered === t.tones.length;
            if (!complete) {
                // partial: only a seventh with 3 of 4 pcs including its third and its seventh
                if (!t.seventh || covered !== 3) continue;
                const roleHas = (role: string) => byPc.has(mod12(rootPc + t.tones.find(x => x[2] === role)![0]));
                if (!roleHas('third') || !roleHas('seventh')) continue;
            } else if (covered < 3) continue;
            if (t.symmetric) {
                const key = `${t.id}:${[...tonePcs].sort((a, b) => a - b).join(',')}`;
                if (seenSym.has(key)) continue;
                seenSym.add(key);
            }
            const missingRoles = t.tones.filter(([s]) => !byPc.has(mod12(rootPc + s))).map(x => x[2]);
            const extras = pcs.filter(p => !tonePcs.includes(p));
            // coherence: letters stack in thirds from the root's letter (symmetric: from ANY chord note)
            const tryRoot = (rp: number): boolean => {
                const rn = byPc.get(rp);
                if (!rn) return false;
                const rl = noteLetter(rn.pitch);
                return t.tones.every(([s, l]) => {
                    const n = byPc.get(mod12(rp + s));
                    return !n || noteLetter(n.pitch) === (rl + l) % 7;
                });
            };
            let coherent: boolean;
            if (t.aug6) {
                // the spelling IS the identity here: require the letter-correct augmented sixth
                coherent = tryRoot(rootPc);
                if (!coherent || !complete) continue;
            } else if (t.symmetric) {
                const rots = tonePcs.filter(p => byPc.has(p));
                coherent = rots.some(tryRoot);
            } else coherent = tryRoot(rootPc);
            const nameRootPc = t.symmetric
                ? mod12(Math.min(...present.map(p => byPc.get(p)!.midi)))   // lowest chord note
                : rootPc;
            const nameRootNote = byPc.get(nameRootPc);
            cands.push({
                t, rootPc: nameRootPc, present, missingRoles, extras, covered, complete, coherent,
                rootSpelled: nameRootNote && (coherent || t.symmetric) ? pcOf(nameRootNote.pitch) : PC_NAMES[nameRootPc]!,
            });
        }
    }
    // A pc-level dominant 7 whose seventh is spelled as an augmented sixth is a German sixth, not a
    // dominant 7 (and an incoherent dominant 7 is dropped in favour of it).
    const hasGer = cands.some(c => c.t.id === 'ger6');
    const filtered = cands.filter(c => !(hasGer && c.t.id === 'dom7' && c.complete && !c.coherent));
    if (filtered.length === 0) {
        return none(notes.filter((n, i) => notes.findIndex(m => mod12(m.midi) === mod12(n.midi)) === i));
    }
    const score = (c: Cand) => [
        -c.covered, c.complete ? 0 : 1, c.coherent ? 0 : 1, c.extras.length,
        c.present.includes(bassPc) && (c.t.symmetric || mod12(c.rootPc) === bassPc) ? 0 : 1,
        TYPE_ORDER.get(c.t.id)!,
    ];
    filtered.sort((a, b) => {
        const sa = score(a), sb = score(b);
        for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
        return 0;
    });
    const best = filtered[0]!;
    const chordNotes = best.present.map(p => byPc.get(p)!).sort((a, b) => a.midi - b.midi);
    const extras = best.extras.map(p => byPc.get(p)!).sort((a, b) => a.midi - b.midi);
    const status: ChordStatus = !best.complete ? 'partial' : extras.length ? 'subset' : 'complete';
    return {
        type: best.t.id, status, root: best.rootSpelled, coherent: best.coherent, symmetric: !!best.t.symmetric,
        chordNotes: chordNotes.map(n => pcOf(n.pitch)), extras: extras.map(n => pcOf(n.pitch)), missing: best.missingRoles,
        held: chordNotes.filter(n => !n.struck).map(n => pcOf(n.pitch)), sounding: soundingPitches, noneNotes: [],
        short: best.t.short(uni(best.rootSpelled)),
    };
}

const uni = (p: PitchClass) => `${p.step}${p.alter > 0 ? '♯'.repeat(p.alter) : p.alter < 0 ? '♭'.repeat(-p.alter) : ''}`;

/** Format a read as the `chord: ...` text (without the "chord: " prefix). `fmt` renders a spelling
 *  (the panel passes the unicode `label`; the clipboard report passes ASCII `ascii`). */
export function chordText(r: ChordRead, fmt: (p: PitchClass) => string = uni): string {
    if (!r.type) {
        const ns = r.noneNotes;
        if (ns.length === 0) return 'none (nothing sounding)';
        if (ns.length === 1) return 'none (one note)';
        if (ns.length === 2) return `none (${fmt(ns[0]!.pitch)}–${fmt(ns[1]!.pitch)}: ${intervalWords(ns[0]!.pitch, ns[1]!.pitch, ns[0]!.midi, ns[1]!.midi)})`;
        return `none (${ns.map(n => fmt(n.pitch)).join('–')}: no triad, seventh or augmented sixth)`;
    }
    const t = CHORD_TYPES.find(x => x.id === r.type)!;
    const seq = (ps: PitchClass[]) => ps.map(fmt).join('–');
    const name = `${fmt(r.root!)} ${t.name}`;
    const sym = r.symmetric ? ' (symmetric: named from lowest note)' : '';
    const bits: string[] = [r.status!];
    if (r.status === 'partial') bits.push(`missing ${r.missing.join(', ')}`);
    if (r.extras.length) bits.push(`extra ${r.extras.map(fmt).join(', ')}`);
    if (r.held.length) bits.push(`${r.held.map(fmt).join(', ')} held`);
    const detail = `(${bits.join('; ')})`;
    if (!r.coherent) return `${name} by pc; spelled ${seq(r.chordNotes)} (incoherent)${sym} ${detail}`;
    const sub = r.status === 'subset' ? ` ⊂ {${r.sounding.map(fmt).join(' ')}}` : '';
    return `${name}${sub}${sym} ${detail}`;
}

/** The chord at one snapshot: the sounding list, with "struck" = struck at this snapshot's own onset time. */
export function chordAt(snap: { t: number; sounding: ReadonlyArray<{ midi: number; pitch: Pitch; onT: number }> }): ChordRead {
    return findChord(snap.sounding.map(s => ({ midi: s.midi, pitch: s.pitch, struck: s.onT >= snap.t })));
}

/** Cap on the arpeggio look-back: at most this many notes, within this many ms of the current onset. */
export const ARPEGGIO_MAX_NOTES = 12;
export const ARPEGGIO_MAX_MS = 2000;

/** Chord types that can be named over TIME (an arpeggio): triads, plus the dominant seventh. Other sevenths
 *  are two triads sharing two notes (A minor 7 = A minor + C major), so a change of triad in time produces
 *  their notes; they are named only when sounding together. The dominant seventh is the one exception (too
 *  strong a sonority to ignore even when its seventh is disconnected, Alexis 2026-10-09). */
const TIME_TYPES: ReadonlySet<TypeId> = new Set<TypeId>(['maj', 'min', 'dim', 'aug', 'dom7']);

/** Pitch-class sets (as 12-bit masks) of every TIME chord type in every transposition. */
const TEMPLATE_MASKS: number[] = (() => {
    const out = new Set<number>();
    for (const t of CHORD_TYPES) if (TIME_TYPES.has(t.id)) for (let r = 0; r < 12; r++) out.add(t.tones.reduce((m, [s]) => m | (1 << mod12(r + s)), 0));
    return [...out];
})();
const subsetOfSomeTemplate = (mask: number) => TEMPLATE_MASKS.some(t => (mask & t) === mask);

export type ChordSource = 'sounding' | 'arpeggio';
export interface ChordReading { read: ChordRead; source: ChordSource; /** notes in the arpeggio span (arpeggio only) */ span?: number; }

/**
 * Chords in time, HIGH CONFIDENCE ONLY ("longest chord-pure suffix"): from note `i` walk back over `notes`,
 * accumulating pitch classes, until adding the next older note would leave every chord template, or the
 * cap (ARPEGGIO_MAX_NOTES / ARPEGGIO_MAX_MS from note i's onset) is hit. The span is named only when its
 * pc-set EQUALS a template's (complete, no extras), via findChord on the committed spellings. No
 * passing-tone logic: a non-chord tone simply ends the span.
 */
export function arpeggioChord(
    notes: ReadonlyArray<{ midi: number; onT: number; committed: Pitch | null }>, i: number,
): { read: ChordRead; span: number } | null {
    const cur = notes[i];
    if (!cur?.committed) return null;
    let mask = 0, n = 0;
    for (let k = i; k >= 0 && n < ARPEGGIO_MAX_NOTES; k--) {
        const nt = notes[k]!;
        if (!nt.committed || cur.onT - nt.onT > ARPEGGIO_MAX_MS) break;
        const m = mask | (1 << mod12(nt.midi));
        if (!subsetOfSomeTemplate(m)) break;
        mask = m; n++;
    }
    if (n < 3) return null;
    const span: ChordNote[] = [];
    for (let k = i - n + 1; k <= i; k++) span.push({ midi: notes[k]!.midi, pitch: notes[k]!.committed!, struck: true });
    const read = findChord(span);
    return read.type && read.status === 'complete' && TIME_TYPES.has(read.type) ? { read, span: n } : null;
}

/** The sounding reading if it is a COMPLETE chord; else the arpeggio reading if one is named; else the
 *  sounding reading (none / partial / subset). */
export function chordReading(
    replay: { snapshots: ReadonlyArray<Parameters<typeof chordAt>[0]>; notes: ReadonlyArray<{ midi: number; onT: number; committed: Pitch | null }> }, i: number,
): ChordReading {
    const read = chordAt(replay.snapshots[i]!);
    if (read.type && read.status === 'complete') return { read, source: 'sounding' };
    const arp = arpeggioChord(replay.notes, i);
    return arp ? { read: arp.read, source: 'arpeggio', span: arp.span } : { read, source: 'sounding' };
}

/** `chordText` plus the arpeggio provenance: "F major (arpeggio, last 5 notes)". */
export function chordReadingText(r: ChordReading, fmt: (p: PitchClass) => string = uni): string {
    if (r.source !== 'arpeggio') return chordText(r.read, fmt);
    const t = CHORD_TYPES.find(x => x.id === r.read.type)!;
    const base = r.read.coherent ? `${fmt(r.read.root!)} ${t.name}` : chordText(r.read, fmt).replace(/ \(complete\)$/, '');
    return `${base} (arpeggio, last ${r.span} notes)`;
}

export interface ChordSegment { read: ChordRead; t0: number; t1: number; /** the 7-letter surface in effect at the span start (null in batch) */ surface: PitchClass[] | null; /** inferred over time from recent notes, not from the sounding set */ arpeggio?: boolean; span?: number; }

/**
 * Contiguous spans over which the identified chord stays the same, for the piano-roll chord lane.
 * One read per onset TIME (the last snapshot at that time, once the whole struck chord is in), so a
 * chord struck bass-first does not flicker through its partial stacks. Identity = type + name
 * spelling + coherence; a change of status (complete/subset) or of held notes keeps the same span.
 */
export function chordSegments(
    snaps: ReadonlyArray<{ t: number; resolvedScale?: PitchClass[] | null; sounding: ReadonlyArray<{ midi: number; pitch: Pitch; onT: number }> }>,
    durationMs: number,
    notes?: ReadonlyArray<{ midi: number; onT: number; committed: Pitch | null }>,
): ChordSegment[] {
    const segs: ChordSegment[] = [];
    let key: string | null = null;
    for (let i = 0; i < snaps.length; i++) {
        if (i + 1 < snaps.length && snaps[i + 1]!.t === snaps[i]!.t) continue;   // wait for the last note at this time
        const cr: ChordReading = notes ? chordReading({ snapshots: snaps, notes }, i) : { read: chordAt(snaps[i]!), source: 'sounding' };
        const read = cr.read;
        // One box per CHORD: the source (sounding vs arpeggio) is not part of the key, so a chord whose
        // reading alternates between held notes and the recent span stays one box. The box is marked as
        // inferred over time only if no part of it was confirmed by notes sounding together.
        const k = read.type ? `${read.short}${read.coherent ? '' : '!'}` : '';
        if (k === key && segs.length) {
            const last = segs[segs.length - 1]!;
            if (cr.source === 'sounding' && last.arpeggio) { delete last.arpeggio; delete last.span; }
            continue;
        }
        if (segs.length) segs[segs.length - 1]!.t1 = snaps[i]!.t;
        segs.push({ read, t0: snaps[i]!.t, t1: durationMs, surface: snaps[i]!.resolvedScale ?? null, ...(cr.source === 'arpeggio' ? { arpeggio: true, span: cr.span } : {}) });
        key = k;
    }
    return segs;
}

const SEMI_OF: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const spellPc = (p: PitchClass) => mod12(SEMI_OF[p.step]! + p.alter);
const FIFTHS_IDX: Record<string, number> = { F: 0, C: 1, G: 2, D: 3, A: 4, E: 5, B: 6 };
const fifthsOf = (p: PitchClass) => FIFTHS_IDX[p.step]! + p.alter * 7;

/** Fill colour for a chord read, shared with the Tonnetz panel (viz/src/music/triadColor.ts). Triads and
 *  sevenths take the gradient of their TRIAD (root, third, fifth) at the committed spellings, placed
 *  within `surface`; diminished/half-dim/dim7 and augmented use fixed colours, augmented sixths 'aug6'.
 *  An incoherent read is coloured by its pc-identity chord (root named by pc). null = no chord. */
export function chordColor(r: ChordRead, surface: readonly PitchClass[] | null): string | null {
    if (!r.type) return null;
    const surf = surface && surface.length === 7 ? surface : DEFAULT_SURFACE;
    const fixed = r.type === 'dim' || r.type === 'hdim7' || r.type === 'dim7' ? 'diminished'
        : r.type === 'aug' ? 'augmented'
        : r.type === 'it6' || r.type === 'fr6' || r.type === 'ger6' ? 'aug6' : null;
    if (fixed) return triadColor(fixed, undefined, surf);
    const minor = r.type === 'min' || r.type === 'min7';
    const quality = minor ? 'minor' : 'major';
    const root = r.root!;
    // Fifths position of the root, from any matched chord note (committed spelling) when coherent.
    // Offsets above the root on the chain: root 0, major third +4, minor third -3, fifth +1.
    const rootPc = spellPc(root);
    let rootPos = fifthsOf(root);
    if (r.coherent) {
        for (const n of r.chordNotes) {
            const off = mod12(spellPc(n) - rootPc);
            const rel = off === 0 ? 0 : off === 7 ? 1 : off === (minor ? 3 : 4) ? (minor ? -3 : 4) : null;
            if (rel !== null) { rootPos = fifthsOf(n) - rel; break; }
        }
    }
    const mean = rootPos + (minor ? (0 - 3 + 1) / 3 : (0 + 4 + 1) / 3);
    return triadColorAt(quality, mean, surf);
}
const DEFAULT_SURFACE: PitchClass[] = (['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const).map(step => ({ step, alter: 0 }));
