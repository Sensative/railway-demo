const D = "__DATA__";

/* ---------- exact ports of the tenant's own arithmetic ---------- */
function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
const r1 = (x) => Math.round(x * 10) / 10;
const SVC = Object.fromEntries(D.services.map((s) => [s.id, s]));
const ROUTE = Object.fromEntries(D.routes.map((r) => [r.id, r]));
const DATE_IX = Object.fromEntries(D.dates.map((d, i) => [d, i]));

/** Which units worked the diagram - deterministic from service + date. */
function formationUnits(svc, date) {
  const [lo, hi] = svc.range;
  const units = [];
  for (let k = 0; units.length < svc.units && k < 200; k++) {
    const n = lo + (hash(svc.id + date + 'unit' + k) % (hi - lo + 1));
    const id = svc.route + '-U' + String(n).padStart(3, '0');
    if (!units.includes(id)) units.push(id);
  }
  return units;
}

/** Per-coach occupancy: reserved seats fill the train, no-shows do not spread evenly. */
function snapshot(serviceId, date) {
  const svc = SVC[serviceId];
  const i = DATE_IX[date];
  const d = D.daily[serviceId];
  if (!svc || i === undefined || d.sold[i] === null) return null;

  const units = formationUnits(svc, date);
  const slots = svc.coachSeats.map((c) => ({
    unit: units[c[0] - 1], coach: c[1],
    seats: c[2] + c[3], std: c[2], first: c[3],
  }));
  const weights = slots.map((s, k) =>
    (1.1 - 0.03 * k + (hash(s.unit + s.coach + date) % 100) / 2500) * s.seats);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const occ = d.occ[i];
  const alloc = slots.map((s, k) => Math.min(s.seats, Math.round((occ * weights[k]) / wsum)));
  let remainder = occ - alloc.reduce((a, b) => a + b, 0);
  for (let guard = 0; remainder !== 0 && guard < svc.seats; guard++) {
    let moved = false;
    for (let k = 0; k < alloc.length && remainder !== 0; k++) {
      const step = Math.sign(remainder);
      const next = alloc[k] + step;
      if (next >= 0 && next <= slots[k].seats) { alloc[k] = next; remainder -= step; moved = true; }
    }
    if (!moved) break;
  }
  const coaches = slots.map((s, k) => ({
    unit_id: s.unit, coach: s.coach,
    device_id: ('iot-' + s.unit + '-' + s.coach).toLowerCase(),
    seats: s.seats, std: s.std, first: s.first,
    seats_occupied: alloc[k], seats_empty: s.seats - alloc[k],
    occupancy_pct: r1((alloc[k] / s.seats) * 100),
  }));
  const sold = d.sold[i];
  const fare = d.rev[i] / sold;
  return {
    svc, date, dayType: D.dayType[i], units, coaches,
    sold, occupied: occ, ghost: d.ghost[i], revenue: d.rev[i],
    away: d.away[i], closed: !!d.closed[i],
    assumed: r1((sold / svc.seats) * 100),
    cabin: r1((occ / svc.seats) * 100),
    fare, ghostValue: d.ghost[i] * fare,
    cfRev: d.cfRev[i], cfSold: d.cfSold[i],
  };
}

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const growth3 = (a, b) => (a ? r3((b / a - 1) * 100) : null);

/**
 * Totals for one departure over a window. Mirrors aggregate() in dataset.mjs,
 * including the counterfactual - what the same booking requests would have
 * earned under 2025's forecast quality, same demand, same fares, same EMSRb.
 */
function windowAgg(id, { weekdayOnly = false, fromMonth = 1, toMonth = 12 } = {}) {
  const svc = SVC[id], d = D.daily[id];
  let departures = 0, sold = 0, occ = 0, ghost = 0, rev = 0, cfRev = 0, cfSold = 0, away = 0, closed = 0;
  for (let i = 0; i < D.dates.length; i++) {
    if (d.sold[i] === null) continue;
    const m = +D.dates[i].slice(5, 7);
    if (m < fromMonth || m > toMonth) continue;
    if (weekdayOnly && D.dayType[i] !== 'weekday') continue;
    departures++; sold += d.sold[i]; occ += d.occ[i]; ghost += d.ghost[i];
    rev += d.rev[i]; cfRev += d.cfRev[i]; cfSold += d.cfSold[i];
    away += d.away[i]; closed += d.closed[i];
  }
  if (!departures) return null;
  const seats = departures * svc.seats;
  const assumed = r1((sold / seats) * 100);
  const cabin = r1((occ / seats) * 100);
  return {
    svc, departures, seats, sold, occ, ghost, away,
    rev: r2(rev), cfRev: r2(cfRev), cfSold,
    closedPct: r1((closed / departures) * 100),
    assumed, cabin, overstatement: r1(assumed - cabin),
    avgFare: r2(rev / sold),
    uplift: r2(rev - cfRev),
    upliftPct: growth3(cfRev, rev),
    ticketsUpliftPct: growth3(cfSold, sold),
    ghostPerDep: r1(ghost / departures),
    awayPerDep: r1(away / departures),
    revPerWeekdayYear: (rev / departures) * 253,
  };
}

/* ---------- formatting ---------- */
const nf = new Intl.NumberFormat('en-GB');
const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const pct = (x) => x.toFixed(1) + '%';
const longDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_LABEL = { weekday: 'Weekday', saturday: 'Saturday', sunday: 'Sunday', bank_holiday: 'Bank holiday' };
const SEQ = ['--seq-1','--seq-2','--seq-3','--seq-4','--seq-5','--seq-6','--seq-7'];
const seqStep = (p) => Math.min(SEQ.length, Math.max(1, Math.floor((p / 100) * SEQ.length) + 1));
const seqVar = (p) => '--seq-' + seqStep(p);
/** The ramp inverts between themes, so the label ink inverts with it. */
const inkOn = (p) => 'var(--seq-ink-' + seqStep(p) + ')';

/* ---------- state ---------- */
const OPENING = { service: 'NBR1-0741', date: '2026-06-16' };
const state = {
  route: SVC[OPENING.service] ? SVC[OPENING.service].route : D.routes[0].id,
  service: SVC[OPENING.service] ? OPENING.service : D.services[0].id,
  date: DATE_IX[OPENING.date] !== undefined
    ? OPENING.date
    : D.dates.find((d, i) => D.dayType[i] === 'weekday') || D.dates[0],
  coach: 0,
  weekdaysOnly: true,
  view: 'train',
  mapZoom: 'network',
  dc: 'peak_core',
  action: 'all',
  sort: { key: 'time', dir: 1 },
};

function servicesFor(route) {
  return D.services
    .filter((s) => route === 'ALL' || s.route === route)
    .sort((a, b) => (a.time === b.time ? a.id.localeCompare(b.id) : a.time.localeCompare(b.time)));
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const s = p.get('s'), dt = p.get('d'), c = p.get('c');
  if (s && SVC[s]) { state.service = s; state.route = SVC[s].route; }
  if (dt && DATE_IX[dt] !== undefined) state.date = dt;
  if (c !== null && !isNaN(+c)) state.coach = +c;
}
function writeHash() {
  const p = new URLSearchParams({ s: state.service, d: state.date, c: String(state.coach) });
  history.replaceState(null, '', '#' + p.toString());
  try { localStorage.setItem('nbr-seat-view', p.toString()); } catch (e) { /* private mode */ }
}
function restore() {
  try {
    const saved = localStorage.getItem('nbr-seat-view');
    if (saved && !location.hash) location.hash = saved;
  } catch (e) { /* private mode */ }
  readHash();
  if (!state.service || SVC[state.service].route !== state.route) {
    state.service = servicesFor(state.route)[0].id;
  }
}

/* ---------- render: rail ---------- */
function renderChips() {
  const el = document.getElementById('routechips');
  const opts = [{ id: 'ALL', name: 'All routes' }].concat(D.routes);
  el.innerHTML = opts.map((r) =>
    `<button class="chip" type="button" data-route="${r.id}" aria-pressed="${state.route === r.id}">` +
    `${r.id === 'ALL' ? 'All routes' : r.id + ' ' + r.name}</button>`).join('');
  el.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    state.route = b.dataset.route;
    const list = servicesFor(state.route);
    if (!list.some((s) => s.id === state.service)) { state.service = list[0].id; state.coach = 0; }
    renderAll();
  }));
}

function renderDate() {
  const input = document.getElementById('date');
  input.min = D.coverage.from; input.max = D.coverage.to; input.value = state.date;
  const i = DATE_IX[state.date];
  document.getElementById('prevday').disabled = i === 0;
  document.getElementById('nextday').disabled = i === D.dates.length - 1;
  document.getElementById('daynote').innerHTML =
    `<span>${longDate(state.date)}</span><span class="tag">${DAY_LABEL[D.dayType[i]] || D.dayType[i]}</span>`;
}

