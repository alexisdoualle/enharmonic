/**
 * MusicXML import for the viz. A MusicXML note carries its notated spelling
 * (`<step>`/`<alter>`/`<octave>`), so an imported score yields BOTH halves of a fixture: the
 * MIDI stream the speller sees (`events`) and the composer's ground-truth spelling (`expected`).
 * That makes an import a fully gradeable fixture, identical in status to the committed ones, so
 * the three-tier colouring works unchanged (unlike a MIDI import, which has no spelling to grade).
 *
 * Scope (v1): score-partwise, one or many parts (merged on a shared clock), `<divisions>` changes,
 * chords (`<chord/>`), voice cursor moves (`<backup>`/`<forward>`), ties (continuations merged into
 * one held note), rests (advance the cursor), and transposing instruments (`<transpose>`: written pitch
 * is converted to sounding/concert pitch, MIDI and spelling together, so a clarinet or horn part reads
 * in the same key as the rest). Grace notes are skipped (no duration). Repeats and voltas are NOT
 * expanded: the written order plays once. `<sound tempo>` sets playback speed, else
 * 120 BPM. Compressed `.mxl` (a zip) is read by {@link readMxl}, which inflates the score with the
 * browser's native `DecompressionStream` (still no dependency) and hands the XML to {@link parseMusicXml}.
 */

import type { RawEvent, Expected } from '../replay.js';

const STEP_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FIFTHS_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;   // fifths -1..+5 through the naturals

export interface ImportResult {
    events: RawEvent[];
    expected: Expected[];
    name: string;
    /** Human-readable notes about anything skipped or assumed, surfaced to the user. */
    warnings: string[];
}

/** midi number of a notated pitch. */
function midiOf(step: string, alter: number, octave: number): number {
    return 12 * (octave + 1) + STEP_SEMITONE[step]! + alter;
}

const LETTER_IDX: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const LETTERS7 = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

/** A part's `<transpose>`: what to ADD to a written pitch to get the sounding (concert) pitch. */
interface Transpose { diatonic: number; chromatic: number; octaveChange: number; }

/** Concert = no pitch-class change: absent, or a whole number of octaves (piccolo, contrabass). */
function isConcert(t: Transpose | null): boolean {
    return t == null || ((t.chromatic + 12 * t.octaveChange) % 12 === 0);
}

/**
 * Convert a WRITTEN pitch to its SOUNDING (concert) pitch through a part's `<transpose>` (clarinet in
 * B♭, horn in F, …). MIDI and spelling are derived from the SAME interval, so they always name the same
 * pitch: `midiOf(step, alter, octave) === midi`. That keeps the imported fixture self-consistent, so the
 * viz scorer never sees a note whose committed spelling and expected spelling are different pitches.
 */
function toSounding(step: string, alter: number, octave: number, t: Transpose | null):
    { step: string; alter: number; octave: number; midi: number } {
    if (t == null) return { step, alter, octave, midi: midiOf(step, alter, octave) };
    const midi = midiOf(step, alter, octave) + t.chromatic + 12 * t.octaveChange;
    const rawIdx = LETTER_IDX[step]! + t.diatonic + 7 * t.octaveChange;   // letter shift (7 letters/octave)
    const soundStep = LETTERS7[((rawIdx % 7) + 7) % 7]!;
    const soundOctave = octave + Math.floor(rawIdx / 7);
    const soundAlter = midi - (12 * (soundOctave + 1) + STEP_SEMITONE[soundStep]!);   // accidental to hit `midi`
    return { step: soundStep, alter: soundAlter, octave: soundOctave, midi };
}

const text = (el: Element | null, sel: string): string | null => el?.querySelector(sel)?.textContent?.trim() ?? null;
const num = (el: Element | null, sel: string): number | null => {
    const t = text(el, sel);
    return t == null ? null : Number(t);
};

/** The 7-letter diatonic scale a key signature spells, for the staff's key-signature band. `fifths`
 *  is the MusicXML count of sharps (>0) or flats (<0). Each step out on the line of fifths sharpens
 *  (or, going flat, flattens) one letter, in the order F C G D A E B / B E A D G C F. */
function scaleFromFifths(fifths: number): { letter: string; accidental: number }[] {
    const acc: Record<string, number> = { F: 0, C: 0, G: 0, D: 0, A: 0, E: 0, B: 0 };
    if (fifths > 0) for (let i = 0; i < fifths; i++) acc[FIFTHS_ORDER[i % 7]!]! += 1;         // F#, C#, G#, ...
    else for (let i = 0; i < -fifths; i++) acc[FIFTHS_ORDER[6 - (i % 7)]!]! -= 1;             // Bb, Eb, Ab, ...
    return ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map(letter => ({ letter, accidental: acc[letter]! }));
}

