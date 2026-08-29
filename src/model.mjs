/**
 * Scenario model for the InnoTrans SeatSense demo.
 *
 * Everything about the fictional operator lives here: network, timetable,
 * demand classes, fares, the sales policy and the 2026 SeatSense effect.
 * `generate.mjs` turns this into the JSON files under ../data. Nothing here is
 * real data.
 *
 * The story in one paragraph:
 *   Northbank Rail sells one seat per ticket and may not oversell. Its morning
 *   peak sells out every weekday and turns passengers away - and then departs
 *   with around a tenth of those paid-for seats empty, because the people who
 *   bought them did not turn up. Through 2025 the operator could not see any
 *   of that: ticket data knows exactly how many seats are unsold, but it
 *   cannot tell a passenger from a no-show, so it does not know how full any
 *   train actually is. SeatSense measures it from 1 January 2026. The empty
 *   seats themselves are not recoverable - a sold seat belongs to its buyer
 *   and overselling is not an option - so the entire value is in pricing the
 *   right departures, which is now possible because the operator finally knows
 *   which departures are genuinely full.
 */

export const GENERATOR_VERSION = '2.0.0';

/** Full 2025 baseline year; 2026 runs to the last day of data we ship. */
export const COVERAGE = {
  baselineYear: 2025,
  seatsenseYear: 2026,
  start: '2025-01-01',
  end: '2026-08-31',
  seatsenseGoLive: '2026-01-01',
};

/**
 * The constraint that makes this a rail problem rather than an airline one.
 *
 * A European operator selling reserved seats sells at most one ticket per seat
 * per departure. A reservation is a contractual right to that specific seat,
 * and denied boarding triggers passenger-rights obligations, so the deliberate
 * overbooking an airline prices into its yield model is not available. Two
 * consequences run through the whole dataset:
 *
 *   - Sales stop at 100% of seated capacity. Demand above that is turned away
 *     and recorded in demand_turned_away, in both years.
 *   - A no-show seat is dead revenue. It cannot be resold, because it still
 *     belongs to the person who bought it, and it cannot be covered by
 *     overselling. Nothing SeatSense does recovers that seat.
 *
 * So the only lever measurement unlocks is price: knowing which departures are
 * genuinely full, rather than merely sold out, and pricing accordingly.
 */
export const PRICING_POLICY = {
  principle:
    'It must always be possible to travel on the departure you want. It may cost more.',
  rule:
    'Price the most popular departures so they land just below full - a measured cabin-factor target - and price the departures either side of them below that. A departure that never reaches its sales cap never turns anyone away.',
  why_it_earns:
    'A departure sold to 100% cannot take another passenger, and the ones it refuses are revenue that simply does not happen. Overselling would absorb them and is not permitted, so the only way to keep them is to make sure the departure never fills: charge for the scarcity instead of rationing it.',
  why_it_needs_measurement:
    'The headroom has to be set against actual occupancy, not tickets sold. Two departures held at 96% sold deliver 89% and 84% of seats occupied, because their no-show rates differ by five points. Set one flat sold-target for both and you give up sales on a train that was already running empty, while still leaving the genuinely full one under-priced. The sold-target has to be per departure, and before 2026 the operator had no way to compute it.',
  /** Cabin factor the pricing aims each popular departure at. */
  targetCabinFactor: 0.88,
  /** Never price a departure to sell above this, so it cannot fill up. */
  soldCeiling: 0.97,
  /**
   * The most the rule may add to a fare. Bounded because a demand-based
   * product still has to be defensible to a regulator and recognisable to a
   * season-ticket holder. Where the cap binds, the departure still sells out
   * occasionally - the policy gets most of the way to never refusing anyone,
   * not all of it.
   */
  maxPremium: 0.045,
  /**
   * Two elasticities, because a fare move on one departure does two different
   * things. Most of its effect is to move passengers to a neighbouring
   * departure of the same journey - near-perfect substitutes, so this is high.
   * A much smaller part is people not travelling at all, which responds to what
   * the whole window costs on average, not to one departure's fare.
   */
  choiceElasticity: 5.5,
  marketElasticity: 0.3,
  /**
   * When a departure fills, this share of the blocked demand takes a
   * neighbouring departure instead. On a commuter railway that share is high -
   * refused the 07:41, you take the 08:11, you do not stay at home - so the
   * revenue lost outright is real but modest. Most of what the policy earns is
   * therefore yield rather than volume: the passenger who must have that train
   * pays for the certainty, and the flexible one is paid to move.
   */
  spillShare: 0.88,
  /** Spill only reaches departures within this many minutes, same direction. */
  spillWindowMinutes: 90,
  /** Iterations used to solve each popular departure's fare for its target. */
  solverPasses: 10,
  /**
   * The shoulder discount is not a standing offer. It scales with how much
   * premium the peak is carrying that day, because its whole purpose is to
   * receive demand priced off the peak. On a quiet Tuesday in August the peak
   * carries no premium, so the shoulder carries no discount and fares are
   * simply what they were in 2025.
   */
  referencePremium: 0.1,
};

