/**
 * Clipboard export: dump what the panels are showing as plain text, for pasting into an agent chat.
 *
 * ⌘/Ctrl+C copies the CURRENT onset — settings, the note, the engine surface it was decided against,
 * and the scoring trace. ⌘/Ctrl+Shift+C copies the RUN — the tally plus every mis-spelled onset. Both
 * read the same snapshot the panels render, so the text can't drift from the screen. Spellings are
 * ASCII (Gb / F#), not the unicode glyphs, so they survive a paste into any terminal or issue box.
 */
import type { AppState } from './state.js';
import { SPIRAL_RANGE_DEFAULT, SPIRAL_CENTER_DEFAULT, current } from './state.js';
import type { Snapshot, ReplayNote, Mode } from './replay.js';
import type { DecisionCandidate } from './decision.js';
import type { Pitch, PitchClass } from '../../src/index.js';
import { ascii } from './format.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const MODE_LONG: Record<Mode, string> = {
    core: 'Core speller (rung 1)',
    rt: 'real-time',
    la: 'real-time + look-ahead',
    tp: 'two-pass (offline batch)',
    control: 'fixed-LoF control — context-free window (music21 default MIDI spelling)',
};
const MAX_ROWS = 300;   // a badly-failing fixture shouldn't paste thousands of lines into a chat

const pitch = (p: Pitch | PitchClass | null | undefined): string =>
    p ? ascii(p) + ('octave' in p ? p.octave : '') : '—';
const sgn = (n: number) => (n > 0 ? '+' + n : String(n));
const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

/** Where in the score an onset sits, when the fixture's ground truth says. */
function place(n: ReplayNote | undefined): string {
    const e = n?.expected;
    return e?.measure != null ? `m${e.measure}${e.beat != null ? ` b${e.beat}` : ''}` : '';
}

/** Settings header — shared by both reports, so a paste always says what produced it. */
function header(s: AppState): string[] {
    const r = s.replay;
    const out = [
        `fixture: ${s.fixtureId}`,
        `speller: ${MODE_LONG[s.mode]} [${s.mode}]`,
        `spiral:  range ±${s.spiralRange}, centre ${sgn(s.spiralCenter)}`
        + (s.spiralRange === SPIRAL_RANGE_DEFAULT && s.spiralCenter === SPIRAL_CENTER_DEFAULT
            ? '  (shipped default)'
            : `  (what-if; shipped default is ±${SPIRAL_RANGE_DEFAULT}, ${sgn(SPIRAL_CENTER_DEFAULT)})`),
    ];
    if (s.sideOverrides.length) out.push(`side markers: ${s.sideOverrides.map(o => `onset ${o.from + 1} → ${o.comma > 0 ? 'sharp' : o.comma < 0 ? 'flat' : 'auto'}`).join(', ')}`);
    if (r) {
        const t = r.tally, pc = (x: number) => (t.total ? (100 * x / t.total).toFixed(1) : '0.0');
        out.push(`tally:   ${pc(t.correct + t.flipped)}% correct (exact: ${pc(t.correct)}%, flipped: ${pc(t.flipped)}%)`
            + ` · ${pc(t.wrong)}% wrong (${t.wrong}) of ${t.total} scored onsets`);
    }
    out.push(`url:     ${location.href}`);
    return out;
}

/** The current onset in full: note, engine surface, and the per-candidate scoring trace. */
export function contextReport(s: AppState): string {
    const snap = current(s);
    if (!snap || !s.replay) return '(no fixture loaded)';
    const note = s.replay.notes[s.step];
    const at = place(note);
    const L: string[] = [];

    L.push(`# enharmonic viz — onset ${snap.onIndex} of ${s.replay.snapshots.length}${at ? ` (${at})` : ''}`, '');
    L.push(...header(s), '');

    L.push('## note');
    L.push(`committed: ${pitch(snap.committed)}   (midi ${snap.midi}, t ${snap.t} ms, dur ${snap.durMs} ms)`);
    L.push(`expected:  ${pitch(snap.expected)}${at ? `   (${at})` : ''}`);
    L.push(`tier:      ${snap.tier}`);
    L.push('');

    L.push('## speller state');
    if (snap.frame || snap.resolvedScale) {
        const byLetter = (ps: typeof snap.frame) => {
            const m = new Map<string, PitchClass>((ps ?? []).map(p => [p.step, p]));
            return LETTERS.map(x => pad(m.has(x) ? pitch(m.get(x)!) : '·', 3)).join(' ').trimEnd();
        };
        if (snap.frame) L.push(`frame:    ${byLetter(snap.frame)}`);
        if (snap.resolvedScale) L.push(`surface:  ${byLetter(snap.resolvedScale)}   (the diatonic collection plus its live alterations)`);
        if (snap.frame && snap.resolvedScale) {
            const fm = new Map(snap.frame.map(p => [p.step, p]));
            const diff = snap.resolvedScale
                .filter(p => { const f = fm.get(p.step); return f && f.alter !== p.alter; })
                .map(p => `${pitch(fm.get(p.step)!)}→${pitch(p)}`);
            if (diff.length) L.push(`overlays: ${diff.join(', ')}`);
        }
        if (snap.frameLofTonic != null) L.push(`spiral:   LoF ${sgn(snap.frameLofTonic)} tonic`);
    } else {
        L.push('(batch two-pass — whole-piece decision, no streaming frame)');
    }
    if (s.showKeyLanes && snap.localColl) L.push(`local key: ${snap.localColl.name}  (tonicizations; margin ${snap.localColl.margin.toFixed(1)}, EXPERIMENTAL display-only)`);
    if (s.showKeyLanes && snap.stableColl) L.push(`stable key: ${snap.stableColl.name}  (home; margin ${snap.stableColl.margin.toFixed(1)}, EXPERIMENTAL display-only)`);
    L.push(`sounding: ${snap.sounding.length
        ? snap.sounding.map(x => pitch(x.pitch) + (x.midi === snap.midi ? '*' : '')).join(' ') + '   (* = this note)'
        : '—'}`);
    L.push('');

    L.push('## decision');
    L.push(...decisionLines(snap, s.mode === 'la'));
    return L.join('\n');
}

