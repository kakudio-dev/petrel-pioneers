// ALL tuning constants live here. First-guess numbers to feel out, NOT balance.
// Energy is an automatic power grid; food is an analogous larder. Every building
// has a fixed power profile; consumers throttle when the battery empties.

import type { BuildingType, SkillId } from './types';

export const FIXED_DT = 0.1; // seconds per sim step

// --- Calendar: the colony clock runs in seasons (~1 minute each), 4 to a year ---
export const SEASON_LENGTH = 60; // seconds per season
export const SEASONS = ['Thaw', 'Highsun', 'Wane', 'Dark'];

// --- Energy grid: production, draw, and battery storage per building type ---
// Producers (command module, generators) feed the grid; consumers (extractors,
// habitats, greenhouses) draw a fixed amount while active (scaled by staffing).
export const ENERGY_PRODUCTION: Record<BuildingType, number> = {
  command: 15, // the core reactor — always on, never staffed
  generator: 10,
  extractor: 0,
  habitat: 0,
  greenhouse: 0,
  garden: 0,
};
export const ENERGY_DRAW: Record<BuildingType, number> = {
  command: 0,
  generator: 0,
  extractor: 4, // E/s to run
  habitat: 2, // E/s life support
  greenhouse: 5, // E/s grow lights (hungry — light is scarce at aphelion)
  garden: 0, // a garden grows in ambient light — no power needed
};
export const ENERGY_STORAGE: Record<BuildingType, number> = {
  command: 300, // the colony battery lives in the command module
  generator: 40, // each generator adds a little grid buffer
  extractor: 0,
  habitat: 0,
  greenhouse: 0,
  garden: 0,
};

// --- Food larder: production and storage per building type ---
// The command module does NOT grow food — it only ships with a full larder. The
// player must get a greenhouse running before that 200 runs dry, or the crew starve
// (the first failure point). Greenhouses are the only food producers.
export const FOOD_PRODUCTION: Record<BuildingType, number> = {
  command: 0,
  generator: 0,
  extractor: 0,
  habitat: 0,
  greenhouse: 6, // +food/s at full staffing & power
  garden: 4, // +food/s at full staffing — no power, but lower yield than a greenhouse
};

// Starvation no longer kills on a timer — it drains crew health, and a crew member dies
// only when their health reaches 0 (see HEALTH_* and crew death in colony.step).
// The larder is provided by the command module: a fixed 250. It does NOT scale with
// current crew. Greenhouses add a little extra space.
export const FOOD_STORAGE: Record<BuildingType, number> = {
  command: 250, // the larder
  generator: 0,
  extractor: 0,
  habitat: 0,
  greenhouse: 30, // each greenhouse adds a little larder space
  garden: 0,
};
export const CREW_FOOD_PER_SEASON = 10; // food each crew eats over one season
export const FOOD_PER_CREW = CREW_FOOD_PER_SEASON / SEASON_LENGTH; // continuous eat rate (food/s)

// --- Crew health (0..HEALTH_MAX %). Falls while the colony starves, recovers while fed. ---
export const HEALTH_MAX = 100;
export const START_HEALTH = HEALTH_MAX; // crew arrive at full health
export const HEALTH_DRAIN_PER_SEASON = 100; // starving: full health lost over one season
export const HEALTH_RECOVER_PER_SEASON = 50; // fed & resting: full recovery takes two seasons
// Healing scales with exertion (draining while starving is unaffected):
export const HEAL_MULT_MISSION = 0.5; // away on a mission — strenuous, 50% penalty
export const HEAL_MULT_BUILDING = 0.75; // staffing buildings — 25% penalty
// idle crew heal at the full rate (×1)

// --- Iron stockpile: storage per building type. When full, extractor output is
//     wasted — a nudge to spend iron on building or expanding. ---
export const IRON_STORAGE: Record<BuildingType, number> = {
  command: 50, // base stockpile
  generator: 0,
  extractor: 60, // ore piles up at the extractor
  habitat: 0,
  greenhouse: 0,
  garden: 0,
};

// --- Other building outputs ---
export const EXTRACTOR_OUTPUT = 8; // +Fe/s (iron) at full staffing & power
export const HABITAT_CAPACITY = 5; // +crew cap per habitat (throttled by power)
export const COMMAND_CAPACITY = 6; // base crew cap from the command module

export const BUILD_COST: Record<BuildingType, number> = {
  command: 0, // never built by the player
  generator: 50,
  extractor: 40,
  habitat: 60,
  greenhouse: 45,
  garden: 20,
};