function renderDepList() {
  const list = servicesFor(state.route);
  document.getElementById('depcount').textContent = list.length + ' on ' + shortDate(state.date);
  document.getElementById('deplist').innerHTML = list.map((s) => {
    const d = D.daily[s.id]; const i = DATE_IX[state.date];
    const occ = d.occ[i], p = occ === null ? 0 : (occ / s.seats) * 100;
    return `<button class="dep" type="button" role="option" data-svc="${s.id}" aria-current="${state.service === s.id}"` +
      ` aria-selected="${state.service === s.id}">` +
      `<span class="t">${s.time}</span>` +
      `<span class="dcol"><span class="d">${s.to}</span>` +
      `<span class="m">${s.id} &middot; ${s.coaches}c</span>` +
      `<span class="bar"><i style="width:${p.toFixed(1)}%"></i></span></span>` +
      `<span class="pct">${occ === null ? '&mdash;' : p.toFixed(0) + '%'}</span></button>`;
  }).join('');
  document.getElementById('deplist').querySelectorAll('.dep').forEach((b) =>
    b.addEventListener('click', () => { state.service = b.dataset.svc; state.coach = 0; renderAll(); }));
  const cur = document.getElementById('deplist').querySelector('[aria-current="true"]');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

/* ---------- render: identity + tiles ---------- */
function renderIdentity(sn) {
  const s = sn.svc;
  document.getElementById('identity').innerHTML =
    `<span class="time num">${s.time}</span>` +
    `<span><span class="od">${s.from} &rarr; ${s.to}</span><br>` +
    `<span class="meta">${s.id} &middot; ${ROUTE[s.route].name} &middot; ${s.formation}, ` +
    `${s.coaches} coaches, ${nf.format(s.seats)} seats ` +
    `(${nf.format(s.seatsStd)} Standard + ${nf.format(s.seatsFirst)} First)</span></span>` +
    `<span class="tags">` +
      `<span class="tag">${D.demandClassLabels[s.dc]}</span>` +
      `<span class="tag">${sn.units.join(' + ')}</span>` +
      (sn.closed ? '<span class="tag hot">Standard sold out</span>' : '') +
    `</span>`;
}

const MODELLED = '<span class="est" title="Not measured. A walk-up who finds no seat simply leaves, so nobody counts them: this is the revenue-management model\u2019s own unconstrained demand. What is observed is that the cabin closed.">MODELLED</span>';

function renderTiles(sn) {
  const s = sn.svc;
  const t = [
    { k: 'Seats on the day', v: nf.format(s.seats), s: s.formation },
    { k: 'Tickets sold', v: nf.format(sn.sold), s: nf.format(s.seats - sn.sold) + ' unsold' },
    { k: 'Seats occupied', v: nf.format(sn.occupied), s: 'measured by ' + s.coaches + ' nodes', cls: 'accent' },
    { k: 'Cabin factor', v: pct(sn.cabin), s: 'ticket system said ' + pct(sn.assumed), cls: 'accent' },
    { k: 'Ghost seats', v: nf.format(sn.ghost), s: gbp0.format(sn.ghostValue) + ' paid, travelled empty', cls: 'warn' },
    { k: 'Walk-ups refused' + MODELLED, v: nf.format(sn.away),
      s: sn.away > 0 ? 'no Standard seat left' : 'none turned away',
      cls: sn.away > 0 ? 'crit' : 'ok' },
    { k: 'Revenue', v: gbp0.format(sn.revenue), s: gbp0.format(sn.fare) + ' average fare' },
  ];
  document.getElementById('tiles').innerHTML = t.map((x) =>
    `<div class="tile ${x.cls || ''}"><div class="k">${x.k}</div>` +
    `<div class="v">${x.v}</div><div class="s">${x.s}</div></div>`).join('');
}

/* ---------- render: formation ---------- */
/**
 * Picking a coach from the diagram and picking it from the table have to do
 * the same thing, or the two disagree about what is selected. Both go here.
 */
function selectCoach(sn, ix) {
  state.coach = ix;
  renderFormation(sn);
  renderCoach(sn);
  writeHash();
}


function renderFormation(sn) {
  const byUnit = new Map();
  sn.coaches.forEach((c, ix) => {
    if (!byUnit.has(c.unit_id)) byUnit.set(c.unit_id, []);
    byUnit.get(c.unit_id).push({ ...c, ix });
  });
  let html = '';
  let firstUnit = true;
  for (const [unit, cs] of byUnit) {
    if (!firstUnit) html += '<div class="coupler"></div>';
    firstUnit = false;
    html += `<div class="unit"><span class="ulabel">${unit} &middot; ${cs.length} coaches</span><div class="cars">` +
      cs.map((c) =>
        `<button class="car" type="button" data-ix="${c.ix}" aria-pressed="${state.coach === c.ix}"` +
        ` title="${unit} coach ${c.coach}: ${c.seats_occupied} of ${c.seats} seats occupied">` +
        `<span class="box" style="background:var(${seqVar(c.occupancy_pct)});color:${inkOn(c.occupancy_pct)}">` +
        (c.first > 0 ? '<span class="first">1st</span>' : '') +
        `<span class="letter">${c.coach}</span>` +
        `<span class="occ">${c.occupancy_pct.toFixed(0)}%</span></span>` +
        `<span class="cap">${c.seats_occupied}/${c.seats}</span></button>`).join('') +
      '</div></div>';
  }
  document.getElementById('formation').innerHTML = html;
  document.getElementById('formation').querySelectorAll('.car').forEach((b) =>
    b.addEventListener('click', () => selectCoach(sn, +b.dataset.ix)));
  document.getElementById('rampsteps').innerHTML =
    SEQ.map((v) => `<i style="background:var(${v})"></i>`).join('');

  const rows = sn.coaches.map((c, ix) =>
    `<tr class="click" data-ix="${ix}" aria-current="${state.coach === ix}">` +
    `<td class="l mono">${c.unit_id}</td><td class="l"><b>${c.coach}</b></td>` +
    `<td class="l mono" style="color:var(--ink-muted)">${c.device_id}</td>` +
    `<td>${c.seats}</td><td>${c.std}</td><td>${c.first}</td>` +
    `<td>${c.seats_occupied}</td><td>${c.seats_empty}</td>` +
    `<td><span class="swatch" style="background:var(${seqVar(c.occupancy_pct)})"></span>${c.occupancy_pct.toFixed(1)}%</td></tr>`).join('');
  document.getElementById('coachtable').innerHTML =
    '<thead><tr><th class="l">Unit</th><th class="l">Coach</th><th class="l">SeatSense node</th>' +
    '<th>Seats</th><th>Std</th><th>1st</th><th>Occupied</th><th>Empty</th><th>Occupancy</th></tr></thead>' +
    `<tbody>${rows}</tbody>`;
  document.getElementById('coachtable').querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => selectCoach(sn, +tr.dataset.ix)));
}

/* ---------- render: seat grid ---------- */
/** Deterministic arrangement of the measured count. Positions are illustrative. */
function seatPattern(key, seats, occupied) {
  const idx = Array.from({ length: seats }, (_, i) => i);
  let s = hash(key) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const on = new Set(idx.slice(0, occupied));
  return Array.from({ length: seats }, (_, i) => on.has(i));
}

