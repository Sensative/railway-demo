/**
 * Query layer over the generated JSON files.
 *
 * The MCP server and the REST API are both thin wrappers around
 * the functions here. Every function returns pre-aggregated numbers plus a
 * short `narrative` string, so a small local model does not have to do
 * arithmetic over thousands of rows to answer a question correctly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const load = (f) => JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));

const META = load('operator.json');
const TICKET_DATA = META.ticket_data;
const SALES_POLICY = META.sales_policy;
const BUSINESS_CASE = META.business_case;
const OPERATOR_PILOT = META.operator.seatsense.pilot;
const SERVICES = load('services.json');
const DEVICES = load('devices.json');
const PRICING = load('pricing.json');
const SEATMAPS = load('seatmaps.json');
const ROWS = { 2025: load('daily-2025.json'), 2026: load('daily-2026.json') };

const SVC = Object.fromEntries(SERVICES.map((s) => [s.service_id, s]));
const BASELINE = META.coverage.baselineYear;
const CURRENT = META.coverage.seatsenseYear;
const COVERAGE_END = META.coverage.end;
const LAST_MONTH = Number(COVERAGE_END.slice(5, 7));
/** Last ordinary weekday in the data - the sensible default for "show me a train". */
const LATEST_WEEKDAY = ROWS[2026].filter((r) => r.day_type === 'weekday').at(-1).date;

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const gbp = (n) => `GBP ${Math.round(n).toLocaleString('en-GB')}`;
const pct = (n) => `${n > 0 ? '+' : ''}${n}%`;
const growth = (a, b) => (a ? r1((b / a - 1) * 100) : null);
const growth3 = (a, b) => (a ? r3((b / a - 1) * 100) : null);
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** The window both years have data for - the only honest comparison. */
export const LIKE_FOR_LIKE = {
  from_month: 1,
  to_month: LAST_MONTH,
  label: `1 January - ${COVERAGE_END.slice(8)} ${MONTH_NAMES[LAST_MONTH - 1]}`,
  note: `${CURRENT} data ends ${COVERAGE_END}, so year-on-year figures compare the same calendar window in both years unless you ask for something else. Both windows contain the same number of weekdays, Saturdays and Sundays, so the comparison needs no calendar adjustment.`,
};

/**
 * The vocabulary this dataset insists on. The difference between the first two
 * entries is the entire argument for SeatSense.
 */
export const DEFINITIONS = {
  assumed_load_factor_pct:
    'Tickets sold / seats. What an operator without seat sensors reports as its load factor. Revenue is booked whether the ticket holder travels or not, so this number counts every no-show as a passenger on board - and it is the number pricing and capacity decisions get made on.',
  cabin_factor_pct:
    'Seats SeatSense measured as physically occupied / seats. The real number. 2026 only: it did not exist before the sensors were fitted.',
  ghost_seats:
    'Seats that were paid for and travelled empty. Not recoverable - the seat still belongs to its buyer, and overselling to cover it is not permitted.',
  sold_out_departures_pct:
    'Share of departures where the Standard cabin sold every seat and was refusing requests. Under EMSRb a sell-out is not automatically a failure: the question is who was on board when it happened.',
  passengers_turned_away:
    'Anytime Standard requests refused because no Standard seat was left - walk-up passengers who could not travel at any price. An airline would absorb these by overbooking; a European operator selling reserved seats cannot. A passenger whose cheap class had closed while dearer seats remained is priced, not refused, and is not counted here.',
  counterfactual:
    "cf_* fields: what the same day's booking requests would have produced under 2025's forecast quality - identical demand, identical fares, identical EMSRb controls, only the forecast error restored. Observed minus counterfactual is the forecast-quality effect - the SeatSense business case.",
  forecast_error:
    "How far the demand forecast fed to EMSRb was from the truth, persistent per departure. 2025: ~25% mean error, calibrated on ticket data that counts ghosts. 2026: ~12.5%, recalibrated on measured occupancy - the paper's scenario pair.",
};

// ---------------------------------------------------------------------------
// Filtering and aggregation
// ---------------------------------------------------------------------------

function select(year, { route_id, demand_class, service_id, day_type, from_month, to_month, from_date, to_date } = {}) {
  const fm = from_month ?? 1;
  const tm = to_month ?? 12;
  return ROWS[year].filter((row) => {
    const svc = SVC[row.service_id];
    const m = Number(row.date.slice(5, 7));
    if (m < fm || m > tm) return false;
    if (from_date && row.date < from_date) return false;
    if (to_date && row.date > to_date) return false;
    if (route_id && svc.route_id !== route_id) return false;
    if (demand_class && svc.demand_class !== demand_class) return false;
    if (service_id && row.service_id !== service_id) return false;
    if (day_type && row.day_type !== day_type) return false;
    return true;
  });
}

/** Distinct dates by day type - the calendar behind an aggregate. */
function dayMix(rows) {
  const seen = new Set(), mix = {};
  for (const r of rows) {
    if (seen.has(r.date)) continue;
    seen.add(r.date);
    mix[r.day_type] = (mix[r.day_type] || 0) + 1;
  }
  return mix;
}

/** Per-day-type totals, so two periods with different calendars can be compared. */
function byDayType(rows) {
  const out = {};
  for (const r of rows) {
    const d = (out[r.day_type] ??= { dates: new Set(), revenue: 0, tickets: 0 });
    d.dates.add(r.date);
    d.revenue += r.revenue_gbp;
    d.tickets += r.tickets_sold;
  }
  return out;
}

/**
 * Rebuild one year's totals on the other year's calendar.
 *
 * A month can contain one more or one fewer weekday than the same month a year
 * earlier, which is worth several percent of its revenue - far more than the
 * effect this demo is trying to show. So any comparison of a period shorter
 * than the whole window has to be adjusted for it.
 */
function onCalendarOf(rows, referenceRows) {
  const mine = byDayType(rows), ref = dayMix(referenceRows);
  let revenue = 0, tickets = 0, covered = true;
  for (const [dt, days] of Object.entries(ref)) {
    const d = mine[dt];
    if (!d) { covered = false; continue; }
    revenue += (d.revenue / d.dates.size) * days;
    tickets += (d.tickets / d.dates.size) * days;
  }
  return { revenue_gbp: r2(revenue), tickets_sold: Math.round(tickets), complete: covered };
}

function aggregate(rows, year) {
  const departures = rows.length;
  if (!departures) return null;
  const seats = rows.reduce((a, r) => a + SVC[r.service_id].seats, 0);
  const sold = sum(rows, 'tickets_sold');
  const revenue = sum(rows, 'revenue_gbp');
  const assumed = r1((sold / seats) * 100);
  const mix = dayMix(rows);
  const out = {
    departures,
    day_mix: mix,
    seats_offered: seats,
    tickets_sold: sold,
    seats_unsold: seats - sold,
    revenue_per_weekday_gbp: mix.weekday ? r2(sum(rows.filter((r) => r.day_type === 'weekday'), 'revenue_gbp') / mix.weekday) : null,
    revenue_gbp: r2(revenue),
    avg_fare_gbp: r2(revenue / sold),
    assumed_load_factor_pct: assumed,
    sold_out_departures_pct: r1((rows.filter((r) => r.sales_closed).length / departures) * 100),
    passengers_turned_away: sum(rows, 'demand_turned_away'),
  };
  if (year >= CURRENT) {
    const occupied = sum(rows, 'seats_occupied');
    const ghost = sum(rows, 'ghost_seats');
    const cabin = r1((occupied / seats) * 100);
    const cfRevenue = sum(rows, 'cf_revenue_gbp');
    out.cabin_factor_pct = cabin;
    out.seatsense = {
      boarded: sum(rows, 'boarded'),
      seats_occupied: occupied,
      cabin_factor_pct: cabin,
      ticket_data_would_have_reported_pct: assumed,
      overstatement_pp: r1(assumed - cabin),
      overstatement_pct: r1((assumed / cabin - 1) * 100),
      ghost_seats: ghost,
      ghost_seat_pct: r1((ghost / seats) * 100),
    };
    out.forecast_effect = {
      counterfactual_revenue_gbp: r2(cfRevenue),
      counterfactual_tickets_sold: sum(rows, 'cf_tickets_sold'),
      revenue_uplift_gbp: r2(revenue - cfRevenue),
      revenue_uplift_pct: growth3(cfRevenue, revenue),
      tickets_uplift_pct: growth3(sum(rows, 'cf_tickets_sold'), sold),
    };
  } else {
    // Deliberately null. Revenue is booked whether the ticket holder travels
    // or not, so nothing in 2025's data distinguishes a passenger from a
    // no-show, and there is no honest occupancy figure to report.
    out.cabin_factor_pct = null;
    out.cabin_factor_status =
      'Not measurable in 2025: no seat sensors, and ticket data cannot see a no-show. Only assumed_load_factor_pct exists, and it overstates how full the train was.';
    out.seatsense = null;
  }
  return out;
}

const GROUPERS = {
  total: () => ({ key: 'network', label: `${META.operator.name} - whole network` }),
  month: (row) => {
    const m = Number(row.date.slice(5, 7));
    return { key: String(m).padStart(2, '0'), label: MONTH_NAMES[m - 1] };
  },
  route: (row) => {
    const s = SVC[row.service_id];
    return { key: s.route_id, label: `${s.route_id} ${s.route_name}` };
  },
  service: (row) => {
    const s = SVC[row.service_id];
    return { key: s.service_id, label: `${s.departure_time} ${s.origin} - ${s.destination}` };
  },
  demand_class: (row) => ({ key: SVC[row.service_id].demand_class, label: SVC[row.service_id].demand_class }),
  day_type: (row) => ({ key: row.day_type, label: row.day_type }),
};

function groupAggregate(year, filters, groupBy) {
  const grouper = GROUPERS[groupBy] || GROUPERS.total;
  const buckets = new Map();
  for (const row of select(year, filters)) {
    const { key, label } = grouper(row);
    if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] });
    buckets.get(key).rows.push(row);
  }
  const out = new Map();
  for (const [key, b] of buckets) out.set(key, { key, label: b.label, agg: aggregate(b.rows, year), rows: b.rows });
  return out;
}

const sameMix = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] || 0) === (b[k] || 0));
};

