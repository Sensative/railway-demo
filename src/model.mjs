/**
 * Scenario model for the InnoTrans SeatSense demo.
 *
 * Everything about the fictional operator lives here: network, timetable,
 * fleet, booking classes, the revenue-management model and the 2026 SeatSense
 * effect. `generate.mjs` turns this into the JSON files under ../data.
 * Nothing here is real data.
 *
 * The story in one paragraph:
 *   Northbank Rail sells one seat per ticket and may not oversell. Seats are
 *   allocated to five nested booking classes by an EMSRb revenue-management
 *   system - the seat-allocation model of Weatherford & Belobaba (Journal of
 *   the Operational Research Society 53, 2002). That model's critical input is
 *   the demand forecast per class, and through 2025 those forecasts were
 *   calibrated on ticket data, which cannot tell a passenger from a no-show.
 *   The forecasts were off by around 25% - the exact error magnitude whose
 *   revenue cost the paper quantifies. SeatSense measures actual occupancy
 *   from 1 January 2026, the forecasts are recalibrated, the error roughly
 *   halves - and the paper's headline applies: cutting the forecast error in
 *   half is worth more than a percent of revenue where demand meets capacity.
 *   Fares are identical in both years; only the allocation changed.
 */

export const GENERATOR_VERSION = '3.0.0';

/** Full 2025 baseline year; 2026 runs to the last day of data we ship. */
export const COVERAGE = {
  baselineYear: 2025,
  seatsenseYear: 2026,
  start: '2025-01-01',
  end: '2026-08-31',
  seatsenseGoLive: '2026-01-01',
};

/**
 * The revenue-management model, taken from the paper rather than invented:
 *
 *   LR Weatherford and PP Belobaba, "Revenue impacts of fare input and demand
 *   forecast accuracy in airline yield management", Journal of the
 *   Operational Research Society 53 (2002) 1-11.
 *
 * Mechanics implemented exactly as described there:
 *   - Nested booking classes on a single leg; seats protected for higher
 *     classes with the EMSRb heuristic (joint protection levels from the
 *     combined demand and demand-weighted average fare of all higher classes).
 *   - Bookings arrive over 15 booking periods; arrivals within each period
 *     are Poisson, and the class arrival rates replicate low-fare passengers
 *     booking before high-fare ones, interspersed.
 *   - Booking limits are re-optimised at the start of every period, on the
 *     remaining capacity and the demand still to come.
 *   - Assumptions carried over from the paper: class demands independent, no
 *     cancellations, spilled passengers lost, no buy-up between classes.
 *
 * The paper's experiment this demo re-stages is forecast accuracy: EMSRb fed
 * forecasts ~25% wrong versus ~12.5% wrong, same realised demand. Its
 * conclusion - forecast accuracy is the input that matters, and halving the
 * error is worth over 1% of revenue when demand reaches capacity - is the
 * SeatSense business case.
 */
export const RM_POLICY = {
  principle:
    'It must always be possible to travel on the departure you want. It may cost more.',
  method: 'EMSRb',
  reference:
    'LR Weatherford and PP Belobaba, "Revenue impacts of fare input and demand forecast accuracy in airline yield management", Journal of the Operational Research Society 53 (2002) 1-11.',
  bookingPeriods: 15,
  reoptimise:
    'Booking limits are re-solved at the start of each of the 15 booking periods, on remaining capacity and the forecast demand still to come - the standard practice the paper describes.',
  how_the_principle_is_kept:
    'EMSRb protects seats for the highest fare class, so a walk-up Anytime passenger finds a seat on the departure they want even when the cheap classes closed weeks earlier. The promise is availability at the top of the fare ladder, not at the bottom.',
  assumptions: [
    'Demands for the booking classes are independent of each other.',
    'No cancellations; a booking holds its specific seat to departure.',
    'A refused request is lost - the model does not resell it on a neighbouring departure.',
    'No buy-up: a passenger refused in their class does not book a higher one.',
  ],
  /**
   * Mean absolute demand-forecast error fed to EMSRb, by year. The 2025/2026
   * pair mirrors the paper's 25% vs 12.5% scenarios. In 2025 the error is not
   * even centred: forecasts were calibrated on ticket sales with everybody
   * assumed to travel, so departures with high no-show rates had their future
   * demand chronically over-forecast - the direction the paper found most
   * expensive.
   */
  forecastError: {
    2025: {
      label: '~25% mean absolute error, biased upward with the no-show rate',
      why: 'Forecasts calibrated on ticket data. A no-show books revenue and looks like a passenger, so the busier a departure looked, the more demand the model expected next time.',
    },
    2026: {
      label: '~12.5% mean absolute error, unbiased',
      why: 'Forecasts recalibrated on measured occupancy per departure - SeatSense sees who actually travels, per seat, every day.',
    },
  },
  what_did_not_change:
    'The fare ladder. Every class fare is identical in 2025 and 2026 - the gain comes from allocating seats to classes correctly, not from charging more.',
};