/**
 * Departures that compete for the same passengers. Within a window a fare
 * change moves people between departures; outside one it mostly moves them in
 * or out of travelling. Anything not listed here stands on its own.
 */
export const COMPETITION_WINDOWS = [
  { id: 'morning_up', direction: 'up', from: '05:00', to: '10:00', label: 'Morning peak and its shoulders, towards the city' },
  { id: 'evening_down', direction: 'down', from: '15:45', to: '20:00', label: 'Evening peak and its shoulders, outbound' },
];

/**
 * How much a departure may be discounted to receive demand priced off the
 * peak. This is a property of sitting next to a peak departure, not of the
 * demand class: an off-peak departure inside the evening window is a shoulder
 * in everything but name, while the same class at midday competes with
 * nothing and is left alone.
 */
export const MAX_SHOULDER_DISCOUNT = {
  peak_shoulder: 0.045,
  offpeak: 0.027,
  early_late: 0.018,
};

export function windowOf(svc) {
  const w = COMPETITION_WINDOWS.find(
    (c) => c.direction === svc.direction && svc.departure_time >= c.from && svc.departure_time <= c.to,
  );
  return w ? w.id : `solo:${svc.service_id}`;
}

/** Seats in one unit of a route's fleet. */
export const unitSeats = (route) => route.unit.cars * route.unit.seatsPerCar;

/** Units coupled for a demand class, and the seats that gives. */
export const formationOf = (route, demandClass) => route.formations[demandClass] ?? 1;
export const seatsFor = (route, demandClass) => unitSeats(route) * formationOf(route, demandClass);

/** The longest formation the route runs - the reference every demand index uses. */
export const peakFormationSeats = (route) =>
  unitSeats(route) * Math.max(...Object.values(route.formations));

/** Demand for a class expressed against the seats that class actually offers. */
export function demandLoadFor(route, demandClass) {
  if (!route) return null;
  const index = route.demandIndex?.[demandClass] ?? DEMAND_CLASSES[demandClass].demandIndex;
  return (peakFormationSeats(route) * index) / seatsFor(route, demandClass);
}

/** Whether a departure sits in a window where a discount can earn anything. */
export function inCompetitionWindow(svc) {
  return !windowOf(svc).startsWith('solo:');
}

export const SALES_POLICY = {
  reservation: 'compulsory - every ticket carries a specific seat',
  tickets_per_seat: 1,
  sales_cap_pct_of_seats: 100,
  overselling: 'not permitted',
  basis:
    'A seat reservation is a contractual right to that seat, and denied boarding triggers passenger-rights obligations. European operators therefore sell at most one ticket per seat per departure, unlike airlines, which deliberately overbook and price the denied-boarding risk into their yield model.',
  consequences: [
    'A departure sold to 100% cannot take another passenger. In 2025 the morning peak did exactly that and refused the rest - revenue that never happened.',
    'A seat sold to someone who does not travel departs empty and the revenue is not recoverable: the seat is still theirs, and overselling to cover it is not an option.',
    'Ticket data knows precisely how many seats are unsold. What it cannot know is how many of the sold seats will actually be sat in - so it cannot rank departures by how full they really are.',
    'That ranking is what pricing decisions are made on, which is why measuring it is worth money even though the empty seats themselves are not.',
  ],
  what_seatsense_does_not_do: [
    'It does not let the operator oversell. That is a policy and passenger-rights question, not a data question.',
    'It does not let the operator resell a no-show seat mid-journey: the reservation still belongs to its buyer for the whole journey.',
    'It does not reduce the no-show rate. People who have paid still fail to travel at roughly the same rate in 2026 as in 2025.',
  ],
};

