import type { Building, BuildingType, BuildState, Directives, Flows, StaffStatus } from './types';
import * as C from './config';

let nextId = 1;
const genId = () => nextId++;

/**
 * A self-contained colony sim object. Owns its slots, stocks, buildings, and
 * directives — no global state. The tick loop just calls step(dt) on "a colony";
 * v0.2 instantiates one, but the multi-colony portfolio (Tier 2) drops in cheaply.
 *
 * Buildings have a lifecycle: 'building' (under construction, drawing iron over
 * time), 'active' (operational), 'demolishing' (inert but still holding its slot
 * while deconstruction runs). Only 'active' buildings produce, consume, house
 * crew, or provide storage.
 *
 * Three buffered grids drive the loop: an energy power grid (battery buffer,
 * brownout throttle), a food larder (famine — the first failure point), and an
 * iron stockpile spent on construction over time.
 */
export class Colony {
  // --- Stocks ---
  E = C.START_E; // energy in the battery
  iron = C.START_IRON;
  food = C.START_FOOD;
  crew = C.START_CREW;

  // --- Space ---
  slotCap = C.SLOT_CAP_START;
  expandCount = 0;

  buildings: Building[] = [];

  directives: Directives = {
    crewPriority: ['generator', 'greenhouse', 'extractor'],
    footing: 'balanced',
  };

  flows: Flows = emptyFlows();
  elapsed = 0; // sim seconds, for the clock
  failed = false; // the colony has starved out (first failure point)

  constructor() {
    // The colony starts as a bare, already-built command module: power, battery, a
    // full larder, and housing — but no food production.
    this.buildings.push(makeBuilding('command', 'active'));
  }

  // --- Derived getters ---
  // Every non-command building holds a slot in every state, including while it is
  // being constructed or torn down (the slot frees only when deconstruction ends).
  get slotsUsed(): number {
    return this.buildings.filter((b) => b.type !== 'command').length;
  }
  get freeSlots(): number {
    return this.slotCap - this.slotsUsed;
  }
  // Storage and capacity come only from ACTIVE buildings.
  get energyCap(): number {
    return this.activeSum(C.ENERGY_STORAGE);
  }
  get ironCap(): number {
    return this.activeSum(C.IRON_STORAGE);
  }
  get foodCap(): number {
    return this.activeSum(C.FOOD_STORAGE);
  }
  get crewCapacity(): number {
    return this.buildings.reduce((s, b) => (b.state === 'active' ? s + b.capacity : s), 0);
  }
  get expandCost(): number {
    return Math.round(C.EXPAND_BASE_COST * C.EXPAND_COST_GROWTH ** this.expandCount);
  }

  private activeSum(map: Record<BuildingType, number>): number {
    return this.buildings.reduce((s, b) => (b.state === 'active' ? s + map[b.type] : s), 0);
  }

  // --- Player actions (Directive 4 + Tier 1 expand) ---
  /** Start a construction project — reserves the slot, then funds over time. */
  build(type: BuildingType): boolean {
    if (type === 'command') return false; // never buildable
    if (this.freeSlots <= 0) return false;
    this.buildings.push(makeBuilding(type, 'building'));
    return true;
  }