const weekdaysIn = (year, filters) => new Set(select(year, { ...filters, day_type: 'weekday' }).map((r) => r.date)).size;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function overview() {
  const head = compareYears({ group_by: 'total' });
  const t = head.rows[0];
  const eff = t.y2026.forecast_effect;
  return {
    yggio_tenant: META.operator.yggioTenant,
    operator: {
      name: META.operator.name,
      country: META.operator.country,
      currency: META.operator.currency,
      product: META.operator.product,
      profile: `${META.routes.length} routes, ${SERVICES.length} daily departures, ${DEVICES.length} SeatSense nodes`,
      disclaimer: META.operator.disclaimer,
    },
    sales_policy: SALES_POLICY,
    seatsense: {
      product: META.operator.seatsense.product,
      measures: META.operator.seatsense.measures,
      fleet_go_live: META.operator.seatsense.fleetGoLive,
      business_case: BUSINESS_CASE,
      pilot: META.operator.seatsense.pilot,
      nodes_online: DEVICES.filter((d) => d.status === 'online').length,
      nodes_offline: DEVICES.filter((d) => d.status !== 'online').length,
    },
    data_coverage: {
      baseline_year: `${BASELINE} - ticket sales only, no occupancy measurement`,
      seatsense_year: `${CURRENT}-01-01 .. ${COVERAGE_END} - ticket sales plus measured seat occupancy`,
      rows: { [BASELINE]: ROWS[2025].length, [CURRENT]: ROWS[2026].length },
      like_for_like_window: LIKE_FOR_LIKE,
    },
    headline: {
      window: head.window.label,
      revenue_gbp: { [BASELINE]: t.y2025.revenue_gbp, [CURRENT]: t.y2026.revenue_gbp, observed_change_pct: t.delta.revenue_pct },
      tickets_sold: { [BASELINE]: t.y2025.tickets_sold, [CURRENT]: t.y2026.tickets_sold, observed_change_pct: t.delta.tickets_sold_pct },
      attributable_to_seatsense: {
        revenue_uplift_pct: eff.revenue_uplift_pct,
        revenue_uplift_gbp: eff.revenue_uplift_gbp,
        against_business_case_pct: BUSINESS_CASE.target_total_revenue_uplift_pct,
        method: "Observed revenue minus what the same days' booking requests would have produced under 2025's forecast quality - same demand, same fares, same EMSRb controls.",
      },
    },
    revenue_management: META.revenue_management,
    blind_spot_2025: {
      what_2025_measured: 'Tickets sold and unsold, exactly. Nothing that saw a seat.',
      so_the_2025_load_factor_is: DEFINITIONS.assumed_load_factor_pct,
      there_is_no_2025_cabin_factor:
        'Not in this dataset and not at the operator. Use ticket_data_blind_spot for what it most likely was, and fullness_ranking for what the gap does to a pricing decision.',
    },
    routes: META.routes,
    demand_classes: META.demand_classes,
    suggested_questions: [
      'What revenue-management model do you run, and what did SeatSense change in it?',
      'What did they think their load factor was in 2025, and what was it really?',
      'Show me the morning peak departures ranked by how full they actually are.',
      'How much revenue is attributable to SeatSense, and how do you know?',
      'How many paid seats travelled empty on the 07:41, and why can you not resell them?',
      'Which departures still need attention?',
    ],
    narrative: `${META.operator.name} (fictional) sells one seat per ticket and may not oversell. Seats are allocated to nested booking classes by an EMSRb revenue-management system (Weatherford & Belobaba, JORS 2002). ${BASELINE} has ticket sales only, so its demand forecasts were calibrated on ghosts; SeatSense measures actual seat occupancy from ${META.operator.seatsense.fleetGoLive} and roughly halves the forecast error - the fare ladder itself never changed. Over ${head.window.label} observed revenue moved ${pct(t.delta.revenue_pct)}, of which ${eff.revenue_uplift_pct}% (${gbp(eff.revenue_uplift_gbp)}) is attributable to the recalibrated forecasts - against a business case of ${BUSINESS_CASE.target_total_revenue_uplift_pct}%. The rest is market growth. No revenue comes from overselling or from reselling a no-show seat; neither is permitted.`,
  };
}

export function listServices({ route_id, demand_class, direction } = {}) {
  const rows = SERVICES.filter(
    (s) => (!route_id || s.route_id === route_id) &&
      (!demand_class || s.demand_class === demand_class) &&
      (!direction || s.direction === direction),
  );
  const formations = {};
  for (const s2 of rows) {
    (formations[s2.route_id] ??= {})[s2.demand_class] =
      `${s2.formation} = ${s2.coaches} coaches, ${s2.seats} seats (${s2.seats_standard} Standard + ${s2.seats_first} First)`;
  }
  return {
    count: rows.length,
    formations_by_route_and_demand_class: formations,
    services: rows,
    notes: [
      `no_show_rate_pct is a property of who buys that particular departure - but it was only observable from ${META.operator.seatsense.fleetGoLive}, and it is what skewed that departure's 2025 demand forecast (see forecast_error_2025_pct).`,
      'sales_cap_pct_of_seats is 100 for every departure: one ticket per seat, no overselling.',
      'Train length varies by route and by time of day: Azuma 9-car or two coupled 5-cars at the peak, a single 5-car off-peak. seats is what that departure actually offers.',
      'The booking-class fare ladder is identical in both years. What changed on 1 January 2026 is the accuracy of the demand forecasts behind the EMSRb booking limits.',
    ],
    narrative: `${rows.length} daily departures${route_id ? ` on ${route_id}` : ''}${demand_class ? ` in demand class ${demand_class}` : ''}. Formations vary by time of day - see formations_by_route_and_demand_class. Note forecast_error_2025_pct against no_show_rate_pct: the departures that no-show most are the ones ticket data over-forecast worst, and that error is what the EMSRb booking limits inherited.`,
  };
}

export function compareYears({ group_by = 'total', route_id, demand_class, service_id, day_type, from_month, to_month } = {}) {
  const fm = from_month ?? LIKE_FOR_LIKE.from_month;
  const tm = to_month ?? LIKE_FOR_LIKE.to_month;
  const filters = { route_id, demand_class, service_id, day_type, from_month: fm, to_month: tm };
  const a = groupAggregate(BASELINE, filters, group_by);
  const b = groupAggregate(CURRENT, filters, group_by);

  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows = keys.map((key) => {
    const x = a.get(key), y = b.get(key);
    const y2025 = x?.agg ?? null, y2026 = y?.agg ?? null;
    // Two Marches can hold a different number of weekdays. Rebuild 2026 on
    // 2025's calendar before comparing, and say which figure is which.
    const adjusted = y2025 && y2026 ? onCalendarOf(y.rows, x.rows) : null;
    const matched = y2025 && y2026 && sameMix(y2025.day_mix, y2026.day_mix);
    return {
      key,
      label: (y || x).label,
      calendar: y2025 && y2026 ? {
        day_mix_2025: y2025.day_mix,
        day_mix_2026: y2026.day_mix,
        identical: matched,
        note: matched
          ? 'Both periods hold the same number of weekdays, Saturdays and Sundays, so the observed change needs no adjustment.'
          : `The two periods do not hold the same working days (${y2025.day_mix.weekday ?? 0} weekdays in ${BASELINE} against ${y2026.day_mix.weekday ?? 0} in ${CURRENT}). One weekday is worth several percent of a month, so quote revenue_pct_calendar_adjusted, not revenue_pct.`,
      } : null,
      y2025,
      y2026,
      delta: y2025 && y2026 ? {
        tickets_sold_pct: growth(y2025.tickets_sold, y2026.tickets_sold),
        revenue_pct: growth(y2025.revenue_gbp, y2026.revenue_gbp),
        revenue_gbp_abs: r2(y2026.revenue_gbp - y2025.revenue_gbp),
        revenue_pct_calendar_adjusted: growth(y2025.revenue_gbp, adjusted.revenue_gbp),
        tickets_sold_pct_calendar_adjusted: growth(y2025.tickets_sold, adjusted.tickets_sold),
        calendar_adjustment_pp: r1((growth(y2025.revenue_gbp, adjusted.revenue_gbp) ?? 0) - (growth(y2025.revenue_gbp, y2026.revenue_gbp) ?? 0)),
        avg_fare_pct: growth(y2025.avg_fare_gbp, y2026.avg_fare_gbp),
        assumed_load_factor_pp: r1(y2026.assumed_load_factor_pct - y2025.assumed_load_factor_pct),
        sold_out_departures_pp: r1(y2026.sold_out_departures_pct - y2025.sold_out_departures_pct),
        attributable_revenue_pct: y2026.forecast_effect?.revenue_uplift_pct ?? null,
        attributable_revenue_gbp: y2026.forecast_effect?.revenue_uplift_gbp ?? null,
      } : null,
    };
  });
  if (group_by !== 'total') {
    rows.sort((p, q) => (q.delta?.attributable_revenue_gbp ?? -Infinity) - (p.delta?.attributable_revenue_gbp ?? -Infinity));
  }

  const out = {
    window: {
      months: `${MONTH_NAMES[fm - 1]} - ${MONTH_NAMES[tm - 1]}`,
      label: fm === LIKE_FOR_LIKE.from_month && tm === LIKE_FOR_LIKE.to_month ? LIKE_FOR_LIKE.label : `${MONTH_NAMES[fm - 1]} - ${MONTH_NAMES[tm - 1]}, both years`,
      like_for_like: true,
      note: fm === LIKE_FOR_LIKE.from_month && tm === LIKE_FOR_LIKE.to_month
        ? LIKE_FOR_LIKE.note
        : `${CURRENT} data ends ${COVERAGE_END}, so both years are read over the same calendar window. Individual months within it do not hold the same working days - see calendar on each row.`,
    },
    filters: { group_by, route_id: route_id ?? 'all', demand_class: demand_class ?? 'all', service_id: service_id ?? 'all', day_type: day_type ?? 'all' },
    rows,
    notes: [
      'revenue_pct is the observed year-on-year change and includes background market growth. attributable_revenue_pct is the part caused by the SeatSense-recalibrated demand forecasts, measured against each departure\'s counterfactual. Quote the second one for anything about SeatSense.',
      'revenue_pct compares raw totals. Where the two periods hold different working days - which happens in most individual months - use revenue_pct_calendar_adjusted, which rebuilds 2026 on 2025\'s calendar. attributable_revenue_pct is immune either way: it compares each 2026 departure with itself.',
      'Check calendar.identical on each row before quoting an observed change.',
      `Cabin factor and ghost seats exist for ${CURRENT} only. assumed_load_factor_pct exists for both years but is not an occupancy figure.`,
    ],
    definitions: DEFINITIONS,
  };

  if (group_by === 'total') {
    const t = rows[0];
    const eff = t.y2026?.forecast_effect;
    out.narrative = t?.delta
      ? `${out.window.label}: revenue ${gbp(t.y2025.revenue_gbp)} -> ${gbp(t.y2026.revenue_gbp)} (${pct(t.delta.revenue_pct)} observed), tickets ${t.y2025.tickets_sold.toLocaleString('en-GB')} -> ${t.y2026.tickets_sold.toLocaleString('en-GB')} (${pct(t.delta.tickets_sold_pct)}), average fare GBP ${t.y2025.avg_fare_gbp} -> GBP ${t.y2026.avg_fare_gbp} (mix, not tariff: the fare ladder is unchanged). Of that, ${eff.revenue_uplift_pct}% (${gbp(eff.revenue_uplift_gbp)}) is attributable to the SeatSense-recalibrated demand forecasts and the rest is market growth. Ticket-derived load factor ${t.y2025.assumed_load_factor_pct}% -> ${t.y2026.assumed_load_factor_pct}%; the real cabin factor in ${CURRENT} is ${t.y2026.cabin_factor_pct}%, ${t.y2026.seatsense.overstatement_pp} points below what ticket data alone reports, and ${BASELINE} has no cabin factor at all.`
      : 'No data for the requested filters.';
  } else {
    const best = rows[0], worst = rows[rows.length - 1];
    out.narrative = `Grouped by ${group_by}, sorted by revenue attributable to the forecast recalibration. Most: ${best?.label} (${gbp(best?.delta?.attributable_revenue_gbp ?? 0)}, ${best?.delta?.attributable_revenue_pct}%). Least: ${worst?.label} (${gbp(worst?.delta?.attributable_revenue_gbp ?? 0)}, ${worst?.delta?.attributable_revenue_pct}%).`;
  }
  return out;
}

