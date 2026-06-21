// Core sim types. A Colony is a fully self-contained sim object (see spec header
// note): its own slots, stocks, directives. No global singletons anywhere.

export type BuildingType = 'command' | 'generator' | 'extractor' | 'habitat' | 'greenhouse';

export type StaffStatus = 'staffed' | 'understaffed' | 'starved' | 'online';

/** A crew member's at-base assignment. 'building' = staffs buildings (the default);
 *  'idle' = off duty. Being away on a mission is tracked on the mission, not here. */
export type CrewTask = 'building' | 'idle';

/** Skills a crew member can train. Add a new one here, in config's SKILLS table, and
 *  wherever its XP is earned — the leveling machinery is generic. */
export type SkillId = 'explorer';

/** Per-crew progress in one skill. `xp` is progress toward the NEXT level (it resets
 *  on level-up); `level` is 0-based and drives the skill's bonuses. */
export interface Skill {
  xp: number;
  level: number;
}

export interface CrewMember {
  id: number;
  name: string;
  /** Health, 0..100 (%). Rises while the colony is fed, falls while it starves. */
  health: number;
  task: CrewTask;
  /** Trained skills, keyed by SkillId (every crew has an entry per known skill). */
  skills: Record<SkillId, Skill>;
  /** Hidden, randomized learning aptitude per skill (a multiplier on XP gained). Not shown. */
  aptitude: Record<SkillId, number>;
}

/** A region discovered by Explore missions. Later, other missions run in zones.
 *  The colony starts in one home zone (where the command hub sits). */
export interface Zone {
  id: number;
  name: string;
  kind: string; // flavour / hint at what missions it'll support (placeholder)
  home?: boolean; // the command hub's zone
  distance: number; // travel distance from the hub (0 for home); drives mission travel time
  // --- Intrinsic geology (rolled once at discovery, never changes) ---
  fertility: number; // 0..1 — food carrying capacity: caps & scales food abundance + greenhouse output
  oreRichness: number; // 0..1 — ore carrying capacity: caps & scales resource abundance + extractor output
  // --- Current harvestable scores (depleted by gather parties, food shifts with seasons) ---
  foodAbundance: number;
  resourceAbundance: number;
}

/** A building under construction, fully operational, or being torn down. Only
 *  'active' buildings produce, consume, house crew, or provide storage. */
export type BuildState = 'building' | 'active' | 'demolishing';

export interface Building {
  id: number;
  type: BuildingType;
  /** crew capacity this building contributes (command module + habitats). */
  capacity: number;
  /** 0..1 — fraction of crew demand met for this building (computed each tick). */
  staffing: number;
  /** 0..1 — fraction of this building's power need met (priority-allocated each tick). */
  powerLevel: number;
  /** E/s of this building's draw met from live generation (vs the battery). */
  genPower: number;
  /** E/s of this building's draw met from stored battery energy. */
  batPower: number;
  state: BuildState;
  /** iron consumed so far during construction (drives the 50% cancel refund). */
  invested: number;
  /** 0..1 — construction progress (building) or deconstruction progress (demolishing). */
  progress: number;
}

/** Last-tick flow snapshot, surfaced to the UI. Rates are per second. */
export interface Flows {
  // Energy grid
  energyProduction: number; // total generation
  energyConsumption: number; // total demand
  energyNet: number; // battery charge/discharge rate (the "bottleneck coming" signal)
  poweredCount: number; // consumers receiving full power
  consumerCount: number; // total power consumers
  storageWasted: boolean; // producing surplus but the battery is full

  // Iron
  ironProduced: number;
  ironNet: number; // production rate (0 when the stockpile is full)
  ironWasted: boolean; // extracting but the stockpile is full

  // Food larder
  foodProduction: number;
  foodConsumption: number;
  foodNet: number; // larder fill/drain rate
  foodRatio: number; // 1 = fully fed; <1 = famine, crew declines
  starving: boolean;

  // Crew
  crewCap: number; // housing capacity (power-throttled habitats + command)
  buildingCrew: number; // crew currently in the building-staffing pool

  brownout: boolean;
}