  /** Begin tearing down an active building. It goes inert immediately (crew and
   *  power freed) but keeps its slot until deconstruction completes. */
  demolish(id: number): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b || b.type === 'command' || b.state !== 'active') return;
    b.state = 'demolishing';
    b.progress = 0;
    b.staffing = 0;
  }

  /** Cancel a construction (50% iron refund, slot freed) or a deconstruction
   *  (free — the building reverts to fully active). */
  cancel(id: number): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b || b.type === 'command') return;
    if (b.state === 'building') {
      this.iron += C.REFUND_FRACTION * b.invested;
      this.buildings = this.buildings.filter((x) => x.id !== id);
    } else if (b.state === 'demolishing') {
      b.state = 'active';
      b.progress = 1;
    }
  }

  expand(): boolean {
    if (this.iron < this.expandCost) return false;
    this.iron -= this.expandCost;
    this.slotCap += C.EXPAND_SLOTS;
    this.expandCount++;
    return true;
  }

  // --- The tick ---
  step(dt: number): void {
    if (this.failed) return; // colony lost — sim is frozen until restart
    this.elapsed += dt;

    // 0. Advance construction & deconstruction projects (spends/refunds iron).
    this.processProjects(dt);

    const f = emptyFlows();
    const energyBefore = this.E;
    const foodBefore = this.food;

    // 1. Staffing (Directive 2): crew limits how hard active staffed buildings run.
    this.assignStaffing();

    // 2. Power grid: production vs consumption (active buildings, scaled by staffing).
    let production = 0;
    let consumption = 0;
    for (const b of this.buildings) {
      if (b.state !== 'active') continue;
      production += C.ENERGY_PRODUCTION[b.type] * b.staffing;
      consumption += C.ENERGY_DRAW[b.type] * b.staffing;
    }
    const cap = this.energyCap;
    const tentativeE = this.E + (production - consumption) * dt;
    let powerRatio = 1;
    let storageWasted = false;
    if (tentativeE >= 0) {
      if (tentativeE > cap) {
        this.E = cap;
        storageWasted = production > consumption;
      } else {
        this.E = tentativeE;
      }
    } else {
      powerRatio = consumption > 0 ? clamp(production / consumption, 0, 1) : 1;
      this.E = 0;
    }

    // 3. Food larder: greenhouses grow it (powered & staffed); crew eat it.
    let foodProduction = 0;
    for (const b of this.buildings) {
      if (b.state !== 'active') continue;
      const base = C.FOOD_PRODUCTION[b.type];
      if (base === 0) continue;
      foodProduction += base * b.staffing * powerRatio;
    }
    const foodConsumption = this.crew * C.FOOD_PER_CREW;
    const foodCap = this.foodCap;
    const tentativeF = this.food + (foodProduction - foodConsumption) * dt;
    let foodRatio = 1;
    let starving = false;
    if (tentativeF >= 0) {
      this.food = Math.min(foodCap, tentativeF);
    } else {
      starving = true;
      foodRatio = foodConsumption > 0 ? clamp(foodProduction / foodConsumption, 0, 1) : 1;
      this.food = 0;
    }

    // 4. Crew grows toward housing capacity (power-throttled habitats + command).
    let housingCap = 0;
    for (const b of this.buildings) {
      if (b.state !== 'active') continue;
      housingCap += b.type === 'habitat' ? b.capacity * powerRatio : b.capacity;
    }
    const growthRate = C.GROWTH_RATE[this.directives.footing];
    const crewGrowth =
      housingCap > 0 ? growthRate * this.crew * (1 - this.crew / housingCap) : 0;

    // 5. Starvation: an empty larder that can't feed everyone kills the unfed crew.
    const starveLoss = starving ? this.crew * (1 - foodRatio) * C.STARVE_RATE : 0;
    this.crew += (crewGrowth - starveLoss) * dt;
    if (this.crew < 0) this.crew = 0;
    if (this.crew < 1) {
      this.crew = 0;
      this.failed = true;
    }

    // 6. Iron from extractors (staffing × power), capped by the stockpile.
    let ironProduced = 0;
    for (const b of this.buildings) {
      if (b.state !== 'active') continue;
      if (b.type === 'extractor') ironProduced += C.EXTRACTOR_OUTPUT * b.staffing * powerRatio;
    }
    this.iron += ironProduced * dt;
    let ironWasted = false;
    const ironCap = this.ironCap;
    if (this.iron > ironCap) {
      this.iron = ironCap;
      ironWasted = ironProduced > 0;
    }

    // Record flows for the UI.
    f.energyProduction = production;
    f.energyConsumption = consumption;
    f.energyNet = (this.E - energyBefore) / dt;
    f.powerRatio = powerRatio;
    f.storageWasted = storageWasted;
    f.ironProduced = ironProduced;
    f.ironNet = ironWasted ? 0 : ironProduced;
    f.ironWasted = ironWasted;
    f.foodProduction = foodProduction;
    f.foodConsumption = foodConsumption;
    f.foodNet = (this.food - foodBefore) / dt;
    f.foodRatio = foodRatio;
    f.starving = starving;
    f.crewCap = housingCap;
    f.crewNet = crewGrowth - starveLoss;
    f.brownout = powerRatio < 0.999;
    this.flows = f;
  }

  /** Fund construction over time (iron-gated) and run deconstruction timers. */
  private processProjects(dt: number): void {
    let iron = this.iron;
    const finishedDemolish: number[] = [];
    for (const b of this.buildings) {
      if (b.state === 'building') {
        const cost = C.BUILD_COST[b.type];
        const time = C.BUILD_TIME[b.type];
        // Most we may invest this tick: enough to advance one time-step of progress.
        const want = time > 0 ? cost * (dt / time) : cost;
        const spend = Math.min(want, iron, cost - b.invested);
        iron -= spend;
        b.invested += spend;
        b.progress = cost > 0 ? b.invested / cost : 1;
        if (b.invested >= cost - 1e-6) {
          b.state = 'active';
          b.progress = 1;
        }
      } else if (b.state === 'demolishing') {
        const time = C.BUILD_TIME[b.type];
        b.progress += time > 0 ? dt / time : 1;
        if (b.progress >= 1) {
          iron += C.REFUND_FRACTION * C.BUILD_COST[b.type];
          finishedDemolish.push(b.id);
        }
      }
    }
    this.iron = iron;
    if (finishedDemolish.length) {
      this.buildings = this.buildings.filter((b) => !finishedDemolish.includes(b.id));
    }
  }

  /** Distribute crew across ACTIVE buildings in priority order, filling each to CREW_REQ. */
  private assignStaffing(): void {
    const order = this.directives.crewPriority;
    const active = this.buildings.filter((b) => b.state === 'active');
    for (const b of this.buildings) {
      if (b.state !== 'active') b.staffing = 0;
    }
    // Structural buildings (req 0) sort first via indexOf -1; they consume no crew.
    active.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    let remaining = this.crew;
    for (const b of active) {
      const req = C.CREW_REQ[b.type];
      if (req <= 0) {
        b.staffing = 1; // structural building, no crew needed
        continue;
      }
      const assigned = Math.min(req, Math.max(0, remaining));
      b.staffing = assigned / req;
      remaining -= assigned;
    }
  }

  staffStatus(b: Building): StaffStatus {
    if (C.CREW_REQ[b.type] <= 0) return 'online';
    if (b.staffing >= 0.999) return 'staffed';
    if (b.staffing <= 0.001) return 'starved';
    return 'understaffed';
  }
}

function makeBuilding(type: BuildingType, state: BuildState): Building {
  let capacity = 0;
  if (type === 'command') capacity = C.COMMAND_CAPACITY;
  else if (type === 'habitat') capacity = C.HABITAT_CAPACITY;
  return {
    id: genId(),
    type,
    capacity,
    staffing: 0,
    state,
    invested: state === 'active' ? C.BUILD_COST[type] : 0,
    progress: state === 'active' ? 1 : 0,
  };
}

function emptyFlows(): Flows {
  return {
    energyProduction: 0,
    energyConsumption: 0,
    energyNet: 0,
    powerRatio: 1,
    storageWasted: false,
    ironProduced: 0,
    ironNet: 0,
    ironWasted: false,
    foodProduction: 0,
    foodConsumption: 0,
    foodNet: 0,
    foodRatio: 1,
    starving: false,
    crewCap: 0,
    crewNet: 0,
    brownout: false,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