export function serviceHistory({ service_id, from_date, to_date, limit = 60 } = {}) {
  const svc = SVC[service_id];
  if (!svc) return { error: `Unknown service_id "${service_id}". Use list_services to see the ${SERVICES.length} valid ids.` };
  const pick = (year) => select(year, { service_id, from_date, to_date }).slice(-limit);
  return {
    service: svc,
    window: { from_date: from_date ?? 'start of data', to_date: to_date ?? COVERAGE_END, rows_per_year: limit },
    [BASELINE]: { rows: pick(BASELINE), summary: aggregate(select(BASELINE, { service_id, from_date, to_date }), BASELINE) },
    [CURRENT]: { rows: pick(CURRENT), summary: aggregate(select(CURRENT, { service_id, from_date, to_date }), CURRENT) },
    definitions: DEFINITIONS,
    narrative: `${svc.departure_time} ${svc.origin} - ${svc.destination} (${svc.demand_class}, ${svc.seats} seats, measured no-show rate ${svc.no_show_rate_pct}%). Showing the last ${limit} days of each year in the window.`,
  };
}

/**
 * What SeatSense actually sees on one train on one day - the moment where
 * "sold out" and "full" turn out to be different things.
 */
export function seatsenseSnapshot({ service_id, date }) {
  const svc = SVC[service_id];
  if (!svc) return { error: `Unknown service_id "${service_id}".` };
  if (!date) return { error: 'A date is required, e.g. 2026-06-16.' };
  if (date < `${CURRENT}-01-01`) {
    return {
      error: `No seat-level data for ${date}. SeatSense went live ${META.operator.seatsense.fleetGoLive}; before that the operator had ticket sales only, which cannot distinguish a passenger from a no-show.`,
      available_from: META.operator.seatsense.fleetGoLive,
    };
  }
  const row = ROWS[CURRENT].find((r) => r.service_id === service_id && r.date === date);
  if (!row) return { error: `No data for ${service_id} on ${date}. Data runs ${CURRENT}-01-01 .. ${COVERAGE_END}.` };

  // Which units worked the diagram - deterministic from service + date, drawn
  // from the part of the route's fleet that matches this departure's unit type
  // (unit numbering runs through the fleet groups in order).
  const route = META.routes.find((r) => r.route_id === svc.route_id);
  let rangeStart = 1;
  let range = null;
  for (const g of route.fleet.unit_types) {
    if (g.type === svc.unit_type) { range = [rangeStart, rangeStart + g.units - 1]; break; }
    rangeStart += g.units;
  }
  const units = [];
  for (let k = 0; units.length < svc.formation_units && k < 200; k++) {
    const n = range[0] + (hash(`${service_id}${date}unit${k}`) % (range[1] - range[0] + 1));
    const id = `${svc.route_id}-U${String(n).padStart(3, '0')}`;
    if (!units.includes(id)) units.push(id);
  }

  // Reserved seats fill the whole train, but no-shows are not spread evenly:
  // the coaches sold latest carry more of them.
  const slots = svc.coach_seats.map((c) => ({
    unit: units[c.set - 1],
    coach: c.letter,
    seats: c.seats_standard + c.seats_first,
  }));
  const weights = slots.map((s2, i) => (1.1 - 0.03 * i + (hash(`${s2.unit}${s2.coach}${date}`) % 100) / 2500) * s2.seats);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const alloc = slots.map((s2, i) => Math.min(s2.seats, Math.round((row.seats_occupied * weights[i]) / wsum)));
  let remainder = row.seats_occupied - alloc.reduce((a, b) => a + b, 0);
  for (let guard = 0; remainder !== 0 && guard < svc.seats; guard++) {
    let moved = false;
    for (let i = 0; i < alloc.length && remainder !== 0; i++) {
      const step = Math.sign(remainder);
      const next = alloc[i] + step;
      if (next >= 0 && next <= slots[i].seats) { alloc[i] = next; remainder -= step; moved = true; }
    }
    if (!moved) break;
  }
  const coaches = slots.map((s2, i) => ({
    unit_id: s2.unit,
    coach: s2.coach,
    device_id: `iot-${s2.unit}-${s2.coach}`.toLowerCase(),
    seats: s2.seats,
    seats_occupied: alloc[i],
    seats_empty: s2.seats - alloc[i],
    occupancy_pct: r1((alloc[i] / s2.seats) * 100),
  }));

  const assumed = r1((row.tickets_sold / svc.seats) * 100);
  const cabin = r1((row.seats_occupied / svc.seats) * 100);
  const fare = row.revenue_gbp / row.tickets_sold;
  const worst = [...coaches].sort((a, b) => b.seats_empty - a.seats_empty)[0];
  return {
    service: { service_id, departure_time: svc.departure_time, origin: svc.origin, destination: svc.destination, demand_class: svc.demand_class, seats: svc.seats, coaches: svc.coaches, formation_units: svc.formation_units },
    date,
    day_type: row.day_type,
    formation: {
      units: units,
      unit_count: svc.formation_units,
      unit_type: svc.formation,
      coaches: svc.coaches,
      seats: svc.seats,
      seats_standard: svc.seats_standard,
      seats_first: svc.seats_first,
      note: `${svc.demand_class} departures on ${svc.route_id} run ${svc.formation}; the route's longest formation is ${route.longest_formation_seats} seats and its shortest ${route.shortest_formation_seats}.`,
    },
    train: {
      tickets_sold: row.tickets_sold,
      seats_unsold: svc.seats - row.tickets_sold,
      assumed_load_factor_pct: assumed,
      sales_closed: row.sales_closed,
      passengers_turned_away: row.demand_turned_away,
      boarded: row.boarded,
      seats_occupied: row.seats_occupied,
      cabin_factor_pct: cabin,
      overstatement_pp: r1(assumed - cabin),
      ghost_seats: row.ghost_seats,
      ghost_seat_pct: r1((row.ghost_seats / svc.seats) * 100),
      revenue_gbp: row.revenue_gbp,
      ghost_seat_value_gbp: r2(row.ghost_seats * fare),
    },
    coaches,
    why_the_ghost_seats_are_not_recoverable: SALES_POLICY.what_seatsense_does_not_do,
    definitions: DEFINITIONS,
    narrative: `${svc.departure_time} ${svc.origin} - ${svc.destination} on ${date}: ${row.tickets_sold} of ${svc.seats} seats sold (${assumed}%)${row.sales_closed ? `, sold out, ${row.demand_turned_away} walk-up passengers turned away` : ''}. SeatSense measured ${row.seats_occupied} seats occupied - a cabin factor of ${cabin}%, ${r1(assumed - cabin)} points below what the ticket system reported - so ${row.ghost_seats} paid-for seats worth ${gbp(row.ghost_seats * fare)} departed empty. Formation ${svc.formation}: ${units.join(' + ')} (${svc.coaches} coaches, ${svc.seats} seats). Emptiest coach: ${worst.unit_id} coach ${worst.coach}, ${worst.seats_empty} free seats of ${worst.seats}. Those seats could not be resold or covered by overselling; what they change is next season's demand forecast for this departure.`,
  };
}

/**
 * The proof that ticket data mis-ranks departures.
 *
 * Ranked by tickets sold, then by measured cabin factor. Where a departure
 * moves between the two lists, every pricing decision taken on the first
 * ranking was aimed at the wrong train.
 */
