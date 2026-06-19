import { describe, it, expect } from 'vitest';
import { Colony } from './colony';
import * as C from './config';

describe('Colony sim regression suite', () => {
  it('1. is deterministic for a given seed and differs across seeds', () => {
    const a = new Colony(42);
    const b = new Colony(42);
    expect(a.zones[0].fertility).toBeCloseTo(b.zones[0].fertility, 5);
    expect(a.crew[0].stats.vigor).toBe(b.crew[0].stats.vigor);

    const c = new Colony(7);
    expect(c.zones[0].fertility).not.toBeCloseTo(a.zones[0].fertility, 5);
  });

  it('2. home geology splits 100 points and abundances mirror geology', () => {
    const z = new Colony(1).zones[0];
    const fertPct = Math.round(z.fertility * 100);
    const orePct = Math.round(z.oreRichness * 100);
    expect(fertPct + orePct).toBe(100);
    expect(fertPct).toBeGreaterThanOrEqual(40);
    expect(fertPct).toBeLessThanOrEqual(60);
    expect(z.foodAbundance).toBe(fertPct);
    expect(z.resourceAbundance).toBe(orePct);
  });

  it('3. food cap is the fixed command larder, not crew-scaled', () => {
    const colony = new Colony();
    expect(colony.foodCap).toBe(30);
    expect(colony.foodCap).toBe(C.FOOD_STORAGE.command);
    colony.crew.length = 3;
    expect(colony.foodCap).toBe(30);
  });

  it('4. crew start at full health', () => {
    const colony = new Colony();
    for (const c of colony.crew) expect(c.health).toBe(C.HEALTH_MAX);
  });

  it('5. gather yields: food has a per-crew carry cap of 5, ore does not', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];

    z.foodAbundance = 100;
    expect(colony.missionYield('gatherFood', z.id, 3)).toBe(15);

    z.foodAbundance = 40;
    expect(colony.missionYield('gatherFood', z.id, 3)).toBe(6);

    z.resourceAbundance = 80;
    expect(colony.missionYield('gatherResources', z.id, 4)).toBe(16);
  });

  it('6. season-aware forecast differs from current-abundance yield', () => {
    const colony = new Colony(5);
    const z = colony.zones[0];
    colony.elapsed = 50;
    z.fertility = 0.5;
    z.foodAbundance = 40;

    expect(colony.missionYield('gatherFood', z.id, 2)).toBe(4);
    expect(colony.missionForecast('gatherFood', z.id, 2)).toBe(9);
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
      elapsed: 0,
      duration: 999,
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

  it('10. foragers do not eat from the larder', () => {
    const colony = new Colony(1);
    colony.step(0.1);
    expect(colony.flows.foodConsumption).toBeCloseTo(6 * (2 / 60), 5); // 0.2

    colony.activeMissions.push({
      id: 1,
      type: 'gatherFood',
      zoneId: colony.zones[0].id,
      crewIds: [colony.crew[0].id, colony.crew[1].id, colony.crew[2].id],
      elapsed: 0,
      duration: 999,
    });
    colony.step(0.1);
    expect(colony.flows.foodConsumption).toBeCloseTo(0.1, 5); // only 3 eat

    colony.activeMissions = [
      {
        id: 2,
        type: 'gatherResources',
        zoneId: colony.zones[0].id,
        crewIds: [colony.crew[0].id, colony.crew[1].id, colony.crew[2].id],
        elapsed: 0,
        duration: 999,
      },
    ];
    colony.step(0.1);
    expect(colony.flows.foodConsumption).toBeCloseTo(0.2, 5); // resource crew still eat
  });

  it('11. gather depletion equals the amount found, applied on resolve', () => {
    const colony = new Colony(1);
    const z = colony.zones[0];
    z.resourceAbundance = 80;
    colony.iron = 0;
    colony.activeMissions.push({
      id: 2,
      type: 'gatherResources',
      zoneId: z.id,
      crewIds: [colony.crew[0].id, colony.crew[1].id],
      elapsed: 0,
      duration: 0.05,
    });
    colony.step(0.1);

    expect(colony.iron).toBe(8);
    expect(z.resourceAbundance).toBe(72);
  });

  it('12. food foragers do not starve — they heal at mission rate mid-famine', () => {
    const colony = new Colony(1);
    const forager = colony.crew[0];
    const stuck = colony.crew[1];
    colony.activeMissions.push({
      id: 3,
      type: 'gatherFood',
      zoneId: colony.zones[0].id,
      crewIds: [forager.id],
      elapsed: 0,
      duration: 999,
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
});
