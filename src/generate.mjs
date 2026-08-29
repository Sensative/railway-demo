#!/usr/bin/env node
/**
 * Generates the demo dataset into ../data as plain JSON.
 *
 *   node src/generate.mjs            # regenerate everything
 *   node src/generate.mjs --through 2026-09-30
 *
 * Output is deterministic: same inputs, byte-identical files. The data is
 * committed to the repo so the demo needs no build step on site.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  GENERATOR_VERSION, COVERAGE, OPERATOR, ROUTES, DEMAND_CLASSES, SEASONALITY,
  BANK_HOLIDAYS, TICKET_DATA, SALES_POLICY, PRICING_POLICY, ATTRIBUTION,
  MARKET_GROWTH_2026, BUSINESS_CASE_TARGET_PCT, pricingActive, noShowRateFor,
  fareDelta2026For, soldTargetFor, windowOf, MAX_SHOULDER_DISCOUNT, rng,
  unitSeats, formationOf, seatsFor, peakFormationSeats,
  jitter, lerp, buildServices, round1, round2,
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

/**
 * One route's whole day, allocated across its departures together.
 *
 * Departures cannot be modelled independently, because the interesting thing
 * that happens is between them. When a departure fills, the demand it refuses
 * does not disappear: most of it takes a neighbouring departure, and the rest
 * does not travel at all. That last part is the revenue the 2026 pricing is
 * designed to keep - by making sure the popular departures never fill.
 *
 * Both years record what ticket data can see: seats sold (never more than the
 * seats there are), revenue, whether the departure reached its cap, and the
 * demand that wanted it and did not travel. 2026 rows add what SeatSense
 * measures, plus `cf_*`: what the departure would have done on 2025's flat
 * fares with the same market growth.
 */
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function makeRouteDay(route, date) {
  const [y, m] = date.split('-').map(Number);
  const seatsense = y >= COVERAGE.seatsenseYear;
  const priceRules = pricingActive(y) === 1;
  const deps = services.filter((s) => s.route_id === route.id);

  // Preferred demand: how many people would take this departure if price were
  // no object and every seat were free. Same in both scenarios below.
  const reference = peakFormationSeats(route);
  const preferred = deps.map((svc) => {
    const index = route.demandIndex?.[svc.demand_class] ?? DEMAND_CLASSES[svc.demand_class].demandIndex;
    return reference * index * SEASONALITY[m - 1] *
      dayTypeFactor(date, svc.demand_class) * jitter(`${svc.service_id}|${date}|vol`, 0.035) *
      (seatsense ? 1 + MARKET_GROWTH_2026 : 1);
  });
  const caps = deps.map((svc) => Math.round((svc.seats * SALES_POLICY.sales_cap_pct_of_seats) / 100));
  const mins = deps.map((svc) => minutesOf(svc.departure_time));

  // Departures that compete for the same passengers, so that a fare move on
  // one of them shows up as a shift to its neighbours rather than as
  // passengers vanishing from the railway.
  const windows = {};
  deps.forEach((svc, i) => { (windows[windowOf(svc)] ??= []).push(i); });

  /**
   * Allocate the day under one fare scenario.
   *
   * With pricing on, each popular departure's fare is solved for its own
   * sold-target: raise it until predicted sales land just below full, and
   * never raise it at all on a day when the departure would not have filled.
   */
  const run = (usePricing) => {
    const mult = deps.map(() => 1);
    const targets = deps.map((svc) => {
      const t = soldTargetFor(svc.service_id, svc.demand_class);
      return t == null ? null : t * svc.seats;
    });

    /** Predicted demand per departure given the current fares. */
    const predict = () => {
      const wanted = deps.map(() => 0);
      for (const idx of Object.values(windows)) {
        const base = idx.reduce((a, i) => a + preferred[i], 0);
        if (base <= 0) continue;
        // What the window costs on average decides how many travel at all;
        // the relative fares inside it decide which departure they take.
        const avgMult = idx.reduce((a, i) => a + preferred[i] * mult[i], 0) / base;
        const total = base * Math.pow(avgMult, -PRICING_POLICY.marketElasticity);
        const weights = idx.map((i) => preferred[i] * Math.pow(mult[i], -PRICING_POLICY.choiceElasticity));
        const wsum = weights.reduce((a, b) => a + b, 0);
        idx.forEach((i, k) => { wanted[i] = (total * weights[k]) / wsum; });
      }
      return wanted;
    };

    // Solve the popular departures' fares for their targets, and set each
    // window's shoulder discount from the premium its peak ends up carrying.
    if (usePricing) {
      for (let pass = 0; pass < PRICING_POLICY.solverPasses; pass++) {
        const wanted = predict();
        for (let i = 0; i < deps.length; i++) {
          if (targets[i] == null || wanted[i] <= 0) continue;
          const ratio = wanted[i] / targets[i];
          if (ratio <= 1 && mult[i] <= 1) { mult[i] = 1; continue; }
          mult[i] = Math.min(
            1 + PRICING_POLICY.maxPremium * route.effectStrength,
            Math.max(1, mult[i] * Math.pow(ratio, 1 / PRICING_POLICY.choiceElasticity)),
          );
        }
        for (const idx of Object.values(windows)) {
          const premiums = idx.filter((i) => targets[i] != null).map((i) => mult[i] - 1);
          if (!premiums.length) continue;
          const mean = premiums.reduce((a, b) => a + b, 0) / premiums.length;
          const intensity = Math.min(1, Math.max(0, mean / PRICING_POLICY.referencePremium));
          for (const i of idx) {
            if (DEMAND_CLASSES[deps[i].demand_class].priced === 'to_target') continue;
            const max = MAX_SHOULDER_DISCOUNT[deps[i].demand_class] ?? 0;
            mult[i] = 1 - max * route.effectStrength * intensity;
          }
        }
      }
    }

    const fares = deps.map((svc, i) => round2(
      svc.fare_2025_gbp * mult[i] * jitter(`${svc.service_id}|${date}|fare`, 0.02),
    ));
    const wanted = predict().map((w) => Math.round(w));
    const sold = wanted.map((w, i) => Math.min(w, caps[i]));
    const lost = deps.map(() => 0);

    for (let i = 0; i < deps.length; i++) {
      const blocked = wanted[i] - sold[i];
      if (blocked <= 0) continue;
      // Most of the refused demand tries a nearby departure; the rest gives up,
      // and that is the revenue the 2026 pricing exists to keep.
      let seeking = Math.round(blocked * PRICING_POLICY.spillShare);
      lost[i] += blocked - seeking;
      const neighbours = deps
        .map((svc, j) => ({ j, gap: Math.abs(mins[j] - mins[i]), sameWay: svc.direction === deps[i].direction }))
        .filter((n) => n.j !== i && n.sameWay && n.gap <= PRICING_POLICY.spillWindowMinutes)
        .sort((p, q) => p.gap - q.gap);
      for (const n of neighbours) {
        if (seeking <= 0) break;
        const room = caps[n.j] - sold[n.j];
        if (room <= 0) continue;
        const take = Math.min(room, seeking);
        sold[n.j] += take;
        seeking -= take;
      }
      lost[i] += Math.max(0, seeking);
    }
    return { fares, wanted, sold, lost, mult };
  };

  const priced = run(priceRules);
  const cf = seatsense ? run(false) : null;

  return deps.map((svc, i) => {
    const row = {
      date,
      service_id: svc.service_id,
      day_type: dayType(date),
      tickets_sold: priced.sold[i],
      revenue_gbp: round2(priced.sold[i] * priced.fares[i]),
      sales_closed: priced.sold[i] >= caps[i],
      demand_turned_away: priced.lost[i],
    };
    const noShowRate = noShowRateFor(svc.service_id, svc.demand_class) *
      jitter(`${svc.service_id}|${date}|ns`, 0.18);
    if (seatsense) {
      const boarded = Math.round(priced.sold[i] * (1 - noShowRate));
      row.boarded = boarded;
      row.seats_occupied = boarded;              // every ticket carries a seat
      row.ghost_seats = priced.sold[i] - boarded; // paid for, travelled empty
      row.cf_tickets_sold = cf.sold[i];
      row.cf_revenue_gbp = round2(cf.sold[i] * cf.fares[i]);
    } else if (TICKET_DATA.loadSurveyDates2025.includes(date) &&
               svc.direction === 'up' && svc.departure_time < '10:00') {
      row.manual_load_survey = Math.round(priced.sold[i] * (1 - noShowRate) * jitter(`${svc.service_id}|${date}|count`, 0.03));
    }
    return row;
  });
}