function renderCoach(sn) {
  const c = sn.coaches[Math.min(state.coach, sn.coaches.length - 1)];
  const layout = D.seatmaps[sn.svc.unitType];
  const inventory = layout ? layout.byCoach[c.coach] : null;
  document.getElementById('seathead').textContent = `Coach ${c.coach} \u2014 ${c.unit_id}`;
  document.getElementById('seathint').textContent =
    `${c.seats_occupied} of ${c.seats} seats occupied \u00b7 ${c.seats_empty} empty`;

  const on = seatPattern(c.device_id + sn.date, c.seats, c.seats_occupied);
  const grid = document.getElementById('seatgrid');

  if (!inventory) { grid.innerHTML = ''; return; }

  // One column per row of the coach, aisle between the A and B sides.
  const rows = new Map();
  inventory.forEach((seat, ix) => {
    if (!rows.has(seat[2])) rows.set(seat[2], []);
    rows.get(seat[2]).push({ n: seat[0], cabin: seat[1], side: seat[3], pos: seat[4], ix });
  });
  const POS = { w: 'window', a: 'aisle' };
  let html = '';
  for (const [row, seats] of rows) {
    html += '<div class="seatcol">';
    let sideBreak = false;
    for (const st of seats) {
      if (st.side === 'B' && !sideBreak) { html += '<span class="aisle"></span>'; sideBreak = true; }
      const cabin = st.cabin === 'f' ? 'First' : 'Standard';
      html += `<span class="seat${on[st.ix] ? ' on' : ''}${st.cabin === 'f' ? ' first' : ''}"` +
        ` data-seat="${c.coach}${st.n}" data-info="${cabin}, row ${row}, ${st.side} side, ${POS[st.pos]}"` +
        ` title="${c.coach}${st.n} \u2014 ${cabin}, row ${row}, ${st.side} side, ${POS[st.pos]}"></span>`;
    }
    if (!sideBreak) html += '<span class="aisle"></span>';
    html += '</div>';
  }
  grid.innerHTML = html;

  const readout = document.getElementById('seatreadout');
  const idle = `${inventory.length} numbered seats, ${c.coach}1 to ${c.coach}${inventory.length}` +
    ` \u00b7 Standard ${layout.layout.standard}, First ${layout.layout.first}` +
    ` \u00b7 point at a seat for its number`;
  readout.textContent = idle;
  grid.onmouseover = (ev) => {
    const t = ev.target.closest('.seat');
    if (t) readout.textContent = `${t.dataset.seat} \u2014 ${t.dataset.info}`;
  };
  grid.onmouseleave = () => { readout.textContent = idle; };

  document.getElementById('caveat').innerHTML =
    `These are coach ${c.coach}\u2019s real seats: <b>${inventory.length} numbered places</b>, ` +
    `${c.coach}1 to ${c.coach}${inventory.length}, Standard ${layout.layout.standard} and ` +
    `First ${layout.layout.first}. <b>${c.seats_occupied} occupied, ${c.seats_empty} empty</b> is ` +
    `measured. <b>Which</b> seats those are is not: a SeatSense node reports occupancy for its coach, ` +
    `so the fill above shows the count against the real seat plan, not identified seats.`;

  const dev = D.devices[c.device_id];
  document.getElementById('node').innerHTML =
    `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-2);margin-bottom:8px">` +
    `Node</h3><dl>` +
    `<dt>Device</dt><dd>${c.device_id}</dd>` +
    `<dt>Unit</dt><dd>${c.unit_id}</dd>` +
    `<dt>Coach</dt><dd>${c.coach}</dd>` +
    `<dt>Seats watched</dt><dd>${c.seats}</dd>` +
    `<dt>Seat numbers</dt><dd>${c.coach}1-${c.coach}${inventory.length}</dd>` +
    (dev ? `<dt>Status</dt><dd style="color:var(--good-text)">${dev.s}</dd>` +
      `<dt>Battery</dt><dd>${dev.b}%</dd><dt>Signal</dt><dd>${dev.r} dBm</dd>` +
      `<dt>Firmware</dt><dd>${dev.fw}</dd>` : '') +
    `</dl>`;
}

/* ---------- render: trend chart ---------- */
let chartPoints = [];
function renderChart(sn) {
  const svc = sn.svc, d = D.daily[svc.id];
  const svg = document.getElementById('chart');
  const W = svg.clientWidth || 900, H = 260;
  const m = { t: 12, r: 14, b: 26, l: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  // A weekend drop on every seventh point buries the sold-vs-occupied gap, so
  // the plot defaults to weekdays - unless the day being examined is not one.
  const selIsWeekday = D.dayType[DATE_IX[sn.date]] === 'weekday';
  const weekdaysOnly = state.weekdaysOnly && selIsWeekday;
  const pts = [];
  D.dates.forEach((date, i) => {
    if (d.sold[i] === null) return;
    if (weekdaysOnly && D.dayType[i] !== 'weekday') return;
    pts.push({ i, date,
      sold: (d.sold[i] / svc.seats) * 100,
      occ: (d.occ[i] / svc.seats) * 100,
      soldN: d.sold[i], occN: d.occ[i], ghost: d.ghost[i], away: d.away[i], rev: d.rev[i] });
  });
  const n = pts.length;
  const x = (k) => m.l + (n === 1 ? iw / 2 : (k / (n - 1)) * iw);
  const y = (v) => m.t + ih - (v / 100) * ih;
  chartPoints = pts.map((p, k) => ({ ...p, px: x(k) }));

  const line = (key) => pts.map((p, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');
  const band = pts.map((p, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(p.sold).toFixed(1)).join(' ') +
    ' ' + pts.map((p, k) => 'L' + x(n - 1 - k).toFixed(1) + ' ' + y(pts[n - 1 - k].occ).toFixed(1)).join(' ') + ' Z';

  let grid = '', ticks = '';
  for (let v = 0; v <= 100; v += 25) {
    grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--hairline)" stroke-width="1"/>`;
    ticks += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" fill="var(--ink-muted)" font-size="10.5"` +
      ` font-family="var(--mono)">${v}</text>`;
  }
  let months = '';
  let lastM = '';
  pts.forEach((p, k) => {
    const mo = p.date.slice(0, 7);
    if (mo !== lastM) {
      lastM = mo;
      months += `<text x="${x(k)}" y="${H - 6}" fill="var(--ink-muted)" font-size="10.5" text-anchor="middle">` +
        new Date(p.date + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + '</text>';
    }
  });

  const selK = pts.findIndex((p) => p.date === sn.date);
  const marker = selK < 0 ? '' :
    `<line x1="${x(selK)}" x2="${x(selK)}" y1="${m.t}" y2="${m.t + ih}" stroke="var(--accent)" stroke-width="1"` +
    ` stroke-dasharray="3 3"/>` +
    `<circle cx="${x(selK)}" cy="${y(pts[selK].occ)}" r="5" fill="var(--series-occ)" stroke="var(--surface)" stroke-width="2"/>` +
    `<circle cx="${x(selK)}" cy="${y(pts[selK].sold)}" r="5" fill="var(--series-sold)" stroke="var(--surface)" stroke-width="2"/>`;

  const closedMarks = pts.map((p, k) => p.away > 0
    ? `<rect x="${(x(k) - 1.2).toFixed(1)}" y="${m.t}" width="2.4" height="5" fill="var(--critical)"/>` : '').join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML = grid + ticks + months +
    `<path d="${band}" fill="var(--series-occ)" opacity="0.13"/>` +
    `<path d="${line('sold')}" fill="none" stroke="var(--series-sold)" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="${line('occ')}" fill="none" stroke="var(--series-occ)" stroke-width="2" stroke-linejoin="round"/>` +
    closedMarks + marker +
    `<line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}" stroke="var(--rule)" stroke-width="1"/>` +
    `<g id="hover"></g>`;

  document.getElementById('legend').innerHTML =
    `<span><i style="background:var(--series-sold)"></i>Tickets sold, % of seats</span>` +
    `<span><i style="background:var(--series-occ)"></i>Seats occupied, % of seats (cabin factor)</span>` +
    `<span><i class="band" style="background:var(--series-occ)"></i>Ghost seats &mdash; paid for, travelled empty</span>` +
    `<span><i style="background:var(--critical);height:8px;width:3px"></i>Walk-ups refused</span>`;
  document.getElementById('trendhead').textContent =
    `${svc.id} ${svc.time} \u2014 sold versus occupied, ` +
    `${weekdaysOnly ? 'weekdays' : 'all days'} from ` +
    `${shortDate(D.coverage.from)} to ${shortDate(D.coverage.to)}`;
  document.querySelectorAll('#viewnav .segb').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('dcsel').addEventListener('change', (e) => {
  state.dc = e.target.value;
  renderRank();
});
document.querySelectorAll('#dayfilter .segb').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.v === 'wd') === weekdaysOnly));
    b.disabled = !selIsWeekday;
    b.title = selIsWeekday ? '' : 'Showing all days: ' + shortDate(sn.date) + ' is not a weekday';
  });
}

