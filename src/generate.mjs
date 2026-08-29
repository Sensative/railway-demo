#!/usr/bin/env node
/**
 * Generates the demo dataset into ../data as plain JSON.
 *
 *   node src/generate.mjs            # regenerate everything
 *   node src/generate.mjs --through 2026-09-30
 *
 * Output is deterministic: same inputs, byte-identical files. The data is
 * committed to the repo so the demo needs no build step on site.
 *
 * What is simulated, per departure per day - the Weatherford-Belobaba (2002)
 * booking model, one run per cabin (Standard, First):
 *
 *   1. Demand per booking class is drawn around its mean (the paper's
 *      stochastic class demand), and arrives over 15 booking periods as
 *      Poisson counts, low fares first but interspersed.
 *   2. At the start of every period, EMSRb booking limits are re-solved from
 *      remaining capacity and the *forecast* of the demand still to come.
 *   3. A request books if its class is open and seats remain; a request that
 *      finds its cabin full is turned away and lost. No overbooking, no
 *      cancellations, no buy-up.
 *
 * 2025 and 2026 differ in exactly one input, as in the paper's experiment:
 * the accuracy of the demand forecast. 2025 forecasts carry the ticket-data
 * bias (about 25% mean error, skewed upward with the no-show rate); 2026
 * forecasts are recalibrated on measured occupancy (about 12.5%, unbiased).
 * The fare ladder never changes. 2026 rows also carry cf_*: the same day's
 * arrivals re-run under 2025-quality forecasts - the paper's paired design -
 * so observed minus counterfactual isolates the forecast-quality effect.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GENERATOR_VERSION, COVERAGE, OPERATOR, ROUTES, DEMAND_CLASSES, DEMAND_MIX,
  BOOKING_CLASSES, ARRIVAL_SHAPES, arrivalCurve, DEMAND_CV, RM_POLICY,
  SEASONALITY, BANK_HOLIDAYS, TICKET_DATA, SALES_POLICY, ATTRIBUTION,
  MARKET_GROWTH_2026, BUSINESS_CASE_TARGET_PCT, UNIT_TYPES,
  unitSeatsStandard, unitSeatsFirst, unitSeatsTotal, formationOf, seatsFor,
  seatsForCabin, coachesFor, formationLabel, peakFormationSeats, faresFor,
  emsrbLimits, poisson, normInv, rng, hash32, jitter, lerp,
  buildServices, round1, round2,
} from './model.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const through = arg('--through', COVERAGE.end);

const iso = (d) => d.toISOString().slice(0, 10);
const eachDate = (from, to) => {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); iso(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(iso(d));
  return out;
};

/** Weekend / bank-holiday demand multiplier for a given demand class. */
function dayTypeFactor(date, demandClass) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  const cls = DEMAND_CLASSES[demandClass];
  const holiday = BANK_HOLIDAYS.has(date);
  if (dow === 0 || holiday) return cls.weekendFactor * 0.82;
  if (dow === 6) return cls.weekendFactor;
  return 1;
}

const dayType = (date) => {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (BANK_HOLIDAYS.has(date)) return 'bank_holiday';
  if (dow === 0) return 'sunday';
  if (dow === 6) return 'saturday';
  return 'weekday';
};

const services = buildServices();
const routeById = Object.fromEntries(ROUTES.map((r) => [r.id, r]));

/** Arrival curves and their remaining-share tails, per class id, precomputed. */
const CURVES = Object.fromEntries(
  Object.entries(ARRIVAL_SHAPES).map(([id, shape]) => {
    const w = arrivalCurve(shape);
    const tail = new Array(w.length + 1).fill(0);
    for (let p = w.length - 1; p >= 0; p--) tail[p] = tail[p + 1] + w[p];
    return [id, { w, tail }];
  }),
);

/** Truncated standard normal draw, seeded. */
function gauss(seed) {
  const r = rng(seed);
  const u1 = Math.max(r(), 1e-12);
  const u2 = r();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-2.5, Math.min(2.5, z));
}

