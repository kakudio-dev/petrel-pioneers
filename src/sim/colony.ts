import type {
  Building,
  BuildingType,
  BuildState,
  CrewMember,
  CrewTask,
  Flows,
  StaffStatus,
  Zone,
} from './types';
import * as C from './config';
import { mulberry32, type Rng } from './rng';

export type MissionType = 'explore' | 'gatherFood' | 'gatherResources';

/** A running expedition: a fixed team of crew sent to a zone (explore has none). */
export interface Mission {
  id: number;
  type: MissionType;
  zoneId: number | null;
  crewIds: number[];
  elapsed: number;
  duration: number;
}

/** A finished expedition, kept for the recent-missions log (and for re-running). */
export interface CompletedMission {
  id: number;
  type: MissionType;
  zoneId: number | null; // the original target zone (null for explore) — used to re-run
  zoneName: string; // target zone, or the newly discovered zone for explore
  crew: number;
  amount: number; // food/ore delivered (0 for explore)
}

let nextId = 1;
const genId = () => nextId++;
const stat = (rng: Rng) => 3 + Math.floor(rng() * 7); // placeholder 3..9
const rollRange = ([lo, hi]: readonly [number, number], rng: Rng) => lo + rng() * (hi - lo);

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

  // --- Crew (a roster of named individuals, not a number) ---
  crew: CrewMember[] = [];

  // --- Missions & discovered zones ---
  zones: Zone[] = [];
  activeMissions: Mission[] = [];
  completedMissions: CompletedMission[] = []; // newest first, capped at C.RECENT_MISSIONS

  // --- Space ---
  slotCap = C.SLOT_CAP_START;
  expandCount = 0;

  buildings: Building[] = [];

  flows: Flows = emptyFlows();
  elapsed = 0;
  failed = false;
  private seasonIndex = 0; // current season (0 = Thaw at t=0); used to fire season-change events
  private rng: Rng;

  constructor(seed?: number) {
    this.rng = seed === undefined ? Math.random : mulberry32(seed);
    this.buildings.push(makeBuilding('command', 'active'));
    for (let i = 0; i < C.START_CREW; i++) this.crew.push(makeCrew(i, this.rng));
    this.zones.push(makeZone(C.HOME_ZONE_NAME, C.HOME_ZONE_KIND, true, this.rng));
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
    // the larder comes from the command module (+ any greenhouse storage); it does not
    // scale with crew count
    return this.activeSum(C.FOOD_STORAGE);
  }
  get crewCapacity(): number {
    return this.buildings.reduce((s, b) => (b.state === 'active' ? s + b.capacity : s), 0);
  }
  get crewCount(): number {
    return this.crew.length;
  }
  /** Crew staffing buildings: task 'building' and not away on a mission. */
  get buildingCrew(): number {
    return this.crew.filter((c) => c.task === 'building' && !this.onMission(c.id)).length;
  }
  onMission(crewId: number): boolean {
    return this.activeMissions.some((m) => m.crewIds.includes(crewId));
  }
  /** Crew at base, free to be sent on a mission. */
  get availableCrew(): CrewMember[] {
    return this.crew.filter((c) => !this.onMission(c.id));
  }
  setTask(id: number, task: CrewTask): void {
    const c = this.crew.find((x) => x.id === id);
    if (c) c.task = task;
  }

  // --- Calendar (seasons cycle; year counts up) ---
  /** Current season index (0 = Thaw at t=0), cycling through SEASONS. */
  get season(): number {
    return Math.floor(this.elapsed / C.SEASON_LENGTH) % C.SEASONS.length;
  }
  /** Name of the current season. */
  get seasonName(): string {
    return C.SEASONS[this.season];
  }
  /** Fraction (0..1) through the current season. */
  get seasonProgress(): number {
    return (this.elapsed % C.SEASON_LENGTH) / C.SEASON_LENGTH;
  }
  /** Current year (1-based: starts at Y1). */
  get year(): number {
    return Math.floor(this.elapsed / (C.SEASON_LENGTH * C.SEASONS.length)) + 1;
  }

  // --- Zone geology ---
  /** The home zone (where the command hub and all buildings sit). */
  get homeZone(): Zone | undefined {
    return this.zones.find((z) => z.home);
  }
  /** Home-zone fertility scales greenhouse food output (buildings sit in the home zone). */
  get fertilityFactor(): number {
    return this.homeZone?.fertility ?? 1;
  }
  /** Home-zone ore richness scales extractor (mine) output. */
  get oreFactor(): number {
    return this.homeZone?.oreRichness ?? 1;
  }

  // --- Missions ---
  /** Discovered (non-home) zones. */
  get discoveredCount(): number {
    return this.zones.filter((z) => !z.home).length;
  }
  get zonesRemaining(): boolean {
    return this.discoveredCount < C.ZONE_NAMES.length;
  }
  missionDuration(type: MissionType): number {
    return type === 'explore' ? C.EXPLORE_DURATION : C.GATHER_DURATION;
  }
  /** Total abundance each crew finds on a run: CREW_FIND_RATE of the zone's current
   *  abundance, per crew. This same amount is what's subtracted from the abundance. */
  private foundBy(crew: number, abundance: number): number {
    return crew * C.CREW_FIND_RATE * abundance;
  }
  /** Food carried home from a given food-abundance level (capped at CREW_CARRY_FOOD/crew). */
  private carriedFood(crew: number, foodAbundance: number): number {
    return Math.round(crew * Math.min(C.CREW_FIND_RATE * foodAbundance, C.CREW_CARRY_FOOD));
  }
  /** Resources actually carried home by a gather run, from the zone's CURRENT abundance —
   *  used when the run resolves. Food is capped at CREW_CARRY_FOOD/crew; ore has no cap. */
  missionYield(type: MissionType, zoneId: number | null, crew: number): number {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone || type === 'explore' || crew <= 0) return 0;
    if (type === 'gatherFood') return this.carriedFood(crew, zone.foodAbundance);
    return Math.round(this.foundBy(crew, zone.resourceAbundance));
  }
  /** Forecast of a run's yield. Unlike missionYield this projects food abundance forward
   *  to when the run RETURNS — applying any season change(s) it will cross — so the
   *  predicted food matches what actually comes back. `lookahead` is the time until return
   *  (full duration for a pre-launch preview; remaining time for an in-flight mission).
   *  Ore ignores seasons. */
  missionForecast(type: MissionType, zoneId: number | null, crew: number, lookahead = C.GATHER_DURATION): number {
    const zone = this.zones.find((z) => z.id === zoneId);
    if (!zone || type === 'explore' || crew <= 0) return 0;
    if (type === 'gatherFood') return this.carriedFood(crew, this.projectedFoodAbundance(zone, lookahead));
    return Math.round(this.foundBy(crew, zone.resourceAbundance));
  }
  /** A zone's food abundance projected `lookahead` seconds ahead, applying each season
   *  change crossed in that window. */
  private projectedFoodAbundance(zone: Zone, lookahead: number): number {
    const fromSeason = Math.floor(this.elapsed / C.SEASON_LENGTH);
    const toSeason = Math.floor((this.elapsed + lookahead) / C.SEASON_LENGTH);
    let food = zone.foodAbundance;
    const fertScore = zone.fertility * C.MAX_ABUNDANCE;
    for (let s = fromSeason + 1; s <= toSeason; s++) {
      const idx = s % C.SEASONS.length;
      food = Math.round((food + C.SEASON_FOOD_GROWTH[idx] * fertScore) * (1 - C.SEASON_FOOD_DECAY[idx]));
    }
    return food;
  }
  /** Launch a mission with a fixed team (crew ids) targeting an optional zone. */
  launchMission(type: MissionType, zoneId: number | null, crewIds: number[]): boolean {
    if (crewIds.length === 0) return false;
    this.activeMissions.push({
      id: genId(),
      type,
      zoneId,
      crewIds: [...crewIds],
      elapsed: 0,
      duration: this.missionDuration(type),
    });
    return true;
  }
  /** Recall an active mission early — its crew return, no reward. */
  recallMission(id: number): void {
    this.activeMissions = this.activeMissions.filter((m) => m.id !== id);
  }

  private discoverZone(): string | undefined {
    if (!this.zonesRemaining) return undefined;
    const name = C.ZONE_NAMES[this.discoveredCount];
    const kind = C.ZONE_KINDS[Math.floor(this.rng() * C.ZONE_KINDS.length)];
    this.zones.push(makeZone(name, kind, false, this.rng));
    return name;
  }

  /** Applied once each time the colony enters a new season: every zone's food abundance
   *  grows by a fraction of its fertility score (spring/summer) or decays by a fraction of
   *  its current level (autumn/winter). No upper cap — Wane/Dark decay settles it into a
   *  steady seasonal swing. Ore abundance is untouched — it only moves on gather runs. */
  private applySeasonChange(idx: number): void {
    const growth = C.SEASON_FOOD_GROWTH[idx]; // fraction of the fertility score added
    const decay = C.SEASON_FOOD_DECAY[idx]; // fraction of current food abundance removed
    for (const z of this.zones) {
      const fertScore = z.fertility * C.MAX_ABUNDANCE;
      const food = (z.foodAbundance + growth * fertScore) * (1 - decay);
      z.foodAbundance = Math.round(food);
    }
  }

  private processMissions(dt: number): void {
    const done: number[] = [];
    for (const m of this.activeMissions) {
      m.elapsed += dt;
      if (m.elapsed >= m.duration) {
        const zone = this.zones.find((z) => z.id === m.zoneId);
        const crew = m.crewIds.length;
        let amount = 0;
        let zoneName = zone?.name ?? '';
        if (m.type === 'explore') {
          zoneName = this.discoverZone() ?? '';
        } else if (m.type === 'gatherFood') {
          amount = this.missionYield('gatherFood', m.zoneId, crew);
          this.food = Math.min(this.foodCap, this.food + amount);
          if (zone) {
            const found = this.foundBy(crew, zone.foodAbundance);
            zone.foodAbundance = Math.max(0, Math.round(zone.foodAbundance - found));
          }
        } else {
          amount = this.missionYield('gatherResources', m.zoneId, crew);
          this.iron = Math.min(this.ironCap, this.iron + amount);
          if (zone) {
            const found = this.foundBy(crew, zone.resourceAbundance);
            zone.resourceAbundance = Math.max(0, Math.round(zone.resourceAbundance - found));
          }
        }
        this.completedMissions.unshift({ id: m.id, type: m.type, zoneId: m.zoneId, zoneName, crew, amount });
        if (this.completedMissions.length > C.RECENT_MISSIONS) this.completedMissions.pop();
        done.push(m.id);
      }
    }
    if (done.length) this.activeMissions = this.activeMissions.filter((m) => !done.includes(m.id));
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
    this.processMissions(dt);

    // Season-change event: fire once when the clock crosses into a new season.
    const seasonIdx = this.season;
    if (seasonIdx !== this.seasonIndex) {
      this.seasonIndex = seasonIdx;
      this.applySeasonChange(seasonIdx);
    }

    const f = emptyFlows();
    const energyBefore = this.E;
    const foodBefore = this.food;

    const active = this.buildings.filter((b) => b.state === 'active');

    // 1. Staffing (priority order = list order): crew fills buildings top-to-bottom.
    this.assignStaffing(active);

    // 2-3. Power grid: fund consumers from generation then battery.
    const power = this.stepPower(active, dt);

    // 4. Food larder (depends on each building's powerLevel set during the power phase).
    const foodResult = this.stepFood(active, dt);

    // 4b. Crew health (depends on the starving result from the food phase).
    this.stepHealth(foodResult.starving, dt);

    // 4c. Death (depends on health drained in the health phase).
    this.stepDeaths();

    // 5. Housing capacity.
    const housingCap = this.stepHousing(active);

    // 7. Iron from extractors.
    const ironResult = this.stepIron(active, dt);

    // Flows for the UI. Every standing consumer draws full power, so all of them
    // count toward the grid load.
    const poweredCount = power.consumers.filter((b) => b.powerLevel >= 0.999).length;
    f.energyProduction = power.production;
    f.energyConsumption = power.demand;
    f.energyNet = (this.E - energyBefore) / dt;
    f.poweredCount = poweredCount;
    f.consumerCount = power.consumers.length;
    f.storageWasted = power.storageWasted;
    f.brownout = poweredCount < power.consumers.length;
    f.ironProduced = ironResult.ironProduced;
    f.ironNet = ironResult.ironWasted ? 0 : ironResult.ironProduced;
    f.ironWasted = ironResult.ironWasted;
    f.foodProduction = foodResult.foodProduction;
    f.foodConsumption = foodResult.foodConsumption;
    f.foodNet = (this.food - foodBefore) / dt;
    f.foodRatio = foodResult.foodRatio;
    f.starving = foodResult.starving;
    f.crewCap = housingCap;
    f.buildingCrew = this.buildingCrew;
    this.flows = f;
  }

  /** Power grid. Production from staffed producers; consumers draw their full draw as
   *  long as they're standing. Fund consumers in priority order — generation first, then
   *  the battery — recording each building's split so the UI can show generated vs stored.
   *  Mutates each building's powerLevel/genPower/batPower and this.E. */
  private stepPower(
    active: Building[],
    dt: number,
  ): { production: number; demand: number; consumers: Building[]; storageWasted: boolean } {
    let production = 0;
    for (const b of active) production += C.ENERGY_PRODUCTION[b.type] * b.staffing;
    // A built consumer draws its FULL power as long as it's standing — whether or
    // not it's staffed or producing. Idle buildings are an ongoing burden.
    const consumers = active.filter((b) => C.ENERGY_DRAW[b.type] > 0);
    let demand = 0;
    for (const b of consumers) demand += C.ENERGY_DRAW[b.type];

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
    return { production, demand, consumers, storageWasted };
  }

  /** Food larder: greenhouses grow it (per-building power & staffing). Gather-food
   *  missions deliver food in batches on completion, not continuously. Mutates this.food. */
  private stepFood(
    active: Building[],
    dt: number,
  ): { foodProduction: number; foodConsumption: number; foodRatio: number; starving: boolean } {
    let foodProduction = 0;
    const fertility = this.fertilityFactor;
    for (const b of active) {
      const base = C.FOOD_PRODUCTION[b.type];
      if (base === 0) continue;
      foodProduction += base * b.staffing * b.powerLevel * fertility;
    }
    // Crew away on a Gather Food run forage for themselves — they don't draw the larder.
    const foragers = new Set<number>();
    for (const m of this.activeMissions) {
      if (m.type === 'gatherFood') for (const id of m.crewIds) foragers.add(id);
    }
    const eatingCrew = Math.max(0, this.crew.length - foragers.size);
    const foodConsumption = eatingCrew * C.FOOD_PER_CREW;
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
    return { foodProduction, foodConsumption, foodRatio, starving };
  }

  /** Crew health: drains a full bar over a season when starving (uniform), recovers
   *  over two seasons when fed — but healing slows with exertion: ×0.5 away on a
   *  mission, ×0.75 staffing buildings, ×1 when idle. */
  private stepHealth(starving: boolean, dt: number): void {
    if (starving) {
      const drain = (-C.HEALTH_DRAIN_PER_SEASON / C.SEASON_LENGTH) * dt;
      for (const c of this.crew) c.health = clamp(c.health + drain, 0, C.HEALTH_MAX);
    } else {
      const heal = (C.HEALTH_RECOVER_PER_SEASON / C.SEASON_LENGTH) * dt;
      for (const c of this.crew) {
        const mult = this.onMission(c.id)
          ? C.HEAL_MULT_MISSION
          : c.task === 'building'
            ? C.HEAL_MULT_BUILDING
            : 1;
        c.health = clamp(c.health + heal * mult, 0, C.HEALTH_MAX);
      }
    }
  }

  /** Death: a crew member dies only when their health reaches 0. (Starvation kills
   *  by draining health, not on a separate timer.) Dead crew leave any mission they
   *  were on; a mission left with no crew is abandoned. */
  private stepDeaths(): void {
    if (this.crew.some((c) => c.health <= 0)) {
      const deadIds = new Set(this.crew.filter((c) => c.health <= 0).map((c) => c.id));
      this.crew = this.crew.filter((c) => !deadIds.has(c.id));
      for (const m of this.activeMissions) m.crewIds = m.crewIds.filter((id) => !deadIds.has(id));
      this.activeMissions = this.activeMissions.filter((m) => m.crewIds.length > 0);
    }
    if (this.crew.length === 0) this.failed = true;
  }

  /** Housing capacity (each habitat throttled by its own power). Crew no longer
   *  grows automatically — the roster is fixed until arrivals are added. */
  private stepHousing(active: Building[]): number {
    let housingCap = 0;
    for (const b of active) {
      housingCap += b.type === 'habitat' ? b.capacity * b.powerLevel : b.capacity;
    }
    return housingCap;
  }

  /** Iron from extractors (staffing × its power), capped by the stockpile.
   *  Mutates this.iron. */
  private stepIron(active: Building[], dt: number): { ironProduced: number; ironWasted: boolean } {
    let ironProduced = 0;
    const oreRichness = this.oreFactor;
    for (const b of active) {
      if (b.type === 'extractor') ironProduced += C.EXTRACTOR_OUTPUT * b.staffing * b.powerLevel * oreRichness;
    }
    this.iron += ironProduced * dt;
    let ironWasted = false;
    const ironCap = this.ironCap;
    if (this.iron > ironCap) {
      this.iron = ironCap;
      ironWasted = ironProduced > 0;
    }
    return { ironProduced, ironWasted };
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
    // Only crew tasked to building work staff buildings; missions/idle don't.
    let remaining = this.buildingCrew;
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
    buildingCrew: 0,
    brownout: false,
  };
}

