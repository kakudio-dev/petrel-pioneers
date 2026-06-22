import type { Colony, CompletedMission, MissionType } from '../sim/colony';
import type { CrewMember } from '../sim/types';
import type { SkillId } from '../sim/types';
import { healthColor, netClass, rate, seasonsLabel, secs } from './format';
import { xpToNext } from '../sim/skills';
import { SKILLS, MISSION_GOALS, MISSION_CREW_MAX, SEASON_LENGTH, type MissionGoal } from '../sim/config';

const GOAL_LABELS: Record<MissionGoal, string> = { quick: 'Quick', regular: 'Regular' };

/** Crew pick order for a mission's skill: highest innate aptitude first (the hidden learning
 *  multiplier rolled at creation). Ties break on crew id for a stable order. */
function crewPickOrder(a: CrewMember, b: CrewMember, skillId: SkillId): number {
  const apA = a.aptitude[skillId] ?? 1;
  const apB = b.aptitude[skillId] ?? 1;
  if (apA !== apB) return apB - apA; // higher aptitude first
  return a.id - b.id; // stable tiebreak
}

const LABEL: Record<MissionType, string> = {
  explore: 'Explore',
  gatherFood: 'Gather Food',
  gatherResources: 'Gather Resources',
};
const ICON: Record<MissionType, string> = {
  explore: 'travel_explore',
  gatherFood: 'grass',
  gatherResources: 'terrain',
};
const DESC: Record<MissionType, string> = {
  explore: 'Chart a new zone',
  gatherFood: 'Forage this zone for food',
  gatherResources: 'Mine this zone for ore',
};
const GATHER_TYPES: MissionType[] = ['gatherFood', 'gatherResources'];