/**
 * Booking classes, highest fare first, as in the paper's five-class problem
 * (its Y/M/B/V/Q). Fare indices are the paper's business-flight fare ratios
 * (275/173/122/93/66), applied to each route's Anytime Standard fare.
 * First is a separate small cabin with its own two-class ladder - the paper's
 * single-cabin model applied per cabin.
 */
export const BOOKING_CLASSES = {
  standard: [
    { id: 'AS', label: 'Anytime Standard', fareIndex: 1.0 },
    { id: 'OP', label: 'Off-Peak Return', fareIndex: 0.63 },
    { id: 'A1', label: 'Advance 1', fareIndex: 0.44 },
    { id: 'A2', label: 'Advance 2', fareIndex: 0.34 },
    { id: 'A3', label: 'Advance 3', fareIndex: 0.24 },
  ],
  first: [
    { id: 'AF', label: 'Anytime First', fareIndex: 1.55 },
    { id: 'F1', label: 'Advance First', fareIndex: 0.95 },
  ],
};

/**
 * How demand splits across the booking classes - the paper's two demand
 * profiles. Its business flight spreads demand almost evenly across the five
 * classes; its leisure flight concentrates demand at the bottom. The peaks
 * here get the business profile, off-peak gets leisure, shoulders a blend.
 */
export const DEMAND_MIX = {
  business: { standard: [0.20, 0.13, 0.22, 0.23, 0.22], first: [0.55, 0.45], firstShare: 0.13 },
  shoulder: { standard: [0.12, 0.12, 0.21, 0.26, 0.29], first: [0.42, 0.58], firstShare: 0.09 },
  leisure: { standard: [0.05, 0.11, 0.19, 0.29, 0.36], first: [0.30, 0.70], firstShare: 0.05 },
};

/**
 * Arrival curves over the 15 booking periods (period 15 = closest to
 * departure). Low-fare classes book early, Anytime books late, everything
 * overlaps - "requests for different price classes are thus interspersed over
 * the booking process", as the paper puts it. Each row sums to 1.
 */
export function arrivalCurve(shape) {
  // shape < 0 loads the curve early, > 0 late, 0 flat.
  const w = [];
  for (let p = 1; p <= 15; p++) {
    const t = (p - 0.5) / 15;
    w.push(Math.exp(shape * (t - 0.5) * 4));
  }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}
export const ARRIVAL_SHAPES = {
  AS: 1.6, OP: 0.5, A1: -0.6, A2: -1.2, A3: -1.8,
  AF: 1.4, F1: -0.8,
};

/** Coefficient of variation of class demand around its mean, both years. */
export const DEMAND_CV = 0.35;

/**
 * Per-service persistent forecast bias - the paper's error scenarios, made
 * per departure. This is the number the whole demo turns on:
 *
 * 2025 - forecasts calibrated on ticket data. Each departure's forecast is
 * off by 20-30% (mean 25%, the paper's larger scenario), persistently, and
 * the *direction* correlates with the no-show rate: a departure full of
 * ghosts looked stronger than it was, so its demand was over-forecast, while
 * a departure whose spill the ticket system never recorded was under-forecast.
 *
 * 2026 - forecasts recalibrated on measured occupancy. The error magnitude
 * halves to 8-17% (mean 12.5%, the paper's improved scenario), unbiased in
 * direction.
 */
export function forecastError25(serviceId, noShowRate) {
  const magnitude = 0.2 + (hash32(`mag25|${serviceId}`) / 4294967296) * 0.1; // 20-30%
  const pOver = Math.min(0.85, 0.35 + 2.8 * noShowRate);
  const over = hash32(`sign25|${serviceId}`) / 4294967296 < pOver;
  return over ? magnitude : -magnitude;
}
export function forecastError26(serviceId) {
  const magnitude = 0.08 + (hash32(`mag26|${serviceId}`) / 4294967296) * 0.09; // 8-17%
  const over = hash32(`sign26|${serviceId}`) / 4294967296 < 0.5;
  return over ? magnitude : -magnitude;
}