/**
 * One cabin's booking process for one departure-day: realise the arrivals
 * once, then let a control policy (defined by its forecast bias) run over
 * them. Arrivals are policy-independent, so 2026 and its counterfactual see
 * the identical demand - the paper's paired-simulation design.
 */
function realiseArrivals(svcId, date, cabin, classIds, means) {
  // Per-class day factor: the stochastic total demand of the paper.
  const dayFactor = classIds.map((id, k) =>
    Math.max(0, 1 + gauss(`${svcId}|${date}|g|${id}`) * DEMAND_CV));
  const periods = [];
  for (let p = 0; p < RM_POLICY.bookingPeriods; p++) {
    const counts = classIds.map((id, k) =>
      poisson(means[k] * dayFactor[k] * CURVES[id].w[p], rng(`${svcId}|${date}|arr|${id}|${p}`)));
    // Interleave the classes within the period, deterministically shuffled.
    const seq = [];
    counts.forEach((n, k) => { for (let i = 0; i < n; i++) seq.push(k); });
    const r = rng(`${svcId}|${date}|mix|${cabin}|${p}`);
    for (let i = seq.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [seq[i], seq[j]] = [seq[j], seq[i]];
    }
    periods.push(seq);
  }
  return periods;
}

/**
 * Run EMSRb seat-inventory control over a realised arrival stream.
 * fares: per class; means: forecast means per class (already biased);
 * capacity: cabin seats. Returns sold per class and the two refusal counts.
 */
function runControl(periods, fares, forecastMeans, classIds, capacity) {
  const n = classIds.length;
  const sold = new Array(n).fill(0);
  let capLeft = capacity;
  let topClassRefused = 0;
  let pricedOff = 0;
  for (let p = 0; p < periods.length; p++) {
    // Forecast of demand still to come, per class, from this checkpoint on.
    const remaining = classIds.map((id, k) => {
      const f = CURVES[id].tail[p];
      return { fare: fares[k], mean: forecastMeans[k] * f, sd: DEMAND_CV * forecastMeans[k] * Math.sqrt(f) };
    });
    const limits = emsrbLimits(remaining, capLeft);
    const soldThisPeriod = new Array(n).fill(0);
    for (const k of periods[p]) {
      // Nested availability: class k's limit, minus what this period already
      // sold in k and every cheaper class.
      let lower = 0;
      for (let j = k; j < n; j++) lower += soldThisPeriod[j];
      if (capLeft > 0 && limits[k] - lower > 0) {
        sold[k]++;
        soldThisPeriod[k]++;
        capLeft--;
      } else if (k === 0) {
        // A refused top-class request means a walk-up passenger who could not
        // travel at any price - the failure the protection levels exist to
        // prevent. (The top class's limit is the remaining capacity itself,
        // so this only happens when the cabin is genuinely full.)
        topClassRefused++;
      } else {
        // A cheap class was closed while dearer seats remained: priced, not
        // refused.
        pricedOff++;
      }
    }
  }
  return { sold, capLeft, topClassRefused, pricedOff };
}

/**
 * One departure-day. Simulates the Standard and First cabins separately
 * (same model, own fare ladder and demand), under the year's forecast
 * quality; for 2026 additionally re-runs the identical arrivals under
 * 2025-quality forecasts to produce the counterfactual.
 */