export const OPERATOR = {
  id: 'northbank-rail',
  name: 'Northbank Rail',
  legalName: 'Northbank Rail Operations Ltd',
  country: 'United Kingdom',
  headquarters: 'London, UK',
  currency: 'GBP',
  fictional: true,
  disclaimer:
    'Northbank Rail is a fictional train operating company. All figures in this dataset are synthetic and generated for demonstration purposes.',
  yggioTenant: 'northbank-rail-prod',
  product: 'Seat-reserved commuter and regional services. Every ticket carries a specific seat; there is no standing-permitted product.',
  seatsense: {
    product: 'Sensative SeatSense',
    deviceModel: 'sensative-seatsense-v2',
    measures:
      'Per-seat occupancy - whether a seat is physically occupied by a person, reported continuously per coach.',
    fleetGoLive: '2026-01-01',
    businessCase:
      'The operator signed off on the rollout against a projected +0.75% of total revenue, from demand-based pricing on measured occupancy alone. No overselling, no reselling of no-show seats, no fare-basket increase.',
    pilot: {
      window: '2025-10-01 .. 2025-12-19',
      scope: '3 units on the Anglia Metro (NBR1), 24 coaches instrumented',
      findings: [
        'Departures that had sold every seat and closed sales departed with an average of 10.4% of those seats empty.',
        'Median 47 paid-for seats travelling empty per sold-out peak departure; worst observed 71.',
        'Ticket data overstated the people on board peak departures by 9-12%.',
        'Two departures the ticket system ranked as equally sold out differed by 5 points of actual occupancy - the no-show rate is a property of who buys that particular train.',
      ],
    },
  },
};

/**
 * Demand classes.
 *
 * `demandIndex` is mean weekday demand as a share of the route's *longest*
 * formation, before the 100% sales cap is applied. Measuring against the
 * longest formation rather than against the seats actually coupled up means the
 * number keeps its meaning when a departure runs short - and a value above 1.0
 * on a departure that runs the full formation means it sells out and turns
 * passengers away. Each route overrides these with its own `demandIndex`,
 * because the routes have genuinely different shapes; the values here are the
 * network default. `fareIndex` is the mean realised yield
 * per passenger as a fraction of the route's peak fare.
 *
 * `noShowRate` is the share of ticket holders who do not travel. It is the
 * same in both years by design: SeatSense measures no-shows, it does not
 * prevent them. In 2025 nobody could observe it, which is exactly why the
 * reported load factor was wrong.
 *
 * The 2026 columns are the pricing response, and they are deliberately small.
 * Fares here are regulated and publicly scrutinised; the demo's claim is not
 * that measurement permits a fare rise, but that it permits moving fares by
 * one or two percent on the *right* departures. `fareDelta2026` is the fare
 * move; `demandDelta2026` is the demand response to it.
 *
 * The elasticities are conservative on purpose. On the classes taking an
 * increase, demand falls by the same percentage as the fare rises - unit
 * elasticity, so on a departure with spare seats the move earns nothing. On
 * the discounted classes demand responds at about 1.5x the fare cut, which is
 * defensible only because the substitute is the adjacent departure of the same
 * journey rather than another mode.
 *
 * That is what makes the whole business case rest on capacity: only where the
 * 100% sales cap binds does a fare rise reach revenue without losing volume.
 * Getting that right requires knowing which departures are genuinely full,
 * which is exactly what ticket data cannot tell you.
 */
