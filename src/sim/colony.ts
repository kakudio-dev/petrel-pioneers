import type { Building, BuildingType, BuildState, Directives, Flows, StaffStatus } from './types';
import * as C from './config';

let nextId = 1;
const genId = () => nextId++;

/**
 * A self-contained colony sim object. Owns its slots, stocks, buildings, and
 * directives — no global state. The tick loop just calls step(dt) on "a colony".
 *
 * The building list order IS the priority order: both power and crew are allocated
 * top-to-bottom. Power flows down the list — each consumer is fully powered until
 * production + battery runs out; the building at the cutoff gets partial; the rest
 * go dark. Crew is staffed the same way. The player sorts buildings to choose who
 * keeps power and workers. The command module is pinned at the top.
 *
 * Three buffered grids drive the loop: an energy grid (battery buffer, priority
 * brownout), a food larder (famine — the first failure point), and an iron
 * stockpile spent on construction over time.
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
    footing: 'balanced',
  };

  flows: Flows = emptyFlows();
  elapsed = 0;
  failed = false;

  constructor() {
    this.buildings.push(makeBuilding('command', 'active'));
  }

  // --- Derived getters ---
  get slotsUsed(): number {
    return this.buildings.filter((b) => b.type !== 'command').length;
  }
  get freeSlots(): number {
    return this.slotCap - this.slotsUsed;
  }
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

  // --- Player actions ---
  build(type: BuildingType): boolean {
    if (type === 'command') return false;
    if (this.freeSlots <= 0) return false;
    this.buildings.push(makeBuilding(type, 'building'));
    return true;
  }

  demolish(id: number): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b || b.type === 'command' || b.state !== 'active') return;
    b.state = 'demolishing';
    b.progress = 0;
    b.staffing = 0;
    b.powerLevel = 0;
  }

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

  /** Raise a building's priority (earlier in the list = power & crew first). */
  moveUp(id: number): void {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i <= 1) return; // index 0 is the pinned command module
    [this.buildings[i - 1], this.buildings[i]] = [this.buildings[i], this.buildings[i - 1]];
  }
  /** Lower a building's priority. */
  moveDown(id: number): void {
    const i = this.buildings.findIndex((b) => b.id === id);
    if (i < 1 || i >= this.buildings.length - 1) return;
    [this.buildings[i + 1], this.buildings[i]] = [this.buildings[i], this.buildings[i + 1]];
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
    if (this.failed) return;
    this.elapsed += dt;

    this.processProjects(dt);

    const f = emptyFlows();
    const energyBefore = this.E;
    const foodBefore = this.food;

    const active = this.buildings.filter((b) => b.state === 'active');

    // 1. Staffing (priority order = list order): crew fills buildings top-to-bottom.
    this.assignStaffing(active);

    // 2. Power grid. Production from staffed producers; consumers draw draw×staffing.
    let production = 0;
    for (const b of active) production += C.ENERGY_PRODUCTION[b.type] * b.staffing;
    // A built consumer draws its FULL power as long as it's standing — whether or
    // not it's staffed or producing. Idle buildings are an ongoing burden.
    const consumers = active.filter((b) => C.ENERGY_DRAW[b.type] > 0);
    let demand = 0;
    for (const b of consumers) demand += C.ENERGY_DRAW[b.type];

    // 3. Fund consumers in priority order — generation first, then the battery —
    //    recording each building's split so the UI can show generated vs stored.
    const cap = this.energyCap;
    let gen = production; // generation budget (rate)
    const batAvail = this.E / dt; // most the battery can supply this tick (rate)
    let bat = batAvail;
    for (const b of consumers) {
      const need = C.ENERGY_DRAW[b.type];
      const fromGen = Math.min(need, gen);
      gen -= fromGen;
      const fromBat = Math.min(need - fromGen, bat);
      bat -= fromBat;
      b.genPower = fromGen;
      b.batPower = fromBat;
      b.powerLevel = (fromGen + fromBat) / need;
    }
    // Leftover generation charges the battery; whatever it supplied drains it.
    const batUsed = batAvail - bat;
    let storageWasted = false;
    let newE = this.E + (gen - batUsed) * dt;
    if (newE > cap) {
      storageWasted = gen > 0;
      newE = cap;
    }
    if (newE < 0) newE = 0;
    this.E = newE;
    for (const b of active) {
      if (C.ENERGY_DRAW[b.type] === 0) {
        b.powerLevel = 1;
        b.genPower = 0;
        b.batPower = 0;
      }
    }

    // 4. Food larder: greenhouses grow it (per-building power & staffing); crew eat it.
    let foodProduction = 0;
    for (const b of active) {
      const base = C.FOOD_PRODUCTION[b.type];
      if (base === 0) continue;
      foodProduction += base * b.staffing * b.powerLevel;
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

    // 5. Crew grows toward housing capacity (each habitat throttled by its own power).
    let housingCap = 0;
    for (const b of active) {
      housingCap += b.type === 'habitat' ? b.capacity * b.powerLevel : b.capacity;
    }
    const growthRate = C.GROWTH_RATE[this.directives.footing];
    const crewGrowth = housingCap > 0 ? growthRate * this.crew * (1 - this.crew / housingCap) : 0;

    // 6. Starvation: an empty larder that can't feed everyone kills the unfed crew.
    const starveLoss = starving ? this.crew * (1 - foodRatio) * C.STARVE_RATE : 0;
    this.crew += (crewGrowth - starveLoss) * dt;
    if (this.crew < 0) this.crew = 0;
    if (this.crew < 1) {
      this.crew = 0;
      this.failed = true;
    }

    // 7. Iron from extractors (staffing × its power), capped by the stockpile.
    let ironProduced = 0;
    for (const b of active) {
      if (b.type === 'extractor') ironProduced += C.EXTRACTOR_OUTPUT * b.staffing * b.powerLevel;
    }
    this.iron += ironProduced * dt;
    let ironWasted = false;
    const ironCap = this.ironCap;
    if (this.iron > ironCap) {
      this.iron = ironCap;
      ironWasted = ironProduced > 0;
    }

    // Flows for the UI. Every standing consumer draws full power, so all of them
    // count toward the grid load.
    const poweredCount = consumers.filter((b) => b.powerLevel >= 0.999).length;
    f.energyProduction = production;
    f.energyConsumption = demand;
    f.energyNet = (this.E - energyBefore) / dt;
    f.poweredCount = poweredCount;
    f.consumerCount = consumers.length;
    f.storageWasted = storageWasted;
    f.brownout = poweredCount < consumers.length;
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
    this.flows = f;
  }

  private processProjects(dt: number): void {
    let iron = this.iron;
    const finishedDemolish: number[] = [];
    for (const b of this.buildings) {
      if (b.state === 'building') {
        const cost = C.BUILD_COST[b.type];
        const time = C.BUILD_TIME[b.type];
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

  /** Staff buildings in list (priority) order, filling each to CREW_REQ. */
  private assignStaffing(active: Building[]): void {
    for (const b of this.buildings) {
      if (b.state !== 'active') {
        b.staffing = 0;
        b.powerLevel = 0;
        b.genPower = 0;
        b.batPower = 0;
      }
    }
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
    powerLevel: 0,
    genPower: 0,
    batPower: 0,
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
    poweredCount: 0,
    consumerCount: 0,
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