interface Attack {
    onMs: number;
    offMs: number;
    midi: number;
    step: string;
    alter: number;
    measure: number;
    beat: number;     // quarter-position within the measure, 1-based (matches the fixtures)
}

/**
 * Parse one MusicXML document into `{ events, expected }`. Throws on a document that is not
 * usable (parse error, timewise, no parts).
 */
export function parseMusicXml(xml: string, fileName = 'imported'): ImportResult {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Not valid XML (parse error).');
    const root = doc.documentElement;
    if (root.nodeName === 'score-timewise') throw new Error('score-timewise is not supported; export score-partwise.');
    if (root.nodeName !== 'score-partwise') throw new Error(`Not a MusicXML score (root <${root.nodeName}>).`);
    const parts = [...doc.querySelectorAll('part')];
    if (parts.length === 0) throw new Error('No <part> found.');

    const warnings: string[] = [];
    let sawGrace = false, sawRepeat = false, sawTranspose = false;

    const tempo = firstTempo(doc) ?? 120;
    const msPerQuarter = 60000 / tempo;

    const attacks: Attack[] = [];
    let respellScale: { letter: string; accidental: number }[] | null = null;

    for (const part of parts) {
        // Position is tracked in QUARTER NOTES (float), so a mid-piece <divisions> change stays consistent.
        let posQ = 0;
        let divisions = 1;
        let measureStartQ = 0;
        let measureNumber = 0;
        // Open tie continuations, keyed by pitch: a tie-stop extends the held note instead of re-attacking.
        const pendingTie = new Map<number, Attack>();
        let lastOnsetQ = 0;   // onset a following <chord/> note attaches to
        let transpose: Transpose | null = null;   // this part's written->sounding transposition

        for (const measure of part.querySelectorAll(':scope > measure')) {
            measureNumber = Number(measure.getAttribute('number')) || measureNumber + 1;
            measureStartQ = posQ;
            if (measure.querySelector('barline repeat')) sawRepeat = true;

            for (const el of [...measure.children]) {
                const tag = el.nodeName;
                if (tag === 'attributes') {
                    const d = num(el, 'divisions');
                    if (d && d > 0) divisions = d;
                    const tr = el.querySelector('transpose');
                    if (tr) {
                        const chromatic = num(tr, 'chromatic') ?? 0;
                        const octaveChange = num(tr, 'octave-change') ?? 0;
                        // diatonic is usually given; if not, approximate it from the chromatic size.
                        const diatonic = num(tr, 'diatonic') ?? Math.round(chromatic * 7 / 12);
                        transpose = { chromatic, diatonic, octaveChange };
                        if (!isConcert(transpose)) sawTranspose = true;
                    }
                    // Take the key signature from a CONCERT part only: a transposing part carries its
                    // WRITTEN key, not the concert key the staff should show.
                    if (respellScale == null && isConcert(transpose)) {
                        const f = num(el, 'key fifths');
                        if (f != null) respellScale = scaleFromFifths(f);
                    }
                } else if (tag === 'backup') {
                    posQ -= (num(el, 'duration') ?? 0) / divisions;
                } else if (tag === 'forward') {
                    posQ += (num(el, 'duration') ?? 0) / divisions;
                } else if (tag === 'note') {
                    const isGrace = !!el.querySelector('grace');
                    const isChord = !!el.querySelector('chord');
                    const isRest = !!el.querySelector('rest');
                    const durQ = (num(el, 'duration') ?? 0) / divisions;
                    if (isGrace) { sawGrace = true; continue; }   // no duration, no onset advance

                    const onsetQ = isChord ? lastOnsetQ : posQ;
                    if (!isChord) { lastOnsetQ = posQ; }

                    if (!isRest) {
                        const pitch = el.querySelector('pitch');
                        const step = text(pitch, 'step');
                        const octave = num(pitch, 'octave');
                        if (step && octave != null) {
                            const writtenAlter = num(pitch, 'alter') ?? 0;
                            const snd = toSounding(step, writtenAlter, octave, transpose);
                            const midi = snd.midi;
                            const onMs = Math.round(onsetQ * msPerQuarter);
                            const offMs = Math.round((onsetQ + durQ) * msPerQuarter);
                            const tieStop = !!el.querySelector('tie[type="stop"], tied[type="stop"]');
                            const tieStart = !!el.querySelector('tie[type="start"], tied[type="start"]');
                            if (tieStop && pendingTie.has(midi)) {
                                const held = pendingTie.get(midi)!;
                                held.offMs = offMs;               // extend the held note over this continuation
                                if (!tieStart) pendingTie.delete(midi);
                            } else {
                                const a: Attack = {
                                    onMs, offMs, midi, step: snd.step, alter: snd.alter,
                                    measure: measureNumber, beat: onsetQ - measureStartQ + 1,
                                };
                                attacks.push(a);
                                if (tieStart) pendingTie.set(midi, a);
                            }
                        }
                    }
                    if (!isChord) posQ += durQ;
                }
            }
        }
    }

    if (attacks.length === 0) throw new Error('No notes found.');
    if (sawGrace) warnings.push('grace notes were skipped');
    if (sawRepeat) warnings.push('repeats/voltas not expanded (written order plays once)');
    if (sawTranspose) warnings.push('transposing instruments converted to concert pitch');
    if (parts.length > 1) warnings.push(`${parts.length} parts merged on a shared clock`);

    // ON-event order is (onset asc, midi asc): the bass commits first, and expected pairs 1:1 with it.
    attacks.sort((p, q) => p.onMs - q.onMs || p.midi - q.midi);
    const expected: Expected[] = attacks.map(a => ({ step: a.step, alter: a.alter, measure: a.measure, beat: a.beat }));

    // Event stream: every attack contributes an on (at onMs) and an off (at offMs). Sort by time, and at
    // an equal time release (off) before attack (on) and order attacks bass-first, so the on-events are
    // encountered in exactly the expected[] order.
    const events: RawEvent[] = [];
    if (respellScale) events.push({ t_ms: 0, type: 'respell', scale: respellScale });
    const raw: RawEvent[] = [];
    for (const a of attacks) {
        raw.push({ t_ms: a.onMs, type: 'on', midi: a.midi });
        raw.push({ t_ms: a.offMs, type: 'off', midi: a.midi });
    }
    const rank = (e: RawEvent) => (e.type === 'off' ? 0 : 1);
    raw.sort((p, q) => p.t_ms - q.t_ms || rank(p) - rank(q) || (p.midi! - q.midi!));
    events.push(...raw);

    const name = fileName.replace(/\.(musicxml|xml|mxl)$/i, '');
    return { events, expected, name, warnings };
}