export const DEMAND_CLASSES = {
  peak_core: {
    label: 'Morning peak core',
    description: 'The 07:00-08:30 arrivals. More people want these than there are seats.',
    demandIndex: 1.08,
    fareIndex: 1.0,
    noShowRate: 0.105,
    /** Priced by the rule: held just below full. See PRICING_POLICY. */
    priced: 'to_target',
    weekendFactor: 0.34,
    pricingRationale:
      'Demand exceeds the seats, so in 2025 these closed sales and refused passengers. The 2026 fare is set per departure so predicted sales land on the measured cabin-factor target instead - never at the cap.',
  },
  peak_shoulder: {
    label: 'Peak shoulder',
    description: 'The departures either side of the crush. Where the priced-off demand goes.',
    demandIndex: 0.55,
    fareIndex: 0.89,
    noShowRate: 0.075,
    priced: 'discount',
    /** Maximum discount, reached on the days the peak carries a full premium. */
    maxDiscount2026: 0.07,
    weekendFactor: 0.46,
    pricingRationale:
      'Discounted to receive the passengers priced off the crush departures, and the ones who used to be refused outright. Measured occupancy is what proves the room is really there.',
  },
  offpeak: {
    label: 'Off-peak',
    description: 'Midday and late evening leisure travel.',
    demandIndex: 0.28,
    fareIndex: 0.62,
    noShowRate: 0.042,
    priced: 'unchanged',
    maxDiscount2026: 0,
    weekendFactor: 0.74,
    pricingRationale:
      'Left alone. These departures do not compete with the peak - nobody moves a midday leisure trip to 07:41 - so a discount here would buy almost no volume and simply give away yield.',
  },
  evening_peak: {
    label: 'Evening peak',
    description: 'The 16:30-18:00 exodus out of the city. Also demand-constrained.',
    demandIndex: 1.04,
    fareIndex: 0.94,
    noShowRate: 0.09,
    priced: 'to_target',
    weekendFactor: 0.58,
    pricingRationale: 'Same rule as the morning peak, on a slightly smaller demand overhang.',
  },
  early_late: {
    label: 'Early / late',
    description: 'First and last departures of the day.',
    demandIndex: 0.2,
    fareIndex: 0.56,
    noShowRate: 0.035,
    priced: 'discount',
    maxDiscount2026: 0.04,
    weekendFactor: 0.44,
    pricingRationale:
      'The first departures of the morning sit inside the peak window, so they get a smaller version of the shoulder discount on the days there is displaced demand to receive.',
  },
};

/**
 * Background market growth in 2026, unrelated to SeatSense. It is generated
 * into the data so that the attribution tool has something real to net off:
 * the observed year-on-year change is market growth plus the pricing effect,
 * and only the second part is the business case.
 */
export const MARKET_GROWTH_2026 = 0.018;

/** What the customer's own business case projects, for reference in the docs. */
export const BUSINESS_CASE_TARGET_PCT = 0.75;

