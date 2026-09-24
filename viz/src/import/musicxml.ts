/**
 * MusicXML import for the viz. A MusicXML note carries its notated spelling
 * (`<step>`/`<alter>`/`<octave>`), so an imported score yields BOTH halves of a fixture: the
 * MIDI stream the speller sees (`events`) and the composer's ground-truth spelling (`expected`).
 * That makes an import a fully gradeable fixture, identical in status to the committed ones, so
 * the three-tier colouring works unchanged (unlike a MIDI import, which has no spelling to grade).
 *
 * Scope (v1): score-partwise, one or many parts (merged on a shared clock), `<divisions>` changes,
 * chords (`<chord/>`), voice cursor moves (`<backup>`/`<forward>`), ties (continuations merged into
 * one held note), rests (advance the cursor). Grace notes are skipped (no duration). Repeats and
 * voltas are NOT expanded: the written order plays once. `<sound tempo>` sets playback speed, else
 * 120 BPM. Compressed `.mxl` (zip) is not handled here; export uncompressed `.musicxml`/`.xml`.
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
    let sawGrace = false, sawRepeat = false;

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

        for (const measure of part.querySelectorAll(':scope > measure')) {
            measureNumber = Number(measure.getAttribute('number')) || measureNumber + 1;
            measureStartQ = posQ;
            if (measure.querySelector('barline repeat')) sawRepeat = true;

            for (const el of [...measure.children]) {
                const tag = el.nodeName;
                if (tag === 'attributes') {
                    const d = num(el, 'divisions');
                    if (d && d > 0) divisions = d;
                    if (respellScale == null) {
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
                            const alter = num(pitch, 'alter') ?? 0;
                            const midi = midiOf(step, alter, octave);
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
                                    onMs, offMs, midi, step, alter,
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

    const name = fileName.replace(/\.(musicxml|xml)$/i, '');
    return { events, expected, name, warnings };
}

/** First `<sound tempo>` in the document (quarter-notes per minute), or null. */
function firstTempo(doc: Document): number | null {
    const t = doc.querySelector('sound[tempo]')?.getAttribute('tempo');
    return t ? Number(t) : null;
}
