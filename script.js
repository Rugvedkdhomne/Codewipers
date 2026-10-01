/* ============================================================
   MEDTRACK PRO — Advanced Medicine Reminder
   ============================================================ */
'use strict';

/* ---------- Constants ---------- */
const STORAGE_KEY = 'medtrack.pro.v2';
const SLOTS = { 1: ['morning'], 2: ['morning', 'night'], 3: ['morning', 'afternoon', 'night'] };
const LABELS = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const ORDER = ['morning', 'afternoon', 'night'];
const DEFAULT_TIMES = { morning: '09:00', afternoon: '14:00', night: '21:00' };

/* ---------- State ---------- */
const state = {
  meds: [],
  size: 'normal',
  contrast: false,
  testDate: null,
  notify: false,
  defTimes: { ...DEFAULT_TIMES }
};

let currentView = 'dash';
let noticeMessage = '';
let memoryOnly = false;
let lastCheckedDay = '';
let lastCheckedMinute = 0;
let justTakenKey = '';
const notifiedSet = new Set();
let toastTimer = null;
let selectedDay = null;
let modalResolver = null;

/* ============================================================
   DATE UTILITIES
   ============================================================ */
const pad2 = n => String(n).padStart(2, '0');
const toYMD = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYMD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toUTC = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYMD(s); d.setDate(d.getDate() + n); return toYMD(d); };
const daysBetween = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 86400000);
const isValidYMD = s => /^\d{4}-\d\d-\d\d$/.test(s || '') && toYMD(parseYMD(s)) === s;
const today = () => (state.testDate && isValidYMD(state.testDate)) ? state.testDate : toYMD(new Date());

const formatLong = s => {
  const d = parseYMD(s);
  return d.toLocaleDateString('en-GB', { weekday: 'long' }) + ', ' +
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
const formatShort = s => parseYMD(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const to12h = h => {
  const [a, b] = h.split(':').map(Number);
  return ((a + 11) % 12 + 1) + ':' + pad2(b) + (a < 12 ? ' AM' : ' PM');
};
const isoTo12h = iso => {
  const d = new Date(iso);
  return to12h(pad2(d.getHours()) + ':' + pad2(d.getMinutes()));
};
const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ============================================================
   COURSE LOGIC
   ============================================================ */
const getCourseEndDate = med => addDays(med.startDate, med.durationDays - 1);
const getCourseDay = (med, date) => daysBetween(date, med.startDate) + 1;
const getCourseState = (med, date) =>
  date < med.startDate ? 'upcoming' :
  date > getCourseEndDate(med) ? 'completed' : 'active';
const isActive = (med, date = today()) => getCourseState(med, date) === 'active';

function getDosesForDate(date = today()) {
  const doses = [];
  state.meds.filter(m => isActive(m, date)).forEach(med => {
    SLOTS[med.dosesPerDay].forEach(slot => {
      const key = `${date}|${slot}`;
      doses.push({
        med,
        slot,
        key,
        time: med.times[slot] || DEFAULT_TIMES[slot],
        takenAt: med.log[key] || null
      });
    });
  });
  return doses.sort((a, b) =>
    ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot) ||
    a.time.localeCompare(b.time) ||
    a.med.name.localeCompare(b.med.name)
  );
}

const getPendingDoses = () => getDosesForDate().filter(d => !d.takenAt);
const getCompletedDoses = () => getDosesForDate().filter(d => d.takenAt);

const currentMinute = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const timeToMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function getDoseState(dose) {
  if (dose.takenAt) return 'taken';
  if (dose.key.split('|')[0] < today()) return 'missed';
  if (state.testDate || today() !== toYMD(new Date())) return 'pending';
  const delta = currentMinute() - timeToMin(dose.time);
  return delta >= 120 ? 'late' : delta >= 0 ? 'due' : 'pending';
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

/* ---------- Icons ---------- */
const ICONS = {
  dash: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  meds: 'M10.5 3.5a5 5 0 017 7l-7 7a5 5 0 01-7-7zM8 8l8 8',
  hist: 'M3 12a9 9 0 109-9 9 9 0 00-7 3.4M3 4v4h4M12 8v5l3 2',
  sett: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4'
};

/* ---------- View helpers ---------- */
const viewDate = () => (selectedDay && isValidYMD(selectedDay)) ? selectedDay : today();

const nameHue = name => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

const renderAvatar = name => {
  const initial = escapeHtml(name.trim().charAt(0).toUpperCase());
  const h = nameHue(name);
  return `<span class="av" style="background:linear-gradient(135deg,hsl(${h} 55% 42%),hsl(${h} 65% 55%))" aria-hidden="true">${initial}</span>`;
};

const getDayStats = date => {
  const doses = getDosesForDate(date);
  return { total: doses.length, taken: doses.filter(d => d.takenAt).length };
};

function calculateStreak() {
  let date = today();
  let streak = 0;
  let stats = getDayStats(date);
  if (!(stats.total && stats.taken === stats.total)) date = addDays(date, -1);
  for (let i = 0; i < 60; i++) {
    stats = getDayStats(date);
    if (!stats.total || stats.taken < stats.total) break;
    streak++;
    date = addDays(date, -1);
  }
  return streak;
}

function buildSummary() {
  const t = today();
  const all = getDosesForDate(t);
  const lines = all.length
    ? all.map(d => (d.takenAt ? '✓ ' : '○ ') + d.med.name +
        ` (${LABELS[d.slot]} ${to12h(d.time)})` +
        (d.takenAt ? ' taken at ' + isoTo12h(d.takenAt) : ' pending')).join('\n')
    : 'No doses scheduled today.';
  return `MedTrack Pro — ${formatLong(t)}\n${lines}\n${getDayStats(t).taken} of ${all.length} doses completed.`;
}

/* ============================================================
   STORAGE
   ============================================================ */
const isValidMed = m => m && typeof m.name === 'string' && m.name.trim() &&
  [1, 2, 3].includes(m.dosesPerDay) && isValidYMD(m.startDate) &&
  Number.isInteger(m.durationDays) && m.durationDays > 0;

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.meds)) throw new Error('Invalid');
    state.size = ['normal', 'large', 'xl'].includes(data.size) ? data.size : 'normal';
    state.contrast = !!data.contrast;
    state.testDate = isValidYMD(data.testDate) ? data.testDate : null;
    state.notify = !!data.notify;
    ORDER.forEach(s => {
      const t = data.defTimes && data.defTimes[s];
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) state.defTimes[s] = t;
    });
    Object.assign(DEFAULT_TIMES, state.defTimes);
    const badCount = data.meds.filter(m => !isValidMed(m)).length;
    state.meds = data.meds.filter(isValidMed).map(m => ({
      id: String(m.id || Math.random().toString(36).slice(2)),
      name: m.name.trim(),
      note: typeof m.note === 'string' ? m.note.slice(0, 40) : '',
      dosesPerDay: m.dosesPerDay,
      startDate: m.startDate,
      durationDays: m.durationDays,
      times: (m.times && typeof m.times === 'object') ? m.times : {},
      log: (m.log && typeof m.log === 'object') ? m.log : {},
      demo: !!m.demo
    }));
    if (badCount) noticeMessage = `${badCount} saved medicine(s) could not be read and were skipped.`;
  } catch (err) {
    noticeMessage = 'Saved data looked damaged, so MedTrack started fresh. A backup was kept.';
    try { localStorage.setItem(STORAGE_KEY + '.backup', raw); } catch (_) {}
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    memoryOnly = false;
  } catch (err) {
    memoryOnly = true;
  }
}