/** Seats per coach x coaches per unit gives the seated capacity we sell against. */
export const ROUTES = [
  {
    id: 'NBR1',
    name: 'Anglia Metro',
    origin: 'Colchester',
    destination: 'London Liverpool Street',
    calling: ['Colchester', 'Marks Tey', 'Kelvedon', 'Witham', 'Chelmsford', 'Shenfield', 'London Liverpool Street'],
    profile: 'Seat-reserved inner-suburban commuter',
    unit: { cars: 4, seatsPerCar: 60 },
    fleetUnits: 24,
    /** Units coupled together, by demand class. Peak trains are longer. */
    formations: { peak_core: 2, peak_shoulder: 2, evening_peak: 2, offpeak: 1, early_late: 1 },
    /**
     * Demand as a share of this route's longest formation, so the number means
     * the same thing whatever is coupled up that hour. A dense inner-suburban
     * route: sharp peaks, but a genuinely useful off-peak of shoppers and
     * students.
     */
    demandIndex: { peak_core: 1.045, peak_shoulder: 0.58, offpeak: 0.28, evening_peak: 1.018, early_late: 0.19 },
    peakFareGbp: 24.6,
    effectStrength: 1.0,
    services: [
      ['0541', 'up', 'early_late'],
      ['0611', 'up', 'peak_shoulder'],
      ['0641', 'up', 'peak_shoulder'],
      ['0711', 'up', 'peak_core'],
      ['0741', 'up', 'peak_core'],
      ['0811', 'up', 'peak_core'],
      ['0841', 'up', 'peak_shoulder'],
      ['0911', 'up', 'peak_shoulder'],
      ['1011', 'up', 'offpeak'],
      ['1211', 'up', 'offpeak'],
      ['1411', 'up', 'offpeak'],
      ['1627', 'down', 'peak_shoulder'],
      ['1657', 'down', 'evening_peak'],
      ['1727', 'down', 'evening_peak'],
      ['1757', 'down', 'evening_peak'],
      ['1827', 'down', 'peak_shoulder'],
      ['1927', 'down', 'offpeak'],
      ['2057', 'down', 'offpeak'],
      ['2227', 'down', 'early_late'],
      ['2327', 'down', 'early_late'],
    ],
  },
  {
    id: 'NBR2',
    name: 'Great Northern Line',
    origin: 'Peterborough',
    destination: "London King's Cross",
    calling: ['Peterborough', 'Huntingdon', 'St Neots', 'Sandy', 'Biggleswade', 'Hitchin', 'Stevenage', "London King's Cross"],
    profile: 'Seat-reserved long-distance commuter',
    unit: { cars: 4, seatsPerCar: 56 },
    fleetUnits: 25,
    /** Twelve cars at peak, four off-peak - the widest swing on the network. */
    formations: { peak_core: 3, peak_shoulder: 2, evening_peak: 3, offpeak: 1, early_late: 1 },
    /**
     * The peakiest route: season-ticket business travel into King's Cross and
     * very little midday demand, which is why it runs 12 cars at 07:48 and 4
     * at 12:18.
     */
    demandIndex: { peak_core: 1.055, peak_shoulder: 0.36, offpeak: 0.18, evening_peak: 1.025, early_late: 0.13 },
    peakFareGbp: 41.2,
    effectStrength: 0.95,
    services: [
      ['0548', 'up', 'early_late'],
      ['0618', 'up', 'peak_shoulder'],
      ['0648', 'up', 'peak_shoulder'],
      ['0718', 'up', 'peak_core'],
      ['0748', 'up', 'peak_core'],
      ['0818', 'up', 'peak_core'],
      ['0848', 'up', 'peak_shoulder'],
      ['0918', 'up', 'peak_shoulder'],
      ['1018', 'up', 'offpeak'],
      ['1218', 'up', 'offpeak'],
      ['1418', 'up', 'offpeak'],
      ['1603', 'down', 'peak_shoulder'],
      ['1633', 'down', 'evening_peak'],
      ['1703', 'down', 'evening_peak'],
      ['1733', 'down', 'evening_peak'],
      ['1803', 'down', 'peak_shoulder'],
      ['1903', 'down', 'offpeak'],
      ['2033', 'down', 'offpeak'],
      ['2203', 'down', 'early_late'],
      ['2303', 'down', 'early_late'],
    ],
  },
  {
    id: 'NBR3',
    name: 'Pennine Shuttle',
    origin: 'Huddersfield',
    destination: 'York',
    calling: ['Huddersfield', 'Dewsbury', 'Leeds', 'Garforth', 'Church Fenton', 'York'],
    profile: 'Seat-reserved regional',
    unit: { cars: 3, seatsPerCar: 68 },
    fleetUnits: 15,
    /** Six cars at peak, three the rest of the day, shoulders included. */
    formations: { peak_core: 2, peak_shoulder: 1, evening_peak: 2, offpeak: 1, early_late: 1 },
    /**
     * The flattest route. Its morning peak is constrained, but the evening peak
     * is not - which makes it the demo's honest counter-example: where nothing
     * is being rationed, measurement earns almost nothing.
     */
    demandIndex: { peak_core: 1.008, peak_shoulder: 0.26, offpeak: 0.24, evening_peak: 0.95, early_late: 0.17 },
    peakFareGbp: 11.4,
    effectStrength: 1.08,
    services: [
      ['0552', 'up', 'early_late'],
      ['0622', 'up', 'peak_shoulder'],
      ['0652', 'up', 'peak_shoulder'],
      ['0722', 'up', 'peak_core'],
      ['0752', 'up', 'peak_core'],
      ['0822', 'up', 'peak_shoulder'],
      ['0922', 'up', 'offpeak'],
      ['1122', 'up', 'offpeak'],
      ['1322', 'up', 'offpeak'],
      ['1614', 'down', 'peak_shoulder'],
      ['1644', 'down', 'evening_peak'],
      ['1714', 'down', 'evening_peak'],
      ['1744', 'down', 'evening_peak'],
      ['1814', 'down', 'peak_shoulder'],
      ['1914', 'down', 'offpeak'],
      ['2044', 'down', 'offpeak'],
      ['2214', 'down', 'early_late'],
      ['2314', 'down', 'early_late'],
    ],
  },
];

/** Month-of-year demand multipliers (1 = January). */
export const SEASONALITY = [0.92, 0.96, 1.02, 0.98, 1.03, 1.05, 1.01, 0.9, 1.09, 1.08, 1.06, 0.94];