export const SALES_POLICY = {
  reservation: 'compulsory - every ticket carries a specific seat',
  tickets_per_seat: 1,
  sales_cap_pct_of_seats: 100,
  overselling: 'not permitted',
  basis:
    'A seat reservation is a contractual right to that seat, and denied boarding triggers passenger-rights obligations. European operators therefore sell at most one ticket per seat per departure, unlike airlines, which deliberately overbook and price the denied-boarding risk into their yield model. The seat-allocation model is the airline one; the overbooking is not.',
  consequences: [
    'A departure sold to 100% cannot take another passenger. In 2025 the morning peak did exactly that and refused the rest - revenue that never happened.',
    'A seat sold to someone who does not travel departs empty and the revenue is not recoverable: the seat is still theirs, and overselling to cover it is not an option.',
    'Ticket data knows precisely how many seats are unsold. What it cannot know is how many of the sold seats will actually be sat in - so demand forecasts calibrated on ticket data are calibrated on ghosts.',
    'Those forecasts are what the booking limits are computed from, which is why measuring occupancy is worth money even though the empty seats themselves are not.',
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
  product:
    'Seat-reserved intercity and commuter services operated with Hitachi Azuma trains. Every ticket carries a specific seat; there is no standing-permitted product.',
  seatsense: {
    product: 'Sensative SeatSense',
    deviceModel: 'sensative-seatsense-v2',
    measures:
      'Per-seat occupancy - whether a seat is physically occupied by a person, reported continuously per coach.',
    fleetGoLive: '2026-01-01',
    businessCase:
      'The operator signed off on the rollout against a projected +0.75% of total revenue, from recalibrating the revenue-management demand forecasts on measured occupancy. No overselling, no reselling of no-show seats, no change to the fare ladder.',
    pilot: {
      window: '2025-10-01 .. 2025-12-19',
      scope: '3 Azuma 5-car units on the Anglia Metro (NBR1), 15 coaches instrumented',
      findings: [
        'Departures that had sold every seat and closed sales departed with an average of 10.4% of those seats empty.',
        'Median 47 paid-for seats travelling empty per sold-out peak departure; worst observed 71.',
        'Ticket data overstated the people on board peak departures by 9-12%.',
        'Two departures the ticket system ranked as equally sold out differed by 5 points of actual occupancy - the no-show rate is a property of who buys that particular train.',
        "Re-run against the pilot's occupancy record, the RM system's demand forecasts for the instrumented departures were off by 22-28%. The Weatherford-Belobaba paper prices that error at 1-2% of revenue on constrained departures.",
      ],
    },
  },
};

/**
 * Demand classes: when in the day a departure runs, which demand profile it
 * gets, and its demand factor - mean weekday demand as a share of the seats
 * the departure actually offers, the paper's demand-factor parameter. The
 * paper simulates 0.9-1.3, where revenue management has its greatest impact;
 * peaks here sit in that band, everything else below it.
 */
export const DEMAND_CLASSES = {
  peak_core: {
    label: 'Morning peak core',
    description: 'The 07:00-08:30 arrivals. More people want these than there are seats.',
    mix: 'business',
    demandFactor: 1.06,
    noShowRate: 0.105,
    weekendFactor: 0.34,
  },
  peak_shoulder: {
    label: 'Peak shoulder',
    description: 'The departures either side of the crush.',
    mix: 'shoulder',
    demandFactor: 0.66,
    noShowRate: 0.075,
    weekendFactor: 0.46,
  },
  offpeak: {
    label: 'Off-peak',
    description: 'Midday and late evening leisure travel.',
    mix: 'leisure',
    demandFactor: 0.52,
    noShowRate: 0.042,
    weekendFactor: 0.74,
  },
  evening_peak: {
    label: 'Evening peak',
    description: 'The 16:30-18:00 exodus out of the city. Also demand-constrained.',
    mix: 'business',
    demandFactor: 1.02,
    noShowRate: 0.09,
    weekendFactor: 0.58,
  },
  early_late: {
    label: 'Early / late',
    description: 'First and last departures of the day.',
    mix: 'leisure',
    demandFactor: 0.34,
    noShowRate: 0.035,
    weekendFactor: 0.44,
  },
};

/**
 * Background market growth in 2026, unrelated to SeatSense. It is generated
 * into the data so that the attribution tool has something real to net off:
 * the observed year-on-year change is market growth plus the forecast-quality
 * effect, and only the second part is the business case.
 */
export const MARKET_GROWTH_2026 = 0.018;

/** What the customer's own business case projects, for reference in the docs. */
export const BUSINESS_CASE_TARGET_PCT = 0.75;

/**
 * The fleet: Hitachi Azuma units, seat counts per coach taken from the LNER
 * Azuma coach layout maps (V3). Wheelchair spaces are not counted - SeatSense
 * instruments seats. A 10-coach train is two 5-car units coupled.
 */
export const UNIT_TYPES = {
  AZ5: {
    id: 'AZ5',
    label: 'Azuma 5-car',
    coaches: [
      { letter: 'A', seats_standard: 56, seats_first: 0 },
      { letter: 'B', seats_standard: 72, seats_first: 0 },
      { letter: 'C', seats_standard: 88, seats_first: 0 },
      { letter: 'D', seats_standard: 38, seats_first: 30 },
      { letter: 'E', seats_standard: 0, seats_first: 18 },
    ],
  },
  AZ9: {
    id: 'AZ9',
    label: 'Azuma 9-car',
    coaches: [
      { letter: 'A', seats_standard: 48, seats_first: 0 },
      { letter: 'B', seats_standard: 84, seats_first: 0 },
      { letter: 'C', seats_standard: 84, seats_first: 0 },
      { letter: 'G', seats_standard: 70, seats_first: 0 }, // cafe bar coach
      { letter: 'H', seats_standard: 84, seats_first: 0 },
      { letter: 'J', seats_standard: 84, seats_first: 0 },
      { letter: 'K', seats_standard: 36, seats_first: 30 },
      { letter: 'L', seats_standard: 0, seats_first: 55 },
      { letter: 'M', seats_standard: 0, seats_first: 18 },
    ],
  },
};

export const unitSeatsStandard = (t) => UNIT_TYPES[t].coaches.reduce((a, c) => a + c.seats_standard, 0);
export const unitSeatsFirst = (t) => UNIT_TYPES[t].coaches.reduce((a, c) => a + c.seats_first, 0);
export const unitSeatsTotal = (t) => unitSeatsStandard(t) + unitSeatsFirst(t); // AZ5 302, AZ9 589

/** Formation for a demand class: which unit type, how many coupled. */
export const formationOf = (route, demandClass) => route.formations[demandClass];
export const seatsForCabin = (route, demandClass, cabin) => {
  const f = formationOf(route, demandClass);
  return f.units * (cabin === 'first' ? unitSeatsFirst(f.type) : unitSeatsStandard(f.type));
};
export const seatsFor = (route, demandClass) =>
  seatsForCabin(route, demandClass, 'standard') + seatsForCabin(route, demandClass, 'first');
export const coachesFor = (route, demandClass) => {
  const f = formationOf(route, demandClass);
  return f.units * UNIT_TYPES[f.type].coaches.length;
};
export const formationLabel = (route, demandClass) => {
  const f = formationOf(route, demandClass);
  return `${f.units} x ${UNIT_TYPES[f.type].label}`;
};
/** Ordered coach list for a formation, for per-coach occupancy views. */
export function formationCoaches(route, demandClass) {
  const f = formationOf(route, demandClass);
  const out = [];
  for (let u = 0; u < f.units; u++) {
    for (const c of UNIT_TYPES[f.type].coaches) {
      out.push({ set: u + 1, letter: c.letter, seats_standard: c.seats_standard, seats_first: c.seats_first });
    }
  }
  return out;
}
export const peakFormationSeats = (route) =>
  Math.max(...Object.keys(route.formations).map((c) => seatsFor(route, c)));

export const ROUTES = [
  {
    id: 'NBR1',
    name: 'Anglia Metro',
    origin: 'Colchester',
    destination: 'London Liverpool Street',
    calling: ['Colchester', 'Marks Tey', 'Kelvedon', 'Witham', 'Chelmsford', 'Shenfield', 'London Liverpool Street'],
    profile: 'Seat-reserved outer-suburban commuter, Azuma 5-car fleet',
    fleet: [{ type: 'AZ5', units: 24 }],
    /** Peak trains run two 5-car units coupled (10 coaches, 604 seats). */
    formations: {
      peak_core: { type: 'AZ5', units: 2 },
      peak_shoulder: { type: 'AZ5', units: 2 },
      evening_peak: { type: 'AZ5', units: 2 },
      offpeak: { type: 'AZ5', units: 1 },
      early_late: { type: 'AZ5', units: 1 },
    },
    /** Demand factor per class - mean weekday demand / seats offered. */
    demandFactor: { peak_core: 1.08, peak_shoulder: 0.66, offpeak: 0.55, evening_peak: 1.05, early_late: 0.38 },
    anytimeStandardGbp: 39.8,
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
    profile: 'Seat-reserved long-distance commuter, Azuma 9-car and 5-car fleet',
    fleet: [{ type: 'AZ9', units: 12 }, { type: 'AZ5', units: 8 }],
    /** Nine coaches at the peak, five off-peak - the widest swing on the network. */
    formations: {
      peak_core: { type: 'AZ9', units: 1 },
      peak_shoulder: { type: 'AZ5', units: 1 },
      evening_peak: { type: 'AZ9', units: 1 },
      offpeak: { type: 'AZ5', units: 1 },
      early_late: { type: 'AZ5', units: 1 },
    },
    demandFactor: { peak_core: 1.1, peak_shoulder: 0.78, offpeak: 0.36, evening_peak: 1.06, early_late: 0.27 },
    anytimeStandardGbp: 64.4,
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
    profile: 'Seat-reserved regional, Azuma 5-car fleet',
    fleet: [{ type: 'AZ5', units: 15 }],
    /**
     * The honest counter-example. The morning peak runs a single 5-car unit
     * and is genuinely constrained; the evening peak runs two coupled and
     * never is - so measurement earns almost nothing there.
     */
    formations: {
      peak_core: { type: 'AZ5', units: 1 },
      peak_shoulder: { type: 'AZ5', units: 1 },
      evening_peak: { type: 'AZ5', units: 2 },
      offpeak: { type: 'AZ5', units: 1 },
      early_late: { type: 'AZ5', units: 1 },
    },
    demandFactor: { peak_core: 1.06, peak_shoulder: 0.52, offpeak: 0.48, evening_peak: 0.85, early_late: 0.34 },
    anytimeStandardGbp: 15.4,
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
 * The 2025 blind spot, stated explicitly because it is the whole argument.
 *
 * Note what ticket data *does* know under a one-ticket-per-seat policy: how
 * many seats are unsold, exactly. Availability is not the gap. The gap is that
 * revenue looks identical whether a ticket holder travels or not, so the
 * demand history the RM forecasts are calibrated on counts every no-show as a
 * passenger - and the booking limits inherit the error.
 */
export const TICKET_DATA = {
  what_2025_had: [
    'Tickets sold and unsold per departure and booking class, exactly - one ticket per seat leaves no ambiguity about availability.',
    'Revenue per departure, which is the same whether the ticket holder travels or not.',
    'Whether sales were closed on a departure, and how much demand arrived afterwards.',
    'Gateline entries and exits at staffed stations - a station total, not a seat.',
    'Manual load surveys: a counter with a clicker on a handful of days a year.',
  ],
  what_2025_could_not_have: [
    'How many of the sold seats were actually sat in - a no-show is invisible to ticket data.',
    'Therefore the cabin factor of any departure, on any day.',
    'Therefore demand forecasts free of ghost passengers: the RM system was calibrated on sales, and sales count people who never travel.',
    'Therefore booking limits computed from the true demand - the input the Weatherford-Belobaba paper shows matters most.',
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
    'Underlying market growth is the counterfactual: what revenue would have done in 2026 without SeatSense-recalibrated forecasts. It is generated into the 2026 demand at this rate, so netting it off isolates the forecast-quality effect. Change the parameter to test how sensitive the attribution is.',
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

/** Seeded Poisson (Knuth). Means here stay well under 1e3, where this is fine. */
export function poisson(mean, rand) {
  if (mean <= 0) return 0;
  if (mean > 60) {
    // Normal approximation keeps the generator fast on the biggest classes.
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(mean + z * Math.sqrt(mean)));
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > limit);
  return k - 1;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation). EMSRb's
 * protection level is mu + sigma * PHI^-1(1 - F_low / F_bar).
 */
export function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * EMSRb nested booking limits, exactly as the paper describes: for each lower
 * class, aggregate all higher classes into one combined demand (mean summed,
 * variance summed) with a demand-weighted average fare, take the protection
 * level where the expected marginal seat revenue falls to the lower fare, and
 * nest the limits.
 *
 * classes: [{ fare, mean, sd }], sorted by fare descending.
 * Returns booking limits per class; limits[0] === capacity.
 */
export function emsrbLimits(classes, capacity) {
  const n = classes.length;
  const limits = new Array(n).fill(capacity);
  let muSum = 0;
  let varSum = 0;
  let revSum = 0;
  for (let k = 0; k < n - 1; k++) {
    muSum += classes[k].mean;
    varSum += classes[k].sd * classes[k].sd;
    revSum += classes[k].fare * classes[k].mean;
    const fareBar = muSum > 0 ? revSum / muSum : classes[k].fare;
    const ratio = classes[k + 1].fare / fareBar;
    let protection;
    if (ratio >= 1) protection = 0;
    else if (ratio <= 0) protection = capacity;
    else protection = muSum + Math.sqrt(varSum) * normInv(1 - ratio);
    protection = Math.max(0, Math.min(capacity, Math.round(protection)));
    limits[k + 1] = Math.max(0, capacity - protection);
  }
  // Nesting invariant: a lower class can never have a higher limit.
  for (let k = 1; k < n; k++) limits[k] = Math.min(limits[k], limits[k - 1]);
  return limits;
}

/**
 * The no-show rate of an individual departure, not just its class.
 *
 * Two departures can be equally sold out and still differ by ten points of
 * actual occupancy, because their passengers differ. The variation is
 * persistent per departure - it is a property of who buys that train - and
 * completely invisible to ticket data, which books the same revenue either
 * way. In this model it matters twice: it is what SeatSense measures, and it
 * is what poisoned the 2025 demand forecasts.
 */
export function noShowRateFor(serviceId, demandClass) {
  const spread = 1 + (hash32(`noshow|${serviceId}`) / 4294967296 - 0.5) * 0.8; // +/-40%
  return DEMAND_CLASSES[demandClass].noShowRate * spread;
}

/** Fares for one route's ladder, per cabin. Identical in both years. */
export function faresFor(route) {
  return {
    standard: BOOKING_CLASSES.standard.map((c) => ({
      ...c, fare_gbp: round2(route.anytimeStandardGbp * c.fareIndex),
    })),
    first: BOOKING_CLASSES.first.map((c) => ({
      ...c, fare_gbp: round2(route.anytimeStandardGbp * c.fareIndex),
    })),
  };
}

/** Flattened timetable: one row per daily departure. */
export function buildServices() {
  const out = [];
  for (const route of ROUTES) {
    for (const [time, direction, demandClass] of route.services) {
      const serviceId = `${route.id}-${time}`;
      const cls = DEMAND_CLASSES[demandClass];
      const fares = faresFor(route);
      const noShow = noShowRateFor(serviceId, demandClass);
      const bias25 = 1 + forecastError25(serviceId, noShow);
      const bias26 = 1 + forecastError26(serviceId);
      out.push({
        service_id: serviceId,
        route_id: route.id,
        route_name: route.name,
        departure_time: `${time.slice(0, 2)}:${time.slice(2)}`,
        direction,
        origin: direction === 'up' ? route.origin : route.destination,
        destination: direction === 'up' ? route.destination : route.origin,
        demand_class: demandClass,
        formation: formationLabel(route, demandClass),
        unit_type: formationOf(route, demandClass).type,
        formation_units: formationOf(route, demandClass).units,
        coaches: coachesFor(route, demandClass),
        seats: seatsFor(route, demandClass),
        seats_standard: seatsForCabin(route, demandClass, 'standard'),
        seats_first: seatsForCabin(route, demandClass, 'first'),
        coach_seats: formationCoaches(route, demandClass),
        demand_factor: round2(route.demandFactor[demandClass]),
        demand_profile: cls.mix,
        booking_classes: {
          standard: fares.standard.map((c) => ({ id: c.id, label: c.label, fare_gbp: c.fare_gbp })),
          first: fares.first.map((c) => ({ id: c.id, label: c.label, fare_gbp: c.fare_gbp })),
        },
        fares_unchanged_note: 'The fare ladder is identical in 2025 and 2026. What changed is the demand forecast behind the booking limits.',
        rm_method: `EMSRb, booking limits re-solved at each of ${RM_POLICY.bookingPeriods} booking checkpoints`,
        forecast_error_2025_pct: round1((bias25 - 1) * 100),
        forecast_error_2026_pct: round1((bias26 - 1) * 100),
        no_show_rate_pct: round1(noShow * 100),
        no_show_rate_known_from: COVERAGE.seatsenseGoLive,
        sales_cap_pct_of_seats: SALES_POLICY.sales_cap_pct_of_seats,
      });
    }
  }
  return out;
}

export const round1 = (n) => Math.round(n * 10) / 10;
export const round2 = (n) => Math.round(n * 100) / 100;
