import type { Colony } from '../sim/colony';
import type { CrewMember, CrewTask } from '../sim/types';
import { healthColor } from './format';
import { xpToNext } from '../sim/skills';

const TASKS: { value: CrewTask; label: string }[] = [
  { value: 'building', label: 'Work in Buildings' },
  { value: 'idle', label: 'Idle' },
];
const STATUS: Record<CrewTask, string> = {
  building: 'On shift',
  idle: 'Idle',
};
interface CrewRow {
  el: HTMLElement;
  select: HTMLSelectElement;
  status: HTMLElement;
  hpFill: HTMLElement;
  hpPct: HTMLElement;
  xpFill: HTMLElement;
  lv: HTMLElement;
}

// The Crew page — a roster of named individuals you assign to tasks. Working in
// buildings is the default; other tasks pull them out of the staffing pool.
export function createCrewPage(colony: Colony) {
  const el = document.createElement('div');
  el.className = 'page';
  el.innerHTML = `
    <div class="panel">
      <h2>Crew <span class="crew-summary"></span></h2>
      <div class="crew-list"></div>
    </div>`;

  const summary = el.querySelector('.crew-summary') as HTMLElement;
  const list = el.querySelector('.crew-list') as HTMLElement;
  const rows = new Map<number, CrewRow>();

  function update() {
    const away = colony.crew.filter((c) => colony.onMission(c.id)).length;
    const onShift = colony.buildingCrew;
    const idle = colony.crewCount - away - onShift;
    summary.textContent = `· ${colony.crewCount} aboard — ${onShift} on shift, ${away} on missions, ${idle} idle`;

    const present = new Set<number>();
    for (const c of colony.crew) {
      present.add(c.id);
      let row = rows.get(c.id);
      if (!row) {
        row = createCrewRow(colony, c);
        rows.set(c.id, row);
        list.appendChild(row.el);
      }
      const away = colony.onMission(c.id);
      row.select.disabled = away;
      if (!away && row.select.value !== c.task) row.select.value = c.task;
      row.status.textContent = away ? 'On mission' : STATUS[c.task];
      row.status.className = `crew-status ${away ? 'task-mission' : 'task-' + c.task}`;
      // live health
      const hp = Math.round(c.health);
      row.hpFill.style.width = `${hp}%`;
      row.hpFill.style.background = healthColor(c.health);
      row.hpPct.textContent = `${hp}%`;
      // explorer skill: level + progress toward next
      const sk = c.skills.explorer;
      row.lv.textContent = `L${sk.level}`;
      row.xpFill.style.width = `${(sk.xp / xpToNext('explorer', sk.level)) * 100}%`;
    }
    for (const [id, row] of rows) {
      if (!present.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
  }

  return { el, update };
}

function createCrewRow(colony: Colony, c: CrewMember): CrewRow {
  const el = document.createElement('div');
  el.className = 'crew-row';
  const opts = TASKS.map((t) => `<option value="${t.value}">${t.label}</option>`).join('');
  el.innerHTML = `
    <span class="crew-av">${c.name[0]}</span>
    <span class="crew-name">${c.name}</span>
    <span class="crew-health" title="Health">
      <span class="cstat-l">HP</span>
      <span class="cbar"><span class="cbarf hp"></span></span>
      <span class="hp-pct"></span>
    </span>
    <span class="crew-skill" title="Explorer">
      <span class="msym skill-icon">explore</span>
      <span class="skill-lv"></span>
      <span class="cbar xp"><span class="cbarf xpf"></span></span>
    </span>
    <select class="crew-task">${opts}</select>
    <span class="crew-status"></span>`;
  const select = el.querySelector('.crew-task') as HTMLSelectElement;
  select.value = c.task;
  select.addEventListener('change', () => colony.setTask(c.id, select.value as CrewTask));
  return {
    el,
    select,
    status: el.querySelector('.crew-status') as HTMLElement,
    hpFill: el.querySelector('.cbarf.hp') as HTMLElement,
    hpPct: el.querySelector('.hp-pct') as HTMLElement,
    xpFill: el.querySelector('.cbarf.xpf') as HTMLElement,
    lv: el.querySelector('.skill-lv') as HTMLElement,
  };
}