function decisionLines(snap: Snapshot, laActive: boolean): string[] {
    const dec = snap.decision;
    if (!dec) return ['(batch two-pass — no per-onset scoring trace)'];
    const hasSide = dec.candidates.some(c => c.sideDelta !== undefined);
    const hasGuard = dec.candidates.some(c => c.guardDelta !== undefined);
    const total = (c: DecisionCandidate) => c.base + c.laDelta + c.nsDelta + (c.guardDelta ?? 0) + (c.sideDelta ?? 0);
    // Columns are STRUCTURAL (per speller), not per-onset, so the table never gains/loses a column between
    // notes: the real-time preset shows Side + Grd (+ LA when it looks ahead); the streaming rungs
    // show LA + NS. Same layout as the scoring panel.
    const cols: { h: string; val: (c: DecisionCandidate) => number }[] = [];
    if (hasSide) cols.push({ h: 'Side', val: c => c.sideDelta ?? 0 });
    if (hasGuard) cols.push({ h: 'Grd', val: c => c.guardDelta ?? 0 });
    if ((hasSide || hasGuard) && laActive) cols.push({ h: 'LA', val: c => c.laDelta });
    // The look-ahead preset (Grd but no Side) also carries the drift-leash + vertical-guard penalty in nsDelta;
    // show it so the printed total always reconciles (it was silently omitted, hiding why a candidate won).
    if (hasGuard && !hasSide) cols.push({ h: 'Vrt', val: c => c.nsDelta });
    if (!hasSide && !hasGuard) cols.push({ h: 'LA', val: c => c.laDelta }, { h: 'NS', val: c => c.nsDelta });
    const out = ['  cand  base' + cols.map(c => padL(c.h, 5)).join('') + '  total'];
    for (const c of dec.candidates) {
        const chosen = c.c.step === dec.chosen.step && c.c.alter === dec.chosen.alter;
        const cells = cols.map(col => { const v = col.val(c); return padL(v ? sgn(v) : '·', 5); }).join('');
        out.push(`${chosen ? '▶' : ' '} ${pad(pitch(c.c), 5)}${padL(sgn(c.base), 5)}${cells}${padL(sgn(total(c)), 7)}`);
    }
    out.push(`chosen: ${pitch(dec.chosen)}`);
    if (dec.override !== 'none') out.push(`override: ${dec.override}`);
    return out;
}

/** The whole run: settings, tally, and every onset the speller did not get exactly right. */
export function runReport(s: AppState): string {
    if (!s.replay) return '(no fixture loaded)';
    const bad = s.replay.snapshots.filter(x => x.tier === 'flipped' || x.tier === 'wrong');
    const L: string[] = [`# enharmonic viz — run report`, ''];
    L.push(...header(s), '');
    L.push(`## not-exactly-right onsets (${bad.length})`);
    if (!bad.length) {
        L.push('(none — every scored onset matched the ground truth)');
    } else {
        L.push('onset  midi  got    exp    tier     where');
        for (const x of bad.slice(0, MAX_ROWS)) {
            L.push(`${padL(String(x.onIndex), 5)}${padL(String(x.midi), 6)}  ${pad(pitch(x.committed), 6)}`
                + ` ${pad(pitch(x.expected), 6)} ${pad(x.tier, 8)} ${place(s.replay.notes[x.onIndex])}`);
        }
        if (bad.length > MAX_ROWS) L.push(`… ${bad.length - MAX_ROWS} more`);
    }
    return L.join('\n');
}

/** Write to the clipboard, falling back to execCommand where the async API is unavailable/blocked. */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch { return false; }
    }
}

let toastEl: HTMLElement | null = null, toastT = 0;
/** The little "copied" flash — the only feedback the shortcut gives. */
export function flash(msg: string): void {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT);
    toastT = window.setTimeout(() => toastEl?.classList.remove('show'), 1100);
}
