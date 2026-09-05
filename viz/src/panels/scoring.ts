/**
 * Scoring table: WHY the speller spelled this note the way it did. For each enharmonic candidate it
 * shows the base interval score against the current frame (broken down per frame slot), the additive
 * look-ahead / neighbour-step deltas, the total the argmax used, and the winner — then a plain-language
 * note when a post-total mechanism (sounding tie-break, rel-minor leading tone, a look-ahead gate)
 * overrode that argmax. The numbers come straight from the kernel's record-only decision trace, so the
 * table is exactly the decision the shipped speller made.
 */
import type { Snapshot } from '../replay.js';
import type { DecisionCandidate } from '../../../src/base.js';
import type { PitchClass } from '../../../src/index.js';
import { rawIntervalBetween, intervalBetween, intervalLabel } from '../../../src/interval.js';
import { label } from '../format.js';

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;

// Max enharmonic candidates for any pitch class (see src/candidates.ts) — the table reserves this many
// rows so stepping between a 2-candidate and a 3-candidate onset does not resize the panel.
const MAX_CANDIDATES = 3;

// Mirror of src/scoring.ts `scoreFor` — the per-interval contribution to a candidate's base score.
function scoreFor(quality: number, number: number): number {
    if (quality === 0) return (number === 4 || number === 5) ? 1 : 0;
    const a = Math.abs(quality);
    if (a === 1) return (number === 3 || number === 6) ? 1 : 0;
    if (a === 2) return -1;
    if (a === 3) return -2;
    return 0;
}

const sgn = (n: number) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');
const numCls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero');

const OVERRIDE_TEXT: Record<string, string> = {
    'sounding-tiebreak': '⊚ sounding tie-break — the frame tied, so the co-onset chord decided',
    'rel-minor-lt': '△ rel-minor leading tone — took the ♯7 over the lowered tonic under a sounding V',
    'lookahead-vertical-gate': '⊥ look-ahead vertical gate — reverted a look-ahead pick that wolfed the chord',
    'lookahead-coherence-gate': '↔ look-ahead coherence gate — reverted a look-ahead pick that broke the passage side',
};