function bindChart() {
  const svg = document.getElementById('chart');
  const tip = document.getElementById('tip');
  const nearest = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * (svg.viewBox.baseVal.width || r.width);
    let best = null, bd = Infinity;
    for (const p of chartPoints) { const dd = Math.abs(p.px - px); if (dd < bd) { bd = dd; best = p; } }
    return best;
  };
  const move = (ev) => {
    const p = nearest(ev);
    if (!p) return;
    const g = svg.querySelector('#hover');
    const vb = svg.viewBox.baseVal;
    g.innerHTML = `<line x1="${p.px}" x2="${p.px}" y1="12" y2="${vb.height - 26}" stroke="var(--rule)" stroke-width="1"/>`;
    tip.classList.add('on');
    tip.innerHTML = `<div class="th">${shortDate(p.date)}</div><dl>` +
      `<dt><i style="background:var(--series-sold)"></i>Sold</dt><dd>${nf.format(p.soldN)}</dd>` +
      `<dt><i style="background:var(--series-occ)"></i>Occupied</dt><dd>${nf.format(p.occN)}</dd>` +
      `<dt>Ghost seats</dt><dd>${nf.format(p.ghost)}</dd>` +
      `<dt>Walk-ups refused</dt><dd>${nf.format(p.away)}</dd>` +
      `<dt>Revenue</dt><dd>${gbp0.format(p.rev)}</dd></dl>`;
    const r = svg.getBoundingClientRect();
    const box = svg.parentElement.getBoundingClientRect();
    const left = r.left - box.left + (p.px / vb.width) * r.width;
    tip.style.left = Math.max(4, Math.min(left + 14, box.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = '14px';
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => {
    tip.classList.remove('on');
    const g = svg.querySelector('#hover'); if (g) g.innerHTML = '';
  });
  svg.addEventListener('click', (ev) => {
    const p = nearest(ev);
    if (p) { state.date = p.date; renderAll(); }
  });
}

/* ---------- render: route table ---------- */
const COLS = [
  { key: 'time', label: 'Dep', l: true, get: (r) => r.svc.time, cell: (r) => `<b>${r.svc.time}</b>` },
  { key: 'id', label: 'Service', l: true, get: (r) => r.svc.id, cell: (r) => `<span class="mono">${r.svc.id}</span>` },
  { key: 'route', label: 'Route', l: true, get: (r) => r.svc.route, cell: (r) => r.svc.route },
  { key: 'to', label: 'To', l: true, get: (r) => r.svc.to, cell: (r) => r.svc.to },
  { key: 'dc', label: 'Demand', l: true, get: (r) => r.svc.dc, cell: (r) => D.demandClassLabels[r.svc.dc] },
  { key: 'coaches', label: 'Coaches', get: (r) => r.svc.coaches, cell: (r) => r.svc.coaches },
  { key: 'seats', label: 'Seats', get: (r) => r.svc.seats, cell: (r) => nf.format(r.svc.seats) },
  { key: 'sold', label: 'Sold', get: (r) => r.sold, cell: (r) => nf.format(r.sold) },
  { key: 'occupied', label: 'Occupied', get: (r) => r.occupied, cell: (r) => nf.format(r.occupied) },
  { key: 'cabin', label: 'Cabin factor', get: (r) => r.cabin,
    cell: (r) => `<span class="swatch" style="background:var(${seqVar(r.cabin)})"></span>${r.cabin.toFixed(1)}%` },
  { key: 'ghost', label: 'Ghosts', get: (r) => r.ghost, cell: (r) => nf.format(r.ghost) },
  { key: 'away', label: 'Refused' + MODELLED, get: (r) => r.away,
    cell: (r) => r.away > 0 ? `<span class="flag crit">${nf.format(r.away)}</span>` : '0' },
  { key: 'revenue', label: 'Revenue', get: (r) => r.revenue, cell: (r) => gbp0.format(r.revenue) },
];

function renderRouteTable() {
  const list = servicesFor(state.route);
  const rows = list.map((s) => snapshot(s.id, state.date)).filter(Boolean);
  const col = COLS.find((c) => c.key === state.sort.key) || COLS[0];
  rows.sort((a, b) => {
    const av = col.get(a), bv = col.get(b);
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return c * state.sort.dir;
  });
  const head = COLS.map((c) =>
    `<th class="sortable${c.l ? ' l' : ''}" data-key="${c.key}"` +
    ` aria-sort="${state.sort.key === c.key ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none'}">` +
    `${c.label}${state.sort.key === c.key ? (state.sort.dir === 1 ? ' \u2191' : ' \u2193') : ''}</th>`).join('');
  const body = rows.map((r) =>
    `<tr class="click" data-svc="${r.svc.id}" aria-current="${state.service === r.svc.id}">` +
    COLS.map((c) => `<td${c.l ? ' class="l"' : ''}>${c.cell(r)}</td>`).join('') + '</tr>').join('');
  document.getElementById('routetable').innerHTML =
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  const tot = rows.reduce((a, r) => ({
    seats: a.seats + r.svc.seats, sold: a.sold + r.sold, occ: a.occ + r.occupied,
    ghost: a.ghost + r.ghost, away: a.away + r.away, rev: a.rev + r.revenue,
  }), { seats: 0, sold: 0, occ: 0, ghost: 0, away: 0, rev: 0 });
  document.getElementById('routehead').textContent =
    `${state.route === 'ALL' ? 'All routes' : state.route + ' ' + ROUTE[state.route].name}` +
    ` \u2014 ${rows.length} departures on ${shortDate(state.date)}: ` +
    `${nf.format(tot.occ)} of ${nf.format(tot.seats)} seats occupied ` +
    `(${((tot.occ / tot.seats) * 100).toFixed(1)}%), ${nf.format(tot.ghost)} ghost seats, ` +
    `${nf.format(tot.away)} walk-ups refused`;

  document.getElementById('routetable').querySelectorAll('thead th').forEach((th) =>
    th.addEventListener('click', () => {
      const k = th.dataset.key;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
      renderRouteTable();
    }));
  document.getElementById('routetable').querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => { state.service = tr.dataset.svc; state.coach = 0; renderAll(); }));
}


/* ---------- what the recalibrated forecast earned on this train ---------- */
const signedGbp = (n) => (n >= 0 ? '+' : '-') + gbp0.format(Math.abs(n));
const signedPct = (n) => (n >= 0 ? '+' : '') + n.toFixed(3) + '%';