/* ============================================================
   ACTIONS
   ============================================================ */
const announce = text => {
  const live = document.getElementById('live');
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
};

const findMed = id => state.meds.find(m => m.id === id);

function addMedicine(values) {
  state.meds.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...values,
    log: {},
    demo: false
  });
  persist();
}

function editMedicine(id, values) {
  const med = findMed(id);
  if (!med) return;
  Object.assign(med, values);
  persist();
}

function deleteMedicine(id) {
  state.meds = state.meds.filter(m => m.id !== id);
  persist();
}

function markTaken(id, key) {
  const med = findMed(id);
  if (!med || med.log[key]) return;
  med.log[key] = new Date().toISOString();
  persist();
  announce(`${med.name} marked as taken`);
}

function undoTake(id, key) {
  const med = findMed(id);
  if (!med) return;
  delete med.log[key];
  persist();
  announce(`${med.name} marked as pending again`);
}

function loadDemoMedicines() {
  const t = today();
  state.meds.push(
    { id: 'demoA' + Date.now(), name: 'Medicine A', dosesPerDay: 2, startDate: t,
      durationDays: 5, times: { morning: '09:00', night: '21:00' }, log: {}, demo: true },
    { id: 'demoB' + Date.now(), name: 'Medicine B', dosesPerDay: 3, startDate: t,
      durationDays: 7, times: { morning: '09:00', afternoon: '14:00', night: '21:00' }, log: {}, demo: true }
  );
  persist();
}

/* ============================================================
   TOAST & NOTIFICATIONS
   ============================================================ */
function showToast(message, undo) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${escapeHtml(message)}</span>` +
    (undo ? '<button class="btn" data-act="tundo">Undo</button>' : '');
  el.classList.add('show');
  window._toastUndo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}

async function handleNotifyToggle(el) {
  if (!el.checked) { state.notify = false; persist(); return; }
  if (!('Notification' in window)) {
    el.checked = false;
    return showToast('This browser does not support alerts.');
  }
  const perm = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  state.notify = perm === 'granted';
  if (!state.notify) {
    el.checked = false;
    showToast('Alerts were not allowed in this browser.');
  }
  persist();
}

/* ============================================================
   MODAL SYSTEM
   ============================================================ */
function openModal(html) {
  const modal = document.getElementById('modal');
  modal.innerHTML = `<div class="ov" data-act="ovl"><div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dt">${html}</div></div>`;
  const first = modal.querySelector('input:not([type=radio]),textarea,button');
  first && first.focus();
}