function buildDaily(from, to) {
  const rows = [];
  for (const date of eachDate(from, to)) for (const route of ROUTES) rows.push(...makeRouteDay(route, date));
  return rows;
}

/** Yggio-shaped IoT nodes: one SeatSense gateway per instrumented coach. */
function buildDevices() {
  const nodes = [];
  const coachLetters = 'ABCDEFGHIJ';
  for (const route of ROUTES) {
    for (let u = 1; u <= route.fleetUnits; u++) {
      const unit = `${route.id}-U${String(u).padStart(3, '0')}`;
      for (let c = 0; c < route.unit.cars; c++) {
        const coach = coachLetters[c];
        const id = `${unit}-${coach}`.toLowerCase();
        // rng() is uniform 0..1. jitter() is NOT - it returns 1 +/- amplitude,
        // so jitter(seed, 1) spans 0..2 and silently doubles anything scaled
        // by it. Use rng directly for anything that must stay inside a range.
        const battery = Math.round(lerp(74, 99, rng(id)()));
        const offline = rng(`${id}|off`)() > 0.985;
        nodes.push({
          _id: `iot-${id}`,
          name: `SeatSense ${unit} coach ${coach}`,
          deviceModelName: OPERATOR.seatsense.deviceModel,
          contextMap: {
            operator: OPERATOR.id,
            route_id: route.id,
            unit_id: unit,
            coach,
            seat_count: route.unit.seatsPerCar,
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
  return nodes;
}

/** Fare actions taken on 1 January 2026, by demand class. */
function buildPricing() {
  return {
    effective_from: COVERAGE.seatsenseGoLive,
    mechanism: 'Demand-based pricing on measured seat occupancy',
    principle: PRICING_POLICY.principle,
    rule: PRICING_POLICY.rule,
    why_it_earns: PRICING_POLICY.why_it_earns,
    why_it_needs_measurement: PRICING_POLICY.why_it_needs_measurement,
    parameters: {
      target_cabin_factor_pct: round1(PRICING_POLICY.targetCabinFactor * 100),
      sold_ceiling_pct: round1(PRICING_POLICY.soldCeiling * 100),
      max_premium_pct: round1(PRICING_POLICY.maxPremium * 100),
      elasticity_between_adjacent_departures: PRICING_POLICY.choiceElasticity,
      market_participation_elasticity: PRICING_POLICY.marketElasticity,
      share_of_refused_demand_that_takes_another_departure: PRICING_POLICY.spillShare,
    },
    rationale:
      "Each popular departure's fare is derived, not chosen: its sold-target is the cabin-factor target plus its own measured no-show rate, capped so it can never reach the sales cap, and the fare moves by whatever it takes to land predicted sales there. The departures either side take a flat discount to receive the demand priced off the peak - and the passengers who used to be refused outright.",
    not_available: SALES_POLICY.what_seatsense_does_not_do,
    phase_in: 'None - the rules were live in full from 1 January 2026.',
    why_the_effect_varies_by_month:
      "The fare is solved against each day's demand, so a departure that would not have filled carries no premium at all. The gain is therefore concentrated in the months when demand most exceeded the seats - in a quiet month nothing was being rationed, so there is nothing to price and the effect falls to almost nothing.",
    class_actions: Object.entries(DEMAND_CLASSES).map(([id, cls]) => ({
      demand_class: id,
      label: cls.label,
      priced: cls.priced,
      priced_by: cls.priced === 'to_target'
        ? 'solved per day, held just below full against a measured cabin-factor target'
        : 'discounted in proportion to the peak premium that day, but only on the departures that sit next to a peak',
      fare_change_pct: round1(
        services.filter((s) => s.demand_class === id).reduce((a, s) => a + s.fare_change_pct, 0) /
        services.filter((s) => s.demand_class === id).length),
      fare_change_range_pct: [
        Math.min(...services.filter((s) => s.demand_class === id).map((s) => s.fare_change_pct)),
        Math.max(...services.filter((s) => s.demand_class === id).map((s) => s.fare_change_pct)),
      ],
      departures_in_a_competition_window: services.filter((s) => s.demand_class === id && s.competition_window).length,
      departures_total: services.filter((s) => s.demand_class === id).length,
      rationale: cls.pricingRationale,
      mean_no_show_rate_pct: round1(cls.noShowRate * 100),
      demand_pct_of_seats_offered_by_route: Object.fromEntries(ROUTES.map((r) => [
        r.id, round1(((peakFormationSeats(r) * (r.demandIndex?.[id] ?? cls.demandIndex)) / seatsFor(r, id)) * 100),
      ])),
      formation_units_by_route: Object.fromEntries(ROUTES.map((r) => [r.id, formationOf(r, id)])),
    })),
    service_actions: services
      .filter((s) => s.demand_class === 'peak_core' || s.demand_class === 'peak_shoulder')
      .map((s) => ({
        service_id: s.service_id,
        departure_time: s.departure_time,
        demand_class: s.demand_class,
        fare_2025_gbp: s.fare_2025_gbp,
        fare_2026_target_gbp: s.fare_2026_target_gbp,
        fare_change_pct: s.fare_change_pct,
        no_show_rate_pct: s.no_show_rate_pct,
        sold_target_pct: s.sold_target_pct,
      })),
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
        units: r.fleetUnits,
        unit_type: `${r.unit.cars}-car, ${unitSeats(r)} seats`,
        coaches: r.fleetUnits * r.unit.cars,
        seats_per_coach: r.unit.seatsPerCar,
      },
      formations: Object.fromEntries(Object.entries(r.formations).map(([cls, n]) => [cls, {
        units: n, coaches: n * r.unit.cars, seats: unitSeats(r) * n,
      }])),
      longest_formation_seats: peakFormationSeats(r),
      shortest_formation_seats: unitSeats(r) * Math.min(...Object.values(r.formations)),
      daily_departures: r.services.length,
      peak_fare_gbp: r.peakFareGbp,
      demand_index_pct_of_longest_formation: Object.fromEntries(
        Object.entries(r.demandIndex).map(([k, v]) => [k, round1(v * 100)])),
    })),
    demand_classes: Object.entries(DEMAND_CLASSES).map(([id, c]) => ({
      demand_class: id, label: c.label, description: c.description,
    })),
    sales_policy: SALES_POLICY,
    ticket_data: TICKET_DATA,
    business_case: {
      target_total_revenue_uplift_pct: BUSINESS_CASE_TARGET_PCT,
      source: 'The operator\'s own projection, signed off before rollout.',
      mechanism: 'Demand-based pricing on measured occupancy. No overselling, no reselling of no-show seats, no increase to the fare basket.',
      assumed_market_growth_pct: round1(MARKET_GROWTH_2026 * 100),
      market_growth_note: ATTRIBUTION.note,
    },
    data_dictionary: {
      both_years: {
        tickets_sold: 'Tickets sold for the departure, never more than the seats there are. A sale, not a person in a seat.',
        revenue_gbp: 'Ticket revenue for the departure. Identical whether the ticket holder travels or not - which is why ticket data cannot see a no-show.',
        sales_closed: 'True if demand exceeded the 100%-of-seats cap and sales were stopped.',
        demand_turned_away: 'Passengers who wanted this departure after sales closed. Not absorbed by overselling, because overselling is not permitted.',
      },
      [`${COVERAGE.baselineYear}_only`]: {
        manual_load_survey: 'Passengers counted by hand on board, on the four survey days only. The single 2025 field that saw actual people.',
        note: 'There is no occupancy field for 2025 because no such measurement existed. tickets_sold / seats is an assumed load factor and overstates the people on board by the no-show rate.',
      },
      [`${COVERAGE.seatsenseYear}_only`]: {
        boarded: 'People SeatSense saw on board. Tickets sold minus no-shows.',
        seats_occupied: 'Seats SeatSense measured as physically occupied - the cabin factor numerator. Equal to boarded, since every ticket carries a seat and there is no standing product.',
        ghost_seats: 'Seats paid for that travelled empty. Not recoverable: the seat still belongs to its buyer and overselling to cover it is not permitted.',
        cf_tickets_sold: "Counterfactual: seats this departure would have sold on 2025's pricing rules, with the same market growth applied.",
        cf_revenue_gbp: 'Counterfactual revenue on the same basis. Observed minus counterfactual is the pricing effect, and that is the SeatSense business case.',
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