function renderForecastEffect(sn) {
  const a = windowAgg(sn.svc.id);
  const dir = a.uplift >= 0 ? 'up' : 'down';
  document.getElementById('fx').innerHTML = [
    { k: 'Revenue, observed', v: gbp0.format(a.rev), s: nf.format(a.departures) + ' departures' },
    { k: 'Counterfactual', v: gbp0.format(a.cfRev), s: '2025-quality forecasts' },
    { k: 'Attributable', v: signedGbp(a.uplift), s: 'over ' + shortDate(D.coverage.from) + ' to ' + shortDate(D.coverage.to), cls: dir },
    { k: 'Attributable share', v: signedPct(a.upliftPct), s: 'of this departure\u2019s revenue', cls: dir },
    { k: 'Tickets', v: signedPct(a.ticketsUpliftPct),
      s: nf.format(Math.abs(a.sold - a.cfSold)) + (a.sold >= a.cfSold ? ' more' : ' fewer') + ' seats sold',
      cls: a.sold >= a.cfSold ? 'up' : 'down' },
  ].map((x) => `<div class="cell"><div class="k">${x.k}</div>` +
    `<div class="v ${x.cls || ''}">${x.v}</div><div class="s">${x.s}</div></div>`).join('');

  // Cumulative attributable revenue, day by day.
  const d = D.daily[sn.svc.id];
  const pts = [];
  let run = 0;
  D.dates.forEach((date, i) => {
    if (d.sold[i] === null) return;
    run += d.rev[i] - d.cfRev[i];
    pts.push({ date, v: run });
  });
  const svg = document.getElementById('fxchart');
  const W = svg.clientWidth || 900, H = 170;
  const m = { t: 10, r: 14, b: 24, l: 74 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const lo = Math.min(0, ...pts.map((q) => q.v)), hi = Math.max(0, ...pts.map((q) => q.v));
  const span = hi - lo || 1;
  const x = (k) => m.l + (pts.length === 1 ? iw / 2 : (k / (pts.length - 1)) * iw);
  const y = (v) => m.t + ih - ((v - lo) / span) * ih;
  const y0 = y(0);
  const line = pts.map((q, k) => (k ? 'L' : 'M') + x(k).toFixed(1) + ' ' + y(q.v).toFixed(1)).join(' ');
  const area = line + ` L${x(pts.length - 1).toFixed(1)} ${y0.toFixed(1)} L${x(0).toFixed(1)} ${y0.toFixed(1)} Z`;
  const gbpAxis = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v.toFixed(0));
  let months = '', lastM = '';
  pts.forEach((q, k) => {
    const mo = q.date.slice(0, 7);
    if (mo !== lastM) {
      lastM = mo;
      months += `<text x="${x(k)}" y="${H - 5}" fill="var(--ink-muted)" font-size="10.5" text-anchor="middle">` +
        new Date(q.date + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + '</text>';
    }
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML =
    `<defs>` +
      `<clipPath id="fxpos"><rect x="0" y="${m.t}" width="${W}" height="${Math.max(0, y0 - m.t)}"/></clipPath>` +
      `<clipPath id="fxneg"><rect x="0" y="${y0}" width="${W}" height="${Math.max(0, m.t + ih - y0)}"/></clipPath>` +
    `</defs>` +
    `<path d="${area}" fill="var(--series-occ)" opacity="0.16" clip-path="url(#fxpos)"/>` +
    `<path d="${area}" fill="var(--series-sold)" opacity="0.16" clip-path="url(#fxneg)"/>` +
    `<line x1="${m.l}" x2="${W - m.r}" y1="${y0}" y2="${y0}" stroke="var(--rule)" stroke-width="1"/>` +
    `<text x="${m.l - 8}" y="${y0 + 4}" text-anchor="end" font-size="10.5" fill="var(--ink-muted)">GBP 0</text>` +
    (y0 - y(hi) > 14 ? `<text x="${m.l - 8}" y="${y(hi) + 9}" text-anchor="end" font-size="10.5" fill="var(--ink-muted)">${gbpAxis(hi)}</text>` : '') +
    (y(lo) - y0 > 14 ? `<text x="${m.l - 8}" y="${y(lo) - 2}" text-anchor="end" font-size="10.5" fill="var(--ink-muted)">${gbpAxis(lo)}</text>` : '') +
    `<path d="${line}" fill="none" stroke="var(--${dir === 'up' ? 'series-occ' : 'series-sold'})" stroke-width="2" stroke-linejoin="round"/>` +
    `<circle cx="${x(pts.length - 1)}" cy="${y(run)}" r="4" fill="var(--${dir === 'up' ? 'series-occ' : 'series-sold'})"/>` +
    months;

  document.getElementById('fxnote').innerHTML =
    `Cumulative attributable revenue: observed minus the counterfactual, day by day. The counterfactual is ` +
    `the same booking requests, the same fare ladder and the same EMSRb controls with only the 2025 forecast ` +
    `error restored \u2014 so this is what forecast quality was worth on this departure, not a fare rise and not ` +
    `market growth. It can be negative: even a halved error is an error, and on some departures the 2026 one ` +
    `points the wrong way. Revenue and tickets can also move in opposite directions: on a departure whose ` +
    `protection was restored, EMSRb holds seats back for the top of the ladder, so it sells fewer seats for ` +
    `more money.`;
}

/* ---------- sold versus actually full ---------- */
function rankRows(month, dc, routeId) {
  const rows = D.services
    .filter((s) => s.dc === dc && (routeId === 'ALL' || s.route === routeId))
    .map((s) => windowAgg(s.id, { weekdayOnly: true, fromMonth: month, toMonth: month }))
    .filter(Boolean);
  const bySold = [...rows].sort((a, b) => b.assumed - a.assumed);
  const byCabin = [...rows].sort((a, b) => b.cabin - a.cabin);
  const ix = (arr, id) => arr.findIndex((q) => q.svc.id === id);
  return byCabin.map((r) => ({
    ...r,
    rankSold: ix(bySold, r.svc.id) + 1,
    rankCabin: ix(byCabin, r.svc.id) + 1,
    change: ix(bySold, r.svc.id) - ix(byCabin, r.svc.id),
  }));
}

function renderRank() {
  const sel = document.getElementById('dcsel');
  if (!sel.options.length) {
    sel.innerHTML = Object.entries(D.demandClassLabels)
      .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = state.dc;
  }
  const month = +state.date.slice(5, 7);
  const monthName = new Date(state.date + 'T12:00:00Z')
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const rows = rankRows(month, state.dc, state.route);
  const scope = `${D.demandClassLabels[state.dc]}, ` +
    `${state.route === 'ALL' ? 'all routes' : state.route} \u00b7 ${monthName} weekdays`;
  document.getElementById('rankhead').textContent = 'Sold versus actually full \u2014 ' + scope;

  if (rows.length < 2) {
    document.getElementById('rankrule').textContent =
      'Fewer than two departures match this demand class and route, so there is no ranking to compare.';
    document.getElementById('slope').innerHTML = '';
    document.getElementById('ranktable').innerHTML = '';
    return;
  }
  const soldSpread = r1(Math.max(...rows.map((r) => r.assumed)) - Math.min(...rows.map((r) => r.assumed)));
  const cabinSpread = r1(Math.max(...rows.map((r) => r.cabin)) - Math.min(...rows.map((r) => r.cabin)));
  const moved = rows.filter((r) => r.change !== 0).length;
  const worst = [...rows].sort((a, b) => b.overstatement - a.overstatement)[0];
  document.getElementById('rankrule').innerHTML =
    `Ticket sales spread these ${rows.length} departures over <b>${soldSpread} points</b>; measured occupancy ` +
    `spreads them over <b>${cabinSpread}</b>, and <b>${moved} of ${rows.length}</b> change rank between the two ` +
    `lists. Widest gap: <b>${worst.svc.id}</b> at ${worst.assumed}% sold but ${worst.cabin}% occupied ` +
    `(${worst.overstatement} points, no-show rate ${worst.svc.noShow}%). Fare and capacity decisions are made ` +
    `on the ranking, so pricing off the left-hand list aims the money at the wrong train. ` +
    `These are averages over the month\u2019s weekdays, not one date.`;

  // Slope chart: rank by tickets sold on the left, by measured occupancy on the right.
  const svg = document.getElementById('slope');
  const W = svg.clientWidth || 900;
  const rowH = 30, top = 34;
  const H = top + rows.length * rowH + 12;
  const lx = Math.min(230, W * 0.3), rx = W - Math.min(230, W * 0.3);
  const y = (rank) => top + (rank - 1) * rowH + rowH / 2;
  const cls = (c) => (c > 0 ? 'series-occ' : c < 0 ? 'series-sold' : 'rule');
  let g = '';
  for (const r of rows) {
    const col = `var(--${cls(r.change)})`;
    g += `<g data-svc="${r.svc.id}" style="cursor:pointer">` +
      `<rect x="0" y="${y(Math.min(r.rankSold, r.rankCabin)) - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>` +
      `<line x1="${lx}" y1="${y(r.rankSold)}" x2="${rx}" y2="${y(r.rankCabin)}" stroke="${col}" stroke-width="2" opacity="0.85"/>` +
      `<circle cx="${lx}" cy="${y(r.rankSold)}" r="4" fill="${col}"/>` +
      `<circle cx="${rx}" cy="${y(r.rankCabin)}" r="4" fill="${col}"/>` +
      `<text x="${lx - 10}" y="${y(r.rankSold) + 4}" text-anchor="end" font-size="12" fill="var(--ink)">` +
        `${r.rankSold}. ${r.svc.id} ${r.assumed}%</text>` +
      `<text x="${rx + 10}" y="${y(r.rankCabin) + 4}" font-size="12" fill="var(--ink)">` +
        `${r.rankCabin}. ${r.svc.id} ${r.cabin}%</text></g>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  svg.innerHTML =
    `<text x="${lx - 10}" y="18" text-anchor="end" font-size="10.5" font-weight="600" ` +
      `fill="var(--ink-muted)" letter-spacing="0.06em">RANKED BY TICKETS SOLD</text>` +
    `<text x="${rx + 10}" y="18" font-size="10.5" font-weight="600" fill="var(--ink-muted)" ` +
      `letter-spacing="0.06em">RANKED BY MEASURED OCCUPANCY</text>` + g;
  svg.onclick = (ev) => {
    const t = ev.target.closest('[data-svc]');
    if (!t) return;
    state.service = t.dataset.svc;
    state.route = SVC[state.service].route;
    state.coach = 0;
    setView('train');
    renderAll();
  };

  const body = rows.map((r) =>
    `<tr class="click" data-svc="${r.svc.id}"><td class="l"><b>${r.svc.time}</b></td>` +
    `<td class="l mono">${r.svc.id}</td><td class="l">${r.svc.route}</td>` +
    `<td>${r.rankSold}</td><td>${r.rankCabin}</td>` +
    `<td class="moved ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : 'flat'}">` +
      `${r.change === 0 ? '\u2013' : (r.change > 0 ? '+' : '') + r.change}</td>` +
    `<td>${r.assumed}%</td><td>${r.cabin}%</td><td>${r.overstatement}</td>` +
    `<td>${r.svc.noShow}%</td><td>${nf.format(r.ghostPerDep)}</td><td>${r.closedPct}%</td></tr>`).join('');
  document.getElementById('ranktable').innerHTML =
    '<thead><tr><th class="l">Dep</th><th class="l">Service</th><th class="l">Route</th>' +
    '<th>Rank sold</th><th>Rank full</th><th>Move</th><th>Sold</th><th>Occupied</th>' +
    '<th>Gap (pp)</th><th>No-show</th><th>Ghosts<br>avg/day</th><th>Sold out</th></tr></thead>' +
    `<tbody>${body}</tbody>`;
  document.getElementById('ranktable').querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.service = tr.dataset.svc; state.route = SVC[state.service].route; state.coach = 0;
      setView('train'); renderAll();
    }));
}

/* ---------- what to do next ---------- */
const ACTIONS = {
  lengthen_the_train: {
    label: 'Lengthen the train',
    rule: 'Selling out on 25% or more of weekdays with a measured cabin factor of 80%+ \u2014 the forecasts are ' +
      'honest now and the train is genuinely full. Revenue management allocates seats, it cannot create them: ' +
      'the answer is more seats, and for the first time the occupancy record can size the case.',
  },
  recalibrate_the_forecast: {
    label: 'Recalibrate the forecast',
    rule: 'A residual demand-forecast error of 8% or more on a constrained departure. The paper prices errors ' +
      'like this at 1-2% of the departure\u2019s revenue; the fix is the same recalibration that produced the ' +
      '2026 gain, one more turn of the crank.',
  },
  open_more_advance: {
    label: 'Open more Advance',
    rule: 'Assumed load factor at or below 50%: the booking limits are rationing nothing, seats travel empty ' +
      'and unsold. Opening the bottom of the ladder wider costs no protected seat here \u2014 measured ' +
      'occupancy is what proves the room is really there.',
  },
};
const ACTION_ORDER = ['lengthen_the_train', 'recalibrate_the_forecast', 'open_more_advance'];

function actionCandidates() {
  const out = [];
  for (const svc of D.services) {
    const a = windowAgg(svc.id, { weekdayOnly: true, fromMonth: 1, toMonth: 8 });
    if (!a) continue;
    const residual = Math.abs(svc.fe26);
    let action = null;
    if (a.closedPct >= 25 && a.cabin >= 80) action = 'lengthen_the_train';
    else if (residual >= 8 && ['peak_core', 'evening_peak'].includes(svc.dc)) action = 'recalibrate_the_forecast';
    else if (a.assumed <= 50) action = 'open_more_advance';
    if (!action) continue;
    out.push({
      ...a, action, residual,
      indicative: action === 'recalibrate_the_forecast'
        ? r2(a.revPerWeekdayYear * 0.01 * (residual / 25)) : 0,
    });
  }
  out.sort((a, b) =>
    ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) ||
    Math.abs(b.indicative) - Math.abs(a.indicative));
  return out;
}

function renderActions() {
  const all = actionCandidates();
  const counts = {};
  for (const c of all) counts[c.action] = (counts[c.action] || 0) + 1;
  const weekdays = all.length ? all[0].departures : 0;
  document.getElementById('actwindow').textContent =
    `Averages per departure over ${weekdays} weekdays, 1 Jan \u2013 31 Aug 2026 \u00b7 ` +
    `${all.length} of ${D.services.length} departures`;

  document.getElementById('actgrid').innerHTML = ACTION_ORDER.map((k) =>
    `<button class="actsum" type="button" data-act="${k}" aria-pressed="${state.action === k}">` +
    `<div class="n">${counts[k] || 0}</div><div class="t">${ACTIONS[k].label}</div>` +
    `<div class="w">${k === 'recalibrate_the_forecast'
      ? gbp0.format(all.filter((c) => c.action === k).reduce((a, c) => a + c.indicative, 0)) + ' indicative a year'
      : 'no money attached \u2014 a capacity or quota call'}</div></button>`).join('') +
    `<button class="actsum" type="button" data-act="all" aria-pressed="${state.action === 'all'}">` +
    `<div class="n">${all.length}</div><div class="t">All candidates</div>` +
    `<div class="w">ranked, capacity first</div></button>`;
  document.getElementById('actgrid').querySelectorAll('.actsum').forEach((b) =>
    b.addEventListener('click', () => { state.action = b.dataset.act; renderActions(); }));

  // The commonest misreading of this table: taking an average for a single day.
  const scope = `Every figure below is that departure\u2019s <b>average across the ${weekdays} weekdays</b> ` +
    `in the window, not one date. A departure can average 4 walk-ups refused and still refuse none on the ` +
    `day the Train view is showing \u2014 most of them refuse nobody most days. `;
  document.getElementById('actrule').innerHTML = scope + (state.action === 'all'
    ? 'Ranked by action priority \u2014 capacity first, then forecast residuals, then quota openings.'
    : `<b>${ACTIONS[state.action].label}.</b> ${ACTIONS[state.action].rule}`);

  const rows = state.action === 'all' ? all : all.filter((c) => c.action === state.action);
  const body = rows.map((c) =>
    `<tr class="click" data-svc="${c.svc.id}" aria-current="${state.service === c.svc.id}">` +
    `<td class="l"><b>${c.svc.time}</b></td><td class="l mono">${c.svc.id}</td>` +
    `<td class="l">${D.demandClassLabels[c.svc.dc]}</td>` +
    `<td class="l">${ACTIONS[c.action].label}</td>` +
    `<td>${c.assumed}%</td><td>${c.cabin}%</td><td>${c.closedPct}%</td>` +
    `<td>${c.awayPerDep > 0 ? `<span class="flag crit">${c.awayPerDep}</span>` : '0'}</td>` +
    `<td>${c.ghostPerDep}</td><td>${c.svc.fe26}%</td>` +
    `<td>${c.indicative ? gbp0.format(c.indicative) : '\u2013'}</td></tr>`).join('');
  document.getElementById('acttable').innerHTML =
    '<thead><tr><th class="l">Dep</th><th class="l">Service</th>' +
    '<th class="l">Demand</th><th class="l">Action</th><th>Sold</th><th>Occupied</th>' +
    '<th>Sold out</th><th>Refused<br>avg/day' + MODELLED + '</th><th>Ghosts<br>avg/day</th>' +
    '<th>Residual error</th><th>Indicative/yr</th></tr></thead>' + `<tbody>${body}</tbody>`;
  document.getElementById('acttable').querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.service = tr.dataset.svc; state.route = SVC[state.service].route; state.coach = 0;
      setView('train'); renderAll();
    }));

  document.getElementById('actnote').innerHTML =
    `Indicative money is attached only to <b>recalibrate the forecast</b>, scaled from the paper\u2019s finding ` +
    `that a 25% forecast error costs 1-2% of revenue on a constrained departure, at a conservative 1% pro rata. ` +
    `The capacity and quota rows carry no money on purpose: the honest number there is the occupancy record ` +
    `itself. What is <b>not</b> on this list is releasing or reselling no-show seats, and overselling \u2014 ` +
    `neither is available to an operator selling reserved seats, which is why the levers are forecast quality, ` +
    `booking limits and rolling stock.`;
}



/* ---------- shared map geometry ---------- */
const WORLD = 4096;
const ROUTE_MAP_MIN_SPAN = 58;   // world units; ~2.1 degrees of longitude
function proj(lon, lat) {
  const x = ((lon + 180) / 360) * WORLD;
  const sn = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * WORLD;
  return [x, y];
}
function frame(points, padFrac) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [lon, lat] of points) {
    const [x, y] = proj(lon, lat);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const w = Math.max(x1 - x0, 0.001), h = Math.max(y1 - y0, 0.001);
  const pad = Math.max(w, h) * padFrac;
  return [x0 - pad, y0 - pad, w + pad * 2, h + pad * 2];
}
/* ---------- render: where this departure runs ---------- */
/**
 * A compact route map for the selected train, in its direction of travel.
 * Absent from Version 1, whose template does not host it, so this no-ops
 * there rather than the two versions needing different engines.
 *
 * It shows geography and the calling order, and nothing about load: there is
 * no per-leg occupancy in the data, so the line carries no value encoding.
 */
function renderRouteMap(sn) {
  const svg = document.getElementById('trainmap');
  if (!svg) return;
  const route = ROUTE[sn.svc.route];
  const stops = sn.svc.dir === 'up' ? route.stations : [...route.stations].slice().reverse();

  const W = svg.clientWidth || 640;
  const H = Math.round(Math.min(380, Math.max(250, W * 0.66)));
  svg.setAttribute('height', H);
  // A short route framed tightly shows no recognisable coast at all - just a
  // green field meeting a blue one. Hold a floor on the extent so every route
  // sits in enough of the country to be placed.
  const box = fitBox(atLeast(frame(stops.map((st) => [st.lon, st.lat]), 0.3), ROUTE_MAP_MIN_SPAN), W, H);
  svg.setAttribute('viewBox', box.join(' '));
  // preserveAspectRatio="meet": marks are counter-scaled so they stay constant.
  const k = 1 / Math.min(W / box[2], H / box[3]);

  const land = D.coast.map((ring) =>
    '<path class="land" d="' +
    ring.map(([lon, lat], i) => (i ? 'L' : 'M') + proj(lon, lat).map((v) => v.toFixed(1)).join(' ')).join(' ') +
    ' Z"/>').join('');

  const pts = stops.map((st) => proj(st.lon, st.lat));
  const rb = frame(stops.map((st) => [st.lon, st.lat]), 0);
  const rc = [rb[0] + rb[2] / 2, rb[1] + rb[3] / 2];
  const d = pts.map((q, i) => (i ? 'L' : 'M') + q.map((v) => v.toFixed(1)).join(' ')).join(' ');

  // One arrowhead on the middle leg. Several smaller ones along the line read
  // as a dashed line rather than as direction of travel.
  const mid = Math.max(1, Math.floor(pts.length / 2));
  const [ax0, ay0] = pts[mid - 1], [ax1, ay1] = pts[mid];
  const chev =
    `<g transform="translate(${((ax0 + ax1) / 2).toFixed(1)} ${((ay0 + ay1) / 2).toFixed(1)}) ` +
    `rotate(${((Math.atan2(ay1 - ay0, ax1 - ax0) * 180) / Math.PI).toFixed(1)}) scale(${k.toFixed(4)})">` +
    `<path class="chev" d="M -5 -6 L 7 0 L -5 6 Z" fill="var(--route-${sn.svc.route})"/></g>`;

  let marks = '';
  stops.forEach((st, i) => {
    const [x, y] = pts[i];
    const end = i === 0 || i === stops.length - 1;
    const label = end ? st.name : '';
    // Place a terminus label on the far side from the route's own centre, and
    // above or below the line, so it never sits on top of the track.
    const left = x > rc[0];
    const dy = y < rc[1] ? -10 : 17;
    marks += `<g class="stnmark${end ? ' term' : ''}" data-stn="${st.name}"` +
      ` transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(4)})">` +
      `<circle r="${end ? 5 : 3}" fill="var(--route-${sn.svc.route})"/>` +
      (label ? `<text class="stnlabel" x="${left ? -9 : 9}" y="${dy}"` +
        ` text-anchor="${left ? 'end' : 'start'}">${label}</text>` : '') +
      `<title>${st.name}${i === 0 ? ' (departs)' : i === stops.length - 1 ? ' (arrives)' : ''}</title></g>`;
  });

  svg.innerHTML = `<g>${land}</g>` +
    `<path class="halo" d="${d}"/>` +
    `<path class="line" stroke="var(--route-${sn.svc.route})" d="${d}"/>` +
    chev + `<g>${marks}</g>`;

  const list = document.getElementById('trainstops');
  if (list) {
    list.innerHTML = stops.map((st, i) => {
      const end = i === 0 || i === stops.length - 1;
      return `<span class="stop${end ? ' end' : ''}">${st.name}</span>`;
    }).join('<span class="sep">&rsaquo;</span>');
  }
  svg.onclick = () => { state.mapZoom = 'route'; setView('map'); };
  const cap = document.getElementById('trainmapnote');
  if (cap) {
    cap.innerHTML = `${stops.length} calling points, ${sn.svc.dir === 'up' ? 'towards the city' : 'outbound'}. ` +
      `The line shows where this departure runs, not how full it is along the way: occupancy is one ` +
      `figure for the whole journey, so nothing in the data attaches to an intermediate stop yet.`;
  }
}

/* ---------- render: the network on a map ---------- */
/**
 * Web Mercator into a fixed world space; framing is done entirely by the
 * viewBox, so zooming never re-projects anything.
 */
/** Grow a frame about its centre until neither side is below `min`. */
function atLeast([x, y, w, h], min) {
  const nw = Math.max(w, min), nh = Math.max(h, min);
  return [x - (nw - w) / 2, y - (nh - h) / 2, nw, nh];
}

/**
 * Grow a frame to the container's aspect ratio, keeping it centred. Without
 * this, preserveAspectRatio="meet" leaves a tall thin route (NBR2 is nearly
 * vertical) stranded in a narrow strip with empty space either side.
 */
function fitBox([x, y, w, h], W, H) {
  const aspect = W / H;
  if (w / h < aspect) { const nw = h * aspect; return [x - (nw - w) / 2, y, nw, h]; }
  const nh = w / aspect;
  return [x, y - (nh - h) / 2, w, nh];
}

const GB_BOX = [[-8.2, 49.9], [1.9, 58.7]];
function extentFor(kind) {
  if (kind === 'gb') return frame(GB_BOX, 0.02);
  // 'route' frames the selected route; with no single route selected it falls
  // back to the whole network, which is what 'network' asks for anyway.
  const one = kind === 'route' ? ROUTE[state.route] : null;
  const routes = one ? [one] : D.routes;
  const pts = routes.flatMap((r) => r.stations.map((st) => [st.lon, st.lat]));
  return frame(pts, 0.22);
}

/** Counter-scale the station marks so they stay constant on screen. */
function rescaleMarks() {
  const svg = document.getElementById('map');
  const vb = svg.viewBox.baseVal;
  const w = svg.clientWidth, h = svg.clientHeight;
  if (!vb.width || !w || !h) return;
  const scale = Math.min(w / vb.width, h / vb.height);   // preserveAspectRatio="meet"
  const k = (1 / scale).toFixed(4);
  svg.querySelectorAll('.stnmark').forEach((g) =>
    g.setAttribute('transform', `translate(${g.dataset.x} ${g.dataset.y}) scale(${k})`));
}

let mapTween = null;
function setExtent(box, animate) {
  const svg = document.getElementById('map');
  const now = (svg.getAttribute('viewBox') || box.join(' ')).split(' ').map(Number);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (mapTween) cancelAnimationFrame(mapTween);
  if (!animate || reduce || now.length !== 4) {
    svg.setAttribute('viewBox', box.join(' '));
    rescaleMarks();
    return;
  }
  const t0 = performance.now(), dur = 420;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    svg.setAttribute('viewBox', now.map((v, i) => v + (box[i] - v) * e).join(' '));
    rescaleMarks();
    if (k < 1) mapTween = requestAnimationFrame(step);
  };
  mapTween = requestAnimationFrame(step);
}

function renderMap(animate) {
  const svg = document.getElementById('map');
  const W = svg.clientWidth || 900;
  svg.setAttribute('height', Math.round(Math.min(620, Math.max(360, W * 0.72))));

  const land = D.coast.map((ring) =>
    '<path class="land" d="' +
    ring.map(([lon, lat], i) => (i ? 'L' : 'M') + proj(lon, lat).map((v) => v.toFixed(1)).join(' ')).join(' ') +
    ' Z"/>').join('');

  let lines = '', stations = '';
  for (const r of D.routes) {
    const dim = state.route !== 'ALL' && state.route !== r.id ? ' dim' : '';
    const d = r.stations.map((st, i) => (i ? 'L' : 'M') + proj(st.lon, st.lat).map((v) => v.toFixed(1)).join(' ')).join(' ');
    lines += `<path class="halo${dim}" d="${d}"/>` +
      `<path class="line${dim}" data-route="${r.id}" stroke="var(--route-${r.id})" d="${d}">` +
      `<title>${r.id} ${r.name}</title></path>`;
    // Marks sit in a group that is scaled by the inverse of the map scale, so a
    // dot stays a dot at every zoom instead of swelling to cover the route.
    r.stations.forEach((st, i) => {
      const [x, y] = proj(st.lon, st.lat);
      const term = i === 0 || i === r.stations.length - 1;
      const toLondon = /London/.test(st.name);
      // The two London termini are 5 km apart, so their labels collide at any
      // extent wide enough to show both. Stagger them by route.
      const dy = toLondon ? [-3, 15, 0][D.routes.findIndex((q) => q.id === r.id)] || 0 : 4;
      stations += `<g class="stnmark${term ? ' term' : ''}${dim}" data-route="${r.id}"` +
        ` data-stn="${st.name}" data-pos="${st.lat.toFixed(4)}, ${st.lon.toFixed(4)}"` +
        ` data-x="${x.toFixed(2)}" data-y="${y.toFixed(2)}">` +
        `<circle r="${term ? 5 : 3.2}" fill="var(--route-${r.id})"/>` +
        (term ? `<text class="stnlabel" x="${toLondon ? -9 : 9}" y="${dy}"` +
          ` text-anchor="${toLondon ? 'end' : 'start'}">${st.name}</text>` : '') +
        `<title>${st.name}</title></g>`;
    });
  }
  svg.innerHTML = `<g>${land}</g><g>${lines}</g><g id="marks">${stations}</g>`;
  setExtent(fitBox(extentFor(state.mapZoom), W, svg.clientHeight || W * 0.72), animate);

  svg.onclick = (ev) => {
    const t = ev.target.closest('[data-route]');
    if (!t) return;
    state.route = t.dataset.route;
    const list = servicesFor(state.route);
    if (!list.some((x) => x.id === state.service)) { state.service = list[0].id; state.coach = 0; }
    renderAll();
    renderMap(true);
  };
  const readout = document.getElementById('mapreadout');
  const idle = `${D.routes.length} routes, ${D.routes.reduce((a, r) => a + r.stations.length, 0)} stations` +
    ` \u00b7 real positions, drawn from ${D.coastSource.split('(')[0].trim()}`;
  readout.textContent = idle;
  svg.onmouseover = (ev) => {
    const t = ev.target.closest('[data-stn]');
    if (t) readout.textContent = `${t.dataset.stn} \u00b7 ${t.dataset.pos} \u00b7 ${t.dataset.route}`;
  };
  svg.onmouseleave = () => { readout.textContent = idle; };

  // Per-route figures for the selected date - the only numbers the map can
  // honestly carry, since nothing in the data attaches to a station yet.
  const cards = D.routes.map((r) => {
    const rows = D.services.filter((x) => x.route === r.id)
      .map((x) => snapshot(x.id, state.date)).filter(Boolean);
    const seats = rows.reduce((a, x) => a + x.svc.seats, 0);
    const occ = rows.reduce((a, x) => a + x.occupied, 0);
    const away = rows.reduce((a, x) => a + x.away, 0);
    return `<button class="routecard" type="button" data-route="${r.id}"` +
      ` aria-pressed="${state.route === r.id}" style="border-left-color:var(--route-${r.id})">` +
      `<div class="rn">${r.id} ${r.name}</div>` +
      `<div class="rs">${r.from} \u2014 ${r.to} \u00b7 ${r.stations.length} stops</div>` +
      `<div class="rv">${rows.length} departures \u00b7 ${nf.format(occ)} of ${nf.format(seats)} seats` +
      ` (${((occ / seats) * 100).toFixed(1)}%)${away > 0 ? ` \u00b7 ${nf.format(away)} refused` : ''}</div></button>`;
  }).join('');
  document.getElementById('mapside').innerHTML =
    `<button class="routecard" type="button" data-route="ALL" aria-pressed="${state.route === 'ALL'}">` +
    `<div class="rn">All routes</div><div class="rs">the whole network on ${shortDate(state.date)}</div></button>` + cards;
  document.getElementById('mapside').querySelectorAll('.routecard').forEach((b) =>
    b.addEventListener('click', () => {
      state.route = b.dataset.route;
      const list = servicesFor(state.route);
      if (!list.some((x) => x.id === state.service)) { state.service = list[0].id; state.coach = 0; }
      renderAll();
      renderMap(true);
    }));

  document.getElementById('maphead').textContent =
    state.route === 'ALL' ? 'Where the network runs'
      : `${state.route} ${ROUTE[state.route].name} \u2014 ${ROUTE[state.route].stops.join(' \u00b7 ')}`;
  document.querySelectorAll('#mapzoom .segb').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.z === state.mapZoom)));
  document.getElementById('mapnote').innerHTML =
    `Real stations in their real positions, on three real corridors \u2014 the Great Eastern Main Line, the ` +
    `Great Northern route and the Huddersfield\u2013York line. <b>The intermediate stations carry no data.</b> ` +
    `Every journey in this model runs terminus to terminus, so nobody boards or alights at Chelmsford or ` +
    `Stevenage and the load along a line is flat by construction. Giving each booking an origin and a ` +
    `destination stop is what would turn these dots into places, and give the line a shape.`;
}