// What resource each building's construction (and refund) is paid in. Most cost iron;
// the garden is built from seed stock and soil prep, so it costs food.
export const BUILD_RESOURCE: Record<BuildingType, 'iron' | 'food'> = {
  command: 'iron',
  generator: 'iron',
  extractor: 'iron',
  habitat: 'iron',
  greenhouse: 'iron',
  garden: 'food',
};

// How many build slots each building occupies. Most take one; the garden needs room
// to spread, so it takes two.
export const BUILD_SLOTS: Record<BuildingType, number> = {
  command: 0, // the command module is separate infra, not a slot
  generator: 1,
  extractor: 1,
  habitat: 1,
  greenhouse: 1,
  garden: 2,
};

// A building type that requires a researched technology before it can be built.
export const BUILDING_TECH: Partial<Record<BuildingType, string>> = {
  garden: 'subsistenceFarming',
};

// Seconds to construct (the time floor — actual time is longer if iron-starved).
// Deconstruction takes the same duration. Refund is 50% on cancel/demolish.
export const BUILD_TIME: Record<BuildingType, number> = {
  command: 0,
  generator: 8,
  extractor: 6,
  habitat: 9,
  greenhouse: 7,
  garden: 6,
};
export const REFUND_FRACTION = 0.5;

// Crew needed to fully staff one building. Command module & habitats are structural
// (no crew to run). Kept low so starting crew (10) staffs the starting buildings.
export const CREW_REQ: Record<BuildingType, number> = {
  command: 0,
  generator: 3,
  extractor: 3,
  habitat: 0,
  greenhouse: 3,
  garden: 2,
};

// --- Missions (zone expeditions that play out over time) ---
// A party carries food rations (from the larder) and eats them as it goes; it travels out
// (travel time = zone distance), gathers until its hold is full or it's down to the food it
// needs to get home, then returns and delivers. Rations and gathered cargo share one hold.
export const CREW_FIND_RATE = 0.01; // a crew's find "share" (feeds the gather rate), level 0
export const CREW_CARRY = 8; // a crew's hold size — rations + gathered cargo combined (level 0)
export const GATHER_RATE_SCALE = 0.1; // cargo/sec = (party find share) × abundance × this
export const TRAVEL_SECONDS_PER_DISTANCE = 2; // one-way travel seconds per distance unit
export const EXPLORE_DISTANCE = 5; // how far a scout ranges out (target zone is unknown)
export const ZONE_DISTANCE_RANGE: [number, number] = [3, 10]; // distance from the hub for new zones
export const MISSION_XP_PER_SEC = 1; // skill XP/sec each crew earns the whole time it's on a mission
export const RECENT_MISSIONS = 5; // how many completed missions to keep in the log
// Mission length presets — the cargo goal as a fraction of the party's hold capacity.
// The party heads home once it has gathered this much of the target resource.
export const MISSION_GOALS = { quick: 0.5, regular: 1 } as const;
export type MissionGoal = keyof typeof MISSION_GOALS;
export const MISSION_CREW_MAX = 4; // most crew that can be sent on one mission (to start)

// --- Skills & leveling (generic — add a skill by extending SkillId + this table, then
//     awarding its XP somewhere). Each level costs `baseXp` more than the last. ---
export interface SkillDef {
  name: string;
  icon: string; // Material Symbol shown on crew rows for this skill
  baseXp: number; // XP to go from level 0→1; level L→L+1 costs baseXp × (L + 1)
}
export const SKILLS: Record<SkillId, SkillDef> = {
  explorer: { name: 'Explorer', icon: 'explore', baseXp: 100 },
  research: { name: 'Research', icon: 'science', baseXp: 100 },
};
// Each crew has a hidden, randomized aptitude per skill that scales how fast they earn its
// XP — rolled once at creation in [APTITUDE_MIN, APTITUDE_MAX] (0.5× to 2× learning speed).
export const APTITUDE_MIN = 0.5;
export const APTITUDE_MAX = 2;
// Explorer bonuses applied per level (on top of the level-0 CREW_* values):
export const CARRY_PER_LEVEL = 8; // +8 hold size per Explorer level
export const FIND_PER_LEVEL = 0.01; // +1% find share per Explorer level
// Abundance is a 0..MAX_ABUNDANCE score. Seasons change it discretely; an active gather
// party depletes it continuously while working the zone.
export const MAX_ABUNDANCE = 100;
export const ORE_ABUNDANCE_MULT = 10; // a zone's starting ore abundance = ore richness × this × 100
// Food abundance change applied once each time the colony ENTERS a season (index matches
// SEASONS: Thaw, Highsun, Wane, Dark). Growth ADDS a fraction of the zone's fertility
// score; decay REMOVES a fraction of current abundance. There is no upper cap — the
// Wane/Dark decay settles food into a steady swing. Ore abundance ignores seasons.
//   Thaw   +2 fertility   Highsun +5 fertility   Wane −25%   Dark −75%
export const SEASON_FOOD_GROWTH = [2, 5, 0, 0]; // fraction of fertility score added
export const SEASON_FOOD_DECAY = [0, 0, 0.25, 0.75]; // fraction of current abundance removed