const closeModal = () => { document.getElementById('modal').innerHTML = ''; };

function confirmDialog(title, yesLabel, callback, message = '') {
  openModal(
    `<h2 id="dt" style="margin-top:0">${title}</h2>` +
    (message ? `<p>${message}</p>` : '') +
    `<div class="row"><button class="btn" data-act="close">Cancel</button>` +
    `<button class="btn dangerS" data-act="yes">${yesLabel}</button></div>`
  );
  window._confirmYes = () => { closeModal(); callback(); };
}

/* ============================================================
   MEDICINE FORM
   ============================================================ */
function openMedicineForm(med) {
  const v = med || { name: '', dosesPerDay: 2, durationDays: 5, startDate: today(), times: {} };
  const slotFields = ORDER.map(slot =>
    `<div data-slot="${slot}">
      <label for="t_${slot}">${LABELS[slot]} time (optional)</label>
      <input type="time" id="t_${slot}" value="${v.times[slot] || DEFAULT_TIMES[slot]}">
      <p class="err" id="e_${slot}"></p>
    </div>`
  ).join('');

  openModal(
    `<h2 id="dt" style="margin-top:0">${med ? 'Edit Medicine' : 'Add Medicine'}</h2>
    <form id="mf" novalidate data-id="${med ? med.id : ''}">
      <label for="nm">Medicine name</label>
      <input type="text" id="nm" value="${escapeHtml(v.name)}" autocomplete="off" placeholder="e.g. Paracetamol">
      <p class="err" id="e_nm"></p>

      <label for="no">Note (optional, e.g. after food)</label>
      <input type="text" id="no" maxlength="40" value="${escapeHtml(v.note || '')}" placeholder="e.g. After breakfast">

      <fieldset>
        <legend>Times per day</legend>
        <div class="seg">
          ${[1, 2, 3].map(n =>
            `<label><input type="radio" name="dp" value="${n}"${v.dosesPerDay === n ? ' checked' : ''}><span>${n}×</span></label>`
          ).join('')}
        </div>
      </fieldset>

      <label for="du">Course duration (days)</label>
      <input type="number" id="du" min="1" max="365" inputmode="numeric" value="${v.durationDays}">
      <p class="err" id="e_du"></p>

      <label for="sd">Start date</label>
      <input type="date" id="sd" value="${v.startDate}">
      <p class="err" id="e_sd"></p>

      ${slotFields}

      <div class="row" style="margin-top:1.5rem">
        <button type="button" class="btn" data-act="close">Cancel</button>
        <button type="submit" class="btn pri">${med ? 'Save Changes' : 'Add Medicine'}</button>
      </div>
    </form>`
  );
  syncSlotVisibility();
}

function syncSlotVisibility() {
  const count = +(document.querySelector('input[name=dp]:checked') || { value: 1 }).value;
  ORDER.forEach(slot => {
    const el = document.querySelector(`[data-slot="${slot}"]`);
    if (el) el.style.display = SLOTS[count].includes(slot) ? '' : 'none';
  });
}

function handleFormSubmit(form) {
  const id = form.dataset.id;
  const g = i => document.getElementById(i);
  const setErr = (i, msg) => { g('e_' + i).textContent = msg; return !!msg; };
  const name = g('nm').value.trim().replace(/\s+/g, ' ');
  const dp = +form.querySelector('input[name=dp]:checked').value;
  const du = Number(g('du').value);
  const sd = g('sd').value;
  let hasError = false;

  hasError |= setErr('nm',
    !name ? 'Please enter the medicine name.' :
    state.meds.some(m => m.id !== id && m.name.toLowerCase() === name.toLowerCase() &&
      getCourseState(m, today()) !== 'completed')
      ? 'This medicine is already in your list.' : '');
  hasError |= setErr('du',
    !Number.isInteger(du) || du < 1 ? 'Please enter a whole number of days, 1 or more.' :
    du > 365 ? 'Please enter 365 days or fewer.' : '');
  hasError |= setErr('sd', !isValidYMD(sd) ? 'Please choose a valid start date.' : '');

  const times = {};
  SLOTS[dp].forEach(slot => {
    const t = g('t_' + slot).value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) hasError |= setErr(slot, 'Please enter a valid time.');
    else { setErr(slot, ''); times[slot] = t; }
  });

  if (hasError) {
    const first = form.querySelector('.err:not(:empty)');
    first && first.previousElementSibling.focus();
    announce('Please fix the highlighted problems.');
    return;
  }

  const values = { name, note: g('no').value.trim().slice(0, 40), dosesPerDay: dp, durationDays: du, startDate: sd, times };
  id ? editMedicine(id, values) : addMedicine(values);
  closeModal();
  render();
  announce(name + (id ? ' updated.' : ' added.'));
}

/* ============================================================
   VIEW BUILDERS
   ============================================================ */
const STATUS_LABELS = {
  taken: ['t', '✓ Taken at '],
  pending: ['p', '○ Pending'],
  due: ['p due', '⏰ Time to take'],
  late: ['l', '! Overdue'],
  missed: ['l', '✕ Missed']
};