/* ---------- views ---------- */
function setView(v) {
  state.view = v;
  for (const name of ['train', 'rank', 'actions', 'case', 'map']) {
    document.getElementById('view-' + name).hidden = name !== v;
  }
  document.querySelectorAll('#viewnav .segb').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  // A hidden container measures 0 wide, so anything drawn to a measured width
  // has to be drawn again once its view is actually on screen.
  const sn = snapshot(state.service, state.date);
  if (v === 'train' && sn) { renderChart(sn); renderRouteMap(sn); }
  if (v === 'rank') renderRank();
  if (v === 'case' && sn) renderForecastEffect(sn);
  if (v === 'map') renderMap(false);
}

/* ---------- orchestration ---------- */
function renderAll() {
  const sn = snapshot(state.service, state.date);
  renderChips();
  renderDate();
  renderDepList();
  if (!sn) {
    document.getElementById('identity').innerHTML =
      `<span class="od">No data for ${SVC[state.service].id} on ${longDate(state.date)}.</span>`;
    document.getElementById('tiles').innerHTML = '';
    return;
  }
  if (state.coach >= sn.coaches.length) state.coach = 0;
  renderIdentity(sn);
  renderTiles(sn);
  renderFormation(sn);
  renderCoach(sn);
  renderChart(sn);
  renderRouteMap(sn);
  renderForecastEffect(sn);
  renderRouteTable();
  renderRank();
  renderActions();
  if (state.view === 'map') renderMap(false);
  writeHash();
}

