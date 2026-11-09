/**
 * Piano keyboard strip: the notes sounding at the current onset, lit on a compact full-range keyboard
 * (A0..C8, fixed, so keys never jump between pieces). Look taken from the tonnetz app's read-only
 * keyboard (`PianoKeyboardController.ts`, `_piano.css`): dark rounded case, small gradient keys, lit keys
 * glow. No labels on the keys: the spelling is in the tooltip and the screen-reader line, and the roll /
 * lattice carry it on screen. Display only, except that a clicked key is handed to `onKey` (main.ts
 * plays it when sound is on).
 *
 * - A lit key that belongs to the chord read at this onset (chord.ts `chordReading`, the same read as the
 *   chord lane) is filled with that chord's 3D-lattice shade (`chordFill`: the triad gradient over the
 *   current surface, so minor is bluish and major yellow-orange; maj7 / min7 blend their two triads).
 *   A sounding note outside the chord, or with no chord named, is neutral grey.
 * - A wrong note gets a red inner frame (the tier, which the fill no longer carries).
 * - Struck-now notes are solid; notes still held from an earlier onset are paler; the current step's
 *   own note gets a ring.
 * - LOCAL compare (viz/src/compare.ts): where the other speller spelled a sounding note differently,
 *   the key gets a compare-cyan underline bar (tooltip names both spellings).
 */
import type { Pitch } from '../../../src/index.js';
import type { Replay, ReplayNote, Tier } from '../replay.js';
import type { Comparison } from '../compare.js';
import { label } from '../format.js';
import { chordReading, chordFill, type ChordRead } from '../chord.js';

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);
const isWhite = (midi: number) => WHITE_PCS.has(((midi % 12) + 12) % 12);
const FULL_LO = 21, FULL_HI = 108;   // A0..C8, the whole piano
const NEUTRAL = '#9aa3b2';           // a sounding note outside the chord, or no chord named

/** One lit key: the note that decides its label (the current step's note, else the latest struck). */
interface Lit { note: ReplayNote; struck: boolean; current: boolean }

const pc = (p: Pitch | null) => p ? label({ step: p.step, alter: p.alter }) : '∅';

export interface KeyboardStrip {
    /** Light the keys for `step` of `replay`. A no-op while the strip is hidden. */
    render(replay: Replay | null, step: number, cmp: Comparison | null): void;
    setVisible(v: boolean): void;
}