export function fullnessRanking({ month, demand_class = 'peak_core', route_id } = {}) {
  const m = month ?? LAST_MONTH;
  const win = { from_month: m, to_month: m, day_type: 'weekday', demand_class, route_id };
  const rows = SERVICES
    .filter((s) => s.demand_class === demand_class && (!route_id || s.route_id === route_id))
    .map((s) => {
      const agg = aggregate(select(CURRENT, { ...win, service_id: s.service_id }), CURRENT);
      if (!agg) return null;
      return {
        service_id: s.service_id,
        departure_time: s.departure_time,
        route_id: s.route_id,
        seats: s.seats,
        assumed_load_factor_pct: agg.assumed_load_factor_pct,
        cabin_factor_pct: agg.cabin_factor_pct,
        overstatement_pp: agg.seatsense.overstatement_pp,
        measured_no_show_rate_pct: s.no_show_rate_pct,
        ghost_seats_per_departure: r1(agg.seatsense.ghost_seats / agg.departures),
        sold_out_departures_pct: agg.sold_out_departures_pct,
        avg_fare_gbp: agg.avg_fare_gbp,
      };
    })
    .filter(Boolean);

  const bySold = [...rows].sort((a, b) => b.assumed_load_factor_pct - a.assumed_load_factor_pct);
  const byCabin = [...rows].sort((a, b) => b.cabin_factor_pct - a.cabin_factor_pct);
  const ranked = byCabin.map((r) => ({
    ...r,
    rank_by_tickets_sold: bySold.findIndex((x) => x.service_id === r.service_id) + 1,
    rank_by_cabin_factor: byCabin.findIndex((x) => x.service_id === r.service_id) + 1,
    rank_change: bySold.findIndex((x) => x.service_id === r.service_id) - byCabin.findIndex((x) => x.service_id === r.service_id),
  }));
  const moved = ranked.filter((r) => r.rank_change !== 0).length;
  const spread = r1(Math.max(...rows.map((r) => r.cabin_factor_pct)) - Math.min(...rows.map((r) => r.cabin_factor_pct)));
  const soldSpread = r1(Math.max(...rows.map((r) => r.assumed_load_factor_pct)) - Math.min(...rows.map((r) => r.assumed_load_factor_pct)));
  const tightest = [...ranked].sort((a, b) => Math.abs(b.overstatement_pp - a.overstatement_pp))[0];
  const pair = [...ranked].sort((a, b) => b.overstatement_pp - a.overstatement_pp);

  return {
    scope: `${demand_class}${route_id ? ` on ${route_id}` : ''}, ${MONTH_NAMES[m - 1]} ${CURRENT} weekdays`,
    ranked_by_cabin_factor: ranked,
    summary: {
      departures: rows.length,
      spread_in_tickets_sold_pp: soldSpread,
      spread_in_cabin_factor_pp: spread,
      departures_that_change_rank: moved,
      widest_overstatement: { service_id: pair[0]?.service_id, overstatement_pp: pair[0]?.overstatement_pp, no_show_rate_pct: pair[0]?.measured_no_show_rate_pct },
      narrowest_overstatement: { service_id: pair.at(-1)?.service_id, overstatement_pp: pair.at(-1)?.overstatement_pp, no_show_rate_pct: pair.at(-1)?.measured_no_show_rate_pct },
    },
    why_it_matters:
      'Fare and capacity decisions are made on the ranking. On tickets sold these departures look almost identical; on measured occupancy they are not, because their no-show rates differ. A fare increase only earns anything on a departure that is genuinely full - on one that merely sold out, it loses the volume it gains.',
    definitions: DEFINITIONS,
    narrative: `${MONTH_NAMES[m - 1]} ${CURRENT} weekdays, ${demand_class}: ${soldSpread === 0 ? `ticket sales cannot separate these ${rows.length} departures at all - every one of them sold every seat` : `ticket sales spread these ${rows.length} departures over just ${soldSpread} points, so the ticket system treats them as near-identical`}. Measured cabin factor spreads them over ${spread} points, and ${moved} of ${rows.length} change rank between the two lists. Worst overstated: ${pair[0]?.service_id} at ${pair[0]?.assumed_load_factor_pct}% sold but ${pair[0]?.cabin_factor_pct}% actually occupied (${pair[0]?.overstatement_pp} points, no-show rate ${pair[0]?.measured_no_show_rate_pct}%). Best: ${pair.at(-1)?.service_id}, ${pair.at(-1)?.overstatement_pp} points. Pricing off the first list aims the money at the wrong train.`,
  };
}

/**
 * The morning peak before and after, departure by departure.
 *
 * Note what does *not* move: the peak's sold load. It cannot - those
 * departures were already selling every seat, and the operator may not sell a
 * 481st. What moves is the fare, and what appears for the first time is the
 * cabin factor showing how far below the ticket figure the real occupancy sits.
 */
export function morningPeakReport({ route_id, month } = {}) {
  const m = month ?? LAST_MONTH;
  const window = { from_month: m, to_month: m, day_type: 'weekday' };
  const morning = SERVICES.filter(
    (s) => s.direction === 'up' && (!route_id || s.route_id === route_id) &&
      ['peak_core', 'peak_shoulder'].includes(s.demand_class) &&
      s.departure_time >= '05:30' && s.departure_time <= '09:30',
  ).sort((a, b) => (a.route_id + a.departure_time).localeCompare(b.route_id + b.departure_time));

  const perService = morning.map((s) => {
    const a = aggregate(select(BASELINE, { ...window, service_id: s.service_id }), BASELINE);
    const b = aggregate(select(CURRENT, { ...window, service_id: s.service_id }), CURRENT);
    const days = b?.departures ?? 0;
    return {
      service_id: s.service_id,
      departure_time: s.departure_time,
      route_id: s.route_id,
      demand_class: s.demand_class,
      seats: s.seats,
      fare_2025_gbp: a?.avg_fare_gbp ?? null,
      fare_2026_gbp: b?.avg_fare_gbp ?? null,
      fare_change_pct: a && b ? growth(a.avg_fare_gbp, b.avg_fare_gbp) : null,
      assumed_load_factor_2025_pct: a?.assumed_load_factor_pct ?? null,
      assumed_load_factor_2026_pct: b?.assumed_load_factor_pct ?? null,
      cabin_factor_2025_pct: null,
      cabin_factor_2026_pct: b?.cabin_factor_pct ?? null,
      ghost_seats_per_departure_2026: b && days ? r1(b.seatsense.ghost_seats / days) : null,
      passengers_per_weekday: { [BASELINE]: a ? Math.round(a.tickets_sold / a.departures) : null, [CURRENT]: b ? Math.round(b.tickets_sold / days) : null },
      turned_away_per_weekday: { [BASELINE]: a ? r1(a.passengers_turned_away / a.departures) : null, [CURRENT]: b ? r1(b.passengers_turned_away / days) : null },
    };
  });

  const cls = (year, demand_class) => aggregate(select(year, { ...window, route_id, demand_class }), year);
  const a25 = cls(BASELINE, 'peak_core'), a26 = cls(CURRENT, 'peak_core');
  const s25 = cls(BASELINE, 'peak_shoulder'), s26 = cls(CURRENT, 'peak_shoulder');
  const share = (c, sh) => (c && sh ? r1((c.tickets_sold / (c.tickets_sold + sh.tickets_sold)) * 100) : null);

  return {
    scope: { route_id: route_id ?? 'all routes', month: `${MONTH_NAMES[m - 1]}, weekdays only, ${BASELINE} vs ${CURRENT}`, services: morning.length },
    summary: {
      peak_core: {
        assumed_load_factor_pct: { [BASELINE]: a25?.assumed_load_factor_pct, [CURRENT]: a26?.assumed_load_factor_pct },
        cabin_factor_pct: { [BASELINE]: null, [CURRENT]: a26?.cabin_factor_pct ?? null },
        ticket_data_overstatement_2026_pp: a26?.seatsense?.overstatement_pp ?? null,
        sold_out_departures_pct: { [BASELINE]: a25?.sold_out_departures_pct, [CURRENT]: a26?.sold_out_departures_pct },
        turned_away_per_weekday: { [BASELINE]: r1((a25?.passengers_turned_away ?? 0) / (a25?.departures ?? 1)), [CURRENT]: r1((a26?.passengers_turned_away ?? 0) / (a26?.departures ?? 1)) },
        avg_fare_gbp: { [BASELINE]: a25?.avg_fare_gbp, [CURRENT]: a26?.avg_fare_gbp, change_pct: growth(a25?.avg_fare_gbp, a26?.avg_fare_gbp) },
        revenue_gbp: { [BASELINE]: a25?.revenue_gbp, [CURRENT]: a26?.revenue_gbp, attributable_pct: a26?.forecast_effect?.revenue_uplift_pct },
      },
      peak_shoulder: {
        assumed_load_factor_pct: { [BASELINE]: s25?.assumed_load_factor_pct, [CURRENT]: s26?.assumed_load_factor_pct },
        cabin_factor_pct: { [BASELINE]: null, [CURRENT]: s26?.cabin_factor_pct ?? null },
        passengers: { [BASELINE]: s25?.tickets_sold, [CURRENT]: s26?.tickets_sold, change_pct: growth(s25?.tickets_sold, s26?.tickets_sold) },
        avg_fare_gbp: { [BASELINE]: s25?.avg_fare_gbp, [CURRENT]: s26?.avg_fare_gbp, change_pct: growth(s25?.avg_fare_gbp, s26?.avg_fare_gbp) },
        revenue_gbp: { [BASELINE]: s25?.revenue_gbp, [CURRENT]: s26?.revenue_gbp, attributable_pct: s26?.forecast_effect?.revenue_uplift_pct },
      },
      share_of_morning_peak_passengers_on_peak_core_pct: {
        [BASELINE]: share(a25, s25),
        [CURRENT]: share(a26, s26),
        means: 'Peak-core share of all passengers travelling in the morning peak window. Falling means demand has spread into the shoulder departures.',
      },
    },
    services: perService,
    definitions: DEFINITIONS,
    what_the_policy_is:
      'EMSRb protection levels keep seats back for the full-fare classes on the crush departures, computed from demand forecasts that measured occupancy has made roughly twice as accurate. The fare ladder is unchanged - what moved is who gets which seat. Travelling on the train you want stays possible at the top of the ladder.',
    narrative: `Morning peak, ${MONTH_NAMES[m - 1]} weekdays. The crush departures sold ${a25?.assumed_load_factor_pct}% of seats in ${BASELINE} on ticket-data forecasts, selling out on ${a25?.sold_out_departures_pct}% of days and refusing ${r1((a25?.passengers_turned_away ?? 0) / (a25?.departures ?? 1))} walk-up passengers a departure. In ${CURRENT}, on forecasts recalibrated by SeatSense, they sell ${a26?.assumed_load_factor_pct}% with a better class mix (average fare ${pct(growth(a25?.avg_fare_gbp, a26?.avg_fare_gbp))} on an unchanged ladder), sell out on ${a26?.sold_out_departures_pct}% of days and refuse ${r1((a26?.passengers_turned_away ?? 0) / (a26?.departures ?? 1))} - and SeatSense measures the cabin factor behind it at ${a26?.cabin_factor_pct}%, ${a26?.seatsense?.overstatement_pp} points below the ticket figure. The shoulder departures carried ${pct(growth(s25?.tickets_sold, s26?.tickets_sold))} passengers year on year, and peak core's share of morning passengers moved from ${share(a25, s25)}% to ${share(a26, s26)}%.`
  };
}