document.querySelectorAll('#viewnav .segb').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));
document.getElementById('dcsel').addEventListener('change', (e) => {
  state.dc = e.target.value;
  renderRank();
});
document.querySelectorAll('#dayfilter .segb').forEach((b) =>
  b.addEventListener('click', () => {
    state.weekdaysOnly = b.dataset.v === 'wd';
    const sn = snapshot(state.service, state.date);
    if (sn) renderChart(sn);
  }));
document.querySelectorAll('#mapzoom .segb').forEach((b) =>
  b.addEventListener('click', () => { state.mapZoom = b.dataset.z; renderMap(true); }));
document.getElementById('date').addEventListener('change', (e) => {
  if (DATE_IX[e.target.value] !== undefined) { state.date = e.target.value; renderAll(); }
  else e.target.value = state.date;
});
document.getElementById('prevday').addEventListener('click', () => {
  const i = DATE_IX[state.date]; if (i > 0) { state.date = D.dates[i - 1]; renderAll(); }
});
document.getElementById('nextday').addEventListener('click', () => {
  const i = DATE_IX[state.date]; if (i < D.dates.length - 1) { state.date = D.dates[i + 1]; renderAll(); }
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const i = DATE_IX[state.date];
  if (e.key === 'ArrowLeft' && i > 0) { state.date = D.dates[i - 1]; renderAll(); }
  if (e.key === 'ArrowRight' && i < D.dates.length - 1) { state.date = D.dates[i + 1]; renderAll(); }
});
let rt;
addEventListener('resize', () => {
  clearTimeout(rt);
  rt = setTimeout(() => {
    const sn = snapshot(state.service, state.date);
    if (sn) { renderChart(sn); renderRouteMap(sn); renderForecastEffect(sn); }
    renderRank();
    if (state.view === 'map') renderMap(false);
  }, 150);
});