export function renderScoring(host: HTMLElement, snap: Snapshot | null): void {
    host.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'scoring — why this spelling';
    host.appendChild(title);
    if (!snap) { host.appendChild(dim('—')); return; }
    if (!snap.decision) { host.appendChild(dim('batch two-pass — whole-piece decision, no per-onset scoring trace')); return; }

    const dec = snap.decision;
    const frameByLetter = new Map(dec.frame.map(p => [p.step, p]));
    const anyLA = dec.candidates.some(c => c.laDelta !== 0);
    const anyNS = dec.candidates.some(c => c.nsDelta !== 0);
    const total = (c: DecisionCandidate) => c.base + c.laDelta + c.nsDelta;
    const chosenKey = `${dec.chosen.step}:${dec.chosen.alter}`;
    const baseWin = dec.candidates.reduce((b, c) => (c.base > b.base ? c : b), dec.candidates[0]!);
    const totalWin = dec.candidates.reduce((b, c) => (total(c) > total(b) ? c : b), dec.candidates[0]!);

    // header: committed vs expected + tier
    const head = document.createElement('div');
    head.className = `note-line tier-${snap.tier}`;
    head.innerHTML = `<span class="note-big">${label(snap.committed)}</span>`
        + (snap.expected ? `<span class="note-exp">expected ${label(snap.expected)}</span>` : '')
        + `<span class="note-meta">midi ${snap.midi} · onset ${snap.onIndex}</span>`;
    host.appendChild(head);

    // The speller's surface, compact: the bare diatonic frame (collection) and the resolved surface it
    // feeds (frame + keep-alive + sounding). A resolved cell that an overlay changed from the frame is
    // marked. Two 7-cell rows — the state that the scoring below reasons against.
    if (snap.frame || snap.resolvedScale) {
        const frameByLetter = new Map(snap.frame?.map(p => [p.step, p]) ?? []);
        const surfByLetter = new Map(snap.resolvedScale?.map(p => [p.step, p]) ?? []);
        const surf = document.createElement('div');
        surf.className = 'surface-block';
        if (snap.frame) surf.appendChild(surfaceRow('frame', frameByLetter));
        if (snap.resolvedScale) surf.appendChild(surfaceRow('surface', surfByLetter, frameByLetter));
        host.appendChild(surf);
    }

    // table — fixed geometry: every column is always present and every onset draws MAX_CANDIDATES rows,
    // so the layout stays put while scrubbing.
    const scroll = document.createElement('div');
    scroll.className = 'score-scroll';
    const table = document.createElement('table');
    table.className = 'score-table';
    table.innerHTML = `<colgroup>`
        + `<col class="col-cand"><col class="col-total">`
        + LETTERS.map(() => '<col class="col-slot">').join('')
        + `<col class="col-delta"><col class="col-delta">`
        + `</colgroup>`;
    const thead = document.createElement('tr');
    thead.innerHTML = `<th>cand</th><th class="c">total</th>`
        + LETTERS.map(L => {
            const p = frameByLetter.get(L);
            return `<th class="c" title="frame slot">${p ? label(p) : L}</th>`;
        }).join('')
        + '<th class="c" title="look-ahead delta">LA</th>'
        + '<th class="c" title="neighbour-step delta">NS</th>';
    table.appendChild(thead);

    for (const c of dec.candidates) {
        const tr = document.createElement('tr');
        const isChosen = `${c.c.step}:${c.c.alter}` === chosenKey;
        if (isChosen) tr.className = 'winner';
        const cells = LETTERS.map(L => {
            if (L === c.c.step) return `<td class="c zero">—</td>`;
            const fp = frameByLetter.get(L);
            if (!fp) return `<td class="c zero">·</td>`;
            const raw = rawIntervalBetween(c.c, fp);
            const contrib = scoreFor(raw.quality, raw.number);
            const name = intervalLabel(intervalBetween(c.c, fp));
            return `<td class="c ${numCls(contrib)}" title="${name}">${contrib === 0 ? '·' : sgn(contrib)}</td>`;
        }).join('');
        tr.innerHTML = `<td><span class="pick${isChosen ? '' : ' blank'}">▶</span>${label(c.c)}</td>`
            + `<td class="c total"><b>${sgn(total(c))}</b> <span class="dim">(${sgn(c.base)})</span></td>`
            + cells
            + `<td class="c ${numCls(c.laDelta)}">${c.laDelta ? sgn(c.laDelta) : '·'}</td>`
            + `<td class="c ${numCls(c.nsDelta)}">${c.nsDelta ? sgn(c.nsDelta) : '·'}</td>`;
        table.appendChild(tr);
    }
    for (let i = dec.candidates.length; i < MAX_CANDIDATES; i++) {
        const tr = document.createElement('tr');
        tr.className = 'filler';
        tr.innerHTML = `<td colspan="${2 + LETTERS.length + 2}"></td>`;
        table.appendChild(tr);
    }
    scroll.appendChild(table);
    host.appendChild(scroll);

    // decision note: what actually chose the pick
    const notes: string[] = [];
    if (dec.override !== 'none') {
        notes.push(OVERRIDE_TEXT[dec.override] ?? dec.override);
    } else if (baseWin !== totalWin) {
        const mech = anyLA && anyNS ? 'look-ahead / neighbour-step' : anyLA ? 'look-ahead' : 'neighbour-step';
        notes.push(`${mech} moved the pick ${label(baseWin.c)} → ${label(totalWin.c)} (the letter into a semitone resolution)`);
    } else {
        notes.push(`frame decided — ${label(totalWin.c)} has the top interval score`);
    }
    const nd = document.createElement('div');
    nd.className = 'decision-note';
    nd.innerHTML = notes.map(n => `<div>${n}</div>`).join('');
    host.appendChild(nd);
}

/** One labelled 7-cell letter row for a resolved map. When `diffFrom` is given, a cell whose spelling
 *  differs from that reference (an overlay changed it) is marked `.overlaid`. */
function surfaceRow(name: string, byLetter: Map<string, PitchClass>, diffFrom?: Map<string, PitchClass>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'surface-row';
    const lab = document.createElement('span');
    lab.className = 'surface-row-label';
    lab.textContent = name;
    wrap.appendChild(lab);
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
        cell.innerHTML = `<span class="surf-spell">${p ? label(p) : '·'}</span>`;
        grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
}

function dim(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'dim';
    d.textContent = text;
    return d;
}