export function pricingActions({ route_id, demand_class } = {}) {
  const win = { from_month: LIKE_FOR_LIKE.from_month, to_month: LIKE_FOR_LIKE.to_month };
  const classRows = PRICING.class_actions
    .filter((c) => !demand_class || c.demand_class === demand_class)
    .map((c) => {
      const f = { ...win, route_id, demand_class: c.demand_class };
      const a = aggregate(select(BASELINE, f), BASELINE);
      const b = aggregate(select(CURRENT, f), CURRENT);
      return {
        ...c,
        realised_avg_fare_gbp: { [BASELINE]: a?.avg_fare_gbp, [CURRENT]: b?.avg_fare_gbp, change_pct: growth(a?.avg_fare_gbp, b?.avg_fare_gbp) },
        cabin_factor_2026_pct: b?.cabin_factor_pct,
        sold_out_departures_pct: { [BASELINE]: a?.sold_out_departures_pct, [CURRENT]: b?.sold_out_departures_pct },
        attributable_revenue_pct: b?.forecast_effect?.revenue_uplift_pct,
        attributable_revenue_gbp: b?.forecast_effect?.revenue_uplift_gbp,
      };
    });
  const total = classRows.reduce((s, c) => s + (c.attributable_revenue_gbp ?? 0), 0);
  return {
    effective_from: PRICING.effective_from,
    mechanism: PRICING.mechanism,
    model_reference: PRICING.model_reference,
    principle: PRICING.principle,
    how_the_principle_is_kept: PRICING.how_the_principle_is_kept,
    method: PRICING.method,
    what_changed_on_go_live: PRICING.what_changed_on_go_live,
    booking_classes_by_route: PRICING.booking_classes_by_route,
    demand_profiles: PRICING.demand_profiles,
    not_available: PRICING.not_available,
    why_the_effect_varies_by_month: PRICING.why_the_effect_varies_by_month,
    measured_over: LIKE_FOR_LIKE.label,
    class_actions: classRows,
    service_actions: PRICING.service_actions.filter((s) => !route_id || s.service_id.startsWith(route_id)),
    total_attributable_revenue_gbp: r2(total),
    notes: [
      'realised_avg_fare_gbp moves without any tariff change: it is the class mix. More Anytime passengers on a train the forecasts now size correctly, more Advance sold on seats that used to be wrongly protected.',
      'A better forecast on a departure with spare seats earns nothing here: every class stays open regardless. Only where the booking limits bind does forecast accuracy reach revenue - the paper found exactly this, with impacts concentrated at demand factors of 1.0 and above.',
    ],
    definitions: DEFINITIONS,
    narrative: `${PRICING.principle} From ${PRICING.effective_from} the EMSRb booking limits (Weatherford & Belobaba, JORS 2002) are computed from demand forecasts recalibrated on measured occupancy: roughly 25% mean error down to roughly 12.5%, per departure. The fare ladder did not move. Over ${LIKE_FOR_LIKE.label} that is worth ${gbp(total)} attributable${classRows.length ? `, led by ${classRows[0].demand_class} at ${pct(classRows[0].attributable_revenue_pct ?? 0)}` : ''}. ${PRICING.why_the_effect_varies_by_month}`,
  };
}

/**
 * Where the money comes from, and - just as important for this audience -
 * where it does not.
 */
export function seatsenseAttribution({ assumed_market_growth_pct, cost_per_coach_gbp } = {}) {
  const win = { from_month: LIKE_FOR_LIKE.from_month, to_month: LIKE_FOR_LIKE.to_month };
  const a = aggregate(select(BASELINE, win), BASELINE);
  const b = aggregate(select(CURRENT, win), CURRENT);
  const eff = b.forecast_effect;
  const observed = b.revenue_gbp - a.revenue_gbp;
  const marketPart = observed - eff.revenue_uplift_gbp;

  // The 2025 forecast error had two directions, and fixing each earns money
  // through a different mechanism. Split the gain by which error each
  // departure carried.
  const sideOf = (predicate) => {
    const ids = new Set(SERVICES.filter(predicate).map((s) => s.service_id));
    const rows = select(CURRENT, win).filter((r) => ids.has(r.service_id));
    const obs = sum(rows, 'revenue_gbp'), cf = sum(rows, 'cf_revenue_gbp');
    return { departures: ids.size, revenue_gbp: r2(obs), counterfactual_gbp: r2(cf), effect_gbp: r2(obs - cf), effect_pct: growth3(cf, obs) };
  };
  const overSide = sideOf((s) => s.forecast_error_2025_pct > 0);
  const underSide = sideOf((s) => s.forecast_error_2025_pct <= 0);

  // Optional sensitivity: what a flat market-growth assumption would have said.
  const flat = assumed_market_growth_pct != null
    ? {
        assumed_market_growth_pct,
        revenue_without_seatsense_gbp: r2(a.revenue_gbp * (1 + assumed_market_growth_pct / 100)),
        attributable_gbp: r2(b.revenue_gbp - a.revenue_gbp * (1 + assumed_market_growth_pct / 100)),
        why_this_is_the_weaker_method:
          'A flat growth rate assumes every departure could have grown. Here the morning peak was already selling out, so it could not absorb any growth at all - which is why the counterfactual is modelled per departure instead.',
      }
    : null;

  // Price / volume decomposition against the counterfactual, not against 2025.
  const cfFare = eff.counterfactual_revenue_gbp / eff.counterfactual_tickets_sold;
  const priceEffect = (b.avg_fare_gbp - cfFare) * b.tickets_sold;
  const volumeEffect = (b.tickets_sold - eff.counterfactual_tickets_sold) * cfFare;

  return {
    window: LIKE_FOR_LIKE.label,
    observed: {
      revenue_gbp: { [BASELINE]: a.revenue_gbp, [CURRENT]: b.revenue_gbp, change_gbp: r2(observed), change_pct: growth(a.revenue_gbp, b.revenue_gbp) },
      tickets_sold: { [BASELINE]: a.tickets_sold, [CURRENT]: b.tickets_sold, change_pct: growth(a.tickets_sold, b.tickets_sold) },
    },
    split_of_the_observed_change: {
      market_growth_gbp: r2(marketPart),
      seatsense_pricing_gbp: eff.revenue_uplift_gbp,
      seatsense_pricing_pct_of_total_revenue: eff.revenue_uplift_pct,
      business_case_pct: BUSINESS_CASE.target_total_revenue_uplift_pct,
      verdict: `Measured ${eff.revenue_uplift_pct}% against a business case of ${BUSINESS_CASE.target_total_revenue_uplift_pct}%.`,
    },
    where_the_gain_lands: {
      departures_over_forecast_in_2025: {
        what_2025_did_wrong: 'Ticket data made these departures look stronger than they were (their no-shows counted as demand), so EMSRb protected too many seats for the top classes. Advance requests were refused while protected seats departed empty and unsold.',
        what_2026_does_instead: 'The recalibrated forecast frees the over-protection: the same seats now get sold down the ladder instead of travelling empty.',
        ...overSide,
      },
      departures_under_forecast_in_2025: {
        what_2025_did_wrong: 'These departures were forecast weaker than they were, so too few seats were protected. The cheap classes filled the train weeks out, and walk-up Anytime passengers found it sold out.',
        what_2026_does_instead: 'The recalibrated forecast raises the protection levels: full-fare demand that used to be refused now finds a seat, which is where the principle - always possible to travel, at a price - is actually kept.',
        ...underSide,
      },
      how_to_read:
        'Both mechanisms are the same paper result: EMSRb allocates exactly as well as its demand forecast allows. Over-forecasting wastes seats, under-forecasting wastes fares; halving the error attacks both at once.',
      so_it_is_not_a_fare_rise:
        'The fare ladder is byte-identical in both years - every class, every route. The average fare moves because the class mix moves: more full-fare passengers accommodated on the trains that used to shut them out, more Advance sold on seats that used to be wrongly reserved.',
      net_gbp: r2(overSide.effect_gbp + underSide.effect_gbp),
    },
    counterfactual_method: {
      what: "Every 2026 departure carries what the same day's booking requests would have produced under 2025's forecast quality - identical demand, identical fares, identical EMSRb mechanics, only the forecast error restored. The attributable figure is the difference, summed per departure. This is the paper's own paired-simulation design.",
      why_not_a_flat_growth_rate:
        'Because the departures that matter were already at capacity. A flat rate credits them with growth they could not physically take, and no-oversell means they cannot take it.',
      fields: 'cf_tickets_sold and cf_revenue_gbp on every 2026 row.',
    },
    decomposition: {
      mix_effect_gbp: r2(priceEffect),
      volume_effect_gbp: r2(volumeEffect),
      method: 'Against the counterfactual: mix_effect = (observed average fare - counterfactual average fare) x observed tickets; volume_effect = (observed tickets - counterfactual tickets) x counterfactual average fare. The fare ladder is unchanged, so the fare component is class mix, not tariff.',
      reading: 'Nearly all of it is volume at an almost unchanged average fare: seats the old forecasts wrongly protected used to depart empty AND unsold, and now carry paying passengers. The class-mix term nets out close to zero, because the freed seats sell down the ladder while the under-forecast trains shift seats up it.',
    },
    ghost_seats: {
      ghost_seat_pct_of_capacity: b.seatsense.ghost_seat_pct,
      ghost_seats_total: b.seatsense.ghost_seats,
      value_if_they_could_be_resold_gbp: r2(b.seatsense.ghost_seats * b.avg_fare_gbp),
      but: 'None of that is claimed, and none of it is in the figures above. A sold seat belongs to its buyer for the whole journey and overselling is not permitted, so a no-show seat is not recoverable. Its value to the operator is as a measurement, not as inventory.',
      what_it_is_worth_instead:
        'Knowing the no-show rate per departure is what makes the cabin factor knowable, and the cabin factor is what the repricing is aimed with.',
    },
    what_this_does_not_claim: [
      'No revenue from overselling. It is not permitted and the dataset never sells more tickets than there are seats.',
      'No revenue from reselling no-show seats. The seat is still the buyer\'s.',
      'No claim that ticket data misses unsold seats - it knows those exactly. What it misses is how many sold seats are actually used, which is what ranks departures by real fullness.',
      'No reduction in the no-show rate: it is the same in both years by construction.',
    ],
    flat_rate_sensitivity: flat,
    payback: cost_per_coach_gbp != null ? (() => {
      const coaches = META.routes.reduce((t, r) => t + r.fleet.coaches, 0);
      const capex = coaches * cost_per_coach_gbp;
      const annual = (eff.revenue_uplift_gbp / weekdaysIn(CURRENT, win)) * 253;
      return {
        cost_per_coach_gbp,
        coaches_instrumented: coaches,
        capex_gbp: r2(capex),
        annualised_uplift_gbp: r2(annual),
        payback_months: annual > 0 ? r1((capex / annual) * 12) : null,
        five_year_net_gbp: r2(annual * 5 - capex),
        assumption: 'Capex only - the figure you supply times the instrumented coaches. It carries no installation, connectivity, platform or integration cost, and no fleet growth. Annualised from the measured window at 253 weekday-equivalents.',
      };
    })() : {
      not_calculated: 'Pass cost_per_coach_gbp to get capex, payback in months and a five-year net against the measured uplift. No sensor price is stored in this dataset.',
      coaches_instrumented: META.routes.reduce((t, r) => t + r.fleet.coaches, 0),
    },
    definitions: DEFINITIONS,
    narrative: `Observed revenue over ${LIKE_FOR_LIKE.label} is up ${gbp(observed)} (${pct(growth(a.revenue_gbp, b.revenue_gbp))}). Splitting that against each departure's counterfactual: ${gbp(marketPart)} is market growth and ${gbp(eff.revenue_uplift_gbp)} is the forecast recalibration - ${eff.revenue_uplift_pct}% of total revenue, against a business case of ${BUSINESS_CASE.target_total_revenue_uplift_pct}%. This is not a fare rise: the fare ladder is identical in both years, and the gain splits by which forecast error each departure carried in 2025 - ${gbp(overSide.effect_gbp)} from the ${overSide.departures} departures ticket data over-forecast (their wrongly protected seats now get sold instead of travelling empty) and ${gbp(underSide.effect_gbp)} from the ${underSide.departures} it under-forecast (full-fare passengers who used to be shut out now find a protected seat). Decomposed, the gain is volume, not price: ${gbp(volumeEffect)} from tickets that could not be sold before against ${gbp(priceEffect)} of class-mix - the average fare barely moves. The ${b.seatsense.ghost_seats.toLocaleString('en-GB')} ghost seats measured in the window are worth ${gbp(b.seatsense.ghost_seats * b.avg_fare_gbp)} on paper and nothing in practice - they cannot be resold and cannot be covered by overselling. Their value is that they made the demand forecasts honest.`,
  };
}

