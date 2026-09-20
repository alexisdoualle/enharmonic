/**
 * center-trace — debug the FRAME CENTRE's movement over a piece. Fast swings of the centre on the line of
 * fifths are a symptom of a destabilised frame (chromatic notes yanking it), and wrong spellings cluster
 * there. This prints the per-onset centre trajectory, flags fast swings, and reports whether wrongs coincide.
 *
 *   npx tsx test/eval/center-trace.ts <fixtureId> [mode=la] [lo] [hi]
 *     fixtureId : a local-fixtures/<id> or test-fixtures <id> (e.g. beethoven_moonlight_mvt1)
 *     mode      : rt | la  (default la)
 *     lo,hi     : onset window to print in detail (default: the 20 around the biggest swing)
 *
 * The centre shown is the frame's MEAN line-of-fifths (what the viz wheel derives its tonic from). Δ is the
 * per-onset change; a |Δ| ≥ SWING or a direction reversal inside REVERSAL_WIN onsets is flagged ⚡.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpellingEngine, RT_PRESET, LA_PRESET } from '../../src/engine.js';
import { resolveStep } from '../../src/kernel.js';
import { lineOfFifths } from '../../src/interval.js';
import type { Pitch, PitchClass } from '../../src/pitch.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWING = 1.5;          // |Δcentre| (fifths/onset) that counts as a fast swing
const REVERSAL_WIN = 3;     // a sign flip within this many onsets is a swing too
const NEAR = 3;             // a wrong is "near a swing" if within this many onsets of one

const [, , fixtureId = 'beethoven_moonlight_mvt1', mode = 'la', loArg, hiArg] = process.argv;

// ── Load a fixture: local-fixtures (events.json/expected.json) or test fixtures ────────────────────────
interface Note { midi: number; tOn: number; tOff: number; }
function loadFixture(id: string): { notes: Note[]; expected: PitchClass[] } {
    const local = join(REPO, 'local-fixtures', id);
    const dir = existsSync(join(local, 'events.json')) ? local : join(REPO, 'test', 'fixtures', id);
    if (!existsSync(join(dir, 'events.json'))) { console.error(`fixture not found: ${id}`); process.exit(1); }
    const events = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) as { t_ms: number; type: string; midi: number }[];
    const expRaw = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { step: string; alter: number }[];
    const notes: Note[] = []; const open = new Map<number, number[]>();
    for (const e of events) {
        if (e.type === 'on') { const i = notes.length; notes.push({ midi: e.midi, tOn: e.t_ms, tOff: e.t_ms + 500 }); (open.get(e.midi) ?? open.set(e.midi, []).get(e.midi)!).push(i); }
        else if (e.type === 'off') { const q = open.get(e.midi); if (q?.length) { const i = q.shift()!; notes[i]!.tOff = e.t_ms; } }
    }
    return { notes, expected: expRaw.map(e => ({ step: e.step as PitchClass['step'], alter: e.alter as PitchClass['alter'] })) };
}

const { notes, expected } = loadFixture(fixtureId);
const mid = notes.map(n => n.midi);
const resolveDir = (a: number): number => { let seen = 0; for (let b = a + 1; b < mid.length && seen < 16; b++) { seen++; const d = resolveStep(mid[a]!, mid[b]!); if (d !== 0) return d; } return 0; };
const dirs = notes.map((_, i) => resolveDir(i));

// ── Drive, recording the frame centre (mean LoF) at each onset commit ──────────────────────────────────
const engine = new SpellingEngine(mode === 'rt' ? RT_PRESET : LA_PRESET);
const out: (Pitch | null)[] = new Array(notes.length).fill(null);
const centre: number[] = new Array(notes.length).fill(NaN);
const pend = new Map<number, number[]>();
const evs: { t: number; on: boolean; i: number }[] = [];
notes.forEach((n, i) => { evs.push({ t: n.tOn, on: true, i }); evs.push({ t: n.tOff, on: false, i }); });
evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || mid[a.i]! - mid[b.i]!);
for (const e of evs) {
    const m = mid[e.i]!;
    if (e.on) {
        engine.noteOn(m, e.t, dirs[e.i]!);
        const scale = engine.getResolvedScale();
        centre[e.i] = scale.reduce((s, p) => s + lineOfFifths(p), 0) / scale.length;
        (pend.get(m) ?? pend.set(m, []).get(m)!).push(e.i);
    } else { const q = pend.get(m); if (q?.length) { out[q.shift()!] = engine.getSpelling(m); if (q.length === 0) engine.noteOff(m); } }
}

// ── Per-onset velocity + swing flags ───────────────────────────────────────────────────────────────────
const d = centre.map((c, i) => i === 0 ? 0 : c - centre[i - 1]!);
const wrong = (i: number) => out[i] != null && (out[i]!.step !== expected[i]!.step || out[i]!.alter !== expected[i]!.alter);
// A centre reversal: it moves up and back down (or vice-versa) within the window — a fast swing, not a modulation.
const reversal = (i: number) => {
    const lo = Math.max(1, i - REVERSAL_WIN), hi = Math.min(centre.length - 1, i + REVERSAL_WIN);
    let up = false, down = false;
    for (let k = lo + 1; k <= hi; k++) { if (d[k]! > 0.6) up = true; if (d[k]! < -0.6) down = true; }
    return up && down;
};
const flagged = (i: number) => Math.abs(d[i]!) >= SWING || reversal(i);

// ── Whole-piece correlation: do wrongs sit near swings? ────────────────────────────────────────────────
const swings = centre.map((_, i) => flagged(i));
let wrongCount = 0, wrongNearSwing = 0, biggest = 1;
for (let i = 1; i < notes.length; i++) {
    if (Math.abs(d[i]!) > Math.abs(d[biggest]!)) biggest = i;
    if (wrong(i)) { wrongCount++; for (let k = Math.max(0, i - NEAR); k <= Math.min(notes.length - 1, i + NEAR); k++) if (swings[k]) { wrongNearSwing++; break; } }
}
const swingOnsets = swings.filter(Boolean).length;
const baseRate = swingOnsets / notes.length;   // chance a random ±NEAR window hits a swing (rough)

const lo = loArg != null ? +loArg : Math.max(0, biggest - 10);
const hi = hiArg != null ? +hiArg : Math.min(notes.length - 1, biggest + 10);
const nm = (p: Pitch | null) => p ? p.step + (p.alter > 0 ? '#'.repeat(p.alter) : p.alter < 0 ? 'b'.repeat(-p.alter) : '') : '·';

console.log(`\n${fixtureId}  mode=${mode}  ${notes.length} onsets`);
console.log(`biggest swing at onset ${biggest} (Δ=${d[biggest]!.toFixed(2)})   window [${lo}..${hi}]\n`);
console.log(`onset  midi  got  exp   tier   centre    Δ      flag`);
for (let i = lo; i <= hi; i++) {
    const bar = (() => { const n = Math.round(centre[i]! * 2); return ' '.repeat(Math.max(0, 16 + Math.min(16, Math.max(-16, n)))) + '│'; })();
    console.log(`${wrong(i) ? '!' : ' '}${String(i).padStart(4)}  ${String(mid[i]).padStart(3)}  ${nm(out[i]).padEnd(4)} ${nm({ step: expected[i]!.step, alter: expected[i]!.alter } as Pitch).padEnd(4)}  ${wrong(i) ? 'WRONG' : '  ·  '}  ${centre[i]!.toFixed(2).padStart(6)}  ${d[i]!.toFixed(2).padStart(6)}  ${flagged(i) ? '⚡' : '  '} ${bar}`);
}
console.log(`\nSWING↔WRONG correlation (whole piece):`);
console.log(`  wrongs: ${wrongCount}   near a swing (±${NEAR}): ${wrongNearSwing} (${wrongCount ? (100 * wrongNearSwing / wrongCount).toFixed(0) : 0}%)`);
console.log(`  swing onsets: ${swingOnsets}/${notes.length} (${(100 * baseRate).toFixed(1)}% of onsets)   — lift = wrong-near-swing rate vs base rate`);