export function initKeyboard(host: HTMLElement, onKey: (midi: number) => void): KeyboardStrip {
    host.classList.add('pk-strip');
    host.innerHTML = '<div class="pk-keys" aria-hidden="true"></div><div class="pk-sr" role="status" aria-live="off"></div>';
    const keysEl = host.querySelector<HTMLElement>('.pk-keys')!;
    const srEl = host.querySelector<HTMLElement>('.pk-sr')!;
    let visible = false;
    let lo = -1, hi = -1;
    const keyEls = new Map<number, HTMLElement>();
    let litMidis: number[] = [];
    let last: { replay: Replay | null; step: number; cmp: Comparison | null } = { replay: null, step: 0, cmp: null };

    function build(nlo: number, nhi: number) {
        lo = nlo; hi = nhi;
        keysEl.innerHTML = '';
        keyEls.clear();
        litMidis = [];
        const whites: number[] = [];
        for (let m = lo; m <= hi; m++) if (isWhite(m)) whites.push(m);
        const w = 100 / whites.length;
        for (let m = lo; m <= hi; m++) {
            const k = document.createElement('div');
            k.dataset.midi = String(m);
            if (isWhite(m)) {
                k.className = 'pk-key pk-white';
                k.style.left = `${whites.indexOf(m) * w}%`;
                k.style.width = `${w}%`;
            } else {
                k.className = 'pk-key pk-black';
                k.style.left = `${(whites.indexOf(m + 1)) * w}%`;   // centred on the line between its two whites
                k.style.width = `${w * 0.62}%`;
            }
            k.addEventListener('pointerdown', e => { e.preventDefault(); onKey(m); });
            keysEl.appendChild(k);
            keyEls.set(m, k);
        }
    }

    /** The range: always the full keyboard. */
    function rangeFor(_replay: Replay | null): [number, number] { return [FULL_LO, FULL_HI]; }

    /** Every note ringing at the current onset's time (the whole struck chord, plus held notes), one per key. */
    function litAt(replay: Replay, step: number): Map<number, Lit> {
        const lit = new Map<number, Lit>();
        const cur = replay.notes[step];
        if (!cur) return lit;
        const t = cur.onT;
        for (const n of replay.notes) {
            if (n.onT > t) break;   // notes are in onset order
            if (n.onT !== t && n.offT <= t) continue;
            const prev = lit.get(n.midi);
            const entry: Lit = { note: n, struck: n.onT === t, current: n === cur };
            // A unison doubling lights its key once: the current step's note wins, else the latest struck.
            if (!prev || entry.current || (!prev.current && n.onT >= prev.note.onT)) lit.set(n.midi, entry);
        }
        return lit;
    }

    /** The chord read at `step`, once the whole struck chord is in (the last note at this onset time), as
     *  the chord lane reads it: coherent and complete (or a complete chord inside extra notes), else none. */
    function chordFor(replay: Replay, step: number): { read: ChordRead; fill: string } | null {
        let j = step;
        while (j + 1 < replay.snapshots.length && replay.snapshots[j + 1]!.t === replay.snapshots[step]!.t) j++;
        const read = chordReading(replay, j).read;
        if (!read.type || !read.coherent || read.status === 'partial') return null;
        const fill = chordFill(read, replay.snapshots[j]!.resolvedScale);
        return fill ? { read, fill } : null;
    }

    function paint() {
        const { replay, step, cmp } = last;
        const [nlo, nhi] = rangeFor(replay);
        if (nlo !== lo || nhi !== hi) build(nlo, nhi);
        for (const m of litMidis) {
            const k = keyEls.get(m);
            if (!k) continue;
            k.classList.remove('pk-on', 'pk-held', 'pk-cur', 'pk-wrong', 'pk-diff', 'pk-nct');
            k.style.removeProperty('--pk-fill');
            k.style.removeProperty('--pk-bg');
            k.removeAttribute('title');
        }
        litMidis = [];
        const lit = replay ? litAt(replay, step) : new Map<number, Lit>();
        const chord = replay && lit.size ? chordFor(replay, step) : null;
        const inChord = new Set((chord?.read.chordNotes ?? []).map(p => `${p.step}${p.alter}`));
        const spoken: string[] = [];
        for (const [m, l] of [...lit.entries()].sort((a, b) => a[0] - b[0])) {
            const k = keyEls.get(m);
            if (!k) continue;
            litMidis.push(m);
            const n = l.note, ours = n.committed;
            const tier: Tier = n.tier;
            const ungraded = !n.expected && !!ours;
            const member = !!ours && inChord.has(`${ours.step}${ours.alter}`);
            const bg = member ? chord!.fill : NEUTRAL;
            // --pk-fill: one solid colour (glow, held tint); --pk-bg: the full background (a blend for maj7/min7)
            k.style.setProperty('--pk-bg', bg);
            k.style.setProperty('--pk-fill', bg.startsWith('linear') ? (bg.match(/#[0-9a-f]{6}/i)?.[0] ?? NEUTRAL) : bg);
            k.classList.add('pk-on');
            if (!member) k.classList.add('pk-nct');
            if (!l.struck) k.classList.add('pk-held');
            if (l.current) k.classList.add('pk-cur');
            const wrong = tier === 'wrong';
            if (wrong) k.classList.add('pk-wrong');
            const theirs = cmp?.differ[n.onIndex] ? cmp.theirs[n.onIndex] ?? null : null;
            const theirsWrong = !!theirs && cmp!.tiers[n.onIndex] === 'wrong';
            if (theirs) k.classList.add('pk-diff');
            const tierWord = ungraded ? 'not graded' : tier === 'correct' ? 'exact' : tier;
            k.title = `ours ${label(ours)} (${tierWord})`
                + (n.expected ? ` · score ${label({ step: n.expected.step as Pitch['step'], alter: n.expected.alter as Pitch['alter'] })}` : '')
                + (theirs ? ` · ${cmp!.label} ${pc(theirs)}${theirsWrong ? ' (wrong)' : ''}` : '')
                + (member ? ` · in ${chord!.read.short}` : '')
                + (l.struck ? '' : ' · held');
            spoken.push(`${label(ours)}${wrong ? ' wrong' : ''}${theirs ? `, ${cmp!.label} ${pc(theirs)}` : ''}`);
        }
        srEl.textContent = spoken.length ? `Sounding${chord ? ` (${chord.read.short})` : ''}: ${spoken.join('; ')}` : 'Nothing sounding';
    }

    return {
        render(replay, step, cmp) {
            last = { replay, step, cmp };
            if (visible) paint();
        },
        setVisible(v) {
            visible = v;
            host.hidden = !v;
            if (v) paint();
        },
    };
}