/**
 * Capacity pressure, counted from the data rather than modelled.
 *
 * This is where the forecast recalibration shows up operationally: fewer
 * walk-ups refused where 2025 under-protected, fewer seats travelling empty
 * and unsold where it over-protected. It also names the residual honestly -
 * the departures that sell out even on honest forecasts, which is where
 * revenue management stops being the answer and more seats start being it.
 */
export function capacityPressure({ month } = {}) {
  const lfl = { day_type: 'weekday', from_month: LIKE_FOR_LIKE.from_month, to_month: LIKE_FOR_LIKE.to_month };
  const yA = aggregate(select(BASELINE, lfl), BASELINE);
  const yB = aggregate(select(CURRENT, lfl), CURRENT);
  const cl = (year, demand_class) => aggregate(select(year, { ...lfl, demand_class }), year);
  const pkA = cl(BASELINE, 'peak_core'), pkB = cl(CURRENT, 'peak_core');
  const evA = cl(BASELINE, 'evening_peak'), evB = cl(CURRENT, 'evening_peak');
  const shA = cl(BASELINE, 'peak_shoulder'), shB = cl(CURRENT, 'peak_shoulder');
  const wdA = weekdaysIn(BASELINE, lfl), wdB = weekdaysIn(CURRENT, lfl);
  const seatsPerPeakTrain = Math.round(pkB.seats_offered / pkB.departures);
  const headroom = Math.round((seatsPerPeakTrain * (100 - pkB.cabin_factor_pct)) / 100);

  const monthly = [];
  for (let i = 1; i <= LAST_MONTH; i++) {
    const win = { from_month: i, to_month: i, day_type: 'weekday' };
    const agg = aggregate(select(CURRENT, win), CURRENT);
    const peak = aggregate(select(CURRENT, { ...win, demand_class: 'peak_core' }), CURRENT);
    const peak25 = aggregate(select(BASELINE, { ...win, demand_class: 'peak_core' }), BASELINE);
    monthly.push({
      month: MONTH_NAMES[i - 1],
      peak_core_sold_out_departures_pct: { [BASELINE]: peak25.sold_out_departures_pct, [CURRENT]: peak.sold_out_departures_pct },
      peak_core_assumed_load_factor_pct: peak.assumed_load_factor_pct,
      peak_core_cabin_factor_pct: peak.cabin_factor_pct,
      passengers_turned_away: { [BASELINE]: peak25.passengers_turned_away, [CURRENT]: peak.passengers_turned_away },
      attributable_revenue_pct: agg.forecast_effect.revenue_uplift_pct,
    });
  }

  return {
    scope: `${LIKE_FOR_LIKE.label}, weekdays, counted from the departure data`,
    the_policy: {
      principle: PRICING.principle,
      how_it_is_kept: PRICING.how_the_principle_is_kept,
      what_seatsense_changed: 'The demand forecasts behind the EMSRb protection levels: roughly 25% mean error on ticket data, roughly 12.5% on measured occupancy. The fare ladder is unchanged.',
    },
    network: {
      sold_out_departures_pct: { [BASELINE]: yA.sold_out_departures_pct, [CURRENT]: yB.sold_out_departures_pct },
      passengers_turned_away_per_weekday: { [BASELINE]: r1(yA.passengers_turned_away / wdA), [CURRENT]: r1(yB.passengers_turned_away / wdB) },
      cabin_factor_pct: { [BASELINE]: null, [CURRENT]: yB.cabin_factor_pct, note: 'Averaged over every departure of the day including the quiet ones - not a peak figure.' },
      ghost_seat_pct: { [BASELINE]: null, [CURRENT]: yB.seatsense.ghost_seat_pct },
    },
    by_class: {
      peak_core: {
        assumed_load_factor_pct: { [BASELINE]: pkA.assumed_load_factor_pct, [CURRENT]: pkB.assumed_load_factor_pct },
        cabin_factor_pct: { [BASELINE]: null, [CURRENT]: pkB.cabin_factor_pct },
        sold_out_departures_pct: { [BASELINE]: pkA.sold_out_departures_pct, [CURRENT]: pkB.sold_out_departures_pct },
        turned_away_per_weekday: { [BASELINE]: r1(pkA.passengers_turned_away / wdA), [CURRENT]: r1(pkB.passengers_turned_away / wdB) },
        avg_fare_gbp: { [BASELINE]: pkA.avg_fare_gbp, [CURRENT]: pkB.avg_fare_gbp },
      },
      evening_peak: {
        assumed_load_factor_pct: { [BASELINE]: evA.assumed_load_factor_pct, [CURRENT]: evB.assumed_load_factor_pct },
        cabin_factor_pct: { [BASELINE]: null, [CURRENT]: evB.cabin_factor_pct },
        sold_out_departures_pct: { [BASELINE]: evA.sold_out_departures_pct, [CURRENT]: evB.sold_out_departures_pct },
        turned_away_per_weekday: { [BASELINE]: r1(evA.passengers_turned_away / wdA), [CURRENT]: r1(evB.passengers_turned_away / wdB) },
      },
      peak_shoulder: {
        assumed_load_factor_pct: { [BASELINE]: shA.assumed_load_factor_pct, [CURRENT]: shB.assumed_load_factor_pct },
        cabin_factor_pct: { [BASELINE]: null, [CURRENT]: shB.cabin_factor_pct },
        avg_fare_gbp: { [BASELINE]: shA.avg_fare_gbp, [CURRENT]: shB.avg_fare_gbp },
        note: 'Where the demand priced off the peak goes, and where the passengers who used to be refused now travel.',
      },
    },
    where_rm_stops_being_the_answer: {
      peak_core_departures_still_selling_out_pct: pkB.sold_out_departures_pct,
      why: 'Revenue management allocates seats; it cannot create them. On a departure whose demand factor sits above 1.0, somebody is refused whatever the forecast quality - accurate forecasts only decide who: the cheap classes close early and the walk-up passenger keeps a protected seat. Where a departure sells out on most weekdays even with honest forecasts, the answer is rolling stock.',
      measured_headroom_per_peak_train: headroom,
      headroom_note: `Peak departures are sold to ${pkB.assumed_load_factor_pct}% and measurably travel at ${pkB.cabin_factor_pct}% - about ${headroom} of ${seatsPerPeakTrain} seats a train. That is the gap the no-show rate opens, it is not sellable under one-ticket-per-seat, and it is the number to have in hand before signing for more rolling stock.`,
    },
    monthly_2026: monthly,
    no_service_quality_claim:
      'This dataset does not claim SeatSense improved punctuality, dwell time or complaints, and carries no modelled figures for them.',
    notes: [
      'Every figure here is counted from the departure data, not modelled.',
      'attributable_revenue_pct in the monthly series tracks how far demand met the seats that month. Forecast quality only earns where the booking limits bind, so a quiet month earns almost nothing - the paper found the same.',
      'A sell-out is not by itself a failure under EMSRb, and 2026 has more of them on some classes: seats that 2025 wrongly protected (and flew empty) are now sold. The failure metric is passengers_turned_away - walk-ups refused at a full train - and where it concentrates.',
    ],
    definitions: DEFINITIONS,
    narrative: `The policy is that it must always be possible to travel on the departure you want, even if it costs more - kept by protecting seats for the top of the fare ladder. Over ${LIKE_FOR_LIKE.label}, peak-core departures sold out on ${pkA.sold_out_departures_pct}% of weekdays in ${BASELINE} and ${pkB.sold_out_departures_pct}% in ${CURRENT}, and walk-ups refused on them fell from ${r1(pkA.passengers_turned_away / wdA)} to ${r1(pkB.passengers_turned_away / wdB)} a weekday as the under-forecast trains got their protection back; the evening peak sells out more often now (${evA.sold_out_departures_pct}% to ${evB.sold_out_departures_pct}%) because seats 2025 wrongly protected no longer travel empty. Network-wide, walk-up refusals moved from ${r1(yA.passengers_turned_away / wdA)} to ${r1(yB.passengers_turned_away / wdB)} a weekday. The peak's average fare is GBP ${pkB.avg_fare_gbp} against GBP ${pkA.avg_fare_gbp} on an unchanged ladder - that is mix, not tariff. What forecasts cannot fix: ${pkB.sold_out_departures_pct}% of peak departures fill even with honest numbers, demand simply exceeds the train - and measured occupancy shows ${headroom} of ${seatsPerPeakTrain} seats a train travelling empty regardless, which is the no-show gap and is not sellable. Both are capacity questions now, and for the first time the operator can size them.`,
  };
}

