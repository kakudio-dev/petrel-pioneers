# 🐦 Petrel Pioneers — v0.2 core loop prototype

Proving that **"automatic with direction"** generates continuous engagement through
shifting bottlenecks *within a fixed space constraint* — before any threat, failure,
or multi-colony layer. See the spec for the full design intent.

## Run it

```
npm install
npm run dev      # http://localhost:5173
```

> Node note: this machine's default `node` (`/usr/local/bin/node`) is v16, which
> Vite can't run. The preview launcher in `../.claude/launch.json` pins the nvm
> Node 25 binary explicitly. For plain `npm run dev`, make sure your shell uses
> Node 20.19+ / 22.12+ (nvm default here is 25).

## What's here

1. **Sim core** (`src/sim/`) — a self-contained `Colony` object (no globals), an
   automatic power grid, and a fixed-timestep loop (`tickLoop.ts`). The Tier-2
   portfolio drops in later without a rewrite.
2. **Stocks panel** — energy battery gauge, iron, crew, and slots. The energy
   net-flow (charge/discharge rate) is the "bottleneck coming" signal.
3. **Buildings panel** — timed construction / deconstruction within slots, the
   power/worker priority order (reorder ▲▼), per-building power & worker meters, a
   power-budget bar, plus Tier-1 **Expand**.
4. **Directives** — Growth Footing.

### Construction & deconstruction

Buildings aren't instant. Each has a **build time** (the floor) and is funded with
iron **over time** — progress = iron invested / cost, gated by both the timer and
iron availability, shown as a progress bar. The slot is reserved the moment you
start. Construction can be **cancelled** for a 50% refund of the iron spent so far.

**Demolition** takes the same duration as construction. The building goes **inert
immediately** (stops drawing power, releases its crew, stops producing/housing) but
**keeps its slot** until deconstruction finishes — on completion it refunds 50% of
the build cost and frees the slot. Demolition can be **cancelled for free** anytime
before it completes, reverting the building to fully active.

All tuning constants live in `src/sim/config.ts`. They are first-guess numbers to
feel out, not balance.

### Resources

Three buffered grids, all driven by the same producer / consumer / stored-buffer
pattern, plus crew:

- **Energy** — an automatic grid. Producers (**Command Module** +15, **Generators**
  +10) feed it; consumers (**Extractors** −4, **Habitats** −2, **Greenhouses** −5)
  draw from it. The **battery** (Command Module 300 + 40/generator) buffers the
  difference. Empty battery + demand > generation ⇒ brownout: power is allocated
  **by priority** down the building list — top consumers stay fully lit, the building
  at the cutoff gets partial power, and the rest go dark. Reorder to choose.
- **Food** — only **Greenhouses** grow it (+6, powered & staffed). The **Command
  Module grows none** — it just ships with a full 200 **larder** (+30/greenhouse).
  Crew eat `0.3/s` each, so the larder drains from the first second. Empty larder +
  too little food ⇒ **famine: crew starve and die**. With no food production at all,
  the colony empties out — the **first failure point** (see below).
- **Iron** (`Fe`) — **Extractors** produce it; spent only on construction/expansion.
  Bounded by a **stockpile** (Command Module 400 + 60/extractor); when full, extractor
  output is wasted — a nudge to spend it.
- **Crew** — grows toward capacity (each habitat throttled by its own power, total
  capped by food) and staffs generators, extractors, and greenhouses **by the same
  priority order** — short crew leaves the lowest buildings unstaffed first.

The **Command Module** is the undemolishable anchor: base generation, battery,
larder, iron stockpile, and crew housing (cap 6). It never consumes a player slot.
The colony **starts as a bare command module with 6 crew** — no generator or
extractor — so the opening is a scramble to bootstrap.

### First failure point — starvation

Starting crew (6) equals the command module's housing cap, so it doesn't grow
without habitats — the 200-food larder drains at a steady `6 × 0.3 = 1.8/s` and
empties at ~111s. Then crew starve and die; if the colony never gets a greenhouse
running it **fails out at ~140s** — a **COLONY LOST** overlay with a Restart. The fix
is one greenhouse, which feeds the colony up to ~20 crew. The food net-flow shows red
from the first second, so the warning is always on screen — losing means ignoring it.

### The dependency cycle

Grow crew (build **habitats**) → need food (build **greenhouses**) → greenhouses
draw power (build **generators**) → slots tighten. Push any resource and a different
one becomes the binding constraint — within a fixed slot count, so every fix is a
trade-off against another use of the space.

## Validation status

The core loop is confirmed working via offline simulation + live UI:

- **Honeymoon → warning → brownout:** with a sensible buildout, generation covers
  demand and the battery stays full; over-build consumers and the battery *drains
  visibly* (the warning) before it empties and the lowest-priority buildings go dark.
- **The collision:** the deficit lands as slots fill (8/8), producing the target
  feeling: *"I'm out of power AND out of slots — what do I sacrifice?"*
- **Re-steer resolves it:** demolishing extractors for generators (or switching to
  Conservation to hold growth) restores full power and refills the battery — and
  creates the next, tighter bottleneck. **Expand** (escalating iron cost) is the
  release valve to a larger slot cap.

### Design notes (changed from the first-guess spec)

- **No energy-allocation slider** (spec's Directive 1). Energy is an automatic power
  grid; the player's energy lever is the generator-vs-consumer build mix and the
  priority order.
- **Power & workers are priority-ordered, not an even draw.** The building list order
  is the priority; both power and crew fill top-to-bottom, so the player sorts (▲▼)
  to choose who keeps running. Replaced the earlier proportional throttle.
- **Per-building fixed power draw** replaces continuous per-crew life support: more
  habitats (to grow crew) means more draw, so the brownout pressure scales with what
  you build.
- **Brownout is non-lethal** (buildings go dark, crew capacity dips) — only the
  Command Module's base generation keeps a floor. Starvation, by contrast, kills.
- **Starvation is lethal** — unlike the brownout, an unfed colony actually dies. This
  is the first real lose condition (see *First failure point* above).
- `CREW_REQ` is 3/building; starting crew is 6 (bare command module).

## Deliberately omitted (per spec)

Pressure/threat waves, the conquest unlock challenge, Tier-2 multi-colony portfolio,
geometric tiles, art. The naked loop comes first. (Failure states are no longer fully
omitted — starvation is the first one.)