function makeDepartureDay(svc, route, date) {
  const [y, m] = date.split('-').map(Number);
  const seatsense = y >= COVERAGE.seatsenseYear;
  const cls = DEMAND_CLASSES[svc.demand_class];
  const mix = DEMAND_MIX[cls.mix];
  const fares = faresFor(route);

  const totalMean = svc.seats * route.demandFactor[svc.demand_class] *
    SEASONALITY[m - 1] * dayTypeFactor(date, svc.demand_class) *
    jitter(`${svc.service_id}|${date}|vol`, 0.035) *
    (seatsense ? 1 + MARKET_GROWTH_2026 : 1);

  const bias25 = 1 + svc.forecast_error_2025_pct / 100;
  const bias26 = 1 + svc.forecast_error_2026_pct / 100;
  const biasNow = seatsense ? bias26 : bias25;

  const cabins = [
    {
      cabin: 'standard',
      capacity: svc.seats_standard,
      classIds: BOOKING_CLASSES.standard.map((c) => c.id),
      fares: fares.standard.map((c) => c.fare_gbp),
      means: BOOKING_CLASSES.standard.map((c, k) => totalMean * (1 - mix.firstShare) * mix.standard[k]),
    },
    {
      cabin: 'first',
      capacity: svc.seats_first,
      classIds: BOOKING_CLASSES.first.map((c) => c.id),
      fares: fares.first.map((c) => c.fare_gbp),
      means: BOOKING_CLASSES.first.map((c, k) => totalMean * mix.firstShare * mix.first[k]),
    },
  ].filter((c) => c.capacity > 0);

  let sold = 0;
  let revenue = 0;
  let turnedAway = 0;
  let anyClosed = false;
  let cfSold = 0;
  let cfRevenue = 0;

  for (const c of cabins) {
    const arrivals = realiseArrivals(svc.service_id, date, c.cabin, c.classIds, c.means);
    const now = runControl(arrivals, c.fares, c.means.map((mu) => mu * biasNow), c.classIds, c.capacity);
    sold += now.sold.reduce((a, b) => a + b, 0);
    revenue += now.sold.reduce((a, s, k) => a + s * c.fares[k], 0);
    // The walk-up story is told on the Standard cabin: a First walk-up refused
    // at a full First cabin still has the Standard ladder open to them.
    if (c.cabin === 'standard') {
      turnedAway += now.topClassRefused;
      if (now.capLeft === 0) anyClosed = true;
    }
    if (seatsense) {
      const cf = runControl(arrivals, c.fares, c.means.map((mu) => mu * bias25), c.classIds, c.capacity);
      cfSold += cf.sold.reduce((a, b) => a + b, 0);
      cfRevenue += cf.sold.reduce((a, s, k) => a + s * c.fares[k], 0);
    }
  }

  const row = {
    date,
    service_id: svc.service_id,
    day_type: dayType(date),
    tickets_sold: sold,
    revenue_gbp: round2(revenue),
    sales_closed: anyClosed,
    demand_turned_away: turnedAway,
  };

  const noShowRate = (svc.no_show_rate_pct / 100) * jitter(`${svc.service_id}|${date}|ns`, 0.18);
  if (seatsense) {
    const boarded = Math.round(sold * (1 - noShowRate));
    row.boarded = boarded;
    row.seats_occupied = boarded;        // every ticket carries a seat
    row.ghost_seats = sold - boarded;    // paid for, travelled empty
    row.cf_tickets_sold = cfSold;
    row.cf_revenue_gbp = round2(cfRevenue);
  } else if (TICKET_DATA.loadSurveyDates2025.includes(date) &&
             svc.direction === 'up' && svc.departure_time < '10:00') {
    row.manual_load_survey = Math.round(sold * (1 - noShowRate) * jitter(`${svc.service_id}|${date}|count`, 0.03));
  }
  return row;
}

function buildDaily(from, to) {
  const rows = [];
  for (const date of eachDate(from, to)) {
    for (const route of ROUTES) {
      for (const svc of services) {
        if (svc.route_id !== route.id) continue;
        rows.push(makeDepartureDay(svc, route, date));
      }
    }
  }
  return rows;
}