document.getElementById('tenant').innerHTML =
  `yggio tenant ${D.tenant}<br>${D.coverage.from} &rarr; ${D.coverage.to} &middot; ` +
  `${nf.format(Object.keys(D.devices).length)} nodes`;
document.getElementById('footnote').innerHTML =
  `<strong>What is measured, and what is not.</strong> SeatSense went live ${D.goLive} and reports ` +
  `occupancy per coach, one node per coach &mdash; so coach totals are measured and individual seat ` +
  `positions are not. Before that the operator had ticket sales only, which cannot tell a passenger ` +
  `from a no-show, so there is no 2025 occupancy figure to compare against and this dashboard covers ` +
  `${D.coverage.from} to ${D.coverage.to} only. Cabin factor is measured occupancy over seats; the ` +
  `ticket system&rsquo;s own figure counts every no-show as a passenger on board. Ghost seats are paid ` +
  `for and travelled empty &mdash; a measurement, not recoverable inventory: the seat still belongs to ` +
  `its buyer and Northbank Rail may not oversell. <b>Walk-ups refused is modelled, not measured.</b> ` +
  `It counts Anytime Standard requests arriving at a full Standard cabin \u2014 but a walk-up who finds ` +
  `no seat simply leaves, so no system counts them. It is the revenue-management model\u2019s ` +
  `unconstrained demand; what an operator really observes is that the cabin closed, and estimates the ` +
  `rest by unconstraining censored sales or from search and ticket-machine logs. SeatSense does not ` +
  `change this: it measures occupancy, not refused demand. Northbank Rail is fictional and this data synthetic.`;

restore();
renderAll();
bindChart();