/** Great Britain bank holidays that matter to a GB timetable. */
export const BANK_HOLIDAYS = new Set([
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26',
  '2025-08-25', '2025-12-25', '2025-12-26',
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25',
  '2026-08-31',
]);

/**
 * The pricing rules were live in full from 1 January 2026, so there is no
 * phase-in to model. The month-to-month variation in the measured effect comes
 * from something more interesting: whether the peak actually sold out that
 * month. In a quiet month the sales cap never binds, the fare increase simply
 * loses the volume it gains, and the effect goes to nearly nothing.
 */
export function pricingActive(year) {
  return year >= COVERAGE.seatsenseYear ? 1 : 0;
}

/**
 * The 2025 blind spot, stated explicitly because it is the whole argument.
 *
 * Note what ticket data *does* know under a one-ticket-per-seat policy: how
 * many seats are unsold, exactly. Availability is not the gap. The gap is that
 * revenue looks identical whether a ticket holder travels or not, so nothing
 * in the ticket system distinguishes a departure that is full from one that
 * merely sold out - and that distinction is what pricing runs on.
 */
export const TICKET_DATA = {
  what_2025_had: [
    'Tickets sold and unsold per departure, exactly - one ticket per seat leaves no ambiguity about availability.',
    'Revenue per departure, which is the same whether the ticket holder travels or not.',
    'Whether sales were closed on a departure, and how much demand arrived afterwards.',
    'Gateline entries and exits at staffed stations - a station total, not a seat.',
    'Manual load surveys: a counter with a clicker on a handful of days a year.',
  ],
  what_2025_could_not_have: [
    'How many of the sold seats were actually sat in - a no-show is invisible to ticket data.',
    'Therefore the cabin factor of any departure, on any day.',
    'Therefore which of two equally sold-out departures was genuinely full and which was not.',
    'Therefore whether a fare move on a given departure was safe or self-defeating.',
  ],
  reported_metric_2025: 'assumed_load_factor_pct = tickets sold / seats. Overstates the people on board by the no-show rate.',
  /** Four manual load-survey days in 2025 - the only 2025 data that saw bodies. */
  loadSurveyDates2025: ['2025-02-12', '2025-05-14', '2025-09-17', '2025-11-12'],
  loadSurveyMethod:
    'Manual count of passengers on board at the busiest point of the journey, morning up services only, plus or minus a few percent counting error. Four days out of 365.',
  /** No-show range the pilot and the surveys agreed on, used for the 2025 inference. */
  pilotNoShowRange: [0.09, 0.12],
};

/** Assumption used when attributing revenue growth to SeatSense. */
export const ATTRIBUTION = {
  assumedMarketGrowthPct: Math.round(MARKET_GROWTH_2026 * 1000) / 10,
  note:
    'Underlying market growth is the counterfactual: what revenue would have done in 2026 without SeatSense-informed pricing. It is generated into the 2026 demand at this rate, so netting it off isolates the pricing effect. Change the parameter to test how sensitive the attribution is.',
};