const doseCard = dose => {
  const status = getDoseState(dose);
  const isTaken = status === 'taken';
  const label = STATUS_LABELS[status];
  const readOnly = dose.key.split('|')[0] !== today();
  const isPop = dose.key === justTakenKey;
  const late = status === 'late' || status === 'missed';
  return `<article class="card dose${isTaken ? ' done' : ''}${isPop ? ' pop' : ''}${late ? ' lateC' : ''}">
    <div class="dh">
      ${renderAvatar(dose.med.name)}
      <div>
        <h3>${escapeHtml(dose.med.name)}</h3>
        <p class="when">${LABELS[dose.slot]} • ${to12h(dose.time)}</p>
        ${dose.med.note ? `<p class="meta">📝 ${escapeHtml(dose.med.note)}</p>` : ''}
        <span class="st ${label[0]}">${isTaken ? label[1] + isoTo12h(dose.takenAt) : label[1]}</span>
      </div>
    </div>
    ${readOnly ? '' : `<button class="btn ${isTaken ? '' : 'pri'}" data-act="${isTaken ? 'undo' : 'take'}"
      data-id="${dose.med.id}" data-key="${dose.key}"
      aria-label="${isTaken ? 'Undo ' : 'Mark as taken: '}${escapeHtml(dose.med.name)}, ${LABELS[dose.slot]}">
      ${isTaken ? 'Undo' : '✓ Mark as Taken'}
    </button>`}
    ${isPop ? '<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>' : ''}
  </article>`;
};

const addButton = '<button class="btn pri" data-act="add">+ Add Medicine</button>';

function renderWeekStrip() {
  const t = today();
  const D = viewDate();
  let html = '<div class="week" role="group" aria-label="Choose a day">';
  for (let i = -3; i <= 3; i++) {
    const date = addDays(t, i);
    const stats = getDayStats(date);
    const complete = stats.total && stats.taken === stats.total;
    const isToday = date === t;
    const isSelected = date === D;
    const dayName = isToday ? 'Today' : parseYMD(date).toLocaleDateString('en-GB', { weekday: 'short' });
    const status = !stats.total ? '–' : complete ? '✓' : `${stats.taken}/${stats.total}`;
    html += `<button class="wd${isSelected ? ' sel' : ''}${isToday ? ' tod' : ''}"
      data-act="selday" data-d="${date}"
      aria-pressed="${isSelected}"
      aria-label="${formatLong(date)}${stats.total ? `, ${stats.taken} of ${stats.total} taken` : ', nothing scheduled'}">
      <small>${dayName}</small>
      <b>${parseYMD(date).getDate()}</b>
      <i class="${complete ? 'ok' : ''}">${status}</i>
    </button>`;
  }
  return html + '</div>';
}

function renderPeriodSummary(allDoses) {
  const hour = new Date().getHours();
  const currentPeriod = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'night';
  return '<div class="per">' + ORDER.map(slot => {
    const slotDoses = allDoses.filter(d => d.slot === slot);
    if (!slotDoses.length) return '';
    const taken = slotDoses.filter(d => d.takenAt).length;
    const complete = taken === slotDoses.length;
    const isNow = slot === currentPeriod && viewDate() === today();
    return `<div class="pt${complete ? ' ok' : ''}${isNow ? ' now' : ''}">
      <span>${LABELS[slot]}</span>
      <b>${complete ? '✓ ' : ''}${taken}/${slotDoses.length}</b>
    </div>`;
  }).join('') + '</div>';
}

function renderInsights() {
  const t = today();
  let total = 0, taken = 0, bars = '';
  for (let i = -6; i <= 0; i++) {
    const date = addDays(t, i);
    const stats = getDayStats(date);
    total += stats.total;
    taken += stats.taken;
    const pct = stats.total ? (stats.taken / stats.total) * 100 : 0;
    bars += `<div class="col">
      <div class="tr"><i data-h="${pct}"></i></div>
      <small>${parseYMD(date).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2)}</small>
    </div>`;
  }
  const pct = total ? Math.round((taken / total) * 100) : 0;
  const streak = calculateStreak();
  return `<section class="card">
    <h3>Last 7 days</h3>
    <p class="big" style="margin-top:.4rem">${total ? `${pct}% of doses ticked` : 'No doses scheduled yet'}</p>
    <div class="cols" role="img" aria-label="Daily completion for the last 7 days">${bars}</div>
    <p class="meta">★ ${streak}-day perfect streak • ${taken} of ${total} doses ticked</p>
  </section>`;
}

