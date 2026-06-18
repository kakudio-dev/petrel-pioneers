// Core sim types. A Colony is a fully self-contained sim object (see spec header
// note): its own slots, stocks, directives. No global singletons anywhere.

export type BuildingType = 'command' | 'generator' | 'extractor' | 'habitat' | 'greenhouse';

export type Footing = 'expansion' | 'balanced' | 'conservation';

export type StaffStatus = 'staffed' | 'understaffed' | 'starved' | 'online';

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
  state: BuildState;
  /** iron consumed so far during construction (drives the 50% cancel refund). */
  invested: number;
  /** 0..1 — construction progress (building) or deconstruction progress (demolishing). */
  progress: number;
}

export interface Directives {
  /** Growth footing mode. (Power & worker priority is the building list order now.) */
  footing: Footing;
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
  crewCap: number; // effective capacity after power + food throttles
  crewNet: number; // growth minus shrinkage

  brownout: boolean;
}
