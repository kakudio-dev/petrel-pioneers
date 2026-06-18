// ALL tuning constants live here. First-guess numbers to feel out, NOT balance.
// Energy is an automatic power grid; food is an analogous larder. Every building
// has a fixed power profile; consumers throttle when the battery empties.

import type { BuildingType } from './types';

export const FIXED_DT = 0.1; // seconds per sim step

// --- Energy grid: production, draw, and battery storage per building type ---
// Producers (command module, generators) feed the grid; consumers (extractors,
// habitats, greenhouses) draw a fixed amount while active (scaled by staffing).
export const ENERGY_PRODUCTION: Record<BuildingType, number> = {
  command: 15, // the core reactor — always on, never staffed
  generator: 10,
  extractor: 0,
  habitat: 0,
  greenhouse: 0,
};
export const ENERGY_DRAW: Record<BuildingType, number> = {
  command: 0,
  generator: 0,
  extractor: 4, // E/s to run
  habitat: 2, // E/s life support
  greenhouse: 5, // E/s grow lights (hungry — light is scarce at aphelion)
};
export const ENERGY_STORAGE: Record<BuildingType, number> = {
  command: 300, // the colony battery lives in the command module
  generator: 40, // each generator adds a little grid buffer
  extractor: 0,
  habitat: 0,
  greenhouse: 0,
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
};

// When the larder is empty and food can't keep up, the colony loses one crew
// member every STARVE_DELAY seconds (discrete, not a smooth shrink).
export const STARVE_DELAY = 9;
export const FOOD_STORAGE: Record<BuildingType, number> = {
  command: 200, // the larder
  generator: 0,
  extractor: 0,
  habitat: 0,
  greenhouse: 30, // each greenhouse adds a little larder space
};
export const FOOD_PER_CREW = 0.3; // food/s eaten per crew

// --- Iron stockpile: storage per building type. When full, extractor output is
//     wasted — a nudge to spend iron on building or expanding. ---
export const IRON_STORAGE: Record<BuildingType, number> = {
  command: 400, // base stockpile
  generator: 0,
  extractor: 60, // ore piles up at the extractor
  habitat: 0,
  greenhouse: 0,
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
};

// Seconds to construct (the time floor — actual time is longer if iron-starved).
// Deconstruction takes the same duration. Refund is 50% on cancel/demolish.
export const BUILD_TIME: Record<BuildingType, number> = {
  command: 0,
  generator: 8,
  extractor: 6,
  habitat: 9,
  greenhouse: 7,
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
};

// --- Missions (discrete expeditions: prepare a team, launch, resolve on finish) ---
export const MISSION_TEAM = 3; // default crew a "Prepare" assembles
export const EXPLORE_TIME = 60; // seconds for 1 crew to discover a zone (÷ team size)
export const GATHER_TIME = 25; // seconds for a food-gathering run
export const FOOD_BATCH = 25; // food returned per crew on a gather run

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
export const START_IRON = 200;
export const START_FOOD = 200; // full larder — the survival countdown starts here
export const START_CREW = 6;