/** Forward-looking: what should the revenue team do next week? */
export function repricingCandidates({ limit = 8, days, month } = {}) {
  const RULES = {
    lengthen_the_train: 'Selling out on 25% or more of weekdays with a measured cabin factor of 80%+ - the forecasts are honest now and the train is genuinely full. Revenue management allocates seats, it cannot create them: the answer is more seats, and for the first time the occupancy record can size the case.',
    recalibrate_the_forecast: "A residual demand-forecast error of 8% or more on a constrained departure, visible as the gap between what the RM system expected and what SeatSense measured boarding. The paper prices errors like this at 1-2% of the departure's revenue; the fix is the same recalibration that produced the 2026 gain, one more turn of the crank.",
    open_more_advance: 'Assumed load factor at or below 50%: the booking limits are rationing nothing, seats travel empty and unsold. Opening the bottom of the ladder wider costs no protected seat here - measured occupancy is what proves the room is really there.',
  };
  const window = month
    ? { from_month: month, to_month: month }
    : days
      ? { from_date: new Date(new Date(COVERAGE_END + 'T00:00:00Z').getTime() - days * 86400000).toISOString().slice(0, 10) }
      : { from_month: LIKE_FOR_LIKE.from_month, to_month: LIKE_FOR_LIKE.to_month };

  const out = [];
  for (const svc of SERVICES) {
    const rows = select(CURRENT, { ...window, service_id: svc.service_id, day_type: 'weekday' });
    if (!rows.length) continue;
    const agg = aggregate(rows, CURRENT);
    const sold = agg.assumed_load_factor_pct;
    const cabin = agg.cabin_factor_pct;
    const closed = agg.sold_out_departures_pct;
    const residualErr = Math.abs(svc.forecast_error_2026_pct);

    let action = null;
    if (closed >= 25 && cabin >= 80) action = 'lengthen_the_train';
    else if (residualErr >= 8 && ['peak_core', 'evening_peak'].includes(svc.demand_class)) action = 'recalibrate_the_forecast';
    else if (sold <= 50) action = 'open_more_advance';
    if (!action) continue;

    const revenuePerWeekdayYear = (agg.revenue_gbp / agg.departures) * 253;
    const indicative = action === 'recalibrate_the_forecast'
      ? r2(revenuePerWeekdayYear * 0.01 * (residualErr / 25))
      : 0;
    out.push({
      service_id: svc.service_id,
      departure_time: svc.departure_time,
      route_id: svc.route_id,
      demand_class: svc.demand_class,
      measured: {
        assumed_load_factor_pct: sold,
        cabin_factor_pct: cabin,
        overstatement_pp: agg.seatsense.overstatement_pp,
        no_show_rate_pct: svc.no_show_rate_pct,
        forecast_error_2026_pct: svc.forecast_error_2026_pct,
        ghost_seats_per_departure: r1(agg.seatsense.ghost_seats / agg.departures),
        sold_out_departures_pct: closed,
        turned_away_per_departure: r1(agg.passengers_turned_away / agg.departures),
        avg_fare_gbp: agg.avg_fare_gbp,
      },
      recommended_action: action,
      reason: RULES[action],
      indicative_annual_revenue_effect_gbp: indicative,
      effect_assumption: action === 'recalibrate_the_forecast'
        ? "Scaled from the paper's finding that a 25% forecast error costs 1-2% of revenue on a constrained departure; a conservative 1% is used pro rata. Indicative only."
        : 'No money attached: this one is a capacity or quota question and the honest number is the occupancy record itself.',
    });
  }

  const priority = ['lengthen_the_train', 'recalibrate_the_forecast', 'open_more_advance'];
  out.sort((a, b) =>
    priority.indexOf(a.recommended_action) - priority.indexOf(b.recommended_action) ||
    Math.abs(b.indicative_annual_revenue_effect_gbp) - Math.abs(a.indicative_annual_revenue_effect_gbp));
  const top = out.slice(0, limit);
  const counts = {};
  for (const c of out) counts[c.recommended_action] = (counts[c.recommended_action] || 0) + 1;

  return {
    window: month ? `${MONTH_NAMES[month - 1]} ${CURRENT} weekdays`
      : days ? `Weekdays ${window.from_date} .. ${COVERAGE_END}`
      : `${LIKE_FOR_LIKE.label} ${CURRENT}, weekdays`,
    rules_applied: RULES,
    not_available: SALES_POLICY.what_seatsense_does_not_do,
    sort_order: 'Action priority (capacity first, then forecast residuals, then quota openings), then largest indicative money first.',
    candidates: top,
    total_candidates: out.length,
    by_action: counts,
    indicative_total_annual_effect_gbp: r2(top.reduce((a, c) => a + c.indicative_annual_revenue_effect_gbp, 0)),
    definitions: DEFINITIONS,
    narrative: `${out.length} departures have a clear next move (${Object.entries(counts).map(([k, v]) => `${v} x ${k}`).join(', ')}); showing the ${top.length} largest. ${top[0] ? `Top: ${top[0].service_id} at ${top[0].departure_time} - ${top[0].recommended_action}. ${top[0].reason}` : ''} Note what is not on the list: releasing or reselling no-show seats, and overselling. Neither is available to an operator selling reserved seats, which is why the levers here are forecast quality, booking limits and rolling stock.`,
  };
}

/**
 * The 2025 blind spot, quantified.
 *
 * This is the tool for "but operators already have ticket data". It shows what
 * the operator reported in 2025 and decided on that basis, why the number
 * could not be an occupancy figure, what the four manual load surveys hinted
 * at, what SeatSense measures the same gap to be in 2026, and - clearly
 * flagged as an inference - what 2025 most likely actually looked like.
 */
export function ticketDataBlindSpot({ demand_class = 'peak_core', month } = {}) {
  const m = month ?? LAST_MONTH;
  // 'all' answers the network-level question: how many people actually
  // travelled in 2025, across every departure of the day.
  const wholeNetwork = demand_class === 'all' || demand_class === 'network';
  const cls = wholeNetwork ? undefined : demand_class;
  const yearWin = { demand_class: cls, day_type: 'weekday' };
  const a = aggregate(select(BASELINE, yearWin), BASELINE);
  const monthWin = { demand_class: cls, day_type: 'weekday', from_month: m, to_month: m };
  const aM = aggregate(select(BASELINE, monthWin), BASELINE);
  const bM = aggregate(select(CURRENT, monthWin), CURRENT);
  const weekdays2025 = weekdaysIn(BASELINE, yearWin);
  const perWeekday = (n) => r1(n / weekdays2025);

  const surveyRows = ROWS[BASELINE].filter((r) => r.manual_load_survey !== undefined);
  const surveys = TICKET_DATA.loadSurveyDates2025.map((date) => {
    const rows = surveyRows.filter((r) => r.date === date);
    const tickets = sum(rows, 'tickets_sold');
    const counted = sum(rows, 'manual_load_survey');
    return { date, services_counted: rows.length, tickets_sold: tickets, passengers_counted_by_hand: counted, tickets_overstated_by_pct: r1((tickets / counted - 1) * 100) };
  });
  const surveyGapPct = r1((sum(surveyRows, 'tickets_sold') / sum(surveyRows, 'manual_load_survey') - 1) * 100);

  const [lo, hi] = TICKET_DATA.pilotNoShowRange;
  const estLow = r1(a.assumed_load_factor_pct * (1 - hi));
  const estHigh = r1(a.assumed_load_factor_pct * (1 - lo));
  const seatsPerTrain = Math.round(a.seats_offered / a.departures);
  const emptyRange = [
    Math.round((seatsPerTrain * Math.max(0, 100 - estHigh)) / 100),
    Math.round((seatsPerTrain * Math.max(0, 100 - estLow)) / 100),
  ];
  const turnedAwayPerYear = (a.passengers_turned_away / weekdays2025) * 253;

  return {
    scope: {
      demand_class: wholeNetwork ? 'all departures' : demand_class,
      baseline: `All ${BASELINE} weekdays (${a.departures} departures)`,
      measured_comparison: `${MONTH_NAMES[m - 1]} ${BASELINE} vs ${MONTH_NAMES[m - 1]} ${CURRENT}`,
    },
    the_constraint: SALES_POLICY,
    what_2025_reported: {
      assumed_load_factor_pct: a.assumed_load_factor_pct,
      how_it_was_calculated: DEFINITIONS.assumed_load_factor_pct,
      cabin_factor_pct: null,
      cabin_factor_status: a.cabin_factor_status,
      sold_out_departures_pct: a.sold_out_departures_pct,
      passengers_turned_away_per_weekday: perWeekday(a.passengers_turned_away),
      decisions_made_on_it: 'Which departures to lengthen, how many seats to protect for the full-fare classes, and the demand forecasts the EMSRb booking limits are computed from.',
    },
    why_ticket_data_cannot_answer_it: {
      available_in_2025: TICKET_DATA.what_2025_had,
      not_available_in_2025: TICKET_DATA.what_2025_could_not_have,
      the_root_cause:
        'Revenue is booked when the ticket is sold. It is identical whether the passenger travels or not, so nothing anywhere in the ticket system distinguishes the two - and no amount of analysis of ticket data can recover the difference.',
    },
    manual_load_surveys_2025: {
      method: TICKET_DATA.loadSurveyMethod,
      surveys,
      tickets_overstated_passengers_by_pct: surveyGapPct,
      why_it_was_not_enough:
        'Four days out of 365, one direction, counted by hand. Enough to suspect the gap, nowhere near enough to price a network on - and it gives a train total, not a per-departure no-show rate you can price against.',
    },
    pilot_2025_q4: OPERATOR_PILOT,
    measured_in_2026: {
      month: `${MONTH_NAMES[m - 1]}, both years`,
      assumed_load_factor_pct: { [BASELINE]: aM.assumed_load_factor_pct, [CURRENT]: bM.assumed_load_factor_pct },
      cabin_factor_pct: { [BASELINE]: null, [CURRENT]: bM.cabin_factor_pct },
      ticket_data_overstates_by_pp: bM.seatsense.overstatement_pp,
      ticket_data_overstates_by_pct: bM.seatsense.overstatement_pct,
      note: 'Same trains, same ticketing system. The gap is what an operator running on ticket sales alone is still carrying, unmeasured.',
    },
    inferred_for_2025: {
      inference: true,
      method: `${BASELINE} assumed load factor x (1 - no-show rate), using the ${lo * 100}-${hi * 100}% range that the Q4 ${BASELINE} pilot and the four manual surveys both landed in. The operator could not have computed this at the time.`,
      estimated_cabin_factor_pct_range: [estLow, estHigh],
      estimated_empty_seats_per_departure_range: emptyRange,
      mean_seats_per_departure: seatsPerTrain,
      estimated_passengers_who_actually_travelled: [
        Math.round(a.tickets_sold * (1 - hi)),
        Math.round(a.tickets_sold * (1 - lo)),
      ],
      tickets_sold_for_comparison: a.tickets_sold,
      passengers_note: `Ticket sales recorded ${a.tickets_sold.toLocaleString('en-GB')} journeys on these weekday departures. Applying the ${lo * 100}-${hi * 100}% no-show range, between ${Math.round(a.tickets_sold * (1 - hi)).toLocaleString('en-GB')} and ${Math.round(a.tickets_sold * (1 - lo)).toLocaleString('en-GB')} people most likely travelled. The operator reported the first number as its passenger count, because it had nothing else.`,
      what_it_cost: {
        revenue_turned_away_gbp_per_year: r2(turnedAwayPerYear * a.avg_fare_gbp),
        revenue_turned_away_basis: `${perWeekday(a.passengers_turned_away)} passengers a weekday x 253 weekdays x ${gbp(a.avg_fare_gbp)} average fare. Not recoverable even with hindsight: the seats those passengers wanted were sold, and the operator may not oversell.`,
        the_larger_cost:
          `Forecasting the network off a load factor roughly ${surveyGapPct}% too high - every no-show counted as demand - and feeding those forecasts to the seat-allocation model. The Weatherford-Belobaba paper prices that error class at 1-2% of revenue on constrained departures; what correcting it is worth here is what ${CURRENT} shows - see seatsense_attribution.`,
      },
      caveat: `An estimate built on a measured range, not a measurement. ${CURRENT} is the first year these numbers are observed rather than inferred.`,
    },
    definitions: DEFINITIONS,
    narrative: `Across ${BASELINE} the operator reported a ${a.assumed_load_factor_pct}% load factor on its ${demand_class} departures, closed sales on ${a.sold_out_departures_pct}% of them and turned away ${perWeekday(a.passengers_turned_away)} passengers a weekday - which it could not absorb, because one ticket means one seat and overselling is not permitted. That load factor was tickets divided by seats: revenue is booked whether the ticket holder travels or not, so it counted every no-show as a passenger and no cabin factor existed. The four manual load surveys that year found ticket sales overstating passengers by ${surveyGapPct}%. In ${MONTH_NAMES[m - 1]} ${CURRENT} SeatSense measures the gap directly: ticket data reports ${bM.assumed_load_factor_pct}%, the real cabin factor is ${bM.cabin_factor_pct}%, ${bM.seatsense.overstatement_pp} points lower. Applying the pilot's ${lo * 100}-${hi * 100}% range to ${BASELINE} puts the real cabin factor then at ${estLow}-${estHigh}% - an estimated ${emptyRange[0]}-${emptyRange[1]} of ${seatsPerTrain} seats a departure travelling empty on trains that had just refused passengers. Of the ${a.tickets_sold.toLocaleString('en-GB')} journeys ticket sales recorded, most likely ${Math.round(a.tickets_sold * (1 - hi)).toLocaleString('en-GB')}-${Math.round(a.tickets_sold * (1 - lo)).toLocaleString('en-GB')} people actually travelled.`,
  };
}