/** Yggio-shaped IoT nodes: one SeatSense gateway per instrumented coach. */
function buildDevices() {
  const nodes = [];
  for (const route of ROUTES) {
    let unitNo = 0;
    for (const group of route.fleet) {
      const type = UNIT_TYPES[group.type];
      for (let u = 0; u < group.units; u++) {
        unitNo += 1;
        const unit = `${route.id}-U${String(unitNo).padStart(3, '0')}`;
        for (const coach of type.coaches) {
          const id = `${unit}-${coach.letter}`.toLowerCase();
          // rng() is uniform 0..1. jitter() is NOT - it returns 1 +/- amplitude,
          // so jitter(seed, 1) spans 0..2 and silently doubles anything scaled
          // by it. Use rng directly for anything that must stay inside a range.
          const battery = Math.round(lerp(74, 99, rng(id)()));
          const offline = rng(`${id}|off`)() > 0.985;
          nodes.push({
            _id: `iot-${id}`,
            name: `SeatSense ${unit} coach ${coach.letter}`,
            deviceModelName: OPERATOR.seatsense.deviceModel,
            contextMap: {
              operator: OPERATOR.id,
              route_id: route.id,
              unit_id: unit,
              unit_type: `${type.label} (${group.type})`,
              coach: coach.letter,
              seat_count: coach.seats_standard + coach.seats_first,
              seat_count_standard: coach.seats_standard,
              seat_count_first: coach.seats_first,
              cabin: coach.seats_first > 0 ? (coach.seats_standard > 0 ? 'mixed' : 'first') : 'standard',
              installed_at: OPERATOR.seatsense.fleetGoLive,
              firmware: '2.4.1',
            },
            status: offline ? 'offline' : 'online',
            latestValues: {
              seatsOccupied: null, // filled per-query by the snapshot endpoints
              batteryPercent: battery,
              rssi: -Math.round(lerp(58, 96, rng(`${id}|rssi`)())),
              reportedAt: offline
                ? `2026-08-${String(12 + Math.floor(rng(`${id}|last`)() * 14)).padStart(2, '0')}T04:12:07Z`
                : '2026-08-31T23:58:02Z',
            },
          });
        }
      }
    }
  }
  return nodes;
}

/** The revenue-management setup - what changed on 1 January 2026, and what did not. */
function buildPricing() {
  return {
    effective_from: COVERAGE.seatsenseGoLive,
    mechanism:
      'EMSRb seat allocation across five nested booking classes per cabin, with demand forecasts recalibrated on measured seat occupancy.',
    model_reference: RM_POLICY.reference,
    principle: RM_POLICY.principle,
    how_the_principle_is_kept: RM_POLICY.how_the_principle_is_kept,
    method: {
      heuristic: RM_POLICY.method,
      booking_periods: RM_POLICY.bookingPeriods,
      reoptimisation: RM_POLICY.reoptimise,
      assumptions: RM_POLICY.assumptions,
    },
    what_changed_on_go_live: {
      demand_forecasts: RM_POLICY.forecastError,
      fares: RM_POLICY.what_did_not_change,
      note:
        "This is the paper's own experiment, run on a railway: same seat-allocation heuristic, same fare ladder, same realised demand - only the forecast error changes. The paper found demand-forecast accuracy to be the input that matters most, worth over 1% of revenue on departures where demand meets capacity, and dwarfing fare-input accuracy and fare dispersion.",
    },
    booking_classes_by_route: Object.fromEntries(ROUTES.map((r) => [r.id, faresFor(r)])),
    demand_profiles: {
      note:
        "The paper's two demand data sets: a business flight with demand spread almost evenly across the five classes, and a leisure flight with demand concentrated at the bottom. Peaks get the business profile, off-peak leisure, shoulders a blend.",
      profiles: DEMAND_MIX,
    },
    class_actions: Object.entries(DEMAND_CLASSES).map(([id, cls]) => ({
      demand_class: id,
      label: cls.label,
      demand_profile: cls.mix,
      demand_factor_by_route: Object.fromEntries(
        ROUTES.map((r) => [r.id, r.demandFactor[id]]),
      ),
      formation_by_route: Object.fromEntries(
        ROUTES.map((r) => [r.id, formationLabel(r, id)]),
      ),
      seats_by_route: Object.fromEntries(
        ROUTES.map((r) => [r.id, seatsFor(r, id)]),
      ),
      mean_no_show_rate_pct: round1(cls.noShowRate * 100),
      what_2026_changed:
        'Nothing about this class itself - its fares and its demand are the same. The booking limits that ration it are computed from forecasts that are now roughly twice as accurate.',
    })),
    service_actions: services
      .filter((s) => s.demand_class === 'peak_core' || s.demand_class === 'evening_peak')
      .map((s) => ({
        service_id: s.service_id,
        departure_time: s.departure_time,
        demand_class: s.demand_class,
        demand_factor: s.demand_factor,
        forecast_error_2025_pct: s.forecast_error_2025_pct,
        forecast_error_2026_pct: s.forecast_error_2026_pct,
        no_show_rate_pct: s.no_show_rate_pct,
        reading:
          s.forecast_error_2025_pct > 0
            ? 'Over-forecast in 2025: too many seats protected for high classes, Advance sales refused, seats travelled empty and unsold.'
            : 'Under-forecast in 2025: too few seats protected, cheap classes filled the train early, walk-up passengers found it sold out.',
      })),
    not_available: SALES_POLICY.what_seatsense_does_not_do,
    phase_in: 'None - the recalibrated forecasts were live in full from 1 January 2026.',
    why_the_effect_varies_by_month:
      'Forecast quality only earns money where the booking limits bind. In a quiet month demand never reaches the seats, every class stays open, and a wrong forecast costs nothing - the paper found the same: revenue impacts concentrate at demand factors of 1.0 and above.',
  };
}