function renderDashboard() {
  const D = viewDate();
  const isToday = D === today();
  const all = getDosesForDate(D);
  const pending = all.filter(d => !d.takenAt);
  const done = all.filter(d => d.takenAt);
  const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
  const streak = calculateStreak();

  let html = `<p class="greet">${greeting()} — here is your checklist</p>
    <h1>${isToday ? "Today's Medicines" : 'Medicines'}</h1>
    <p class="sub">${formatLong(D)}</p>`;

  if (!state.meds.length) {
    return html + `<div class="card empty">
      <p>No medicines added yet.</p>
      <p>Add your first medicine to start today's checklist.</p>
      ${addButton}
      <p style="margin-top:1rem"><button class="btn ghost" data-act="demo">Try with sample medicines</button></p>
    </div>`;
  }

  html += renderWeekStrip();

  if (!isToday) {
    html += `<div class="note">You are viewing another day. Doses can only be ticked on today's date.<br>
      <button class="btn" data-act="seltoday" style="margin-top:.5rem">Back to today</button></div>`;
  }

  if (!all.length) {
    html += `<div class="card empty">
      <p>No doses are scheduled for this day.</p>
      <p>Check the Medicines page for upcoming courses.</p>
    </div>`;
  } else {
    const R = 44, C = 2 * Math.PI * R;
    const offset = C * (1 - pct / 100);
    html += `<section class="card prog" aria-label="Progress">
      <div class="ring" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Doses completed">
        <svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#10a05a"/>
              <stop offset="100%" stop-color="#34d399"/>
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r="${R}" class="rb"/>
          <circle cx="50" cy="50" r="${R}" class="rf" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${offset}"/>
        </svg>
        <b>${pct}%</b>
      </div>
      <div>
        <p class="big">${done.length} of ${all.length} doses completed</p>
        <p class="meta">${pending.length ? `${pending.length} ${isToday ? 'still to take' : 'not taken'}` : '✓ All medicines completed.'}</p>
        ${isToday && streak ? `<p class="meta">★ ${streak} ${streak > 1 ? 'perfect days' : 'perfect day'} in a row</p>` : ''}
      </div>
    </section>${renderPeriodSummary(all)}`;
  }

  if (isToday && pending.length) {
    const next = pending[0];
    const status = getDoseState(next);
    const statusText = status === 'late' ? ' • Overdue' : status === 'due' ? ' • Time to take' : '';
    html += `<section class="hero" aria-label="Next dose">
      <p class="kick">Next dose</p>
      <h2>${escapeHtml(next.med.name)}</h2>
      <p class="hl">${LABELS[next.slot]} • ${to12h(next.time)}${statusText}</p>
      <div class="row">
        <button class="btn heroB" data-act="take" data-id="${next.med.id}" data-key="${next.key}">✓ Mark as Taken</button>
        <button class="btn heroG" data-act="speak" data-id="${next.med.id}" data-key="${next.key}">🔊 Read aloud</button>
      </div>
    </section>`;
  }

  html += `<h2>${isToday ? 'Pending' : 'Not taken'} – ${pending.length}</h2>` +
    (pending.length ? pending.map(doseCard).join('') :
      `<div class="card empty"><p>${isToday ? 'Nothing pending for today.' : 'Everything was taken.'}</p></div>`);

  html += `<h2>${isToday ? 'Completed Today' : 'Completed'} – ${done.length}</h2>` +
    (done.length ? done.map(doseCard).join('') :
      `<p class="sub">Nothing taken yet${isToday ? ' today' : ''}.</p>`);

  return html + `<div class="row" style="margin-top:1.5rem">
    ${addButton}
    <button class="btn" data-act="share">Share today's summary</button>
  </div>`;
}

function renderMedicineCard(med) {
  const t = today();
  const courseState = getCourseState(med, t);
  const timesText = SLOTS[med.dosesPerDay]
    .map(slot => `${LABELS[slot]} ${to12h(med.times[slot] || DEFAULT_TIMES[slot])}`)
    .join(', ');
  const courseDay = getCourseDay(med, t);
  const progress = courseState === 'active'
    ? Math.round((courseDay / med.durationDays) * 100) : 0;
  return `<article class="card">
    <div class="dh">
      ${renderAvatar(med.name)}
      <h3>${escapeHtml(med.name)}${med.demo ? ' <span class="meta">(sample)</span>' : ''}</h3>
    </div>
    ${med.note ? `<p class="meta">📝 ${escapeHtml(med.note)}</p>` : ''}
    <p class="when">${med.dosesPerDay} ${med.dosesPerDay > 1 ? 'times' : 'time'} a day</p>
    <p class="meta">${timesText}</p>
    <p class="meta">Course: ${med.durationDays} days • Started ${formatShort(med.startDate)} • Ends ${formatShort(getCourseEndDate(med))}</p>
    <p class="meta"><b>${courseState === 'active'
      ? `Day ${courseDay} of ${med.durationDays}`
      : `Starts ${formatShort(med.startDate)}`}</b></p>
    ${courseState === 'active' ? `
      <div class="cbar"><i data-w="${progress}"></i></div>
      <p class="meta">${med.durationDays - courseDay} day(s) left after today</p>` : ''}
    <div class="row" style="margin-top:.6rem">
      <button class="btn" data-act="edit" data-id="${med.id}" aria-label="Edit ${escapeHtml(med.name)}">Edit</button>
      <button class="btn danger" data-act="del" data-id="${med.id}" aria-label="Delete ${escapeHtml(med.name)}">Delete</button>
    </div>
  </article>`;
}