function makeZone(name: string, kind: string, home: boolean, rng: Rng): Zone {
  let fertility: number;
  let oreRichness: number;
  if (home) {
    // home zone: roll an integer fertility % in range, ore richness takes the rest (sum = 100)
    const [lo, hi] = C.HOME_FERTILITY_PCT_RANGE;
    const pct = lo + Math.floor(rng() * (hi - lo + 1));
    fertility = pct / 100;
    oreRichness = (100 - pct) / 100;
  } else {
    fertility = rollRange(C.FERTILITY_RANGE, rng);
    oreRichness = rollRange(C.ORE_RICHNESS_RANGE, rng);
  }
  return {
    id: genId(),
    name,
    kind,
    home,
    fertility,
    oreRichness,
    // abundance is a score starting at the zone's geological ceiling, then depletes as it's worked
    foodAbundance: Math.round(fertility * C.MAX_ABUNDANCE),
    resourceAbundance: Math.round(oreRichness * C.MAX_ABUNDANCE),
  };
}

function makeCrew(index: number, rng: Rng): CrewMember {
  const name = C.CREW_NAMES[index % C.CREW_NAMES.length];
  return {
    id: genId(),
    name,
    health: C.START_HEALTH,
    stats: { vigor: stat(rng), tech: stat(rng), grit: stat(rng) },
    task: 'building',
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