mkdirSync(DATA_DIR, { recursive: true });

const write = (name, obj) => {
  writeFileSync(join(DATA_DIR, name), JSON.stringify(obj, null, name.startsWith('daily-') ? 0 : 2) + '\n');
  return name;
};

const daily2025 = buildDaily('2025-01-01', '2025-12-31');
const daily2026 = buildDaily('2026-01-01', through);

const files = [
  write('operator.json', {
    operator: OPERATOR,
    coverage: { ...COVERAGE, end: through },
    routes: ROUTES.map((r) => ({
      route_id: r.id,
      name: r.name,
      origin: r.origin,
      destination: r.destination,
      calling_points: r.calling,
      profile: r.profile,
      fleet: {
        units: r.fleet.map((g) => `${g.units} x ${UNIT_TYPES[g.type].label}`).join(', '),
        unit_types: r.fleet.map((g) => ({
          type: g.type,
          label: UNIT_TYPES[g.type].label,
          units: g.units,
          coaches_per_unit: UNIT_TYPES[g.type].coaches.length,
          seats_per_unit: unitSeatsTotal(g.type),
          seats_standard: unitSeatsStandard(g.type),
          seats_first: unitSeatsFirst(g.type),
        })),
        coaches: r.fleet.reduce((a, g) => a + g.units * UNIT_TYPES[g.type].coaches.length, 0),
      },
      formations: Object.fromEntries(Object.entries(r.formations).map(([cls, f]) => [cls, {
        formation: `${f.units} x ${UNIT_TYPES[f.type].label}`,
        coaches: f.units * UNIT_TYPES[f.type].coaches.length,
        seats: seatsFor(r, cls),
        seats_standard: seatsForCabin(r, cls, 'standard'),
        seats_first: seatsForCabin(r, cls, 'first'),
      }])),
      longest_formation_seats: peakFormationSeats(r),
      shortest_formation_seats: Math.min(...Object.keys(r.formations).map((c) => seatsFor(r, c))),
      daily_departures: r.services.length,
      anytime_standard_fare_gbp: r.anytimeStandardGbp,
      demand_factor: Object.fromEntries(Object.entries(r.demandFactor).map(([k, v]) => [k, round2(v)])),
    })),
    demand_classes: Object.entries(DEMAND_CLASSES).map(([id, c]) => ({
      demand_class: id, label: c.label, description: c.description, demand_profile: c.mix,
    })),
    sales_policy: SALES_POLICY,
    revenue_management: {
      method: RM_POLICY.method,
      reference: RM_POLICY.reference,
      booking_periods: RM_POLICY.bookingPeriods,
      principle: RM_POLICY.principle,
      how_the_principle_is_kept: RM_POLICY.how_the_principle_is_kept,
      forecast_error: RM_POLICY.forecastError,
      fares: RM_POLICY.what_did_not_change,
    },
    ticket_data: TICKET_DATA,
    business_case: {
      target_total_revenue_uplift_pct: BUSINESS_CASE_TARGET_PCT,
      source: 'The operator\'s own projection, signed off before rollout.',
      mechanism:
        'Recalibrating the RM demand forecasts on measured occupancy - the Weatherford-Belobaba forecast-accuracy effect. No overselling, no reselling of no-show seats, no change to the fare ladder.',
      assumed_market_growth_pct: round1(MARKET_GROWTH_2026 * 100),
      market_growth_note: ATTRIBUTION.note,
    },
    data_dictionary: {
      both_years: {
        tickets_sold: 'Tickets sold for the departure across all booking classes, never more than the seats there are. A sale, not a person in a seat.',
        revenue_gbp: 'Ticket revenue for the departure. Identical whether the ticket holder travels or not - which is why ticket data cannot see a no-show.',
        sales_closed: 'True if the Standard cabin sold every seat and was refusing requests. (First is a separate small pool; a full First cabin alone does not close the train.)',
        demand_turned_away: 'Anytime Standard requests refused because no Standard seat was left - walk-up passengers who could not travel at any price. Not absorbed by overselling, because overselling is not permitted. A request refused because its cheap class closed while dearer seats remained is not counted here: that passenger was priced, not refused, and the top of the ladder was still open.',
      },
      [`${COVERAGE.baselineYear}_only`]: {
        manual_load_survey: 'Passengers counted by hand on board, on the four survey days only. The single 2025 field that saw actual people.',
        note: 'There is no occupancy field for 2025 because no such measurement existed. tickets_sold / seats is an assumed load factor and overstates the people on board by the no-show rate.',
      },
      [`${COVERAGE.seatsenseYear}_only`]: {
        boarded: 'People SeatSense saw on board. Tickets sold minus no-shows.',
        seats_occupied: 'Seats SeatSense measured as physically occupied - the cabin factor numerator. Equal to boarded, since every ticket carries a seat and there is no standing product.',
        ghost_seats: 'Seats paid for that travelled empty. Not recoverable: the seat still belongs to its buyer and overselling to cover it is not permitted.',
        cf_tickets_sold: "Counterfactual: what the same day's booking requests would have produced under 2025's forecast quality - the same EMSRb controls fed the old forecasts.",
        cf_revenue_gbp: 'Counterfactual revenue on the same basis. Observed minus counterfactual is the forecast-quality effect, and that is the SeatSense business case.',
      },
    },
    generator: { version: GENERATOR_VERSION, generated_at: new Date().toISOString().slice(0, 10) },
  }),
  write('services.json', services),
  write('devices.json', buildDevices()),
  write('pricing.json', buildPricing()),
  write('daily-2025.json', daily2025),
  write('daily-2026.json', daily2026),
];

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
console.log(`wrote ${files.join(', ')}`);
console.log(`2025: ${daily2025.length} rows, ${sum(daily2025, 'tickets_sold').toLocaleString()} tickets, GBP ${Math.round(sum(daily2025, 'revenue_gbp')).toLocaleString()}`);
console.log(`2026: ${daily2026.length} rows (through ${through}), ${sum(daily2026, 'tickets_sold').toLocaleString()} tickets, GBP ${Math.round(sum(daily2026, 'revenue_gbp')).toLocaleString()}`);
const cf = sum(daily2026, 'cf_revenue_gbp');
const obs = sum(daily2026, 'revenue_gbp');
console.log(`2026 attributable vs cf: GBP ${Math.round(obs - cf).toLocaleString()} (${((obs / cf - 1) * 100).toFixed(3)}% of cf)`);
