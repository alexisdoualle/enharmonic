/**
 * Metronome for live takes. Clicks are scheduled ahead on the audio clock (immune to main-thread jank)
 * and placed so they REACH THE SPEAKERS on the beat: a player keys in time with what they hear, and key
 * events carry the performance clock, so the click is compensated for output latency.
 */
import { playClick, ctxTimeAt, audioNow } from './audio.js';

/** A take's rhythmic grid: `t0` is bar 1 beat 1 on the take's clock (ms); `t1` is where recording ended
 *  (a bar line), absent while recording. */
export interface Grid { bpm: number; num: number; den: number; t0: number; t1?: number; }

/** Clicks of countdown before bar 1, whatever the meter. */
export const COUNT_IN = 4;

/** Clicks per bar: compound meters (6/8, 9/8, 12/8) click the dotted quarter. */
export const clicksPerBar = (g: Pick<Grid, 'num' | 'den'>) => g.den === 8 && g.num % 3 === 0 ? g.num / 3 : g.num;
/** ms per click; `bpm` counts clicks. */
export const clickMs = (g: Pick<Grid, 'bpm'>) => 60000 / g.bpm;
export const barMs = (g: Grid) => clicksPerBar(g) * clickMs(g);

const LOOKAHEAD_MS = 150, TICK_MS = 25;

export class Metronome {
    private timer = 0;
    private next = 0;          // index of the next click to schedule (0 = first count-in click)
    private perf0 = 0;         // performance-clock time of click 0
    private ms = 500;
    private limit = Infinity;  // first click index NOT to play (set by stopAt)
    running = false;

    /** Start clicking at `perf0` (performance clock). Clicks 0..COUNT_IN-1 are the countdown; bar 1 starts
     *  at click COUNT_IN. `onClick(k)` fires on the main thread at each click, for the visual pulse. */
    start(bpm: number, perBar: number, perf0: number, onClick: (k: number) => void): void {
        this.stop();
        this.running = true;
        this.perf0 = perf0;
        this.next = 0;
        this.limit = Infinity;
        const ms = this.ms = 60000 / bpm;
        const tick = () => {
            const horizon = performance.now() + LOOKAHEAD_MS;
            while (this.next < this.limit && this.perf0 + this.next * ms < horizon) {
                const k = this.next++, at = this.perf0 + k * ms;
                const when = ctxTimeAt(at);
                const accent = k < COUNT_IN ? k === 0 : (k - COUNT_IN) % perBar === 0;
                if (when >= audioNow()) playClick(when, accent);
                setTimeout(() => { if (this.running) onClick(k); }, Math.max(0, at - performance.now()));
            }
        };
        tick();
        this.timer = window.setInterval(tick, TICK_MS);
    }

    /** The click index sounding at performance time `perf` (fractional). */
    clickAt(perf: number): number { return (perf - this.perf0) / this.ms; }
    /** Performance time of click `k`. */
    perfOf(k: number): number { return this.perf0 + k * this.ms; }
    /** Play no click from index `k` on (already scheduled ones still sound). */
    stopAt(k: number): void { this.limit = k; }

    stop(): void {
        clearInterval(this.timer);
        this.running = false;
    }
}
