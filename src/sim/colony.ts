import type {
  Building,
  BuildingType,
  BuildState,
  CrewMember,
  CrewTask,
  Flows,
  SkillId,
  StaffStatus,
  Zone,
} from './types';
import * as C from './config';
import { gainXp, makeAptitudes, makeSkills, skillLevel } from './skills';
import { mulberry32, type Rng } from './rng';

export type MissionType = 'explore' | 'gatherFood' | 'gatherResources';

/** Which skill a mission trains and reads. (All map to Explorer for now; split this
 *  when a dedicated mining/foraging skill is added.) */
const MISSION_SKILL: Record<MissionType, SkillId> = {
  explore: 'explorer',
  gatherFood: 'explorer',
  gatherResources: 'explorer',
};

/** Where a mission is in its lifecycle: traveling out, working the zone, or heading home. */
export type MissionPhase = 'outbound' | 'gathering' | 'returning';

/** A running expedition. A party travels out (travelTime), gathers until its hold is full,
 *  then travels back (returnTime) and delivers its cargo. Explore skips gathering — it
 *  discovers a zone on arrival and turns straight around. */
export interface Mission {
  id: number;
  type: MissionType;
  zoneId: number | null;
  crewIds: number[];
  phase: MissionPhase;
  phaseElapsed: number; // seconds spent in the current phase
  travelTime: number; // one-way travel time (cached at launch)
  returnTime: number; // duration of the return leg (full travelTime, or less if recalled outbound)
  cargo: number; // units gathered so far (shares the hold with provisions)
  provisions: number; // food rations remaining (eaten by the crew over the run)
  lengthSeasons: number; // seasons of rations provisioned (short/regular/long)
  starving: boolean; // set per tick when the party can't feed itself this tick
  startedAt: number; // colony elapsed time at launch (for total duration)
  discovered?: string; // explore: the zone name discovered on arrival
}

/** A finished expedition, kept for the recent-missions log (and for re-running). */
export interface CompletedMission {
  id: number;
  type: MissionType;
  zoneId: number | null; // the original target zone (null for explore) — used to re-run
  zoneName: string; // target zone, or the newly discovered zone for explore
  crew: number;
  amount: number; // food/ore delivered (0 for explore)
  duration: number; // seconds the run actually took, launch to delivery
}