export function createMissionsPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Active Missions <span class="active-count"></span></h2>
      <div class="active-list"></div>
    </div>
    <div class="panel">
      <h2>Recent Missions</h2>
      <div class="recent-list"><div class="empty">No completed missions yet.</div></div>
    </div>
    <div class="panel">
      <h2>Zones <span class="zone-count"></span></h2>
      <div class="zone-list"></div>
    </div>`;

  const activeCount = el.querySelector('.active-count') as HTMLElement;
  const activeList = el.querySelector('.active-list') as HTMLElement;
  const zoneCount = el.querySelector('.zone-count') as HTMLElement;
  const zoneList = el.querySelector('.zone-list') as HTMLElement;
  const recentList = el.querySelector('.recent-list') as HTMLElement;

  const openZones = new Set<number>(); // expanded zone ids (multiple allowed)
  const home = colony.zones.find((z) => z.home); // expand the home zone (The Roost) by default
  if (home) openZones.add(home.id);
  const openMissions = new Set<number>(); // active missions expanded to show their crew
  const teams = new Map<string, Set<number>>(); // open mission setup -> staged crew
  const goals = new Map<string, MissionGoal>(); // open mission setup -> chosen goal preset
  const goalOf = (key: string): MissionGoal => goals.get(key) ?? 'regular';
  const choosing = new Map<string, number>(); // setup key -> the spot's crew id being reassigned
  let activeSig = '';
  let zoneSig = '';
  let recentSig = '';
  const fills = new Map<
    number,
    {
      fill: HTMLElement;
      left: HTMLElement;
      phase: HTMLElement;
      gather: HTMLElement | null;
      cons: HTMLElement | null;
      net: HTMLElement | null;
    }
  >();

  // Pre-launch preview: the goal, the food it costs, and an approximate round-trip time.
  function previewHTML(type: MissionType, zoneId: number | null, crewIds: number[], goal: MissionGoal): string {
    const fraction = MISSION_GOALS[goal];
    const cost = Math.round(colony.missionRations(type, zoneId, crewIds, fraction));
    const eta = seasonsLabel(colony.estimateRunSeconds(type, zoneId, crewIds, fraction));
    const headline =
      type === 'explore'
        ? colony.zonesRemaining
          ? 'Goal: discover a new zone'
          : 'Region fully explored'
        : `Goal: collect ${colony.goalAmount(crewIds, fraction)} ${type === 'gatherFood' ? 'food' : 'ore'}`;
    return `<div class="prev-goal">${headline}</div>
      <div class="prev-meta">costs ~${cost} food · ${eta} round trip</div>`;
  }

  // Best free crew for a mission's skill, in pick order (most experienced first).
  function rankedFree(skill: SkillId, excludeIds: Set<number>): CrewMember[] {
    return colony.availableCrew
      .filter((c) => !excludeIds.has(c.id))
      .sort((a, b) => crewPickOrder(a, b, skill));
  }
  // Crew may be staged in multiple pending setups at once; they only become exclusive when
  // a mission is launched. A setup opens auto-filled with the best `count` free crew.
  function autoFill(key: string, count: number, skill: SkillId) {
    const t = new Set<number>();
    const want = Math.min(Math.max(1, count), MISSION_CREW_MAX);
    for (const c of rankedFree(skill, t)) {
      if (t.size >= want) break;
      t.add(c.id);
    }
    teams.set(key, t);
  }

  function toggleZone(id: number) {
    if (openZones.has(id)) {
      openZones.delete(id);
      for (const k of [...teams.keys()]) if (k.startsWith(`${id}:`)) closeSetup(k);
    } else {
      openZones.add(id);
    }
    renderZones();
  }
  // The mission type encoded in a setup key (`${zoneId}:${type}` or 'explore').
  function typeForKey(key: string): MissionType {
    return key === 'explore' ? 'explore' : (key.split(':')[1] as MissionType);
  }
  function closeSetup(key: string) {
    teams.delete(key);
    goals.delete(key);
    choosing.delete(key);
  }
  function toggleMission(key: string) {
    if (teams.has(key)) closeSetup(key);
    else autoFill(key, 1, colony.missionSkill(typeForKey(key)));
    renderZones();
  }

  // Launch a mission and clear the committed crew from any other pending setups.
  function commitLaunch(type: MissionType, zoneId: number | null, crewIds: number[], goal: MissionGoal) {
    if (crewIds.length === 0) return;
    colony.launchMission(type, zoneId, crewIds, MISSION_GOALS[goal]);
    for (const [, t] of teams) for (const id of crewIds) t.delete(id);
    renderZones();
  }

  // Can a logged mission be re-run right now? (crew free, and zones left for explore)
  function canRerun(m: CompletedMission): boolean {
    if (m.type === 'explore' && !colony.zonesRemaining) return false;
    return colony.availableCrew.length > 0;
  }

  // The replay button expands the recent mission into the same planning widget used to
  // create it, pre-filled with the original crew count.
  function toggleRecent(m: CompletedMission) {
    const key = `recent:${m.id}`;
    if (teams.has(key)) closeSetup(key);
    else {
      if (!canRerun(m)) return;
      autoFill(key, m.crew, colony.missionSkill(m.type));
    }
    renderRecent();
  }

  function setupHTML(key: string, type: MissionType, zoneId: number | null): string {
    const t = teams.get(key) ?? new Set<number>();
    const skill = colony.missionSkill(type);
    const team = colony.crew.filter((c) => t.has(c.id)).sort((a, b) => crewPickOrder(a, b, skill));
    const choosingId = choosing.get(key);

    // crew-count stepper (1..MISSION_CREW_MAX, also bounded by available crew)
    const canAdd = team.length < MISSION_CREW_MAX && colony.crew.some((c) => !colony.onMission(c.id) && !t.has(c.id));
    const stepper = `<div class="crew-stepper">
      <span class="crew-count">${team.length} / ${MISSION_CREW_MAX} crew</span>
      <div class="crew-spin">
        <button class="crew-step" data-step="1"${canAdd ? '' : ' disabled'}><span class="msym">keyboard_arrow_up</span></button>
        <button class="crew-step" data-step="-1"${team.length > 1 ? '' : ' disabled'}><span class="msym">keyboard_arrow_down</span></button>
      </div>
    </div>`;

    const cards = team.length
      ? team.map((c) => crewCardHTML(c, skill, c.id === choosingId, colony, type, zoneId)).join('')
      : '<div class="empty">No crew available.</div>';

    // chooser: tap a spot to pick who fills it (candidates sorted best-first for this skill)
    let chooser = '';
    if (choosingId !== undefined) {
      const candidates = colony.crew
        .filter((c) => !colony.onMission(c.id) && (!t.has(c.id) || c.id === choosingId))
        .sort((a, b) => crewPickOrder(a, b, skill));
      chooser = `<div class="crew-chooser">${candidates.map((c) => chooserRowHTML(c, skill, c.id === choosingId)).join('')}</div>`;
    }

    // gather missions let the player pick a cargo goal; explore is a fixed there-and-back
    const goalToggle =
      type === 'explore'
        ? ''
        : `<div class="goal-toggle">${(Object.keys(MISSION_GOALS) as MissionGoal[])
            .map(
              (g) =>
                `<button class="len-btn${goalOf(key) === g ? ' active' : ''}" data-len="${g}">${GOAL_LABELS[g]} ${Math.round(MISSION_GOALS[g] * 100)}%</button>`,
            )
            .join('')}</div>`;
    return `<div class="setup" data-key="${key}" data-mt="${type}" data-zone="${zoneId ?? 'x'}">
      <div class="setup-controls">${goalToggle}${stepper}</div>
      <div class="crew-cards">${cards}</div>
      ${chooser}
      <div class="setup-preview">${previewHTML(type, zoneId, [...t], goalOf(key))}</div>
      <div class="setup-foot"><button class="setup-launch">Launch</button></div>
    </div>`;
  }

  function geoHTML(z: { fertility: number; oreRichness: number }): string {
    return `<div class="zgeo">
      <span class="zgeo-item"><span class="msym">eco</span> Fertility <b>${Math.round(z.fertility * 100)}</b></span>
      <span class="zgeo-item"><span class="msym">diamond</span> Ore richness <b>${Math.round(z.oreRichness * 100)}</b></span>
    </div>`;
  }

  function missionSubHTML(zoneId: number, type: MissionType): string {
    const key = `${zoneId}:${type}`;
    const open = teams.has(key);
    return `<div class="msub${open ? ' open' : ''}">
      <div class="msub-head clickable" data-key="${key}">
        <span class="msym msub-icon">${ICON[type]}</span>
        <span class="msub-name"><b>${LABEL[type]}</b> <span class="mission-desc">${DESC[type]}</span></span>
        <span class="msym zrow-chev">${open ? 'expand_less' : 'expand_more'}</span>
      </div>
      ${open ? `<div class="msub-body">${setupHTML(key, type, zoneId)}</div>` : ''}</div>`;
  }

  function renderZones() {
    zoneList.innerHTML = '';

    for (const z of colony.zones) {
      const zoneOpen = openZones.has(z.id);
      const row = document.createElement('div');
      row.className = `zrow${z.home ? ' home' : ''}${zoneOpen ? ' open' : ''}`;
      const tag = z.home ? '<span class="zone-tag">HUB</span>' : '';
      const body = zoneOpen
        ? `<div class="zrow-body">${geoHTML(z)}${GATHER_TYPES.map((t) => missionSubHTML(z.id, t)).join('')}</div>`
        : '';
      row.innerHTML = `
        <div class="zrow-head clickable">
          <span class="msym zrow-icon">${z.home ? 'hub' : 'place'}</span>
          <span class="zrow-name"><b>${z.name}</b> <span class="mission-desc">${z.kind}</span></span>
          <span class="zstats">
            <span class="zstat" title="Food abundance"><span class="msym">grass</span> <span data-zfood="${z.id}">${Math.round(z.foodAbundance)}</span></span>
            <span class="zstat" title="Resource abundance"><span class="msym">terrain</span> <span data-zres="${z.id}">${Math.round(z.resourceAbundance)}</span></span>
          </span>
          ${tag}<span class="msym zrow-chev">${zoneOpen ? 'expand_less' : 'expand_more'}</span>
        </div>${body}`;
      row.querySelector('.zrow-head')!.addEventListener('click', () => toggleZone(z.id));
      if (zoneOpen) {
        row.querySelectorAll('.msub-head').forEach((h) =>
          h.addEventListener('click', () => toggleMission((h as HTMLElement).dataset.key!)),
        );
      }
      zoneList.appendChild(row);
    }

    // Explore row at the bottom (its own setup; no target zone)
    const exploreOpen = teams.has('explore');
    const canExplore = colony.zonesRemaining;
    const erow = document.createElement('div');
    erow.className = `zrow explore${exploreOpen ? ' open' : ''}`;
    erow.innerHTML = `
      <div class="zrow-head${canExplore ? ' clickable' : ''}">
        <span class="msym zrow-icon">travel_explore</span>
        <span class="zrow-name"><b>Explore</b> <span class="mission-desc">${canExplore ? 'Chart a new zone' : 'Region fully explored'}</span></span>
        ${canExplore ? `<span class="msym zrow-chev">${exploreOpen ? 'expand_less' : 'expand_more'}</span>` : ''}
      </div>
      ${exploreOpen ? `<div class="zrow-body">${setupHTML('explore', 'explore', null)}</div>` : ''}`;
    if (canExplore) erow.querySelector('.zrow-head')!.addEventListener('click', () => toggleMission('explore'));
    zoneList.appendChild(erow);

    wireSetups(zoneList, renderZones);
  }

  function wireSetups(container: HTMLElement, rerender: () => void) {
    container.querySelectorAll('.setup').forEach((setupEl) => {
      const key = (setupEl as HTMLElement).dataset.key!;
      const type = (setupEl as HTMLElement).dataset.mt as MissionType;
      const zraw = (setupEl as HTMLElement).dataset.zone!;
      const zoneId = zraw === 'x' ? null : Number(zraw);
      const team = teams.get(key);
      if (!team) return;
      const skill = colony.missionSkill(type);

      // crew-count stepper: + auto-fills the best free crew, − drops the lowest-ranked
      setupEl.querySelectorAll('.crew-step').forEach((btn) =>
        btn.addEventListener('click', () => {
          const step = Number((btn as HTMLElement).dataset.step);
          if (step > 0 && team.size < MISSION_CREW_MAX) {
            const add = rankedFree(skill, team)[0];
            if (add) team.add(add.id);
          } else if (step < 0 && team.size > 1) {
            const worst = colony.crew
              .filter((c) => team.has(c.id))
              .sort((a, b) => crewPickOrder(a, b, skill))
              .pop();
            if (worst) team.delete(worst.id);
          }
          choosing.delete(key);
          rerender();
        }),
      );
      // tap a spot to open its chooser (or close it if already open)
      setupEl.querySelectorAll('.crew-card').forEach((card) =>
        card.addEventListener('click', () => {
          const id = Number((card as HTMLElement).dataset.spot);
          if (choosing.get(key) === id) choosing.delete(key);
          else choosing.set(key, id);
          rerender();
        }),
      );
      // pick a candidate to fill the open spot
      setupEl.querySelectorAll('.chooser-row').forEach((row) =>
        row.addEventListener('click', () => {
          const spot = choosing.get(key);
          const pick = Number((row as HTMLElement).dataset.pick);
          if (spot !== undefined && pick !== spot) {
            team.delete(spot);
            team.add(pick);
          }
          choosing.delete(key);
          rerender();
        }),
      );
      setupEl.querySelectorAll('.len-btn').forEach((btn) =>
        btn.addEventListener('click', () => {
          goals.set(key, (btn as HTMLElement).dataset.len as MissionGoal);
          rerender();
        }),
      );
      const launch = setupEl.querySelector('.setup-launch') as HTMLButtonElement;
      launch.disabled = team.size < 1;
      launch.addEventListener('click', () => {
        const committed = [...team];
        if (committed.length === 0) return;
        const goal = goalOf(key);
        closeSetup(key);
        commitLaunch(type, zoneId, committed, goal);
        rerender();
      });
    });
  }

  function update() {
    // active missions
    activeCount.textContent = `(${colony.activeMissions.length})`;
    const sig = colony.activeMissions.map((m) => m.id).join(',');
    if (sig !== activeSig) {
      activeSig = sig;
      fills.clear();
      if (colony.activeMissions.length === 0) {
        activeList.innerHTML = '<div class="empty">No active missions.</div>';
      } else {
        activeList.innerHTML = '';
        for (const m of colony.activeMissions) {
          const zone = colony.zones.find((z) => z.id === m.zoneId);
          const skill = colony.missionSkill(m.type);
          const team = m.crewIds
            .map((id) => colony.crew.find((c) => c.id === id))
            .filter(Boolean)
            .map((c) => crewCardHTML(c as CrewMember, skill, false, colony, m.type, m.zoneId, false))
            .join('');
          const open = openMissions.has(m.id);
          const card = document.createElement('div');
          card.className = `amission${open ? ' open' : ''}`;
          card.innerHTML = `
            <div class="amission-head clickable">
              <span class="msym mission-icon">${ICON[m.type]}</span>
              <span class="amission-name"><b>${LABEL[m.type]}</b> <span class="mission-desc">${zone ? zone.name : 'Uncharted region'}</span></span>
              <span class="m-phase"></span>
              <span class="m-prog"><span class="m-fill"></span></span>
              <span class="m-left"></span>
              <span class="msym m-chev">${open ? 'expand_less' : 'expand_more'}</span>
            </div>
            <div class="amission-body">
              <div class="crew-cards">${team}</div>
              ${
                m.type === 'explore'
                  ? ''
                  : `<div class="mrates">
                <span class="mrate" title="Total cargo the party gathers into the shared hold each season.">Gathering<span class="mr-gather"></span></span>
                <span class="mrate" title="Food the crew eats from the hold each season.">Consumption<span class="mr-cons"></span></span>
                <span class="mrate" title="Net change in the hold each season — gathering minus consumption.">Net<span class="mr-net"></span></span>
              </div>`
              }
              <div class="amission-foot"><button class="m-recall">Recall</button></div>
            </div>`;
          const recall = card.querySelector('.m-recall') as HTMLElement;
          recall.addEventListener('click', () => colony.recallMission(m.id));
          const chev = card.querySelector('.m-chev') as HTMLElement;
          card.querySelector('.amission-head')!.addEventListener('click', () => {
            const nowOpen = !openMissions.has(m.id);
            if (nowOpen) openMissions.add(m.id);
            else openMissions.delete(m.id);
            card.classList.toggle('open', nowOpen);
            chev.textContent = nowOpen ? 'expand_less' : 'expand_more';
          });
          activeList.appendChild(card);
          fills.set(m.id, {
            fill: card.querySelector('.m-fill') as HTMLElement,
            left: card.querySelector('.m-left') as HTMLElement,
            phase: card.querySelector('.m-phase') as HTMLElement,
            gather: card.querySelector('.mr-gather'),
            cons: card.querySelector('.mr-cons'),
            net: card.querySelector('.mr-net'),
          });
        }
      }
    }
    for (const m of colony.activeMissions) {
      const r = fills.get(m.id);
      if (!r) continue;
      const unit = m.type === 'gatherFood' ? 'food' : 'ore';
      const rations = m.starving ? 'out of food!' : `rations ${Math.ceil(m.provisions)}`;
      let progress = 1;
      let phaseText = '';
      if (m.phase === 'outbound') {
        progress = m.travelTime > 0 ? m.phaseElapsed / m.travelTime : 1;
        phaseText = `${m.type === 'explore' ? 'Scouting' : 'Traveling out'} · ${rations}`;
      } else if (m.phase === 'gathering') {
        progress = m.goal > 0 ? m.cargo / m.goal : 1; // fill the bar toward the goal
        phaseText = `Gathering · ${Math.floor(m.cargo)}/${m.goal} ${unit} · ${rations}`;
      } else {
        progress = m.returnTime > 0 ? m.phaseElapsed / m.returnTime : 1;
        phaseText =
          m.type === 'explore' ? `Returning · ${rations}` : `Returning · ${Math.round(m.cargo)} ${unit}`;
      }
      r.fill.style.width = `${Math.min(100, progress * 100)}%`;
      r.phase.textContent = phaseText;
      r.left.textContent = `~${secs(colony.missionEta(m))}`;
      if (r.gather && r.cons && r.net) {
        // gathering only happens while working the zone; eating happens the whole trip
        const gather = m.phase === 'gathering' ? colony.missionGatherRate(m) : 0;
        const cons = colony.missionFoodUse(m);
        const net = gather - cons;
        r.gather.textContent = rate(gather);
        r.gather.className = `mr-gather ${netClass(gather)}`;
        r.cons.textContent = rate(-cons);
        r.cons.className = `mr-cons ${netClass(-cons)}`;
        r.net.textContent = rate(net);
        r.net.className = `mr-net ${netClass(net)}`;
      }
    }

    // zones (re-render on zone or mission-set change; keeps crew availability fresh)
    zoneCount.textContent = `(${colony.zones.length})`;
    const zsig = colony.zones.map((z) => z.id).join(',') + '|' + sig;
    if (zsig !== zoneSig) {
      zoneSig = zsig;
      renderZones();
    }
    // live-update abundance % without rebuilding rows (so clicks survive)
    for (const z of colony.zones) {
      const f = zoneList.querySelector(`[data-zfood="${z.id}"]`);
      const r = zoneList.querySelector(`[data-zres="${z.id}"]`);
      if (f) f.textContent = `${Math.round(z.foodAbundance)}`;
      if (r) r.textContent = `${Math.round(z.resourceAbundance)}`;
    }

    // recent completed missions — re-render when the log OR re-run availability changes
    const rsig =
      colony.completedMissions.map((m) => m.id).join(',') +
      `|${colony.availableCrew.length}|${colony.zonesRemaining}`;
    if (rsig !== recentSig) {
      recentSig = rsig;
      renderRecent();
    }
    updateCrewStats(); // keep HP + Explorer level/XP on setup/active crew rows live
  }

  // Live-fill HP and the Explorer level/XP bar on every mission crew row.
  function updateCrewStats() {
    el.querySelectorAll('.mcrew-row[data-crew], .crew-card[data-crew]').forEach((row) => {
      const c = colony.crew.find((x) => x.id === Number((row as HTMLElement).dataset.crew));
      if (!c) return;
      const fill = row.querySelector('.cbarf.hp') as HTMLElement | null;
      const pct = row.querySelector('.hp-pct') as HTMLElement | null;
      if (fill && pct) {
        const hp = Math.round(c.health);
        fill.style.width = `${hp}%`;
        fill.style.background = healthColor(c.health);
        pct.textContent = `${hp}%`;
      }
      const skillEl = row.querySelector('.mcrew-skill') as HTMLElement | null;
      const lv = skillEl?.querySelector('.skill-lv') as HTMLElement | null;
      const xpFill = skillEl?.querySelector('.cbarf.xpf') as HTMLElement | null;
      if (skillEl && lv && xpFill) {
        const skillId = skillEl.dataset.skill as SkillId;
        const sk = c.skills[skillId];
        lv.textContent = `L${sk.level}`;
        xpFill.style.width = `${(sk.xp / xpToNext(skillId, sk.level)) * 100}%`;
      }
    });
  }

  function renderRecent() {
    const log = colony.completedMissions;
    if (!log.length) {
      recentList.innerHTML = '<div class="empty">No completed missions yet.</div>';
      return;
    }
    recentList.innerHTML = log
      .map((m) => {
        const key = `recent:${m.id}`;
        const open = teams.has(key);
        const setup = open ? `<div class="recent-setup">${setupHTML(key, m.type, m.zoneId)}</div>` : '';
        return `<div class="recent-item${open ? ' open' : ''}">${recentRowHTML(m, canRerun(m), open)}${setup}</div>`;
      })
      .join('');
    recentList.querySelectorAll('.recent-rerun').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const m = colony.completedMissions.find((x) => x.id === Number((btn as HTMLElement).dataset.mid));
        if (m) toggleRecent(m);
      }),
    );
    wireSetups(recentList, renderRecent);
    updateCrewStats();
  }

  return { el, update };
}

function recentRowHTML(m: CompletedMission, rerunnable: boolean, open: boolean): string {
  let sub: string;
  let got: string;
  if (m.type === 'explore') {
    sub = `${m.crew} crew`;
    got = m.zoneName ? `Discovered ${m.zoneName}` : 'Region explored';
  } else {
    sub = `${m.zoneName} · ${m.crew} crew`;
    got = m.type === 'gatherFood' ? `+${m.amount} food` : `+${m.amount} ore`;
  }
  // collapsed row reports what actually happened; the expanded setup shows the prediction
  return `<div class="recent-row">
    <span class="msym recent-icon">${ICON[m.type]}</span>
    <span class="recent-main"><b>${LABEL[m.type]}</b> <span class="mission-desc">${sub}</span></span>
    <span class="recent-result"><span class="recent-got">${got}</span><span class="recent-took">took ${secs(m.duration)}</span></span>
    <button class="recent-rerun${open ? ' open' : ''}" data-mid="${m.id}"${rerunnable ? '' : ' disabled'} title="${open ? 'Hide' : 'Plan a repeat'}"><span class="msym">${open ? 'expand_less' : 'replay'}</span></button>
  </div>`;
}

// A crew card showing carry capacity, gather rate at the zone, and level + XP progress.
// In the prep screen it's an interactive spot (tap to choose who fills it); on an active
// mission it's a static read-out (interactive = false).
function crewCardHTML(
  c: CrewMember,
  skillId: SkillId,
  choosing: boolean,
  colony: Colony,
  type: MissionType,
  zoneId: number | null,
  interactive = true,
): string {
  const skill = SKILLS[skillId];
  const carry = colony.crewCarry(c);
  const unit = type === 'gatherResources' ? 'ore' : 'food';
  const perSeason = Math.round(colony.crewGatherRate(c, zoneId, type) * SEASON_LENGTH);
  // Tooltips describe each stat qualitatively — what it is and what drives it, no formulas.
  const carryTip = `How much cargo this crew member can haul home on a mission. More skilled gatherers can carry more.`;
  const gatherTip = `This crew member is able to gather ${perSeason} ${unit} per season in this zone. This amount is determined by the amount of the resource available and the crew member's skill in gathering.`;
  const skillTip = `${skill.name} skill — improves by going on missions. More skilled crew carry more and gather faster.`;
  const hpTip = `Health — drops while the crew starves, recovers while fed. A crew member dies at 0.`;
  const gatherStat =
    type === 'explore'
      ? ''
      : `<span class="crew-stat"><span class="msym" title="${gatherTip}">eco</span>${rate(colony.crewGatherRate(c, zoneId, type))}</span>`;
  const tag = interactive ? 'button' : 'div';
  const attrs = interactive
    ? `class="crew-card${choosing ? ' choosing' : ''}" data-spot="${c.id}" data-crew="${c.id}"`
    : `class="crew-card static" data-crew="${c.id}"`;
  return `<${tag} ${attrs}>
    <span class="crew-name">${c.name}</span>
    <span class="crew-stats">
      <span class="crew-stat"><span class="msym" title="${carryTip}">inventory_2</span>+${carry} capacity</span>
      ${gatherStat}
    </span>
    <span class="mcrew-skill" data-skill="${skillId}"><span class="msym skill-icon" title="${skillTip}">${skill.icon}</span><span class="skill-lv"></span><span class="cbar xp"><span class="cbarf xpf"></span></span></span>
    <span class="mcrew-hp"><span class="cbar" title="${hpTip}"><span class="cbarf hp"></span></span><span class="hp-pct"></span></span>
  </${tag}>`;
}

// A candidate row in the spot chooser, showing level and XP-to-next so the order reads clearly.
function chooserRowHTML(c: CrewMember, skillId: SkillId, selected: boolean): string {
  const skill = SKILLS[skillId];
  const s = c.skills[skillId];
  const toNext = Math.max(0, Math.round(xpToNext(skillId, s.level) - s.xp));
  return `<button class="chooser-row${selected ? ' selected' : ''}" data-pick="${c.id}">
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="chooser-skill"><span class="msym skill-icon">${skill.icon}</span> L${s.level}</span>
    <span class="chooser-next">${toNext} to next</span>
  </button>`;
}
