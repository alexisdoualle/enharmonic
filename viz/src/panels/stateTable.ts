/**
 * State table: the speller's surface at the current onset — the 7-letter resolved scale (frame +
 * keep-alive + sounding overlay), the note just committed vs its ground truth, and the notes
 * still ringing. This is read straight from the shipped kernel's snapshot, so it is exactly the state
 * the spelling decision saw.
 */
import type { Snapshot } from '../replay.js';
import type { PitchClass } from '../../../src/index.js';
import { label } from '../format.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const TIER_TEXT: Record<string, string> = { correct: '✓ correct', flipped: '⇄ flipped (coherent side)', wrong: '✗ wrong', unread: '∅ unread' };

export function renderStateTable(host: HTMLElement, snap: Snapshot | null): void {
    host.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'speller state';
    host.appendChild(title);
    if (!snap) { host.appendChild(row('—', '')); return; }

    // The note under the cursor.
    const noteBox = document.createElement('div');
    noteBox.className = `note-line tier-${snap.tier}`;
    noteBox.innerHTML = `<span class="note-big">${label(snap.committed)}</span>`
        + `<span class="note-meta">midi ${snap.midi} · onset ${snap.onIndex}</span>`
        + `<span class="note-tier">${TIER_TEXT[snap.tier]}</span>`
        + (snap.expected ? `<span class="note-exp">expected ${label(snap.expected)}</span>` : '');
    host.appendChild(noteBox);

    // The bare diatonic base (the diatonic collection), then the resolved surface it feeds. Where the surface
    // differs from the frame is the keep-alive + sounding overlay — those surface cells are marked.
    const frameByLetter = new Map(snap.frame?.map(p => [p.step, p]) ?? []);
    const surfByLetter = new Map(snap.resolvedScale?.map(p => [p.step, p]) ?? []);

    if (snap.frame) host.appendChild(labelled('frame (collection)', surfaceGrid(frameByLetter)));
    host.appendChild(labelled('resolved surface', surfaceGrid(surfByLetter, frameByLetter)));

    // Sounding notes.
    const sounding = document.createElement('div');
    sounding.className = 'sounding';
    if (snap.sounding.length === 0) sounding.innerHTML = '<span class="dim">—</span>';
    for (const s of snap.sounding) {
        const chip = document.createElement('span');
        chip.className = 'sound-chip' + (s.midi === snap.midi ? ' current' : '');
        chip.textContent = label(s.pitch);
        sounding.appendChild(chip);
    }
    host.appendChild(labelled(`sounding (${snap.sounding.length})`, sounding));

    if (snap.frameLofTonic == null && snap.resolvedScale == null)
        host.appendChild(row('frame', 'batch two-pass — whole-piece decision, no streaming frame'));
}

/** A 7-cell letter grid for a resolved map. When `diffFrom` is given, a cell whose spelling differs
 *  from that reference (i.e. an overlay changed it) is marked `.overlaid`. */
function surfaceGrid(byLetter: Map<string, PitchClass>, diffFrom?: Map<string, PitchClass>): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'surface';
    for (const L of LETTERS) {
        const p = byLetter.get(L);
        const altered = p && p.alter !== 0;
        const ref = diffFrom?.get(L);
        const overlaid = !!(p && ref && (p.alter !== ref.alter || p.step !== ref.step));
        const cell = document.createElement('div');
        cell.className = `surf-cell${altered ? ' altered' : ''}${overlaid ? ' overlaid' : ''}`;
        if (overlaid && ref) cell.title = `overlay: frame ${label(ref)} → ${label(p!)}`;
        cell.innerHTML = `<span class="surf-letter">${L}</span><span class="surf-spell">${p ? label(p) : '·'}</span>`;
        grid.appendChild(cell);
    }
    return grid;
}

function labelled(text: string, body: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('div');
    lab.className = 'field-label';
    lab.textContent = text;
    wrap.append(lab, body);
    return wrap;
}
function row(k: string, v: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'field';
    d.innerHTML = `<div class="field-label">${k}</div><div class="dim">${v}</div>`;
    return d;
}
