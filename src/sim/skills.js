// Generic crew skill/leveling machinery. A skill is just an {xp, level} pair per crew;
// XP is skill-specific and each level costs progressively more. To add a skill: extend
// SkillId (types.ts), add an entry to C.SKILLS (config.ts), and call gainXp() where it's
// earned. Bonuses per level live with whatever system consumes the level.
import * as C from './config';
/** A fresh skill set with every known skill at level 0. */
export function makeSkills() {
    const skills = {};
    for (const id of Object.keys(C.SKILLS))
        skills[id] = { xp: 0, level: 0 };
    return skills;
}
/** A hidden per-skill learning aptitude (XP multiplier), rolled in [APTITUDE_MIN, MAX]. */
export function makeAptitudes(rng) {
    const apt = {};
    for (const id of Object.keys(C.SKILLS))
        apt[id] = C.APTITUDE_MIN + rng() * (C.APTITUDE_MAX - C.APTITUDE_MIN);
    return apt;
}
/** XP required to advance from `level` to `level + 1` (rises each level). */
export function xpToNext(id, level) {
    return C.SKILLS[id].baseXp * (level + 1);
}
/** A crew member's current level in a skill (0 if somehow absent). */
export function skillLevel(crew, id) {
    return crew.skills[id]?.level ?? 0;
}
/** Award XP to a crew member's skill, scaled by their hidden aptitude for it, leveling up
 *  as many times as the XP allows. */
export function gainXp(crew, id, amount) {
    const s = crew.skills[id];
    if (!s)
        return;
    s.xp += amount * (crew.aptitude[id] ?? 1);
    while (s.xp >= xpToNext(id, s.level)) {
        s.xp -= xpToNext(id, s.level);
        s.level++;
    }
}
