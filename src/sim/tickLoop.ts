import { FIXED_DT } from './config';

/**
 * Fixed-timestep accumulator loop (spec §4). The sim steps deterministically;
 * render is decoupled and only reads state. A speed multiplier runs extra steps
 * per frame — handy for feeling the loop fast during prototyping, and the same
 * mechanism makes offline-progress / fast-forward trivial later.
 */
export class TickLoop {
  private accumulator = 0;
  private last = 0;
  private raf = 0;
  speed = 1;
  paused = false;

  constructor(
    private readonly step: (dt: number) => void,
    private readonly render: () => void,
  ) {}

  start(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      const realDt = Math.min((now - this.last) / 1000, 0.25); // clamp tab-away spikes
      this.last = now;
      if (!this.paused) {
        this.accumulator += realDt * this.speed;
        let steps = 0;
        while (this.accumulator >= FIXED_DT && steps < 2000) {
          this.step(FIXED_DT);
          this.accumulator -= FIXED_DT;
          steps++;
        }
      }
      this.render();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}
