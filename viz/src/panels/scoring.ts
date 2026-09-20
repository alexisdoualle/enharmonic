/**
 * Scoring table: WHY the speller spelled this note the way it did. For each enharmonic candidate it
 * shows the base interval score against the current frame (broken down per frame slot), the additive
 * look-ahead / recency-guard / side-anchor deltas, the total the argmax used, and the winner — then a
 * plain-language note when a post-total mechanism (sounding tie-break, rel-minor leading tone, a
 * look-ahead gate) overrode that argmax. The numbers come straight from the engine's record-only
 * decision trace (`decision()`), so the table is exactly the decision the shipped speller made.
 */
import type { Snapshot } from '../replay.js';
import type { DecisionCandidate } from '../decision.js';
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

export function renderScoring(host: HTMLElement, snap: Snapshot | null, laActive = false): void {
    host.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'scoring — why this spelling';
    host.appendChild(title);
    if (!snap) { host.appendChild(dim('—')); return; }

    // header: committed vs expected + tier
    const head = document.createElement('div');
    head.className = `note-line tier-${snap.tier}`;
    head.innerHTML = `<span class="note-big">${label(snap.committed)}</span>`
        + (snap.expected ? `<span class="note-exp">expected ${label(snap.expected)}</span>` : '')
        + `<span class="note-meta">midi ${snap.midi} · onset ${snap.onIndex} · ${snap.durMs} ms</span>`;
    host.appendChild(head);

    // The speller's surface, compact: the bare diatonic frame (collection) and the resolved surface it
    // feeds (the collection plus its live alterations). A resolved cell changed from the frame is
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

    if (snap.twoPass) host.appendChild(twoPassSummary(snap.twoPass));

    if (!snap.decision) {
        host.appendChild(dim(
            snap.twoPass ? 'selected pass has no per-candidate trace'
            : snap.frame ? 'Core speller — no per-candidate scoring trace'
            : 'fixed-LoF control (music21 default) — context-free window, no per-candidate scoring trace',
        ));
        return;
    }

    const dec = snap.decision;
    const frameByLetter = new Map(dec.frame.map(p => [p.step, p]));
    const hasGuard = dec.candidates.some(c => c.guardDelta !== undefined);
    const hasSide = dec.candidates.some(c => c.sideDelta !== undefined);
    const total = (c: DecisionCandidate) => c.base + c.laDelta + c.nsDelta + (c.guardDelta ?? 0) + (c.sideDelta ?? 0);
    // Delta columns depend on the SPELLER (structural), not on this onset's values, so the table never gains
    // or loses a column between notes: the real-time preset shows Side (anchor) + Grd (guard), + LA
    // when it looks ahead (`laActive`); the streaming rungs show LA/NS. Columns compose.
    const deltaCols: { label: string; title: string; val: (c: DecisionCandidate) => number }[] = [];
    if (hasSide) deltaCols.push({ label: 'Side', title: 'side-anchor penalty: −anchor × fifths outside the collection', val: c => c.sideDelta ?? 0 });
    if (hasGuard) deltaCols.push({ label: 'Grd', title: 'recency-guard penalty', val: c => c.guardDelta ?? 0 });
    if ((hasSide || hasGuard) && laActive) deltaCols.push({ label: 'LA', title: 'look-ahead: step toward the resolution', val: c => c.laDelta });
    // Look-ahead preset (Grd but no Side): nsDelta carries its drift-leash + vertical-guard penalty — show it
    // so the total reconciles (otherwise a candidate can win with no visible reason, e.g. the op28/4 dim7).
    if (hasGuard && !hasSide) deltaCols.push({ label: 'Vrt', title: 'drift-leash + vertical-guard penalty', val: c => c.nsDelta });
    if (!hasSide && !hasGuard) deltaCols.push(
        { label: 'LA', title: 'look-ahead delta', val: c => c.laDelta },
        { label: 'NS', title: 'neighbour-step delta', val: c => c.nsDelta },
    );
    const chosenKey = `${dec.chosen.step}:${dec.chosen.alter}`;
    const baseWin = dec.candidates.reduce((b, c) => (c.base > b.base ? c : b), dec.candidates[0]!);
    const totalWin = dec.candidates.reduce((b, c) => (total(c) > total(b) ? c : b), dec.candidates[0]!);

    // table — fixed geometry: every column is always present and every onset draws MAX_CANDIDATES rows,
    // so the layout stays put while scrubbing.
    const scroll = document.createElement('div');
    scroll.className = 'score-scroll';
    const table = document.createElement('table');
    table.className = 'score-table';
    table.innerHTML = `<colgroup>`
        + `<col class="col-cand"><col class="col-total">`
        + LETTERS.map(() => '<col class="col-slot">').join('')
        + deltaCols.map(() => '<col class="col-delta">').join('')
        + `</colgroup>`;
    const thead = document.createElement('tr');
    thead.innerHTML = `<th>cand</th><th class="c">total</th>`
        + LETTERS.map(L => {
            const p = frameByLetter.get(L);
            return `<th class="c" title="frame slot">${p ? label(p) : L}</th>`;
        }).join('')
        + deltaCols.map(d => `<th class="c" title="${d.title}">${d.label}</th>`).join('');
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
            + deltaCols.map(d => { const v = d.val(c); return `<td class="c ${numCls(v)}">${v ? sgn(v) : '·'}</td>`; }).join('');
        table.appendChild(tr);
    }
    for (let i = dec.candidates.length; i < MAX_CANDIDATES; i++) {
        const tr = document.createElement('tr');
        tr.className = 'filler';
        tr.innerHTML = `<td colspan="${2 + LETTERS.length + deltaCols.length}"></td>`;
        table.appendChild(tr);
    }
    scroll.appendChild(table);
    host.appendChild(scroll);

    // decision note: what actually chose the pick
    const notes: string[] = [];
    if (dec.override !== 'none') {
        notes.push(OVERRIDE_TEXT[dec.override] ?? dec.override);
    } else if (hasSide) {
        notes.push(baseWin !== totalWin
            ? `collection tie-break took ${label(totalWin.c)} over the equally-near ${label(baseWin.c)} (sharp side)`
            : `nearest rep to the collection — ${label(totalWin.c)} sits fewest fifths outside the key`);
        notes.push('base = −(fifths outside the collection); the letter columns show each rep’s intervals with the collection');
    } else if (baseWin !== totalWin) {
        // Name the mechanism(s) that actually moved the pick — the delta terms on which the winner beats the
        // base-only winner. For the guarded speller LA / vertical / guard COMPOSE, so more than one can apply.
        const movers: string[] = [];
        if (totalWin.laDelta - baseWin.laDelta > 0) movers.push('look-ahead');
        if ((totalWin.guardDelta ?? 0) - (baseWin.guardDelta ?? 0) > 0) movers.push('recency guard');
        if (totalWin.nsDelta - baseWin.nsDelta > 0) movers.push(hasGuard ? 'vertical guard / drift leash' : 'neighbour-step');
        const mech = movers.length ? movers.join(' + ') : 'the deltas';
        notes.push(`${mech} moved the pick ${label(baseWin.c)} → ${label(totalWin.c)}`);
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

/** Offline reconciliation: the forward and backward directional picks and the merged result. */
function twoPassSummary(trace: NonNullable<Snapshot['twoPass']>): HTMLElement {
    const d = document.createElement('div');
    d.className = 'decision-note';
    const name = (p: PitchClass | null) => (p ? label(p) : '—');
    d.innerHTML = `<div><b>two-pass</b> · forward ${name(trace.forward)} · backward ${name(trace.backward)}</div>`
        + `<div>resolved ${name(trace.selected)}${trace.agrees ? ' (both passes agree)' : ' (reconciled at a change-point)'}</div>`;
    return d;
}

function dim(text: string): HTMLElement {
    const d = document.createElement('div');
    d.className = 'dim';
    d.textContent = text;
    return d;
}