function renderMedicines() {
  const t = today();
  const current = state.meds.filter(m => getCourseState(m, t) !== 'completed');
  let html = `<h1>All Medicines</h1>
    <p class="sub">Active and upcoming courses</p>
    <p>${addButton}</p>`;
  if (state.meds.some(m => m.demo)) {
    html += `<div class="note">Sample medicines are shown.
      <button class="btn ghost" data-act="rmdemo" style="margin-top:.5rem">Remove sample medicines</button></div>`;
  }
  return html + (current.length
    ? current.map(renderMedicineCard).join('')
    : '<div class="card empty"><p>No active medicines.</p></div>');
}

function renderHistory() {
  const completed = state.meds
    .filter(m => getCourseState(m, today()) === 'completed')
    .sort((a, b) => getCourseEndDate(b).localeCompare(getCourseEndDate(a)));

  const historyHtml = completed.length ? completed.map(med => {
    const total = med.durationDays * med.dosesPerDay;
    const taken = Object.keys(med.log).length;
    const pct = total ? Math.round((taken / total) * 100) : 0;
    return `<article class="card">
      <h3>${escapeHtml(med.name)}</h3>
      <p class="when">${med.durationDays}-day course</p>
      <p class="meta">Completed on ${formatShort(getCourseEndDate(med))} ${parseYMD(getCourseEndDate(med)).getFullYear()}</p>
      <p class="meta">${taken} of ${total} doses ticked (${pct}%)</p>
      <div class="cbar" style="margin-top:.6rem"><i data-w="${pct}" style="background:var(--grad-ok)"></i></div>
      <div class="row" style="margin-top:.6rem">
        <button class="btn danger" data-act="del" data-id="${med.id}" aria-label="Delete ${escapeHtml(med.name)} from history">Delete</button>
      </div>
    </article>`;
  }).join('') : '<div class="card empty"><p>No completed courses yet.</p></div>';

  return `<h1>History</h1>${renderInsights()}
    <h2 style="margin-top:1.2rem">Completed Courses</h2>${historyHtml}`;
}

function renderSettings() {
  const sizes = [['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra Large']];
  return `<h1>Settings</h1>
    <section class="card">
      <fieldset>
        <legend style="margin-top:0">Text size</legend>
        <div class="seg" style="flex-wrap:wrap">
          ${sizes.map(([v, l]) =>
            `<label><input type="radio" name="sz" value="${v}"${state.size === v ? ' checked' : ''}><span>${l}</span></label>`
          ).join('')}
        </div>
      </fieldset>
      <label style="display:flex;gap:.7rem;align-items:center;min-height:52px;margin-top:1rem;cursor:pointer">
        <input type="checkbox" id="hc" style="width:1.4rem;height:1.4rem;accent-color:var(--pri)"${state.contrast ? ' checked' : ''}>
        High contrast mode
      </label>
    </section>

    <section class="card">
      <h3>Default dose times</h3>
      <p class="meta">Used when you add a new medicine. Existing medicines keep their own times.</p>
      ${ORDER.map(slot =>
        `<label for="d_${slot}">${LABELS[slot]}</label>
         <input type="time" id="d_${slot}" data-def="${slot}" value="${DEFAULT_TIMES[slot]}">`
      ).join('')}
    </section>

    <section class="card">
      <h3>Alerts</h3>
      <p class="meta">Optional. Browser alerts only work while this page is open and depend on your device and browser permissions. They are not a guaranteed reminder.</p>
      <label style="display:flex;gap:.7rem;align-items:center;min-height:52px;margin:0;cursor:pointer">
        <input type="checkbox" id="nf" style="width:1.4rem;height:1.4rem;accent-color:var(--pri)"${state.notify ? ' checked' : ''}>
        Alert me when a dose time arrives
      </label>
    </section>

    <section class="card">
      <h3>Your data</h3>
      <p class="meta">Everything is stored only in this browser. MedTrack is a checklist and does not send reminders or give medical advice.</p>
      <div class="row">
        <button class="btn" data-act="export">Export Data</button>
        <button class="btn" data-act="import">Import Data</button>
        <button class="btn danger" data-act="clear">Clear All Data</button>
      </div>
    </section>

    <details class="card">
      <summary style="min-height:44px;font-size:.95rem;font-weight:700;cursor:pointer;list-style:none">
        Developer: test a different date
      </summary>
      <label for="td" style="margin-top:.8rem">Test date</label>
      <input type="date" id="td" value="${state.testDate || ''}">
      <div class="row" style="margin-top:.7rem">
        <button class="btn" data-act="settd">Use this date</button>
        <button class="btn" data-act="realtd">Use real date</button>
      </div>
      ${state.testDate ? `<p class="err">Test date active: ${state.testDate}</p>` : ''}
    </details>`;
}

/* ============================================================
   RENDER PIPELINE
   ============================================================ */
const viewBuilders = {
  dash: renderDashboard,
  meds: renderMedicines,
  hist: renderHistory,
  sett: renderSettings
};

