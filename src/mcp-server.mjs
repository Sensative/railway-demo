#!/usr/bin/env node
/**
 * The Yggio tenant - an MCP server over stdio.
 *
 * This is what Claude connects to. It emulates the Yggio DiMS tenant of
 * a British train operator: SeatSense IoT nodes plus the commercial data
 * needed to answer "what did measuring actual seat occupancy earn us?".
 *
 * Deliberately zero-dependency: the MCP stdio transport is newline-delimited
 * JSON-RPC 2.0, which is short enough to implement directly. Nothing to
 * npm install means nothing to fail on the stand.
 */
import * as db from './dataset.mjs';

const SERVER = { name: 'yggio-seatsense', version: '1.0.0' };
const PROTOCOL_FALLBACK = '2024-11-05';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const TOOLS = [
  {
    name: 'yggio_overview',
    description:
      "Start here. What this Yggio tenant contains: the operator, its sales policy (one ticket per seat, no overselling), the SeatSense device estate, which periods have measured seat occupancy, and the headline numbers including how much revenue is attributable to SeatSense. Answers 'what data do you have?'.",
    inputSchema: { type: 'object', properties: {} },
    handler: () => db.overview(),
  },
  {
    name: 'compare_years',
    description:
      'The main analysis tool. Compares 2025 (ticket sales only, no sensors) with 2026 (SeatSense live from 1 January) over the same calendar window. Every 2026 group also carries the revenue attributable to the SeatSense-recalibrated demand forecasts, measured against a per-departure counterfactual (same demand, same fares, 2025-quality forecasts), so the SeatSense effect is separated from background market growth. Use group_by to break it down by month, route, demand_class or service.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['total', 'month', 'route', 'service', 'demand_class', 'day_type'], description: "Level of detail. Default 'total'." },
        route_id: str('Optional filter: NBR1, NBR2 or NBR3.'),
        demand_class: { type: 'string', enum: ['peak_core', 'peak_shoulder', 'offpeak', 'evening_peak', 'early_late'], description: 'Optional filter.' },
        service_id: str('Optional filter, e.g. NBR1-0741.'),
        day_type: { type: 'string', enum: ['weekday', 'saturday', 'sunday', 'bank_holiday'], description: 'Optional filter.' },
        from_month: int('Optional first calendar month, 1-12. Defaults to the like-for-like window.'),
        to_month: int('Optional last calendar month, 1-12.'),
      },
    },
    handler: (a) => db.compareYears(a),
  },
  {
    name: 'ticket_data_blind_spot',
    description:
      "Why 2025's numbers are not just lower but wrong. An operator without seat sensors reports tickets/seats as its load factor, which counts every no-show as a passenger on board - so it cannot know its cabin factor at all. This tool shows what the operator reported in 2025 and decided on that basis, the four manual load surveys that hinted at the gap, the gap SeatSense measures directly in 2026, and an explicitly-flagged inference of what 2025 actually looked like. Use it whenever someone says operators already have ticket data.",
    inputSchema: {
      type: 'object',
      properties: {
        demand_class: { type: 'string', enum: ['peak_core', 'peak_shoulder', 'offpeak', 'evening_peak', 'early_late'], description: "Which departures to examine. Default 'peak_core' - where the blind spot cost the most." },
        month: int('Calendar month 1-12 for the measured 2026 comparison. Defaults to the latest month with data.'),
      },
    },
    handler: (a) => db.ticketDataBlindSpot(a),
  },
  {
    name: 'fullness_ranking',
    description:
      "The proof that ticket data mis-ranks departures. Ranks departures by tickets sold and then by measured cabin factor, and shows which ones change place. Departures the ticket system calls equally sold out differ by several points of actual occupancy, because their no-show rates differ - and pricing decisions are made on the ranking. Use this to explain why measuring occupancy is worth money when the empty seats themselves cannot be resold.",
    inputSchema: {
      type: 'object',
      properties: {
        demand_class: { type: 'string', enum: ['peak_core', 'peak_shoulder', 'offpeak', 'evening_peak', 'early_late'], description: "Default 'peak_core'." },
        route_id: str('Optional filter.'),
        month: int('Calendar month 1-12. Defaults to the latest month with data.'),
      },
    },
    handler: (a) => db.fullnessRanking(a),
  },
  {
    name: 'morning_peak_report',
    description:
      'The morning peak before and after, departure by departure: realised average fares (mix on an unchanged ladder), ticket-derived load factor, measured cabin factor, ghost seats and walk-ups refused. The crush departures cannot be oversold, so what moves is who is on board.',
    inputSchema: {
      type: 'object',
      properties: {
        route_id: str('Optional: NBR1, NBR2 or NBR3. Omit for the whole network.'),
        month: int('Calendar month 1-12 to compare in both years. Defaults to the latest month with data.'),
      },
    },
    handler: (a) => db.morningPeakReport(a),
  },
  {
    name: 'seatsense_snapshot',
    description:
      "What SeatSense actually sees on one train on one day: tickets sold versus seats physically occupied, per coach, plus the passengers turned away when sales closed and the ghost seats (paid for, travelled empty) that could not be resold. 2026 only - nothing measured seats in 2025. Use this when someone asks about a specific departure or date.",
    inputSchema: {
      type: 'object',
      properties: {
        service_id: str('Required, e.g. NBR1-0741. Use list_services to find ids.'),
        date: str('Required, ISO date between 2026-01-01 and the end of the data, e.g. 2026-06-16.'),
      },
      required: ['service_id', 'date'],
    },
    handler: (a) => db.seatsenseSnapshot(a),
  },
  {
    name: 'seatsense_attribution',
    description:
      'For the commercial question "how much of the revenue growth is really SeatSense?". Splits the observed change into market growth and the forecast-quality effect using a per-departure counterfactual rather than a flat growth assumption, shows where the gain lands (departures ticket data over-forecast versus under-forecast in 2025), decomposes it into class mix and volume, and states plainly what it does NOT claim - no fare rise (the ladder is identical in both years), no revenue from overselling, none from reselling no-show seats.',
    inputSchema: {
      type: 'object',
      properties: {
        assumed_market_growth_pct: { type: 'number', description: 'Counterfactual market growth without SeatSense. Defaults to 1.8. Change it to test the attribution.' },
      },
    },
    handler: (a) => db.seatsenseAttribution(a),
  },
  {
    name: 'pricing_actions',
    description:
      "The revenue-management setup: EMSRb seat allocation over five nested booking classes (Weatherford & Belobaba, JORS 2002), the fare ladder per route (identical in both years), and what changed on 1 January 2026 - the demand forecasts behind the booking limits, recalibrated on measured occupancy from ~25% to ~12.5% error. Per demand class and per departure, with the realised class mix and the revenue attributable. Also lists what was not available: overselling and reselling no-show seats.",
    inputSchema: {
      type: 'object',
      properties: { route_id: str('Optional filter.'), demand_class: str('Optional filter.') },
    },
    handler: (a) => db.pricingActions(a),
  },
  {
    name: 'capacity_pressure',
    description:
      "Capacity pressure counted from the data: sold-out departures, walk-up passengers refused at full trains, cabin factor, and what measurement changes for a capacity-planning case. Also carries the 2026 month-by-month series showing that the forecast-quality effect appears only in the months when demand met the seats. Deliberately claims no service-quality improvement.",
    inputSchema: { type: 'object', properties: { month: int('Calendar month 1-12. Defaults to the latest month with data.') } },
    handler: (a) => db.capacityPressure(a),
  },
  {
    name: 'repricing_candidates',
    description:
      "Forward-looking: which departures still need attention, ranked, with the measured numbers and the rule behind each. Separates the genuinely full departures where only more seats will help from those whose forecasts still carry a residual error worth money, and the quiet ones whose booking limits ration nothing. Answers 'what should we do next?'.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: int('How many candidates to return. Default 8.'),
        days: int('Optional: look back this many days instead of the whole year to date.'),
        month: int('Optional: analyse a single calendar month of 2026 instead.'),
      },
    },
    handler: (a) => db.repricingCandidates(a),
  },
  {
    name: 'list_services',
    description: 'The timetable: every daily departure with its route, demand class, Azuma formation and seat count (Standard + First), booking-class fare ladder (identical in both years), no-show rate and per-departure forecast errors. Use it to find a service_id.',
    inputSchema: {
      type: 'object',
      properties: {
        route_id: str('Optional: NBR1, NBR2 or NBR3.'),
        demand_class: str('Optional filter.'),
        direction: { type: 'string', enum: ['up', 'down'], description: "Optional: 'up' towards the city, 'down' outbound." },
      },
    },
    handler: (a) => db.listServices(a),
  },
  {
    name: 'service_history',
    description: 'Day-by-day rows for one departure in both years - tickets sold, revenue and, for 2026, the SeatSense measurements. Use it to look at trends or specific dates for a single train.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: str('Required, e.g. NBR2-0748.'),
        from_date: str('Optional ISO date.'),
        to_date: str('Optional ISO date.'),
        limit: int('Rows per year, most recent first in the window. Default 60.'),
      },
      required: ['service_id'],
    },
    handler: (a) => db.serviceHistory(a),
  },
  {
    name: 'seat_map',
    description: 'The seat inventory: which numbered seats a coach actually has, where they sit and which cabin they are in. Call with nothing for the fleet totals, with unit_type or service_id for a formation, and with coach for the seats themselves. This is what the fleet is built from, not what SeatSense measured - occupancy is reported per coach.',
    inputSchema: {
      type: 'object',
      properties: {
        unit_type: str("Optional: 'AZ5' or 'AZ9'."),
        service_id: str('Optional: a departure, e.g. NBR2-0748 - uses whatever unit type works it.'),
        coach: str("Optional coach letter, e.g. 'C'. Returns every numbered seat in it."),
      },
    },
    handler: (a) => db.seatMap(a),
  },
  {
    name: 'yggio_list_iotnodes',
    description: 'The raw Yggio device view: SeatSense IoT nodes, one per instrumented coach, with their context map, install date and status. Use it for questions about the sensor estate rather than the commercial data.',
    inputSchema: {
      type: 'object',
      properties: {
        route_id: str('Optional filter.'),
        unit_id: str('Optional filter, e.g. NBR1-U003.'),
        status: { type: 'string', enum: ['online', 'offline'], description: 'Optional filter.' },
        limit: int('Default 25.'),
        offset: int('Default 0.'),
      },
    },
    handler: (a) => db.listDevices(a),
  },
  {
    name: 'yggio_iotnode_readings',
    description: 'Latest values and the same-day occupancy series for one SeatSense node - seat occupancy per departure for that coach, plus battery and signal strength.',
    inputSchema: {
      type: 'object',
      properties: {
        device_id: str('Required, e.g. iot-nbr1-u003-b.'),
        date: str('Optional ISO date in 2026. Defaults to the latest weekday in the data.'),
      },
      required: ['device_id'],
    },
    handler: (a) => db.deviceReadings(a),
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const result = (id, res) => send({ jsonrpc: '2.0', id, result: res });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(msg) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return result(id, {
        protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked || '') ? asked : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          'Yggio tenant for Northbank Rail, a fictional British train operator running Azuma trains and selling reserved seats: one ticket per seat, no overselling. Seats are allocated by an EMSRb revenue-management system (Weatherford & Belobaba, JORS 2002); the fare ladder is identical in both years, and what SeatSense changed on 2026-01-01 is the accuracy of the demand forecasts behind the booking limits (~25% error on ticket data, ~12.5% on measured occupancy). 2025 has ticket sales only, which cannot see a no-show, so 2025 has no cabin factor at all. Call yggio_overview first. All money is GBP. Year-on-year figures are like-for-like over the same calendar window. When asked what SeatSense is worth, quote the attributable figure (measured against a per-departure counterfactual), not the observed year-on-year change, which includes market growth.',
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'resources/list':
      return result(id, { resources: [] });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });
    case 'tools/call': {
      const tool = BY_NAME[params.name];
      if (!tool) return fail(id, -32602, `Unknown tool "${params.name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`);
      try {
        const payload = tool.handler(params.arguments || {});
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          isError: Boolean(payload && payload.error),
        });
      } catch (err) {
        return result(id, {
          content: [{ type: 'text', text: `Tool "${params.name}" failed: ${err.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    for (const one of Array.isArray(msg) ? msg : [msg]) handle(one);
  }
});
process.stdin.on('end', () => process.exit(0));