let nextId = 1;
const genId = () => nextId++;
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
    this.zones.push(makeZone(C.HOME_ZONE_NAME, C.HOME_ZONE_KIND, true, this.rng, this.season));
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
  /** A crew member's find "share" — base rate plus Explorer bonus (feeds the gather rate). */
  private findRate(c: CrewMember): number {
    return C.CREW_FIND_RATE + skillLevel(c, 'explorer') * C.FIND_PER_LEVEL;
  }
  /** A crew member's hold size — base capacity plus Explorer bonus. */
  private carryCap(c: CrewMember): number {
    return C.CREW_CARRY + skillLevel(c, 'explorer') * C.CARRY_PER_LEVEL;
  }
  private crewByIds(ids: number[]): CrewMember[] {
    return ids
      .map((id) => this.crew.find((c) => c.id === id))
      .filter((c): c is CrewMember => c !== undefined);
  }
  private teamCapacity(team: CrewMember[]): number {
    let cap = 0;
    for (const c of team) cap += this.carryCap(c);
    return cap;
  }
  /** Cargo/sec a team pulls in at a given abundance: party find-share × abundance × scale. */
  private gatherRate(team: CrewMember[], abundance: number): number {
    let share = 0;
    for (const c of team) share += this.findRate(c);
    return share * abundance * C.GATHER_RATE_SCALE;
  }
  private abundanceOf(zone: Zone | undefined, type: MissionType): number {
    if (!zone) return 0;
    return type === 'gatherResources' ? zone.resourceAbundance : zone.foodAbundance;
  }
  /** The skill a mission type trains and reads (drives which level the UI shows). */
  missionSkill(type: MissionType): SkillId {
    return MISSION_SKILL[type];
  }
  /** One-way travel time to a mission's destination. */
  travelTime(type: MissionType, zoneId: number | null): number {
    const distance = type === 'explore' ? C.EXPLORE_DISTANCE : (this.zones.find((z) => z.id === zoneId)?.distance ?? 0);
    return distance * C.TRAVEL_SECONDS_PER_DISTANCE;
  }
  /** Hold size of the team that would crew a mission (sum of per-crew capacity). */
  partyCapacity(crewIds: number[]): number {
    return this.teamCapacity(this.crewByIds(crewIds));
  }
  /** Estimated seconds to fill a hold from `fromCargo` at `abundance` — a forward sim that
   *  accounts for the zone depleting as it's worked (ignores future season shifts). */
  private gatherSeconds(team: CrewMember[], abundance: number, fromCargo: number, capacity: number): number {
    let cargo = fromCargo;
    let ab = abundance;
    let t = 0;
    const dt = 0.5;
    while (cargo < capacity - 1e-6 && ab > 1e-6 && t < 600) {
      let g = this.gatherRate(team, ab) * dt;
      g = Math.min(g, capacity - cargo, ab);
      cargo += g;
      ab -= g;
      t += dt;
    }
    return t;
  }
  /** Estimated seconds for a full round trip if launched now (preview) — the gather phase
   *  is bounded by the chosen mission length (a party heads home when its rations run low). */
  estimateRunSeconds(type: MissionType, zoneId: number | null, crewIds: number[], lengthSeasons: number): number {
    const travel = this.travelTime(type, zoneId);
    if (type === 'explore') return travel * 2;
    const team = this.crewByIds(crewIds);
    const ab = this.abundanceOf(this.zones.find((z) => z.id === zoneId), type);
    const gather = Math.min(this.gatherSeconds(team, ab, 0, this.teamCapacity(team)), lengthSeasons * C.SEASON_LENGTH);
    return travel + gather + travel;
  }
  /** Estimated seconds until an active mission's hold is full (0 once it's returning),
   *  bounded by the rations it set out with. */
  missionTimeToFull(m: Mission): number {
    if (m.type === 'explore' || m.phase === 'returning') return 0;
    const team = this.crewByIds(m.crewIds);
    const ab = this.abundanceOf(this.zones.find((z) => z.id === m.zoneId), m.type);
    const travelLeft = m.phase === 'outbound' ? Math.max(0, m.travelTime - m.phaseElapsed) : 0;
    const gatheringElapsed = m.phase === 'gathering' ? m.phaseElapsed : 0;
    const gatherBudget = Math.max(0, m.lengthSeasons * C.SEASON_LENGTH - gatheringElapsed);
    const fill = Math.min(this.gatherSeconds(team, ab, m.cargo, this.teamCapacity(team)), gatherBudget);
    return travelLeft + fill;
  }
  /** Estimated seconds until an active mission is back home and delivered. */
  missionEta(m: Mission): number {
    if (m.phase === 'returning') return Math.max(0, m.returnTime - m.phaseElapsed);
    return this.missionTimeToFull(m) + m.travelTime;
  }

  /** Food a party eats per second. */
  private missionConsumption(team: CrewMember[]): number {
    return team.length * C.FOOD_PER_CREW;
  }
  /** Rations a mission needs at launch. Everyone provisions to last `lengthSeasons`, but a
   *  food-gather party that out-collects its appetite (net positive) only needs enough to
   *  reach the zone; ore/explore parties also reserve the return trip (their cargo isn't
   *  edible). Returns the ideal amount — the larder may not be able to supply all of it. */
  provisionsNeeded(type: MissionType, zoneId: number | null, crewIds: number[], lengthSeasons: number): number {
    const team = this.crewByIds(crewIds);
    if (team.length === 0) return 0;
    const cons = this.missionConsumption(team);
    const travel = this.travelTime(type, zoneId);
    const lengthSeconds = lengthSeasons * C.SEASON_LENGTH;
    if (type === 'explore') return cons * 2 * travel; // there and back
    if (type === 'gatherFood') {
      const coll0 = this.gatherRate(team, this.abundanceOf(this.zones.find((z) => z.id === zoneId), 'gatherFood'));
      return cons * travel + Math.max(0, cons - coll0) * lengthSeconds; // self-feeds on the gathered food
    }
    return cons * (2 * travel + lengthSeconds); // gatherResources: rations for the whole trip
  }

  /** Launch a mission with a fixed team (crew ids) targeting an optional zone. Rations are
   *  drawn from the larder (capped at what's available). */
  launchMission(
    type: MissionType,
    zoneId: number | null,
    crewIds: number[],
    lengthSeasons: number = C.MISSION_LENGTHS.regular,
  ): boolean {
    if (crewIds.length === 0) return false;
    const travelTime = this.travelTime(type, zoneId);
    const provisions = Math.min(this.provisionsNeeded(type, zoneId, crewIds, lengthSeasons), this.food);
    this.food -= provisions;
    this.activeMissions.push({
      id: genId(),
      type,
      zoneId,
      crewIds: [...crewIds],
      phase: 'outbound',
      phaseElapsed: 0,
      travelTime,
      returnTime: travelTime,
      cargo: 0,
      provisions,
      lengthSeasons,
      starving: false,
      startedAt: this.elapsed,
    });
    return true;
  }
  /** Feed a mission `need` food this tick: rations first, then (for food runs) gathered
   *  food. Sets the mission's `starving` flag if it can't cover the need. */
  private feed(m: Mission, need: number): void {
    if (need <= 1e-9) return;
    const fromProv = Math.min(need, m.provisions);
    m.provisions -= fromProv;
    need -= fromProv;
    if (need > 1e-9 && m.type === 'gatherFood') {
      const fromCargo = Math.min(need, m.cargo);
      m.cargo -= fromCargo;
      need -= fromCargo;
    }
    if (need > 1e-9) m.starving = true;
  }
  /** Recall an active mission — it heads home now, carrying whatever it has gathered. The
   *  return takes a full travel leg if it had reached the zone, or only the time already
   *  spent traveling if it was still outbound. */
  recallMission(id: number): void {
    const m = this.activeMissions.find((x) => x.id === id);
    if (!m || m.phase === 'returning') return;
    m.returnTime = m.phase === 'outbound' ? m.phaseElapsed : m.travelTime;
    m.phase = 'returning';
    m.phaseElapsed = 0;
  }

  private discoverZone(): string | undefined {
    if (!this.zonesRemaining) return undefined;
    const name = C.ZONE_NAMES[this.discoveredCount];
    const kind = C.ZONE_KINDS[Math.floor(this.rng() * C.ZONE_KINDS.length)];
    this.zones.push(makeZone(name, kind, false, this.rng, this.season));
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

  /** Advance every active mission through its phases: travel out → gather until full →
   *  travel home → deliver. Gathering depletes the zone as cargo accumulates and trains
   *  the party's Explorer skill over time. */
  private processMissions(dt: number): void {
    const done: number[] = [];
    for (const m of this.activeMissions) {
      const team = this.crewByIds(m.crewIds);
      const zone = this.zones.find((z) => z.id === m.zoneId);
      const cons = this.missionConsumption(team);
      const need = cons * dt; // food the crew must eat this tick
      m.starving = false;

      // crew train their mission's skill the whole time they're away — travel, gather, return
      for (const c of team) gainXp(c, MISSION_SKILL[m.type], C.MISSION_XP_PER_SEC * dt);

      if (m.phase === 'outbound') {
        m.phaseElapsed += dt;
        this.feed(m, need); // eating while traveling out
        if (m.phaseElapsed >= m.travelTime) {
          if (m.type === 'explore') {
            m.discovered = this.discoverZone() ?? '';
            m.phase = 'returning';
            m.phaseElapsed = 0;
            m.returnTime = m.travelTime;
          } else {
            m.phase = 'gathering';
            m.phaseElapsed = 0;
          }
        }
      } else if (m.phase === 'gathering') {
        m.phaseElapsed += dt;
        const capacity = this.teamCapacity(team);
        const free = Math.max(0, capacity - m.provisions - m.cargo); // room left in the hold
        const abundance = this.abundanceOf(zone, m.type);

        if (m.type === 'gatherFood') {
          // harvest food: crew eat the gathered food first, surplus fills the hold
          const harvest = Math.min(this.gatherRate(team, abundance) * dt, abundance, free + need);
          if (zone) zone.foodAbundance = Math.max(0, zone.foodAbundance - harvest);
          const eaten = Math.min(harvest, need);
          m.cargo += harvest - eaten;
          this.feed(m, need - eaten); // any shortfall comes from rations
        } else {
          // harvest ore into the hold; crew eat rations (ore isn't edible)
          const harvest = Math.min(this.gatherRate(team, abundance) * dt, abundance, free);
          if (zone) zone.resourceAbundance = Math.max(0, zone.resourceAbundance - harvest);
          m.cargo += harvest;
          this.feed(m, need);
        }

        // head home when the hold is full, the food we can eat is down to the return trip,
        // or the zone is tapped out
        const edible = m.provisions + (m.type === 'gatherFood' ? m.cargo : 0);
        const returnReserve = cons * m.travelTime;
        if (m.provisions + m.cargo >= capacity - 1e-6 || edible <= returnReserve + 1e-6 || abundance <= 1e-6) {
          m.phase = 'returning';
          m.phaseElapsed = 0;
          m.returnTime = m.travelTime;
        }
      } else {
        // returning — still eating
        m.phaseElapsed += dt;
        this.feed(m, need);
        if (m.phaseElapsed >= m.returnTime) {
          const amount = Math.round(m.cargo);
          if (m.type === 'gatherFood') this.food = Math.min(this.foodCap, this.food + amount);
          else if (m.type === 'gatherResources') this.iron = Math.min(this.ironCap, this.iron + amount);
          // unused rations go back into the larder
          if (m.provisions > 0) this.food = Math.min(this.foodCap, this.food + Math.round(m.provisions));
          this.completedMissions.unshift({
            id: m.id,
            type: m.type,
            zoneId: m.zoneId,
            zoneName: m.type === 'explore' ? (m.discovered ?? '') : (zone?.name ?? ''),
            crew: m.crewIds.length,
            amount,
            duration: this.elapsed - m.startedAt,
          });
          if (this.completedMissions.length > C.RECENT_MISSIONS) this.completedMissions.pop();
          done.push(m.id);
        }
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
    // Away crew eat from their mission rations, not the larder — only crew at home draw it.
    const homeCrew = this.crew.filter((c) => !this.onMission(c.id)).length;
    const foodConsumption = homeCrew * C.FOOD_PER_CREW;
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

  /** Crew health. Away crew live off their mission rations: they recover at the away rate
   *  while fed, and drain only if their mission has run out of food. At-home crew drain
   *  while the colony starves, else recover (×0.75 staffing, ×1 idle). */
  private stepHealth(starving: boolean, dt: number): void {
    const starvingAway = new Set<number>();
    for (const m of this.activeMissions) if (m.starving) for (const id of m.crewIds) starvingAway.add(id);
    const drainPerSec = -C.HEALTH_DRAIN_PER_SEASON / C.SEASON_LENGTH;
    const healPerSec = C.HEALTH_RECOVER_PER_SEASON / C.SEASON_LENGTH;
    for (const c of this.crew) {
      let delta: number;
      if (this.onMission(c.id)) {
        delta = starvingAway.has(c.id) ? drainPerSec * dt : healPerSec * C.HEAL_MULT_MISSION * dt;
      } else if (starving) {
        delta = drainPerSec * dt;
      } else {
        const mult = c.task === 'building' ? C.HEAL_MULT_BUILDING : 1;
        delta = healPerSec * mult * dt;
      }
      c.health = clamp(c.health + delta, 0, C.HEALTH_MAX);
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

/** A new zone's starting food abundance, seeded from where the seasonal cycle sits. The
 *  base is a steady-state estimate — a year's worth of growth (Thaw + Highsun) run through
 *  the autumn/winter decay (Wane × Dark) — then the cycle is replayed from Thaw up to the
 *  current season. At game start (Thaw) that adds one more Thaw growth on top of the base. */
function seasonalFoodStart(fertility: number, season: number): number {
  const fertScore = fertility * C.MAX_ABUNDANCE;
  const totalGrowth = C.SEASON_FOOD_GROWTH.reduce((sum, g) => sum + g, 0);
  const decayProduct = C.SEASON_FOOD_DECAY.reduce((p, d) => p * (1 - d), 1);
  let food = totalGrowth * fertScore * decayProduct; // base ≈ value entering Thaw
  for (let i = 0; i <= season; i++) {
    food = (food + C.SEASON_FOOD_GROWTH[i] * fertScore) * (1 - C.SEASON_FOOD_DECAY[i]);
  }
  return Math.round(food);
}

function makeZone(name: string, kind: string, home: boolean, rng: Rng, season: number): Zone {
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
    distance: home ? 0 : rollRange(C.ZONE_DISTANCE_RANGE, rng),
    fertility,
    oreRichness,
    // food seeds from the seasonal cycle; ore starts at its geological ceiling
    foodAbundance: seasonalFoodStart(fertility, season),
    resourceAbundance: Math.round(oreRichness * C.MAX_ABUNDANCE),
  };
}

function makeCrew(index: number, rng: Rng): CrewMember {
  const name = C.CREW_NAMES[index % C.CREW_NAMES.length];
  return {
    id: genId(),
    name,
    health: C.START_HEALTH,
    task: 'building',
    skills: makeSkills(),
    aptitude: makeAptitudes(rng),
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
