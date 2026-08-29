/**
 * Builds dashboard/index.html: a self-contained interactive seat-usage
 * dashboard. The per-coach allocation is the same code as seatsenseSnapshot in
 * dataset.mjs, so every number the page shows matches the yggio MCP tools.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const meta = read('data/operator.json');
const services = read('data/services.json');
const rows2026 = read('data/daily-2026.json');
const devices = read('data/devices.json');

const routes = meta.routes ?? meta.operator?.routes ?? null;
if (!routes) throw new Error('routes not found in operator.json: ' + Object.keys(meta));

/** Unit-number range for a service's unit type - the fleet groups run in order. */
function unitRange(svc) {
  const route = routes.find((r) => r.route_id === svc.route_id);
  let start = 1;
  for (const g of route.fleet.unit_types) {
    if (g.type === svc.unit_type) return [start, start + g.units - 1];
    start += g.units;
  }
  throw new Error(`no unit group for ${svc.service_id}`);
}

const svcOut = services.map((s) => ({
  id: s.service_id,
  route: s.route_id,
  time: s.departure_time,
  dir: s.direction,
  from: s.origin,
  to: s.destination,
  dc: s.demand_class,
  formation: s.formation,
  units: s.formation_units,
  coaches: s.coaches,
  seats: s.seats,
  seatsStd: s.seats_standard,
  seatsFirst: s.seats_first,
  coachSeats: s.coach_seats.map((c) => [c.set, c.letter, c.seats_standard, c.seats_first]),
  range: unitRange(s),
  anytime: s.booking_classes.standard[0].fare_gbp,
  ladder: s.booking_classes.standard.map((b) => [b.id, b.label, b.fare_gbp]),
  noShow: s.no_show_rate_pct,
  fe25: s.forecast_error_2025_pct,
  fe26: s.forecast_error_2026_pct,
}));

// Dates, ordered; rows encoded as parallel arrays indexed by date.
const dates = [...new Set(rows2026.map((r) => r.date))].sort();
const dateIx = new Map(dates.map((d, i) => [d, i]));
const dayType = new Array(dates.length).fill(null);

const daily = {};
for (const s of svcOut) {
  daily[s.id] = {
    sold: new Array(dates.length).fill(null),
    occ: new Array(dates.length).fill(null),
    ghost: new Array(dates.length).fill(null),
    rev: new Array(dates.length).fill(null),
    away: new Array(dates.length).fill(null),
    closed: new Array(dates.length).fill(0),
    cfRev: new Array(dates.length).fill(null),
    cfSold: new Array(dates.length).fill(null),
  };
}
for (const r of rows2026) {
  const i = dateIx.get(r.date);
  const d = daily[r.service_id];
  if (!d) continue;
  dayType[i] = r.day_type;
  d.sold[i] = r.tickets_sold;
  d.occ[i] = r.seats_occupied;
  d.ghost[i] = r.ghost_seats;
  d.rev[i] = Math.round(r.revenue_gbp * 100) / 100;
  d.away[i] = r.demand_turned_away;
  d.closed[i] = r.sales_closed ? 1 : 0;
  d.cfRev[i] = Math.round(r.cf_revenue_gbp * 100) / 100;
  d.cfSold[i] = r.cf_tickets_sold;
}

const dev = {};
for (const d of devices) {
  dev[d._id] = {
    b: d.latestValues.batteryPercent,
    r: d.latestValues.rssi,
    s: d.status,
    fw: d.contextMap.firmware,
    at: d.latestValues.reportedAt,
  };
}

const routeOut = routes.map((r) => ({
  id: r.route_id,
  name: r.name,
  from: r.origin,
  to: r.destination,
  stops: r.calling_points,
  fleet: r.fleet.units,
  coaches: r.fleet.coaches,
  departures: r.daily_departures,
  anytime: r.anytime_standard_fare_gbp,
}));

const payload = {
  tenant: meta.yggio_tenant ?? 'northbank-rail-prod',
  operator: 'Northbank Rail',
  coverage: { from: dates[0], to: dates[dates.length - 1] },
  goLive: '2026-01-01',
  dates,
  dayType,
  routes: routeOut,
  services: svcOut,
  daily,
  devices: dev,
  demandClassLabels: {
    peak_core: 'Morning peak core',
    peak_shoulder: 'Peak shoulder',
    offpeak: 'Off-peak',
    evening_peak: 'Evening peak',
    early_late: 'Early / late',
  },
};

const tpl = readFileSync(join(root, 'dashboard/template.html'), 'utf8');
const out = tpl.replace('"__DATA__"', JSON.stringify(payload));
writeFileSync(join(root, 'dashboard/index.html'), out);
console.log(
  `dashboard/index.html written - ${svcOut.length} services, ${dates.length} days, ` +
    `${Object.keys(dev).length} nodes, ${(out.length / 1e6).toFixed(2)} MB`,
);
