import { FIXED_DT } from './config';
/**
 * Fixed-timestep accumulator loop. The sim steps deterministically; render is
 * decoupled and only reads state. A speed multiplier runs extra steps per tick.
 *
 * Driven by setInterval rather than requestAnimationFrame so the sim keeps running
 * when the tab is in the background (RAF is fully paused while hidden) — which also
 * makes the eventual offline-progress / fast-forward trivial.
 */
export class TickLoop {
    step;
    render;
    accumulator = 0;
    last = 0;
    timer;
    speed = 1;
    paused = false;
    constructor(step, render) {
        this.step = step;
        this.render = render;
    }
    start() {
        this.last = performance.now();
        this.timer = setInterval(() => {
            const now = performance.now();
            // Clamp to 1s so a throttled background tab still advances ~real-time without
            // a spiral of death after a long pause.
            const realDt = Math.min((now - this.last) / 1000, 1);
            this.last = now;
            if (!this.paused) {
                this.accumulator += realDt * this.speed;
                let steps = 0;
                while (this.accumulator >= FIXED_DT && steps < 4000) {
                    this.step(FIXED_DT);
                    this.accumulator -= FIXED_DT;
                    steps++;
                }
            }
            this.render();
        }, 33); // ~30 ticks/sec while visible
    }
    stop() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
    }
}