function render(anim) {
  document.documentElement.className =
    (state.size === 'normal' ? '' : state.size) +
    (state.contrast ? ' hc' : '');

  const navItems = [
    ['dash', 'Dashboard'],
    ['meds', 'Medicines'],
    ['hist', 'History'],
    ['sett', 'Settings']
  ];

  document.querySelector('nav').innerHTML = navItems.map(([k, l]) =>
    `<button data-nav="${k}"${currentView === k ? ' aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[k]}"/></svg>
      <span>${l}</span>
    </button>`
  ).join('');

  let banner = '';
  if (noticeMessage) banner += `<div class="note" role="alert">${escapeHtml(noticeMessage)}</div>`;
  if (memoryOnly) banner += `<div class="note" role="alert">This browser is not allowing MedTrack to save. Your changes will be lost when you close the page.</div>`;
  if (state.testDate) banner += `<div class="note">Test date in use: ${state.testDate}</div>`;

  const app = document.getElementById('app');
  app.className = anim === true ? 'anim' : anim === 'soft' ? 'soft' : '';
  app.innerHTML = banner + viewBuilders[currentView]();

  lastCheckedDay = today();
  lastCheckedMinute = currentMinute();

  if (anim === true) {
    app.querySelectorAll('.card,.hero,.wd,.pt').forEach((el, i) => {
      el.style.setProperty('--i', Math.min(i, 8));
    });
  }

  const applyProgress = () => {
    app.querySelectorAll('.rf').forEach(el => {
      el.style.strokeDashoffset = el.dataset.off;
    });
    app.querySelectorAll('.cbar i').forEach(el => {
      el.style.width = el.dataset.w + '%';
    });
    app.querySelectorAll('.tr i').forEach(el => {
      el.style.height = el.dataset.h + '%';
    });
  };

  if (anim) {
    requestAnimationFrame(() => requestAnimationFrame(applyProgress));
  } else {
    applyProgress();
  }

  if (anim === true) {
    app.querySelectorAll('.ring b').forEach(el => {
      const target = parseInt(el.textContent, 10);
      let start = null;
      const step = ts => {
        start = start || ts;
        const k = Math.min(1, (ts - start) / 1100);
        const eased = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(target * eased) + '%';
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  justTakenKey = '';
}

/* ============================================================
   EVENT HANDLERS
   ============================================================ */
document.addEventListener('click', e => {
  /* Button ripple effect */
  const btn = e.target.closest('.btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  const nav = e.target.closest('[data-nav]');
  if (nav) {
    currentView = nav.dataset.nav;
    render(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  const action = e.target.closest('[data-act]');
  if (!action) return;
  const { act, id, key } = action.dataset;

  if (act === 'ovl') { if (e.target === action) closeModal(); return; }
  if (act === 'close') return closeModal();
  if (act === 'yes') return window._confirmYes && window._confirmYes();

  if (act === 'selday') {
    selectedDay = action.dataset.d === today() ? null : action.dataset.d;
    render('soft');
    return;
  }
  if (act === 'seltoday') { selectedDay = null; render('soft'); return; }

  if (act === 'share') {
    return openModal(
      `<h2 id="dt" style="margin-top:0">Share today's summary</h2>
       <p class="meta">Copy this and send it to a family member or caregiver.</p>
       <textarea readonly id="ex" aria-label="Summary">${escapeHtml(buildSummary())}</textarea>
       <div class="row" style="margin-top:.7rem">
         <button class="btn pri" data-act="copy">Copy</button>
         <button class="btn" data-act="close">Close</button>
       </div>`
    );
  }

  if (act === 'copy') {
    const ta = document.getElementById('ex');
    ta.select();
    try {
      navigator.clipboard.writeText(ta.value).then(
        () => showToast('Copied to clipboard'),
        () => { document.execCommand('copy'); showToast('Copied to clipboard'); }
      );
    } catch (_) {
      try { document.execCommand('copy'); showToast('Copied to clipboard'); } catch (__) {}
    }
    return;
  }

  if (act === 'import') {
    return openModal(
      `<h2 id="dt" style="margin-top:0">Import Data</h2>
       <p class="meta">Paste data you exported earlier. It will be added to your current medicines.</p>
       <textarea id="im" aria-label="Data to import"></textarea>
       <p class="err" id="e_im"></p>
       <div class="row">
         <button class="btn pri" data-act="doimport">Import</button>
         <button class="btn" data-act="close">Cancel</button>
       </div>`
    );
  }

  if (act === 'doimport') {
    try {
      const arr = JSON.parse(document.getElementById('im').value);
      if (!Array.isArray(arr)) throw new Error();
      const valid = arr.filter(isValidMed).map(m => ({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: m.name.trim(),
        note: typeof m.note === 'string' ? m.note.slice(0, 40) : '',
        dosesPerDay: m.dosesPerDay,
        startDate: m.startDate,
        durationDays: m.durationDays,
        times: (m.times && typeof m.times === 'object') ? m.times : {},
        log: (m.log && typeof m.log === 'object') ? m.log : {},
        demo: false
      }));
      if (!valid.length) throw new Error();
      state.meds.push(...valid);
      persist();
      closeModal();
      render();
      showToast(`Imported ${valid.length} medicine(s)`);
    } catch (_) {
      document.getElementById('e_im').textContent = 'That text could not be read. Please paste the exported data exactly.';
    }
    return;
  }

  if (act === 'tundo') {
    document.getElementById('toast').classList.remove('show');
    window._toastUndo && window._toastUndo();
    return;
  }

  if (act === 'speak') {
    const dose = getDosesForDate().find(d => d.key === key && d.med.id === id);
    if (!dose) return;
    const remaining = getPendingDoses().length;
    speak(`Next medicine: ${dose.med.name}, ${LABELS[dose.slot]}, at ${to12h(dose.time)}. You have ${remaining} dose${remaining > 1 ? 's' : ''} left today.`);
    return;
  }

  if (act === 'add') return openMedicineForm();
  if (act === 'edit') return openMedicineForm(findMed(id));

  if (act === 'take') {
    markTaken(id, key);
    try { navigator.vibrate && navigator.vibrate(40); } catch (_) {}
    justTakenKey = key;
    render('soft');
    showToast(`✓ ${findMed(id).name} marked as taken`, () => { undoTake(id, key); render('soft'); });
    const btn = document.querySelector(`[data-act=undo][data-key="${key}"]`);
    btn && btn.focus();
    return;
  }

  if (act === 'undo') {
    return confirmDialog('Undo this dose?', 'Yes, Undo', () => {
      undoTake(id, key);
      render();
    }, 'It will go back to Pending.');
  }

  if (act === 'del') {
    const med = findMed(id);
    return confirmDialog('Delete this medicine?', 'Delete', () => {
      deleteMedicine(id);
      render();
      announce('Medicine deleted');
    }, escapeHtml(med ? med.name : ''));
  }

  if (act === 'demo') { loadDemoMedicines(); render(); }
  if (act === 'rmdemo') {
    state.meds = state.meds.filter(m => !m.demo);
    persist();
    render();
  }

  if (act === 'clear') {
    return confirmDialog('Delete all medicine data?', 'Delete Everything', () => {
      state.meds = [];
      noticeMessage = '';
      persist();
      render();
      announce('All data deleted');
    });
  }

  if (act === 'export') {
    return openModal(
      `<h2 id="dt" style="margin-top:0">Export Data</h2>
       <p>Select all the text below and copy it to keep a backup.</p>
       <textarea readonly id="ex" aria-label="Exported data">${escapeHtml(JSON.stringify(state.meds, null, 2))}</textarea>
       <p><button class="btn" data-act="close">Close</button></p>`
    );
  }

  if (act === 'settd') {
    const v = document.getElementById('td').value;
    state.testDate = isValidYMD(v) ? v : null;
    persist();
    render();
  }

  if (act === 'realtd') {
    state.testDate = null;
    persist();
    render();
  }
});

document.addEventListener('submit', e => {
  if (e.target.id === 'mf') {
    e.preventDefault();
    handleFormSubmit(e.target);
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.name === 'dp') syncSlotVisibility();
  if (t.name === 'sz') { state.size = t.value; persist(); render(); }
  if (t.id === 'hc') { state.contrast = t.checked; persist(); render(); }
  if (t.id === 'nf') handleNotifyToggle(t);
  if (t.dataset.def && /^([01]\d|2[0-3]):[0-5]\d$/.test(t.value)) {
    state.defTimes[t.dataset.def] = t.value;
    DEFAULT_TIMES[t.dataset.def] = t.value;
    persist();
    announce('Default time saved');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

/* ============================================================
   SPEECH SYNTHESIS
   ============================================================ */
function speak(text) {
  if (!('speechSynthesis' in window)) return announce(text);
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.85;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  speechSynthesis.speak(utterance);
}

/* ============================================================
   PERIODIC REFRESH (every 20 seconds)
   ============================================================ */
setInterval(() => {
  const busy = document.querySelector('.ov') ||
    /INPUT|TEXTAREA/.test((document.activeElement || {}).tagName || '');

  if (state.notify && 'Notification' in window &&
      Notification.permission === 'granted' && !state.testDate) {
    const now = currentMinute();
    getPendingDoses().forEach(dose => {
      const key = dose.key + dose.med.id;
      const delta = now - timeToMin(dose.time);
      if (delta >= 0 && delta < 5 && !notifiedSet.has(key)) {
        notifiedSet.add(key);
        try {
          new Notification(`Time for ${dose.med.name}`, {
            body: `${LABELS[dose.slot]} • ${to12h(dose.time)}`,
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230b5c7a"><path d="M12 2L3 7v10l9 5 9-5V7z"/></svg>'
          });
        } catch (_) {}
      }
    });
  }

  if (!busy && (today() !== lastCheckedDay || currentMinute() !== lastCheckedMinute)) {
    render();
  }
}, 20000);

/* ============================================================
   INITIALIZATION
   ============================================================ */
loadState();
render(true);