/** First `<sound tempo>` in the document (quarter-notes per minute), or null. */
function firstTempo(doc: Document): number | null {
    const t = doc.querySelector('sound[tempo]')?.getAttribute('tempo');
    return t ? Number(t) : null;
}

// ── .mxl (compressed MusicXML) ─────────────────────────────────────────────────

const ZIP_EOCD = 0x06054b50;   // end of central directory
const ZIP_CDIR = 0x02014b50;   // central directory file header

interface ZipEntry { name: string; method: number; compSize: number; localOff: number; }

/**
 * Inflate the MusicXML text out of a compressed `.mxl` file (a ZIP archive). No dependency: the ZIP
 * central directory is parsed by hand and the score member is inflated with the browser's
 * `DecompressionStream`. The member is chosen from `META-INF/container.xml`'s rootfile when present,
 * else the first non-`META-INF` `.musicxml`/`.xml`. Throws a clear message on anything unsupported.
 */
export async function readMxl(buf: ArrayBuffer): Promise<string> {
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    // Locate the end-of-central-directory record (scan back from the end, past any ZIP comment).
    let eocd = -1;
    for (let i = bytes.length - 22, min = Math.max(0, bytes.length - 22 - 0xffff); i >= min; i--) {
        if (dv.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a valid .mxl (no ZIP end record)');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);

    const entries: ZipEntry[] = [];
    const dec = new TextDecoder();
    for (let n = 0; n < count && off + 46 <= bytes.length; n++) {
        if (dv.getUint32(off, true) !== ZIP_CDIR) break;
        const method = dv.getUint16(off + 10, true);
        const compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true);
        const extraLen = dv.getUint16(off + 30, true);
        const commentLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
        entries.push({ name, method, compSize, localOff });
        off += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.length === 0) throw new Error('empty or unreadable .mxl archive');

    const inflate = async (e: ZipEntry): Promise<string> => {
        // The local header repeats the name/extra lengths; data begins right after them.
        const dataStart = e.localOff + 30 + dv.getUint16(e.localOff + 26, true) + dv.getUint16(e.localOff + 28, true);
        const comp = bytes.subarray(dataStart, dataStart + e.compSize);
        if (e.method === 0) return dec.decode(comp);                                  // stored
        if (e.method !== 8) throw new Error(`unsupported .mxl compression (method ${e.method})`);
        if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unzip .mxl; export uncompressed .musicxml');
        const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return dec.decode(await new Response(stream).arrayBuffer());
    };

    // Prefer the rootfile that META-INF/container.xml points at; else the first score member.
    const container = entries.find(e => e.name === 'META-INF/container.xml');
    if (container) {
        const m = /full-path\s*=\s*"([^"]+)"/.exec(await inflate(container));
        const target = m && entries.find(e => e.name === m[1]);
        if (target) return inflate(target);
    }
    const score = entries.find(e => /\.(musicxml|xml)$/i.test(e.name) && !e.name.startsWith('META-INF/'))
        ?? entries.find(e => /\.(musicxml|xml)$/i.test(e.name));
    if (!score) throw new Error('no .musicxml found inside the .mxl');
    return inflate(score);
}
