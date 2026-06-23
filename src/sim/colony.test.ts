import { describe, it, expect } from 'vitest';
import { Colony } from './colony';
import * as C from './config';
import { gainXp, skillLevel, xpToNext } from './skills';

describe('Colony sim regression suite', () => {
  it('1. is deterministic for a given seed and differs across seeds', () => {
    const a = new Colony(42);
    const b = new Colony(42);
    expect(a.zones[0].fertility).toBeCloseTo(b.zones[0].fertility, 5);
    expect(a.zones[0].oreRichness).toBeCloseTo(b.zones[0].oreRichness, 5);

    const c = new Colony(7);
    expect(c.zones[0].fertility).not.toBeCloseTo(a.zones[0].fertility, 5);
  });

  it('2. home geology splits 100 points; ore mirrors geology, food seeds from the season', () => {
    const z = new Colony(1).zones[0];
    const fertPct = Math.round(z.fertility * 100);
    const orePct = Math.round(z.oreRichness * 100);
    expect(fertPct + orePct).toBe(100);
    expect(fertPct).toBeGreaterThanOrEqual(40);
    expect(fertPct).toBeLessThanOrEqual(60);
    // ore abundance starts at 10× the ore richness and is unaffected by seasons
    expect(z.resourceAbundance).toBe(Math.round(z.oreRichness * C.MAX_ABUNDANCE * C.ORE_ABUNDANCE_MULT));
    // food is seeded from the seasonal cycle (Thaw at game start), not the flat fertility ceiling
    const F = z.fertility * C.MAX_ABUNDANCE;
    const base = C.SEASON_FOOD_GROWTH.reduce((a, g) => a + g, 0) * F * C.SEASON_FOOD_DECAY.reduce((p, d) => p * (1 - d), 1);
    const expectedThaw = Math.round((base + C.SEASON_FOOD_GROWTH[0] * F) * (1 - C.SEASON_FOOD_DECAY[0]));
    expect(z.foodAbundance).toBe(expectedThaw);
  });

  it('3. food cap is the fixed command larder, not crew-scaled', () => {
    const colony = new Colony();
    expect(colony.foodCap).toBe(250);
    expect(colony.foodCap).toBe(C.FOOD_STORAGE.command);
    colony.crew.length = 3;
    expect(colony.foodCap).toBe(250);
  });

  it('4. crew start at full health', () => {
    const colony = new Colony();
    for (const c of colony.crew) expect(c.health).toBe(C.HEALTH_MAX);
  });

  it('5. party hold size sums crew holds; travel time scales with distance', () => {
    const colony = new Colony(1);
    const team = colony.crew.slice(0, 3);
    team.forEach((c) => (c.aptitude.explorer = 1)); // isolate carry from aptitude scaling
    const three = team.map((c) => c.id);
    expect(colony.partyCapacity(three)).toBe(C.CREW_CARRY * 3);
    expect(colony.travelTime('gatherFood', colony.zones[0].id)).toBe(0); // home, no travel
    colony.zones[0].distance = 5;
    expect(colony.travelTime('gatherFood', colony.zones[0].id)).toBe(5 * C.TRAVEL_SECONDS_PER_DISTANCE);
  });

  it('6. a gather run draws rations, delivers ore, and works the zone', () => {
    const colony = new Colony(1);
    const z = colony.zones[0]; // home -> no travel
    z.resourceAbundance = 1000; // rich, so gathering is fast enough to fit in the hold
    colony.iron = 0;
    colony.food = 100;
    const foodBefore = colony.food;
    colony.launchMission('gatherResources', z.id, [colony.crew[0].id]);
    expect(foodBefore - colony.food).toBeGreaterThan(0); // rations taken from the larder
    for (let i = 0; i < 3000 && colony.activeMissions.length; i++) colony.step(0.1);

    expect(colony.iron).toBeGreaterThan(0); // delivered ore
    expect(z.resourceAbundance).toBeLessThan(1000); // zone worked
    expect(colony.completedMissions[0].duration).toBeGreaterThan(0);
  });

  it('7. health drains a full bar per season when starving', () => {
    const colony = new Colony(1);
    colony.food = 0;
    for (let i = 0; i < 30; i++) colony.step(0.1);
    expect(colony.crew[0].health).toBeCloseTo(95, 5);
    expect(colony.crewCount).toBe(6);
  });

  it('8. healing scales with exertion when fed', () => {
    const colony = new Colony(1);
    colony.crew[0].task = 'idle';
    colony.crew[1].task = 'building';
    colony.activeMissions.push({
      id: 1,
      type: 'gatherResources',
      zoneId: colony.zones[0].id,
      crewIds: [colony.crew[2].id],
      phase: 'returning', // parked away (won't complete) so crew[2] stays on a mission
      phaseElapsed: 0,
      travelTime: 0,
      returnTime: 9999,
      cargo: 0,
      provisions: 9999, // well-stocked, so it never starves during the test
      goal: 0,
      goalFraction: 1,
      starving: false,
      startedAt: 0,
    });
    colony.crew[0].health = 50;
    colony.crew[1].health = 50;
    colony.crew[2].health = 50;
    colony.food = colony.foodCap;

    for (let i = 0; i < 30; i++) colony.step(0.1);

    expect(colony.crew[0].health - 50).toBeCloseTo(2.5, 5); // idle ×1
    expect(colony.crew[1].health - 50).toBeCloseTo(1.875, 5); // building ×0.75
    expect(colony.crew[2].health - 50).toBeCloseTo(1.25, 5); // mission ×0.5
  });

  it('9. death only at 0 HP, no timer', () => {
    const colony = new Colony(1);
    const doomedId = colony.crew[0].id;
    colony.crew[0].health = 2;
    colony.food = 0;
    for (let i = 0; i < 20; i++) colony.step(0.1);

    expect(colony.crewCount).toBe(5);
    expect(colony.crew.find((c) => c.id === doomedId)).toBeUndefined();
    expect(colony.failed).toBe(false);
    for (const c of colony.crew) expect(c.health).toBeGreaterThan(0);
  });

  it('10. away crew eat mission rations, not the larder', () => {
    const colony = new Colony(1);
    colony.step(0.1);
    expect(colony.flows.foodConsumption).toBeCloseTo(6 * (10 / 60), 5); // all 6 home -> all draw larder

    const parked = {
      phase: 'returning' as const,
      phaseElapsed: 0,
      travelTime: 0,
      returnTime: 9999,
      cargo: 0,
      provisions: 9999,
      goal: 0,
      goalFraction: 1,
      starving: false,
      startedAt: 0,
    };
    colony.activeMissions.push({
      id: 1,
      type: 'gatherResources',
      zoneId: colony.zones[0].id,
      crewIds: [colony.crew[0].id, colony.crew[1].id, colony.crew[2].id],
      ...parked,
    });
    colony.step(0.1);
    // any mission type: the 3 away live off rations, only the 3 at home draw the larder
    expect(colony.flows.foodConsumption).toBeCloseTo(3 * (10 / 60), 5);
  });

  it('11. recall while outbound returns over the distance already traveled', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.distance = 5; // travelTime = 10s
    colony.launchMission('gatherResources', z.id, [colony.crew[0].id]);
    const m = colony.activeMissions[0];
    expect(m.travelTime).toBe(10);

    for (let i = 0; i < 30; i++) colony.step(0.1); // 3s out, still traveling
    expect(m.phase).toBe('outbound');
    colony.recallMission(m.id);
    expect(m.phase).toBe('returning');
    expect(m.returnTime).toBeCloseTo(3, 1); // only the time already spent traveling
  });

  it('12. away crew live off rations — they heal at mission rate even mid-famine', () => {
    const colony = new Colony(1);
    const forager = colony.crew[0];
    const stuck = colony.crew[1];
    colony.activeMissions.push({
      id: 3,
      type: 'gatherFood',
      zoneId: colony.zones[0].id,
      crewIds: [forager.id],
      phase: 'returning', // parked away so it doesn't gather/complete during the test
      phaseElapsed: 0,
      travelTime: 0,
      returnTime: 9999,
      cargo: 0,
      provisions: 9999, // stocked with rations -> away crew stays fed
      goal: 0,
      goalFraction: 1,
      starving: false,
      startedAt: 0,
    });
    forager.health = 50;
    stuck.health = 50;
    colony.food = 0; // empty larder -> colony is starving
    for (let i = 0; i < 30; i++) colony.step(0.1); // 3s

    // forager feeds itself and heals at the away-mission rate (0.5 * 50/season)
    expect(forager.health).toBeCloseTo(51.25, 5);
    // a larder-dependent crew drains a full bar/season
    expect(stuck.health).toBeCloseTo(45, 5);
  });

  it('13. skills level up, each level costing more XP', () => {
    const c = new Colony(1).crew[0];
    c.aptitude.explorer = 1; // isolate the leveling curve from the hidden aptitude multiplier
    expect(skillLevel(c, 'explorer')).toBe(0);
    expect(xpToNext('explorer', 0)).toBe(C.SKILLS.explorer.baseXp);
    expect(xpToNext('explorer', 1)).toBe(C.SKILLS.explorer.baseXp * 2);

    gainXp(c, 'explorer', 100); // exactly one level
    expect(c.skills.explorer.level).toBe(1);
    expect(c.skills.explorer.xp).toBe(0);

    gainXp(c, 'explorer', 250); // 200 to reach L2, 50 carried over
    expect(c.skills.explorer.level).toBe(2);
    expect(c.skills.explorer.xp).toBe(50);
  });

  it('14. crew train their skill the whole mission — including travel legs', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.distance = 5; // travelTime 10s -> the first 10s are pure travel, no gathering
    const c = colony.crew[0];
    c.aptitude.explorer = 1; // clean rate
    colony.launchMission('gatherResources', z.id, [c.id]);
    for (let i = 0; i < 50; i++) colony.step(0.1); // 5s, still traveling out

    expect(colony.activeMissions[0].phase).toBe('outbound'); // hasn't reached the zone yet
    expect(c.skills.explorer.xp).toBeCloseTo(50 * C.MISSION_XP_PER_SEC * 0.1, 5); // XP earned while traveling
  });

  it('14b. hidden aptitude scales XP gain (2x learns twice as fast as 1x)', () => {
    const fast = new Colony(1).crew[0];
    const slow = new Colony(1).crew[0];
    fast.aptitude.explorer = 2;
    slow.aptitude.explorer = 1;
    gainXp(fast, 'explorer', 50);
    gainXp(slow, 'explorer', 50);
    // fast banked 100 -> level 1; slow banked 50 -> still level 0 with 50 xp
    expect(fast.skills.explorer.level).toBe(1);
    expect(slow.skills.explorer.level).toBe(0);
    expect(slow.skills.explorer.xp).toBe(50);
  });

  it('15. Explorer levels raise hold size (+1 per level)', () => {
    const colony = new Colony(1);
    const c = colony.crew[0];
    c.aptitude.explorer = 1; // isolate carry from aptitude scaling
    expect(colony.partyCapacity([c.id])).toBe(C.CREW_CARRY); // level 0
    c.skills.explorer.level = 3;
    expect(colony.partyCapacity([c.id])).toBe(C.CREW_CARRY + 3 * C.CARRY_PER_LEVEL);
  });

  it('15b. aptitude scales carry capacity and gather rate (0.5x–2x)', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.resourceAbundance = 100;
    const c = colony.crew[0];
    c.aptitude.explorer = 2; // top aptitude
    expect(colony.crewCarry(c)).toBe(Math.round(C.CREW_CARRY * 2));
    const fast = colony.crewGatherRate(c, z.id, 'gatherResources');
    c.aptitude.explorer = 0.5; // bottom aptitude
    expect(colony.crewCarry(c)).toBe(Math.round(C.CREW_CARRY * 0.5));
    const slow = colony.crewGatherRate(c, z.id, 'gatherResources');
    expect(fast).toBeCloseTo(slow * 4, 6); // 2x vs 0.5x -> 4x gather
  });

  it('15c. leveling up mid-mission raises the goal (still goalFraction of the bigger hold)', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.resourceAbundance = 1000;
    const c = colony.crew[0];
    c.aptitude.explorer = 1; // isolate from aptitude scaling
    c.skills.explorer.level = 0;
    colony.launchMission('gatherResources', z.id, [c.id], C.MISSION_GOALS.quick); // 50%
    colony.step(0.1);
    const m = colony.activeMissions[0];
    const goalBefore = m.goal; // 50% of a level-0 hold
    expect(goalBefore).toBeCloseTo(C.CREW_CARRY * 0.5, 0);

    c.skills.explorer.level = 3; // promoted mid-mission -> hold grows
    colony.step(0.1);
    expect(m.goalFraction).toBe(C.MISSION_GOALS.quick); // fraction unchanged
    expect(m.goal).toBeCloseTo((C.CREW_CARRY + 3 * C.CARRY_PER_LEVEL) * 0.5, 0); // goal grew
    expect(m.goal).toBeGreaterThan(goalBefore);
  });

  it('16. recall while gathering takes a full travel leg home', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.distance = 3; // travelTime 6
    z.resourceAbundance = 1000; // rich, so the run is still gathering (not done) at 7s
    colony.launchMission('gatherResources', z.id, [colony.crew[0].id]);
    for (let i = 0; i < 70; i++) colony.step(0.1); // 6s travel + 1s gather -> gathering
    const m = colony.activeMissions[0];
    expect(m.phase).toBe('gathering');

    colony.recallMission(m.id);
    expect(m.phase).toBe('returning');
    expect(m.returnTime).toBe(6); // full distance back
  });

  it('17. a net-positive food run only provisions for the trip out', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.distance = 5;
    z.foodAbundance = 300; // rich enough that collection rate > consumption for one crew
    const cons = 1 * C.FOOD_PER_CREW;
    const travel = colony.travelTime('gatherFood', z.id);
    const need = colony.provisionsNeeded('gatherFood', z.id, [colony.crew[0].id], 0.5);
    expect(need).toBeCloseTo(cons * travel, 5); // just enough to reach the zone
  });

  it('18. rations come from the larder and unused ones return on completion', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.distance = 5;
    colony.food = 100;
    const before = colony.food;
    colony.launchMission('gatherResources', z.id, [colony.crew[0].id]);
    const taken = before - colony.food;
    expect(taken).toBeGreaterThan(0); // rations drawn from the larder

    colony.recallMission(colony.activeMissions[0].id); // turn around immediately (barely ate)
    for (let i = 0; i < 10 && colony.activeMissions.length; i++) colony.step(0.1);
    expect(colony.food).toBeGreaterThan(before - taken); // most rations returned to the larder
  });

  it('19. rations are capped at the length share of the hold, but only what is needed', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    const cap = colony.partyCapacity([colony.crew[0].id]); // hold size
    colony.food = 1000; // larder isn't the limiter

    // slow ore gather would "need" far more food than the cap -> capped at Quick's 50% of the hold
    z.resourceAbundance = 50;
    const quickOre = colony.missionRations('gatherResources', z.id, [colony.crew[0].id], C.MISSION_GOALS.quick);
    expect(quickOre).toBeCloseTo(cap * 0.5, 5);

    // a net-positive food run needs little -> takes less than the Regular (100%) cap
    z.distance = 5;
    z.foodAbundance = 300;
    const food = colony.missionRations('gatherFood', z.id, [colony.crew[0].id], C.MISSION_GOALS.regular);
    expect(food).toBeLessThan(cap * 1); // well under the 100% cap
    expect(food).toBeGreaterThan(0);
  });

  it('20. research: cost paid up front, completes over time, unlocks the building', () => {
    const colony = new Colony(1);
    colony.food = 250;
    expect(colony.canBuild('garden')).toBe(false); // gated behind the tech
    const before = colony.food;
    expect(colony.startResearch('subsistenceFarming', [colony.crew[0].id])).toBe(true);
    expect(before - colony.food).toBe(C.TECHS[0].cost.food); // 50 food, up front
    expect(colony.techStatus('subsistenceFarming')).toBe('researching');
    for (let i = 0; i < 5000 && colony.activeResearch.length; i++) colony.step(0.1);
    expect(colony.isResearched('subsistenceFarming')).toBe(true);
    expect(colony.canBuild('garden')).toBe(true); // unlocked
  });

  it('21. research crew can be added, removed, and swapped mid-project', () => {
    const colony = new Colony(1);
    colony.food = 250;
    const [a, b, c] = colony.crew;
    colony.startResearch('subsistenceFarming', [a.id]);
    expect(colony.research('subsistenceFarming')!.crewIds).toEqual([a.id]);

    expect(colony.addResearchCrew('subsistenceFarming', b.id)).toBe(true);
    expect(colony.research('subsistenceFarming')!.crewIds).toContain(b.id);
    expect(colony.onResearch(b.id)).toBe(true); // now busy, off the available pool
    expect(colony.availableCrew.some((x) => x.id === b.id)).toBe(false);

    expect(colony.addResearchCrew('subsistenceFarming', b.id)).toBe(false); // already on it
    expect(colony.swapResearchCrew('subsistenceFarming', a.id, c.id)).toBe(true);
    expect(colony.research('subsistenceFarming')!.crewIds).toEqual([c.id, b.id]);

    expect(colony.removeResearchCrew('subsistenceFarming', c.id)).toBe(true);
    expect(colony.research('subsistenceFarming')!.crewIds).toEqual([b.id]);
    expect(colony.removeResearchCrew('subsistenceFarming', b.id)).toBe(false); // never below one
  });
});
