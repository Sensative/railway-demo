#!/usr/bin/env node
/**
 * Fake Yggio - the REST view of the same data.
 *
 * Optional for the demo, but useful on the stand: it lets you show the "raw"
 * platform behind Claude in a browser or with curl, so the audience sees that
 * Claude is reading a data platform and not making things up.
 *
 *   node src/yggio-api.mjs            # http://localhost:8787
 *   PORT=9000 node src/yggio-api.mjs
 */
import { createServer } from 'node:http';
import * as db from './dataset.mjs';

const PORT = Number(process.env.PORT || 8787);
const num = (v) => (v == null || v === '' ? undefined : Number(v));

/** Yggio proper is token-authenticated; here any token is accepted. */
const ROUTES = [
  ['/healthz', () => ({ status: 'ok', service: 'fake-yggio', time: new Date().toISOString() })],
  ['/api/iotnodes', (q) => db.listDevices({ route_id: q.route_id, unit_id: q.unit_id, status: q.status, limit: num(q.limit) ?? 25, offset: num(q.offset) ?? 0 })],
  ['/api/demo/overview', () => db.overview()],
  ['/api/demo/services', (q) => db.listServices({ route_id: q.route_id, demand_class: q.demand_class, direction: q.direction })],
  ['/api/demo/compare', (q) => db.compareYears({ group_by: q.group_by, route_id: q.route_id, demand_class: q.demand_class, service_id: q.service_id, day_type: q.day_type, from_month: num(q.from_month), to_month: num(q.to_month) })],
  ['/api/demo/fullness-ranking', (q) => db.fullnessRanking({ demand_class: q.demand_class, route_id: q.route_id, month: num(q.month) })],
  ['/api/demo/blind-spot', (q) => db.ticketDataBlindSpot({ demand_class: q.demand_class, month: num(q.month) })],
  ['/api/demo/morning-peak', (q) => db.morningPeakReport({ route_id: q.route_id, month: num(q.month) })],
  ['/api/demo/snapshot', (q) => db.seatsenseSnapshot({ service_id: q.service_id, date: q.date })],
  ['/api/demo/attribution', (q) => db.seatsenseAttribution({ assumed_market_growth_pct: num(q.assumed_market_growth_pct) })],
  ['/api/demo/pricing', (q) => db.pricingActions({ route_id: q.route_id, demand_class: q.demand_class })],
  ['/api/demo/capacity-pressure', (q) => db.capacityPressure({ month: num(q.month) })],
  ['/api/demo/repricing', (q) => db.repricingCandidates({ limit: num(q.limit), days: num(q.days), month: num(q.month) })],
  ['/api/demo/service-history', (q) => db.serviceHistory({ service_id: q.service_id, from_date: q.from_date, to_date: q.to_date, limit: num(q.limit) })],
];

const INDEX = {
  service: 'fake-yggio',
  note: 'Stand-in for a Yggio DiMS tenant, serving synthetic SeatSense data for a fictional British train operator. Authentication is stubbed - any or no bearer token is accepted.',
  endpoints: [
    'GET /healthz',
    'GET /api/iotnodes?route_id=&unit_id=&status=&limit=&offset=',
    'GET /api/iotnodes/{id}',
    'GET /api/iotnodes/{id}/latest?date=',
    'GET /api/demo/overview',
    'GET /api/demo/services?route_id=&demand_class=&direction=',
    'GET /api/demo/compare?group_by=total|month|route|service|demand_class|day_type',
    'GET /api/demo/blind-spot?demand_class=peak_core&month=',
    'GET /api/demo/fullness-ranking?demand_class=peak_core&month=',
    'GET /api/demo/morning-peak?route_id=&month=',
    'GET /api/demo/snapshot?service_id=NBR1-0741&date=2026-06-16',
    'GET /api/demo/attribution?assumed_market_growth_pct=1.8',
    'GET /api/demo/pricing',
    'GET /api/demo/capacity-pressure?month=',
    'GET /api/demo/repricing?limit=&days=&month=',
    'GET /api/demo/service-history?service_id=NBR2-0748&limit=10',
  ],
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(url.searchParams);
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body, null, 2) + '\n');
  };

  try {
    if (path === '/') return json(200, INDEX);

    // /api/iotnodes/{id} and /api/iotnodes/{id}/latest
    const node = path.match(/^\/api\/iotnodes\/([^/]+)(\/latest)?$/);
    if (node) {
      const payload = db.deviceReadings({ device_id: decodeURIComponent(node[1]), date: q.date });
      if (payload.error) return json(404, payload);
      return json(200, node[2] ? { ...payload.iotnode, latestValues: payload.latestValues, occupancy_series: payload.occupancy_series } : payload);
    }

    const route = ROUTES.find(([p]) => p === path);
    if (!route) return json(404, { error: `No such endpoint: ${path}`, see: INDEX.endpoints });
    const payload = route[1](q);
    return json(payload && payload.error ? 400 : 200, payload);
  } catch (err) {
    return json(500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`fake-yggio listening on http://localhost:${PORT}`);
  console.log('try: curl -s localhost:' + PORT + '/api/demo/overview | jq .headline');
});
