// Generic crew skill/leveling machinery. A skill is just an {xp, level} pair per crew;
// XP is skill-specific and each level costs progressively more. To add a skill: extend
// SkillId (types.ts), add an entry to C.SKILLS (config.ts), and call gainXp() where it's
// earned. Bonuses per level live with whatever system consumes the level.

import * as C from './config';
import type { CrewMember, Skill, SkillId } from './types';

/** A fresh skill set with every known skill at level 0. */
export function makeSkills(): Record<SkillId, Skill> {
  const skills = {} as Record<SkillId, Skill>;
  for (const id of Object.keys(C.SKILLS) as SkillId[]) skills[id] = { xp: 0, level: 0 };
  return skills;
}

/** XP required to advance from `level` to `level + 1` (rises each level). */
export function xpToNext(id: SkillId, level: number): number {
  return C.SKILLS[id].baseXp * (level + 1);
}

/** A crew member's current level in a skill (0 if somehow absent). */
export function skillLevel(crew: CrewMember, id: SkillId): number {
  return crew.skills[id]?.level ?? 0;
}

/** Award XP to a crew member's skill, leveling up as many times as the XP allows. */
export function gainXp(crew: CrewMember, id: SkillId, amount: number): void {
  const s = crew.skills[id];
  if (!s) return;
  s.xp += amount;
  while (s.xp >= xpToNext(id, s.level)) {
    s.xp -= xpToNext(id, s.level);
    s.level++;
  }
}
