/**
 * The recent-notes buffer of the copied context report: the last N notes played up to and including
 * the current one, oldest first, in input (bass-first) order. Pure, so it is testable without a DOM.
 */
import type { Replay, ReplayNote } from './replay.js';
import { ascii } from './format.js';

export const RECENT_NOTES = 8;

/** Where in the score an onset sits, when the fixture's ground truth says. */
export function place(n: ReplayNote | undefined): string {
    const e = n?.expected;
    return e?.measure != null ? `m${e.measure}${e.beat != null ? ` b${e.beat}` : ''}` : '';
}

const sp = (p: { step: string; alter: number; octave?: number } | null | undefined): string =>
    p ? ascii(p as never) + (p.octave ?? '') : '—';

export function recentNotesLines(replay: Replay, step: number, n = RECENT_NOTES): string[] {
    const from = Math.max(0, step - n + 1);
    const rows = replay.notes.slice(from, step + 1).map((x, k) => {
        const i = from + k;
        return {
            mark: i === step ? '▶' : ' ',
            step: String(i + 1),
            where: place(x),
            midi: String(x.midi),
            dur: String(Math.round(x.offT - x.onT)),
            // when this note ends relative to the current note's onset: + = still sounding then
            ends: (() => { const d = Math.round(x.offT - (replay.notes[step]?.onT ?? x.onT)); return d > 0 ? `+${d}` : String(d); })(),
            pc: String(((x.midi % 12) + 12) % 12),
            got: sp(x.committed),
            exp: sp(x.expected),
            tier: x.expected ? x.tier : 'not graded',
        };
    });
    const w = (f: (r: (typeof rows)[number]) => string, h: string) => Math.max(h.length, ...rows.map(r => f(r).length));
    const ws = w(r => r.step, 'step'), ww = w(r => r.where, 'm.beat'), wm = w(r => r.midi, 'midi'),
        wp = w(r => r.pc, 'pc'), wd = w(r => r.dur, 'dur ms'), wn = w(r => r.ends, 'ends'), wg = w(r => r.got, 'committed'), we = w(r => r.exp, 'expected');
    const line = (m: string, a: string, b: string, c: string, d: string, h: string, k: string, e: string, f: string, g: string) =>
        `${m} ${a.padStart(ws)}  ${b.padEnd(ww)}  ${c.padStart(wm)}  ${d.padStart(wp)}  ${h.padStart(wd)}  ${k.padStart(wn)}  ${e.padEnd(wg)}  ${f.padEnd(we)}  ${g}`;
    return [
        `## recent notes (last ${n}, oldest first)`,
        line(' ', 'step', 'm.beat', 'midi', 'pc', 'dur ms', 'ends', 'committed', 'expected', 'tier'),
        ...rows.map(r => line(r.mark, r.step, r.where, r.midi, r.pc, r.dur, r.ends, r.got, r.exp, r.tier)),
        '',
    ];
}