// --- Technology tree ---------------------------------------------------------------
// Research plays out like a mission: assign crew to a tech and they accumulate research
// points over time until it completes, unlocking its effects. The tech's resource cost
// is paid up front when research begins.
export interface TechDef {
  id: string;
  name: string;
  icon: string; // Material Symbol shown on the tech node
  description: string; // what the technology IS
  enables: string; // what it unlocks / lets the player do
  requires: string[]; // prerequisite tech ids (all must be researched first)
  cost: { food?: number; iron?: number }; // paid up front to begin researching
  researchCost: number; // research points needed to finish
  unlocksBuilding?: BuildingType; // a building type this tech makes buildable
}

export const TECHS: TechDef[] = [
  {
    id: 'subsistenceFarming',
    name: 'Subsistence Farming',
    icon: 'agriculture',
    description:
      'Hardy cold-frame cultivation that needs no power — just soil, seed, and patient hands. The colony’s first step toward feeding itself instead of living out of the larder.',
    enables: 'Unlocks the Garden — a low-tech food plot that produces food with no energy.',
    requires: [],
    cost: { food: 50 },
    researchCost: 60,
    unlocksBuilding: 'garden',
  },
];

// Research speed: a crew's research "share" per second (base + per-level), scaled by their
// hidden Research aptitude. A project's rate is the sum of its crew's shares × the scale.
export const CREW_RESEARCH_RATE = 1; // research points/sec per crew (Research level 0)
export const RESEARCH_PER_LEVEL = 0.5; // +per Research level
export const RESEARCH_RATE_SCALE = 1; // multiplier on the summed party research rate
export const RESEARCH_XP_PER_SEC = 1; // Research XP/sec each crew earns while researching

// --- Zone geology (intrinsic, rolled once when a zone is discovered) ---
// Fertility is the food carrying capacity: it caps food abundance, scales how fast
// food regrows each season, and scales greenhouse output. Ore richness is the same
// for resources: it caps resource abundance and scales extractor (mine) output.
// The home zone splits 100 points between the two: fertility is rolled in this
// (inclusive, integer-%) range and ore richness takes the remainder, so a fertile
// home is ore-poor and vice versa.
export const HOME_FERTILITY_PCT_RANGE: [number, number] = [40, 60];
export const FERTILITY_RANGE: [number, number] = [0.3, 1.0]; // [min, max] rolled for discovered zones
export const ORE_RICHNESS_RANGE: [number, number] = [0.3, 1.0];

// The home zone — where the command hub sits. The colony starts here.
export const HOME_ZONE_NAME = 'The Roost';
export const HOME_ZONE_KIND = 'Command Hub';

// Discovered-zone flavour (names used in order; kinds picked at random).
export const ZONE_NAMES = [
  'North Ridge', 'Black Flats', 'The Rift', 'Cinder Basin', 'Pale Hollow',
  'Frost Reach', 'Iron Gulch', 'Still Sea', 'Ashfall', 'Dim Vale',
];
export const ZONE_KINDS = ['Ore Field', 'Ice Field', 'Cavern', 'Ruins', 'Geothermal Vent', 'Scrap Field'];

// Names drawn (in order) for the colony roster.
export const CREW_NAMES = [
  'Vance', 'Okoye', 'Rhys', 'Calla', 'Mireh', 'Dov', 'Sten', 'Yara',
  'Pell', 'Nim', 'Asha', 'Bran', 'Cyra', 'Tam', 'Iko', 'Wren',
];

// --- Slots / expansion (Tier 1) — the command module is separate infra, so all
//     SLOT_CAP_START slots are free for the player's own buildings. ---
export const SLOT_CAP_START = 8;
export const EXPAND_SLOTS = 4;
export const EXPAND_BASE_COST = 220; // first expansion iron cost
export const EXPAND_COST_GROWTH = 1.7; // escalating: the difficulty curve lives here

// --- Starting state ---
// The colony starts as a bare command module: a full larder and stocks to bootstrap
// with, but no food production. Get a greenhouse running before the larder empties.
export const START_E = 200; // start mid-battery
export const START_IRON = 0;
export const START_CREW = 6;
export const START_FOOD = 100; // start with a partly-stocked larder (cap is FOOD_STORAGE.command, 250)
