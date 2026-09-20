/**
 * Emit the two shipped tiers' three-tier scores for the LBD figure: the real-time speller (`Speller`)
 * and the offline two-pass (`spellTwoPass`). Drives the SHIPPED src library directly (not the examples),
 * so the figure numbers are exactly what the library produces. Writes JSON in the shape the figure
 * generator reads: { rungs: { rt: tiers, tp: tiers } }, tiers = {correct,flipped,wrong,committed,total}.
 *   npx tsx test/eval/guarded-tiers.ts <clean|noisy> <out.json>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Speller, spellTwoPass, type Pitch, type TwoPassNote } from '../../src/index.js';
import { scoreTiers } from './score.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TATUM = 125;
const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const [, , variant = 'clean', outPath] = process.argv;
if (!outPath) { console.error('usage: guarded-tiers.ts <clean|noisy> <out.json>'); process.exit(1); }

interface Note { onset: number; dur: number; step: string; alter: number; midi: number; }
const parse = (t: string): Note[] => {
    const ns: Note[] = []; const re = /\(\s*(\d+)\s+"([A-G])([nsf]+)(\d+)"\s+(\d+)\s+(\d+)\s*\)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) { const alter = m[3] === 'n' ? 0 : [...m[3]!].reduce((a, c) => a + (c === 's' ? 1 : c === 'f' ? -1 : 0), 0);
        ns.push({ onset: +m[1]!, dur: +m[5]!, step: m[2]!, alter, midi: (+m[4]! + 1) * 12 + STEP[m[2]!]! + alter }); }
    ns.sort((a, b) => a.onset - b.onset || a.midi - b.midi); return ns;
};
const ladderNotes = (n: Note[]): TwoPassNote[] => n.map(x => ({ midi: x.midi, tOn: x.onset * TATUM, tOff: (x.onset + x.dur) * TATUM }));
function driveCore(N: TwoPassNote[]): (Pitch | null)[] {
    const s = new Speller();
    const evs: { t: number; on: boolean; i: number }[] = [];
    N.forEach((x, i) => { evs.push({ t: x.tOn, on: true, i }); evs.push({ t: x.tOff, on: false, i }); });
    evs.sort((a, b) => a.t - b.t || Number(a.on) - Number(b.on) || N[a.i]!.midi - N[b.i]!.midi);
    const out: (Pitch | null)[] = new Array(N.length).fill(null); const pend = new Map<number, number[]>();
    for (const e of evs) { const midi = N[e.i]!.midi;
        if (e.on) { s.noteOn(midi, { t: e.t }); (pend.get(midi) ?? pend.set(midi, []).get(midi)!).push(e.i); }
        else { const q = pend.get(midi); if (q?.length) { out[q.shift()!] = s.getSpelling(midi); if (q.length === 0) s.noteOff(midi); } } }
    return out;
}

const stem = variant === 'noisy' ? 'opnd-m-noisy' : 'opnd-m';
const dir = join(REPO, 'corpora', 'meredith', stem, stem);
if (!existsSync(dir)) { console.error(`corpus missing: ${dir}`); process.exit(1); }
const files = readdirSync(dir).filter(f => f.endsWith('.opnd-m')).sort();
const acc = { rt: { correct: 0, flipped: 0, wrong: 0 }, tp: { correct: 0, flipped: 0, wrong: 0 } };
for (const f of files) {
    const notes = parse(readFileSync(join(dir, f), 'utf8'));
    const ln = ladderNotes(notes);
    const expected = notes.map(n => ({ step: n.step, alter: n.alter })); const keys = notes.map(n => n.onset);
    const rt = scoreTiers(driveCore(ln), expected, keys);
    const tp = scoreTiers(spellTwoPass(ln) as (Pitch | null)[], expected, keys);
    acc.rt.correct += rt.correct; acc.rt.flipped += rt.flipped; acc.rt.wrong += rt.wrong;
    acc.tp.correct += tp.correct; acc.tp.flipped += tp.flipped; acc.tp.wrong += tp.wrong;
}
const tiers = (t: { correct: number; flipped: number; wrong: number }) => {
    const committed = t.correct + t.flipped + t.wrong; return { ...t, committed, total: committed };
};
const out = { corpus: 'meredith-8x25000', variant, rungs: { rt: tiers(acc.rt), tp: tiers(acc.tp) } };
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}: rt ${acc.rt.correct}c/${acc.rt.flipped}f/${acc.rt.wrong}w  tp ${acc.tp.correct}c/${acc.tp.flipped}f/${acc.tp.wrong}w`);