// ---------------------------------------------------------------------------
// Deterministic randomness - same seed always produces the same dataset.
// ---------------------------------------------------------------------------

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function rng(seed) {
  let a = hash32(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Symmetric multiplicative jitter, e.g. jitter(seed, 0.035) -> 0.965 .. 1.035 */
export function jitter(seed, amplitude) {
  return 1 + (rng(seed)() * 2 - 1) * amplitude;
}

export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * The no-show rate of an individual departure, not just its class.
 *
 * This is the number the whole demo turns on. Two departures can be equally
 * sold out and still differ by ten points of actual occupancy, because their
 * passengers differ: a 07:11 full of flexible-fare season travellers no-shows
 * far more than an 07:41 sold mostly on date-specific advance tickets. The
 * variation is persistent per departure - it is a property of who buys that
 * train - so it is stable enough to price against, and completely invisible to
 * ticket data, which books the same revenue either way.
 */
export function noShowRateFor(serviceId, demandClass) {
  const spread = 1 + (hash32(`noshow|${serviceId}`) / 4294967296 - 0.5) * 0.8; // +/-40%
  return DEMAND_CLASSES[demandClass].noShowRate * spread;
}

/**
 * The indicative 2026 fare move for one departure, at mean weekday demand.
 *
 * The fare the operator actually charges is solved per day, against that day's
 * expected demand - a quiet Tuesday in August carries no premium at all,
 * because nothing would have filled. This function is the annual headline
 * figure for the timetable, not the price of any particular journey.
 *
 * Note which departure gets the *smaller* increase: the one with the higher
 * no-show rate, because it can be sold closer to full without ever refusing
 * anyone. Ticket data would have ranked them the other way round.
 */
export function fareDelta2026For(serviceId, demandClass, inWindow = true, route = null) {
  const cls = DEMAND_CLASSES[demandClass];
  if (cls.priced !== 'to_target') {
    return inWindow ? -(MAX_SHOULDER_DISCOUNT[demandClass] ?? 0) : 0;
  }
  const targetSold = soldTargetFor(serviceId, demandClass);
  // Demand is indexed on the longest formation; compare it to the seats this
  // departure actually offers before deciding whether a premium is needed.
  const load = demandLoadFor(route, demandClass);
  if (load == null || load <= targetSold) return 0;
  return Math.min(
    PRICING_POLICY.maxPremium,
    Math.pow(load / targetSold, 1 / PRICING_POLICY.choiceElasticity) - 1,
  );
}

/** Sold-target the rule aims a to_target departure at, as a share of seats. */
export function soldTargetFor(serviceId, demandClass) {
  const cls = DEMAND_CLASSES[demandClass];
  if (cls.priced !== 'to_target') return null;
  return Math.min(PRICING_POLICY.soldCeiling, PRICING_POLICY.targetCabinFactor + noShowRateFor(serviceId, demandClass));
}

/** Flattened timetable: one row per daily departure. */
export function buildServices() {
  const out = [];
  for (const route of ROUTES) {
    for (const [time, direction, demandClass] of route.services) {
      const seats = seatsFor(route, demandClass);
      const cls = DEMAND_CLASSES[demandClass];
      const fare2025 = round2(route.peakFareGbp * cls.fareIndex);
      const departureTime = `${time.slice(0, 2)}:${time.slice(2)}`;
      const win = COMPETITION_WINDOWS.find(
        (c) => c.direction === direction && departureTime >= c.from && departureTime <= c.to,
      );
      const inWindow = Boolean(win);
      const windowId = win?.id ?? null;
      out.push({
        service_id: `${route.id}-${time}`,
        route_id: route.id,
        route_name: route.name,
        departure_time: `${time.slice(0, 2)}:${time.slice(2)}`,
        direction,
        origin: direction === 'up' ? route.origin : route.destination,
        destination: direction === 'up' ? route.destination : route.origin,
        demand_class: demandClass,
        seats,
        formation_units: formationOf(route, demandClass),
        coaches: route.unit.cars * formationOf(route, demandClass),
        seats_per_coach: route.unit.seatsPerCar,
        unit_type: `${route.unit.cars}-car, ${unitSeats(route)} seats`,
        longest_formation_seats: peakFormationSeats(route),
        fare_2025_gbp: fare2025,
        fare_2026_target_gbp: round2(fare2025 * (1 + fareDelta2026For(`${route.id}-${time}`, demandClass, inWindow, route) * route.effectStrength)),
        fare_change_pct: round1(fareDelta2026For(`${route.id}-${time}`, demandClass, inWindow, route) * route.effectStrength * 100),
        competition_window: inWindow ? windowId : null,
        priced_by: cls.priced === 'to_target'
          ? 'solved per day, held just below full against a measured cabin-factor target'
          : inWindow ? 'discounted in proportion to the peak premium that day, to receive displaced demand'
                     : 'left unchanged - competes with nothing',
        sold_target_pct: cls.priced === 'to_target' ? round1(soldTargetFor(`${route.id}-${time}`, demandClass) * 100) : null,
        no_show_rate_pct: round1(noShowRateFor(`${route.id}-${time}`, demandClass) * 100),
        no_show_rate_known_from: COVERAGE.seatsenseGoLive,
        sales_cap_pct_of_seats: SALES_POLICY.sales_cap_pct_of_seats,
      });
    }
  }
  return out;
}

export const round1 = (n) => Math.round(n * 10) / 10;
export const round2 = (n) => Math.round(n * 100) / 100;