// ---------------------------------------------------------------------------
// Yggio device surface
// ---------------------------------------------------------------------------

/**
 * The seat inventory: which numbered seats a coach actually has.
 *
 * This is what the fleet is built from, not what SeatSense measured. Occupancy
 * is reported per coach, so this answers "which seats exist and where are
 * they", not "which of them were sat in" - keep the two apart when answering.
 */
export function seatMap({ unit_type, service_id, coach } = {}) {
  let type = unit_type;
  let svc = null;
  if (service_id) {
    svc = SVC[service_id];
    if (!svc) return { error: `Unknown service_id "${service_id}".` };
    type = svc.unit_type;
  }
  if (!type) {
    return {
      fleet: SEATMAPS.fleet,
      unit_types: Object.fromEntries(Object.entries(SEATMAPS.unit_types).map(([k, v]) => [k, {
        label: v.label, coaches: v.coaches, seats_total: v.seats_total,
        seats_standard: v.seats_standard, seats_first: v.seats_first, layout: v.layout,
        seats_per_coach: Object.fromEntries(Object.entries(v.by_coach).map(([c, ss]) => [c, ss.length])),
      }])),
      note: SEATMAPS.note,
      measurement_note: SEATMAPS.measurement_note,
      narrative: `${SEATMAPS.fleet.units} units, ${SEATMAPS.fleet.coaches} coaches, ${SEATMAPS.fleet.seats.toLocaleString('en-GB')} numbered seats across ${SEATMAPS.fleet.distinct_layouts} layouts (${Object.entries(SEATMAPS.fleet.numbered_places_per_layout).map(([k, v]) => `${k} ${v}`).join(', ')}). Pass unit_type or service_id, and optionally coach, for the seats themselves.`,
    };
  }
  const map = SEATMAPS.unit_types[type];
  if (!map) return { error: `Unknown unit_type "${type}". Known: ${Object.keys(SEATMAPS.unit_types).join(', ')}.` };
  if (coach) {
    const letter = String(coach).toUpperCase();
    const seats = map.by_coach[letter];
    if (!seats) return { error: `${type} has no coach ${letter}. Coaches: ${map.coaches.join(', ')}.` };
    const std = seats.filter((x) => x.cabin === 'standard').length;
    const first = seats.length - std;
    return {
      unit_type: type, label: map.label, coach: letter,
      seats: seats.length, seats_standard: std, seats_first: first,
      rows: seats.at(-1).row, layout: map.layout,
      seat_list: seats,
      measurement_note: SEATMAPS.measurement_note,
      narrative: `${map.label} coach ${letter}: ${seats.length} numbered seats (${std} Standard, ${first} First) over ${seats.at(-1).row} rows, ${letter}1 to ${seats.at(-1).seat}. Standard is ${map.layout.standard}, First ${map.layout.first}. Which of them were occupied is a per-coach count, not a per-seat one.`,
    };
  }
  return {
    unit_type: type, label: map.label, coaches: map.coaches,
    seats_total: map.seats_total, seats_standard: map.seats_standard, seats_first: map.seats_first,
    layout: map.layout,
    by_coach: Object.fromEntries(Object.entries(map.by_coach).map(([c, ss]) => [c, {
      seats: ss.length,
      seats_standard: ss.filter((x) => x.cabin === 'standard').length,
      seats_first: ss.filter((x) => x.cabin === 'first').length,
      rows: ss.at(-1).row,
      first_seat: ss[0].seat, last_seat: ss.at(-1).seat,
    }])),
    note: SEATMAPS.note,
    measurement_note: SEATMAPS.measurement_note,
    narrative: `${map.label}: ${map.coaches.length} coaches, ${map.seats_total} numbered seats (${map.seats_standard} Standard ${map.layout.standard}, ${map.seats_first} First ${map.layout.first})${svc ? `, the formation ${svc.service_id} works` : ''}. Pass coach for the seats themselves.`,
  };
}

export function listDevices({ route_id, unit_id, status, limit = 25, offset = 0 } = {}) {
  const all = DEVICES.filter(
    (d) => (!route_id || d.contextMap.route_id === route_id) &&
      (!unit_id || d.contextMap.unit_id === unit_id) &&
      (!status || d.status === status),
  );
  const page = all.slice(offset, offset + limit);
  const byRoute = {};
  for (const d of DEVICES) byRoute[d.contextMap.route_id] = (byRoute[d.contextMap.route_id] || 0) + 1;
  return {
    total: all.length,
    offset,
    limit,
    fleet_summary: {
      nodes: DEVICES.length,
      by_route: byRoute,
      online: DEVICES.filter((d) => d.status === 'online').length,
      offline: DEVICES.filter((d) => d.status !== 'online').length,
      installed_at: META.operator.seatsense.fleetGoLive,
      device_model: META.operator.seatsense.deviceModel,
    },
    iotnodes: page,
    narrative: `${DEVICES.length} SeatSense nodes in Yggio tenant ${META.operator.yggioTenant} - one per instrumented coach, all installed ${META.operator.seatsense.fleetGoLive}. Showing ${page.length} of ${all.length} matching.`,
  };
}

/** Latest values plus a same-day occupancy series for one coach's sensor. */
export function deviceReadings({ device_id, date }) {
  const dev = DEVICES.find((d) => d._id === device_id || d._id === `iot-${String(device_id).toLowerCase()}`);
  if (!dev) return { error: `Unknown device_id "${device_id}". Use yggio_list_iotnodes to find ids (they look like iot-nbr1-u003-b).` };
  const day = date ?? LATEST_WEEKDAY;
  if (day < `${CURRENT}-01-01`) return { error: `SeatSense was installed ${META.operator.seatsense.fleetGoLive}; no readings exist for ${day}.` };

  const series = [];
  for (const svc of SERVICES.filter((s) => s.route_id === dev.contextMap.route_id)
    .sort((a, b) => a.departure_time.localeCompare(b.departure_time))) {
    const row = ROWS[CURRENT].find((r) => r.service_id === svc.service_id && r.date === day);
    if (!row) continue;
    const snap = seatsenseSnapshot({ service_id: svc.service_id, date: day }).coaches;
    const coach = snap?.find((c) => c.unit_id === dev.contextMap.unit_id && c.coach === dev.contextMap.coach)
      ?? snap?.find((c) => c.coach === dev.contextMap.coach);
    series.push({
      time: `${day}T${svc.departure_time}:00Z`,
      service_id: svc.service_id,
      seats: dev.contextMap.seat_count,
      seatsOccupied: coach ? Math.round((coach.occupancy_pct / 100) * dev.contextMap.seat_count) : null,
      occupancyPercent: coach ? coach.occupancy_pct : null,
    });
  }
  const peak = series.reduce((a, s) => ((s.occupancyPercent ?? 0) > (a?.occupancyPercent ?? -1) ? s : a), null);
  return {
    iotnode: { _id: dev._id, name: dev.name, deviceModelName: dev.deviceModelName, contextMap: dev.contextMap, status: dev.status },
    date: day,
    latestValues: { ...dev.latestValues, seatsOccupied: series.at(-1)?.seatsOccupied ?? null },
    occupancy_series: series,
    narrative: `${dev.name} (${dev.contextMap.seat_count} seats) on ${day}: ${series.length} departures reported.${peak ? ` Busiest was the ${peak.service_id.slice(-4).replace(/(\d\d)(\d\d)/, '$1:$2')} at ${peak.occupancyPercent}% seat occupancy.` : ''}`,
  };
}

export function meta() {
  return { operator: META, services: SERVICES.length, devices: DEVICES.length, coverage: META.coverage, like_for_like: LIKE_FOR_LIKE };
}

function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
