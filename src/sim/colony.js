import * as C from './config';
import { gainXp, makeAptitudes, makeSkills, skillLevel } from './skills';
import { mulberry32 } from './rng';
/** The work phase of each mission trains this skill. (All map to Explorer for now; split
 *  this when a dedicated mining/combat/etc. skill is added.) */
const MISSION_SKILL = {
    explore: 'explorer',
    gatherFood: 'explorer',
    gatherResources: 'explorer',
};
/** Traveling to and from a mission always trains Explorer, regardless of mission type. */
const TRAVEL_SKILL = 'explorer';
/** Researching a technology trains this skill. */
const RESEARCH_SKILL = 'research';
let nextId = 1;
const genId = () => nextId++;
const rollRange = ([lo, hi], rng) => lo + rng() * (hi - lo);
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
    crew = [];
    // --- Missions & discovered zones ---
    zones = [];
    activeMissions = [];
    completedMissions = []; // newest first, capped at C.RECENT_MISSIONS
    // --- Research ---
    activeResearch = [];
    researched = new Set(); // ids of completed technologies
    // --- Space ---
    slotCap = C.SLOT_CAP_START;
    expandCount = 0;
    buildings = [];
    flows = emptyFlows();
    elapsed = 0;
    failed = false;
    seasonIndex = 0; // current season (0 = Thaw at t=0); used to fire season-change events
    rng;
    constructor(seed) {
        this.rng = seed === undefined ? Math.random : mulberry32(seed);
        this.buildings.push(makeBuilding('command', 'active'));
        for (let i = 0; i < C.START_CREW; i++)
            this.crew.push(makeCrew(i, this.rng));
        this.zones.push(makeZone(C.HOME_ZONE_NAME, C.HOME_ZONE_KIND, true, this.rng, this.season));
    }
    // --- Derived getters ---
    get slotsUsed() {
        return this.buildings.reduce((s, b) => s + C.BUILD_SLOTS[b.type], 0);
    }
    get freeSlots() {
        return this.slotCap - this.slotsUsed;
    }
    get energyCap() {
        return this.activeSum(C.ENERGY_STORAGE);
    }
    get ironCap() {
        return this.activeSum(C.IRON_STORAGE);
    }
    get foodCap() {
        // the larder comes from the command module (+ any greenhouse storage); it does not
        // scale with crew count
        return this.activeSum(C.FOOD_STORAGE);
    }
    get crewCapacity() {
        return this.buildings.reduce((s, b) => (b.state === 'active' ? s + b.capacity : s), 0);
    }
    get crewCount() {
        return this.crew.length;
    }
    /** Crew staffing buildings: task 'building', not away on a mission, not researching. */
    get buildingCrew() {
        return this.crew.filter((c) => c.task === 'building' && !this.onMission(c.id) && !this.onResearch(c.id)).length;
    }
    onMission(crewId) {
        return this.activeMissions.some((m) => m.crewIds.includes(crewId));
    }
    /** Whether a crew member is currently assigned to a research project. */
    onResearch(crewId) {
        return this.activeResearch.some((r) => r.crewIds.includes(crewId));
    }
    /** Whether a crew member is occupied (mission or research) and unavailable. */
    busy(crewId) {
        return this.onMission(crewId) || this.onResearch(crewId);
    }
    /** Crew at base, free to be sent on a mission or assigned to research. */
    get availableCrew() {
        return this.crew.filter((c) => !this.busy(c.id));
    }
    setTask(id, task) {
        const c = this.crew.find((x) => x.id === id);
        if (c)
            c.task = task;
    }
    // --- Calendar (seasons cycle; year counts up) ---
    /** Current season index (0 = Thaw at t=0), cycling through SEASONS. */
    get season() {
        return Math.floor(this.elapsed / C.SEASON_LENGTH) % C.SEASONS.length;
    }
    /** Name of the current season. */
    get seasonName() {
        return C.SEASONS[this.season];
    }
    /** Fraction (0..1) through the current season. */
    get seasonProgress() {
        return (this.elapsed % C.SEASON_LENGTH) / C.SEASON_LENGTH;
    }
    /** Current year (1-based: starts at Y1). */
    get year() {
        return Math.floor(this.elapsed / (C.SEASON_LENGTH * C.SEASONS.length)) + 1;
    }
    // --- Zone geology ---
    /** The home zone (where the command hub and all buildings sit). */
    get homeZone() {
        return this.zones.find((z) => z.home);
    }
    /** Home-zone fertility scales greenhouse food output (buildings sit in the home zone). */
    get fertilityFactor() {
        return this.homeZone?.fertility ?? 1;
    }
    /** Home-zone ore richness scales extractor (mine) output. */
    get oreFactor() {
        return this.homeZone?.oreRichness ?? 1;
    }
    // --- Missions ---
    /** Discovered (non-home) zones. */
    get discoveredCount() {
        return this.zones.filter((z) => !z.home).length;
    }
    get zonesRemaining() {
        return this.discoveredCount < C.ZONE_NAMES.length;
    }
    /** A crew member's find "share" — base rate plus Explorer bonus, scaled by their hidden
     *  Explorer aptitude (0.5×–2×, same roll that scales their XP gain). */
    findRate(c) {
        const base = C.CREW_FIND_RATE + skillLevel(c, 'explorer') * C.FIND_PER_LEVEL;
        return base * (c.aptitude.explorer ?? 1);
    }
    /** A crew member's hold size — base capacity plus Explorer bonus, scaled by their hidden
     *  Explorer aptitude (0.5×–2×). Rounded so capacities stay whole. */
    carryCap(c) {
        const base = C.CREW_CARRY + skillLevel(c, 'explorer') * C.CARRY_PER_LEVEL;
        return Math.round(base * (c.aptitude.explorer ?? 1));
    }
    crewByIds(ids) {
        return ids
            .map((id) => this.crew.find((c) => c.id === id))
            .filter((c) => c !== undefined);
    }
    teamCapacity(team) {
        let cap = 0;
        for (const c of team)
            cap += this.carryCap(c);
        return cap;
    }
    /** Cargo/sec a team pulls in at a given abundance: party find-share × abundance × scale. */
    gatherRate(team, abundance) {
        let share = 0;
        for (const c of team)
            share += this.findRate(c);
        return share * abundance * C.GATHER_RATE_SCALE;
    }
    abundanceOf(zone, type) {
        if (!zone)
            return 0;
        return type === 'gatherResources' ? zone.resourceAbundance : zone.foodAbundance;
    }
    /** A single crew member's hold contribution (carry capacity). */
    crewCarry(c) {
        return this.carryCap(c);
    }
    /** A single crew member's gather rate (cargo/sec) at a zone — 0 for explore or no zone.
     *  This is their marginal contribution: gather is additive across the party. */
    crewGatherRate(c, zoneId, type) {
        if (type === 'explore')
            return 0;
        const ab = this.abundanceOf(this.zones.find((z) => z.id === zoneId), type);
        return this.findRate(c) * ab * C.GATHER_RATE_SCALE;
    }
    /** The skill a mission type trains and reads (drives which level the UI shows). */
    missionSkill(type) {
        return MISSION_SKILL[type];
    }
    /** One-way travel time to a mission's destination. */
    travelTime(type, zoneId) {
        const distance = type === 'explore' ? C.EXPLORE_DISTANCE : (this.zones.find((z) => z.id === zoneId)?.distance ?? 0);
        return distance * C.TRAVEL_SECONDS_PER_DISTANCE;
    }
    /** Hold size of the team that would crew a mission (sum of per-crew capacity). */
    partyCapacity(crewIds) {
        return this.teamCapacity(this.crewByIds(crewIds));
    }
    /** Estimated seconds to gather `target` cargo from `fromCargo` at `abundance` — a forward
     *  sim that accounts for the zone depleting as it's worked (ignores future season shifts). */
    gatherSeconds(team, abundance, fromCargo, target) {
        let cargo = fromCargo;
        let ab = abundance;
        let t = 0;
        const dt = 0.5;
        while (cargo < target - 1e-6 && ab > 1e-6 && t < 600) {
            let g = this.gatherRate(team, ab) * dt;
            g = Math.min(g, target - cargo, ab);
            cargo += g;
            ab -= g;
            t += dt;
        }
        return t;
    }
    /** The cargo a mission aims to gather: a fraction of the party's hold (short/regular/long). */
    goalAmount(crewIds, goalFraction) {
        return Math.round(this.teamCapacity(this.crewByIds(crewIds)) * goalFraction);
    }
    /** Estimated seconds for a full round trip if launched now (preview): travel out, gather
     *  to the goal under current conditions, then travel back. */
    estimateRunSeconds(type, zoneId, crewIds, goalFraction) {
        const travel = this.travelTime(type, zoneId);
        if (type === 'explore')
            return travel * 2;
        const team = this.crewByIds(crewIds);
        const ab = this.abundanceOf(this.zones.find((z) => z.id === zoneId), type);
        return travel + this.gatherSeconds(team, ab, 0, this.goalAmount(crewIds, goalFraction)) + travel;
    }
    /** Estimated seconds until an active mission reaches its goal (0 once it's returning). */
    missionTimeToGoal(m) {
        if (m.type === 'explore' || m.phase === 'returning')
            return 0;
        const team = this.crewByIds(m.crewIds);
        const ab = this.abundanceOf(this.zones.find((z) => z.id === m.zoneId), m.type);
        const travelLeft = m.phase === 'outbound' ? Math.max(0, m.travelTime - m.phaseElapsed) : 0;
        return travelLeft + this.gatherSeconds(team, ab, m.cargo, m.goal);
    }
    /** Estimated seconds until an active mission is back home and delivered. */
    missionEta(m) {
        if (m.phase === 'returning')
            return Math.max(0, m.returnTime - m.phaseElapsed);
        return this.missionTimeToGoal(m) + m.travelTime;
    }
    /** Food a party eats per second. */
    missionConsumption(team) {
        return team.length * C.FOOD_PER_CREW;
    }
    /** Live cargo/sec an active mission's party is gathering right now (0 for explore or a
     *  tapped-out zone). Reads current crew levels, so it tracks mid-mission level-ups. */
    missionGatherRate(m) {
        if (m.type === 'explore')
            return 0;
        const team = this.crewByIds(m.crewIds);
        const ab = this.abundanceOf(this.zones.find((z) => z.id === m.zoneId), m.type);
        return this.gatherRate(team, ab);
    }
    /** Live food/sec an active mission's party eats. */
    missionFoodUse(m) {
        return this.missionConsumption(this.crewByIds(m.crewIds));
    }
    /** Rations a mission needs at launch — enough to last the estimated round trip to its goal.
     *  A food-gather party that out-collects its appetite only needs enough to reach the zone
     *  (it eats the food it gathers); ore/explore parties carry the whole trip. The larder may
     *  not be able to supply all of it. */
    provisionsNeeded(type, zoneId, crewIds, goalFraction) {
        const team = this.crewByIds(crewIds);
        if (team.length === 0)
            return 0;
        const cons = this.missionConsumption(team);
        const travel = this.travelTime(type, zoneId);
        if (type === 'explore')
            return cons * 2 * travel; // there and back
        const ab = this.abundanceOf(this.zones.find((z) => z.id === zoneId), type);
        const gatherTime = this.gatherSeconds(team, ab, 0, this.goalAmount(crewIds, goalFraction));
        if (type === 'gatherFood') {
            const coll0 = this.gatherRate(team, ab);
            return cons * travel + Math.max(0, cons - coll0) * gatherTime; // self-feeds on the gathered food
        }
        return cons * (2 * travel + gatherTime); // gatherResources: rations for the whole trip
    }
    /** Rations a mission actually takes: what it needs to reach its goal, but never more than
     *  the length's share of the hold (goalFraction × capacity). So a short run carries at most
     *  half a hold of food and backfills the rest with cargo; it only takes less if that's all
     *  it needs. (Explore isn't hold-bound — it just provisions the round trip.) */
    missionRations(type, zoneId, crewIds, goalFraction) {
        const needed = this.provisionsNeeded(type, zoneId, crewIds, goalFraction);
        if (type === 'explore')
            return needed;
        return Math.min(needed, this.teamCapacity(this.crewByIds(crewIds)) * goalFraction);
    }
    /** Launch a mission with a fixed team (crew ids) targeting an optional zone. The goal is a
     *  fraction of the hold; rations are drawn from the larder (capped at what's available). */
    launchMission(type, zoneId, crewIds, goalFraction = C.MISSION_GOALS.regular) {
        if (crewIds.length === 0)
            return false;
        const travelTime = this.travelTime(type, zoneId);
        const provisions = Math.min(this.missionRations(type, zoneId, crewIds, goalFraction), this.food);
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
            goalFraction,
            goal: this.goalAmount(crewIds, goalFraction),
            starving: false,
            startedAt: this.elapsed,
        });
        return true;
    }
    /** Feed a mission `need` food this tick: rations first, then (for food runs) gathered
     *  food. Sets the mission's `starving` flag if it can't cover the need. */
    feed(m, need) {
        if (need <= 1e-9)
            return;
        const fromProv = Math.min(need, m.provisions);
        m.provisions -= fromProv;
        need -= fromProv;
        if (need > 1e-9 && m.type === 'gatherFood') {
            const fromCargo = Math.min(need, m.cargo);
            m.cargo -= fromCargo;
            need -= fromCargo;
        }
        if (need > 1e-9)
            m.starving = true;
    }
    /** Recall an active mission — it heads home now, carrying whatever it has gathered. The
     *  return takes a full travel leg if it had reached the zone, or only the time already
     *  spent traveling if it was still outbound. */
    recallMission(id) {
        const m = this.activeMissions.find((x) => x.id === id);
        if (!m || m.phase === 'returning')
            return;
        m.returnTime = m.phase === 'outbound' ? m.phaseElapsed : m.travelTime;
        m.phase = 'returning';
        m.phaseElapsed = 0;
    }
    discoverZone() {
        if (!this.zonesRemaining)
            return undefined;
        const name = C.ZONE_NAMES[this.discoveredCount];
        const kind = C.ZONE_KINDS[Math.floor(this.rng() * C.ZONE_KINDS.length)];
        this.zones.push(makeZone(name, kind, false, this.rng, this.season));
        return name;
    }
    /** Applied once each time the colony enters a new season: every zone's food abundance
     *  grows by a fraction of its fertility score (spring/summer) or decays by a fraction of
     *  its current level (autumn/winter). No upper cap — Wane/Dark decay settles it into a
     *  steady seasonal swing. Ore abundance is untouched — it only moves on gather runs. */
    applySeasonChange(idx) {
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
    processMissions(dt) {
        const done = [];
        for (const m of this.activeMissions) {
            const team = this.crewByIds(m.crewIds);
            // Refresh the goal from current crew levels: if they level up mid-mission, their bigger
            // hold raises the target (still goalFraction of capacity), and gatherRate/capacity below
            // already read live levels, so the collection rate keeps pace too.
            m.goal = this.goalAmount(m.crewIds, m.goalFraction);
            const zone = this.zones.find((z) => z.id === m.zoneId);
            const cons = this.missionConsumption(team);
            const need = cons * dt; // food the crew must eat this tick
            m.starving = false;
            const xp = C.MISSION_XP_PER_SEC * dt;
            if (m.phase === 'outbound') {
                m.phaseElapsed += dt;
                for (const c of team)
                    gainXp(c, TRAVEL_SKILL, xp); // traveling trains Explorer
                this.feed(m, need); // eating while traveling out
                if (m.phaseElapsed >= m.travelTime) {
                    if (m.type === 'explore') {
                        m.discovered = this.discoverZone() ?? '';
                        m.phase = 'returning';
                        m.phaseElapsed = 0;
                        m.returnTime = m.travelTime;
                    }
                    else {
                        m.phase = 'gathering';
                        m.phaseElapsed = 0;
                    }
                }
            }
            else if (m.phase === 'gathering') {
                m.phaseElapsed += dt;
                for (const c of team)
                    gainXp(c, MISSION_SKILL[m.type], xp); // working trains the mission skill
                const capacity = this.teamCapacity(team);
                const free = Math.max(0, capacity - m.provisions - m.cargo); // room left in the hold
                const abundance = this.abundanceOf(zone, m.type);
                if (m.type === 'gatherFood') {
                    // harvest food: crew eat the gathered food first, surplus fills the hold
                    const harvest = Math.min(this.gatherRate(team, abundance) * dt, abundance, free + need);
                    if (zone)
                        zone.foodAbundance = Math.max(0, zone.foodAbundance - harvest);
                    const eaten = Math.min(harvest, need);
                    m.cargo += harvest - eaten;
                    this.feed(m, need - eaten); // any shortfall comes from rations
                }
                else {
                    // harvest ore into the hold; crew eat rations (ore isn't edible)
                    const harvest = Math.min(this.gatherRate(team, abundance) * dt, abundance, free);
                    if (zone)
                        zone.resourceAbundance = Math.max(0, zone.resourceAbundance - harvest);
                    m.cargo += harvest;
                    this.feed(m, need);
                }
                // head home when the goal is met, the hold is full, the food we can eat is down to
                // the return trip, or the zone is tapped out
                const edible = m.provisions + (m.type === 'gatherFood' ? m.cargo : 0);
                const returnReserve = cons * m.travelTime;
                if (m.cargo >= m.goal - 1e-6 ||
                    m.provisions + m.cargo >= capacity - 1e-6 ||
                    edible <= returnReserve + 1e-6 ||
                    abundance <= 1e-6) {
                    m.phase = 'returning';
                    m.phaseElapsed = 0;
                    m.returnTime = m.travelTime;
                }
            }
            else {
                // returning — still eating, and traveling trains Explorer
                m.phaseElapsed += dt;
                for (const c of team)
                    gainXp(c, TRAVEL_SKILL, xp);
                this.feed(m, need);
                if (m.phaseElapsed >= m.returnTime) {
                    const amount = Math.round(m.cargo);
                    if (m.type === 'gatherFood')
                        this.food = Math.min(this.foodCap, this.food + amount);
                    else if (m.type === 'gatherResources')
                        this.iron = Math.min(this.ironCap, this.iron + amount);
                    // unused rations go back into the larder
                    if (m.provisions > 0)
                        this.food = Math.min(this.foodCap, this.food + Math.round(m.provisions));
                    this.completedMissions.unshift({
                        id: m.id,
                        type: m.type,
                        zoneId: m.zoneId,
                        zoneName: m.type === 'explore' ? (m.discovered ?? '') : (zone?.name ?? ''),
                        crew: m.crewIds.length,
                        amount,
                        duration: this.elapsed - m.startedAt,
                    });
                    if (this.completedMissions.length > C.RECENT_MISSIONS)
                        this.completedMissions.pop();
                    done.push(m.id);
                }
            }
        }
        if (done.length)
            this.activeMissions = this.activeMissions.filter((m) => !done.includes(m.id));
    }
    // --- Research / technology ---
    /** A technology definition by id. */
    tech(id) {
        return C.TECHS.find((t) => t.id === id);
    }
    isResearched(id) {
        return this.researched.has(id);
    }
    isResearching(id) {
        return this.activeResearch.some((r) => r.techId === id);
    }
    /** The active research project for a tech, if any. */
    research(id) {
        return this.activeResearch.find((r) => r.techId === id);
    }
    /** All prerequisites of a tech are researched (so it could be started). */
    prereqsMet(id) {
        const t = this.tech(id);
        return !!t && t.requires.every((r) => this.researched.has(r));
    }
    /** Lifecycle status of a tech, for the tree UI. */
    techStatus(id) {
        if (this.isResearched(id))
            return 'researched';
        if (this.isResearching(id))
            return 'researching';
        return this.prereqsMet(id) ? 'available' : 'locked';
    }
    /** Techs that list `id` as a prerequisite (what it leads to). */
    dependents(id) {
        return C.TECHS.filter((t) => t.requires.includes(id));
    }
    /** Can the colony afford to begin researching this tech right now? */
    canAffordTech(id) {
        const t = this.tech(id);
        if (!t)
            return false;
        return this.food >= (t.cost.food ?? 0) && this.iron >= (t.cost.iron ?? 0);
    }
    /** A crew member's research "share" per second — base + Research level, × their aptitude. */
    researchRate(c) {
        const base = C.CREW_RESEARCH_RATE + skillLevel(c, RESEARCH_SKILL) * C.RESEARCH_PER_LEVEL;
        return base * (c.aptitude[RESEARCH_SKILL] ?? 1);
    }
    /** Public: a single crew member's research rate (points/sec). */
    crewResearchRate(c) {
        return this.researchRate(c) * C.RESEARCH_RATE_SCALE;
    }
    /** Live research points/sec a project's assigned crew produce together. */
    projectResearchRate(r) {
        let rate = 0;
        for (const c of this.crewByIds(r.crewIds))
            rate += this.researchRate(c);
        return rate * C.RESEARCH_RATE_SCALE;
    }
    /** Estimated seconds until a research project finishes at its current rate. */
    researchEta(r) {
        const rate = this.projectResearchRate(r);
        return rate > 1e-9 ? (r.cost - r.progress) / rate : Infinity;
    }
    /** The skill a tech trains while being researched (Research, for now). */
    researchSkill() {
        return RESEARCH_SKILL;
    }
    /** Begin researching a tech with a fixed crew. Deducts the tech's cost up front. Fails if
     *  the tech is unknown, already done/in-progress, prereqs unmet, unaffordable, or no crew. */
    startResearch(techId, crewIds) {
        if (crewIds.length === 0)
            return false;
        const t = this.tech(techId);
        if (!t)
            return false;
        if (this.techStatus(techId) !== 'available')
            return false;
        if (!this.canAffordTech(techId))
            return false;
        this.food -= t.cost.food ?? 0;
        this.iron -= t.cost.iron ?? 0;
        this.activeResearch.push({
            id: genId(),
            techId,
            crewIds: [...crewIds],
            progress: 0,
            cost: t.researchCost,
            startedAt: this.elapsed,
        });
        return true;
    }
    /** Cancel a research project. No refund (the cost was spent on setup). */
    cancelResearch(techId) {
        this.activeResearch = this.activeResearch.filter((r) => r.techId !== techId);
    }
    processResearch(dt) {
        const done = [];
        const xp = C.RESEARCH_XP_PER_SEC * dt;
        for (const r of this.activeResearch) {
            const team = this.crewByIds(r.crewIds);
            for (const c of team)
                gainXp(c, RESEARCH_SKILL, xp);
            r.progress += this.projectResearchRate(r) * dt;
            if (r.progress >= r.cost - 1e-6) {
                this.researched.add(r.techId);
                done.push(r.id);
            }
        }
        if (done.length)
            this.activeResearch = this.activeResearch.filter((r) => !done.includes(r.id));
    }
    get expandCost() {
        return Math.round(C.EXPAND_BASE_COST * C.EXPAND_COST_GROWTH ** this.expandCount);
    }
    activeSum(map) {
        return this.buildings.reduce((s, b) => (b.state === 'active' ? s + map[b.type] : s), 0);
    }
    // --- Player actions ---
    /** Whether a building type may be built now: not the command module, its tech (if any)
     *  is researched, and there are enough free slots for its footprint. */
    canBuild(type) {
        if (type === 'command')
            return false;
        if (!this.techUnlocked(type))
            return false;
        return this.freeSlots >= C.BUILD_SLOTS[type];
    }
    /** A building type is buildable when it has no tech requirement, or that tech is done. */
    techUnlocked(type) {
        const req = C.BUILDING_TECH[type];
        return !req || this.researched.has(req);
    }
    build(type) {
        if (!this.canBuild(type))
            return false;
        this.buildings.push(makeBuilding(type, 'building'));
        return true;
    }
    demolish(id) {
        const b = this.buildings.find((x) => x.id === id);
        if (!b || b.type === 'command' || b.state !== 'active')
            return;
        b.state = 'demolishing';
        b.progress = 0;
        b.staffing = 0;
        b.powerLevel = 0;
    }
    cancel(id) {
        const b = this.buildings.find((x) => x.id === id);
        if (!b || b.type === 'command')
            return;
        if (b.state === 'building') {
            this.refundResource(C.BUILD_RESOURCE[b.type], C.REFUND_FRACTION * b.invested);
            this.buildings = this.buildings.filter((x) => x.id !== id);
        }
        else if (b.state === 'demolishing') {
            b.state = 'active';
            b.progress = 1;
        }
    }
    /** Raise a building's priority (earlier in the list = power & crew first). */
    moveUp(id) {
        const i = this.buildings.findIndex((b) => b.id === id);
        if (i <= 1)
            return; // index 0 is the pinned command module
        [this.buildings[i - 1], this.buildings[i]] = [this.buildings[i], this.buildings[i - 1]];
    }
    /** Lower a building's priority. */
    moveDown(id) {
        const i = this.buildings.findIndex((b) => b.id === id);
        if (i < 1 || i >= this.buildings.length - 1)
            return;
        [this.buildings[i + 1], this.buildings[i]] = [this.buildings[i], this.buildings[i + 1]];
    }
    expand() {
        if (this.iron < this.expandCost)
            return false;
        this.iron -= this.expandCost;
        this.slotCap += C.EXPAND_SLOTS;
        this.expandCount++;
        return true;
    }
    // --- The tick ---
    step(dt) {
        if (this.failed)
            return;
        this.elapsed += dt;
        this.processProjects(dt);
        this.processMissions(dt);
        this.processResearch(dt);
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
    stepPower(active, dt) {
        let production = 0;
        for (const b of active)
            production += C.ENERGY_PRODUCTION[b.type] * b.staffing;
        // A built consumer draws its FULL power as long as it's standing — whether or
        // not it's staffed or producing. Idle buildings are an ongoing burden.
        const consumers = active.filter((b) => C.ENERGY_DRAW[b.type] > 0);
        let demand = 0;
        for (const b of consumers)
            demand += C.ENERGY_DRAW[b.type];
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
        if (newE < 0)
            newE = 0;
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
    stepFood(active, dt) {
        let foodProduction = 0;
        const fertility = this.fertilityFactor;
        for (const b of active) {
            const base = C.FOOD_PRODUCTION[b.type];
            if (base === 0)
                continue;
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
        }
        else {
            starving = true;
            foodRatio = foodConsumption > 0 ? clamp(foodProduction / foodConsumption, 0, 1) : 1;
            this.food = 0;
        }
        return { foodProduction, foodConsumption, foodRatio, starving };
    }
    /** Crew health. Away crew live off their mission rations: they recover at the away rate
     *  while fed, and drain only if their mission has run out of food. At-home crew drain
     *  while the colony starves, else recover (×0.75 staffing, ×1 idle). */
    stepHealth(starving, dt) {
        const starvingAway = new Set();
        for (const m of this.activeMissions)
            if (m.starving)
                for (const id of m.crewIds)
                    starvingAway.add(id);
        const drainPerSec = -C.HEALTH_DRAIN_PER_SEASON / C.SEASON_LENGTH;
        const healPerSec = C.HEALTH_RECOVER_PER_SEASON / C.SEASON_LENGTH;
        for (const c of this.crew) {
            let delta;
            if (this.onMission(c.id)) {
                delta = starvingAway.has(c.id) ? drainPerSec * dt : healPerSec * C.HEAL_MULT_MISSION * dt;
            }
            else if (starving) {
                delta = drainPerSec * dt;
            }
            else {
                // researching is strenuous work, like staffing a building
                const working = c.task === 'building' || this.onResearch(c.id);
                const mult = working ? C.HEAL_MULT_BUILDING : 1;
                delta = healPerSec * mult * dt;
            }
            c.health = clamp(c.health + delta, 0, C.HEALTH_MAX);
        }
    }
    /** Death: a crew member dies only when their health reaches 0. (Starvation kills
     *  by draining health, not on a separate timer.) Dead crew leave any mission they
     *  were on; a mission left with no crew is abandoned. */
    stepDeaths() {
        if (this.crew.some((c) => c.health <= 0)) {
            const deadIds = new Set(this.crew.filter((c) => c.health <= 0).map((c) => c.id));
            this.crew = this.crew.filter((c) => !deadIds.has(c.id));
            for (const m of this.activeMissions)
                m.crewIds = m.crewIds.filter((id) => !deadIds.has(id));
            this.activeMissions = this.activeMissions.filter((m) => m.crewIds.length > 0);
            for (const r of this.activeResearch)
                r.crewIds = r.crewIds.filter((id) => !deadIds.has(id));
            this.activeResearch = this.activeResearch.filter((r) => r.crewIds.length > 0);
        }
        if (this.crew.length === 0)
            this.failed = true;
    }
    /** Housing capacity (each habitat throttled by its own power). Crew no longer
     *  grows automatically — the roster is fixed until arrivals are added. */
    stepHousing(active) {
        let housingCap = 0;
        for (const b of active) {
            housingCap += b.type === 'habitat' ? b.capacity * b.powerLevel : b.capacity;
        }
        return housingCap;
    }
    /** Iron from extractors (staffing × its power), capped by the stockpile.
     *  Mutates this.iron. */
    stepIron(active, dt) {
        let ironProduced = 0;
        const oreRichness = this.oreFactor;
        for (const b of active) {
            if (b.type === 'extractor')
                ironProduced += C.EXTRACTOR_OUTPUT * b.staffing * b.powerLevel * oreRichness;
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
    /** Add `amount` of a build resource back to its stock (iron uncapped, food capped). */
    refundResource(res, amount) {
        if (res === 'food')
            this.food = Math.min(this.foodCap, this.food + amount);
        else
            this.iron += amount;
    }
    processProjects(dt) {
        const finishedDemolish = [];
        for (const b of this.buildings) {
            const res = C.BUILD_RESOURCE[b.type];
            const cost = C.BUILD_COST[b.type];
            const time = C.BUILD_TIME[b.type];
            if (b.state === 'building') {
                const avail = res === 'food' ? this.food : this.iron;
                const want = time > 0 ? cost * (dt / time) : cost;
                const spend = Math.min(want, avail, cost - b.invested);
                if (res === 'food')
                    this.food -= spend;
                else
                    this.iron -= spend;
                b.invested += spend;
                b.progress = cost > 0 ? b.invested / cost : 1;
                if (b.invested >= cost - 1e-6) {
                    b.state = 'active';
                    b.progress = 1;
                }
            }
            else if (b.state === 'demolishing') {
                b.progress += time > 0 ? dt / time : 1;
                if (b.progress >= 1) {
                    this.refundResource(res, C.REFUND_FRACTION * cost);
                    finishedDemolish.push(b.id);
                }
            }
        }
        if (finishedDemolish.length) {
            this.buildings = this.buildings.filter((b) => !finishedDemolish.includes(b.id));
        }
    }
    /** Staff buildings in list (priority) order, filling each to CREW_REQ. */
    assignStaffing(active) {
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
    staffStatus(b) {
        if (C.CREW_REQ[b.type] <= 0)
            return 'online';
        if (b.staffing >= 0.999)
            return 'staffed';
        if (b.staffing <= 0.001)
            return 'starved';
        return 'understaffed';
    }
}
function makeBuilding(type, state) {
    let capacity = 0;
    if (type === 'command')
        capacity = C.COMMAND_CAPACITY;
    else if (type === 'habitat')
        capacity = C.HABITAT_CAPACITY;
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
function emptyFlows() {
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
function seasonalFoodStart(fertility, season) {
    const fertScore = fertility * C.MAX_ABUNDANCE;
    const totalGrowth = C.SEASON_FOOD_GROWTH.reduce((sum, g) => sum + g, 0);
    const decayProduct = C.SEASON_FOOD_DECAY.reduce((p, d) => p * (1 - d), 1);
    let food = totalGrowth * fertScore * decayProduct; // base ≈ value entering Thaw
    for (let i = 0; i <= season; i++) {
        food = (food + C.SEASON_FOOD_GROWTH[i] * fertScore) * (1 - C.SEASON_FOOD_DECAY[i]);
    }
    return Math.round(food);
}
function makeZone(name, kind, home, rng, season) {
    let fertility;
    let oreRichness;
    if (home) {
        // home zone: roll an integer fertility % in range, ore richness takes the rest (sum = 100)
        const [lo, hi] = C.HOME_FERTILITY_PCT_RANGE;
        const pct = lo + Math.floor(rng() * (hi - lo + 1));
        fertility = pct / 100;
        oreRichness = (100 - pct) / 100;
    }
    else {
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
        resourceAbundance: Math.round(oreRichness * C.MAX_ABUNDANCE * C.ORE_ABUNDANCE_MULT),
    };
}
function makeCrew(index, rng) {
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
function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
}
