#!/usr/bin/env node
/**
 * Pre-flight check: drives the fake Yggio MCP server over stdio exactly the
 * way Claude Code does, calls every tool, and prints one line per tool.
 *
 *   node src/selftest.mjs
 *
 * Run this before the demo. If every line says OK, the demo works offline.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let nextId = 1, buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  }
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const CALLS = [
  ['yggio_overview', {}],
  ['compare_years', { group_by: 'total' }],
  ['compare_years', { group_by: 'month' }],
  ['compare_years', { group_by: 'demand_class' }],
  ['compare_years', { group_by: 'route' }],
  ['compare_years', { group_by: 'service', route_id: 'NBR1' }],
  ['ticket_data_blind_spot', {}],
  ['fullness_ranking', {}],
  ['fullness_ranking', { demand_class: 'evening_peak', month: 6 }],
  ['ticket_data_blind_spot', { demand_class: 'evening_peak' }],
  ['morning_peak_report', { route_id: 'NBR1' }],
  ['morning_peak_report', {}],
  ['seatsense_snapshot', { service_id: 'NBR1-0741', date: '2026-06-16' }],
  ['seatsense_snapshot', { service_id: 'NBR1-0741', date: '2025-06-16' }], // must fail politely
  ['seatsense_attribution', {}],
  ['seatsense_attribution', { assumed_market_growth_pct: 3.5 }],
  ['pricing_actions', {}],
  ['capacity_pressure', {}],
  ['repricing_candidates', {}],
  ['repricing_candidates', { month: 6 }],
  ['list_services', { route_id: 'NBR3' }],
  ['service_history', { service_id: 'NBR2-0748', limit: 5 }],
  ['yggio_list_iotnodes', { route_id: 'NBR1', limit: 3 }],
  ['yggio_iotnode_readings', { device_id: 'iot-nbr1-u003-b' }],
  ['nonexistent_tool', {}], // must return a JSON-RPC error, not crash
];

/** Calls that are supposed to come back as a handled error. */
const EXPECT_ERROR = new Set(['seatsense_snapshot|2025-06-16', 'nonexistent_tool|']);

let failures = 0;
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1.0.0' } });
console.log(`initialize      OK  protocol ${init.result.protocolVersion}, server ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await rpc('tools/list', {});
console.log(`tools/list      OK  ${list.result.tools.length} tools`);
for (const t of list.result.tools) {
  if (!t.description || !t.inputSchema) { console.log(`  MISSING SCHEMA  ${t.name}`); failures++; }
}

for (const [name, args] of CALLS) {
  const res = await rpc('tools/call', { name, arguments: args });
  const key = `${name}|${args.date ?? ''}`;
  const expectError = EXPECT_ERROR.has(key);
  const label = `${name}(${JSON.stringify(args)})`.slice(0, 52).padEnd(54);

  if (res.error) {
    const ok = expectError;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} rpc error: ${res.error.message.slice(0, 60)}`);
    if (!ok) failures++;
    continue;
  }
  const text = res.result.content[0].text;
  let payload;
  try { payload = JSON.parse(text); } catch { console.log(`FAIL ${label} non-JSON payload`); failures++; continue; }

  const isError = Boolean(payload.error);
  if (isError !== expectError) {
    console.log(`FAIL ${label} ${isError ? `unexpected error: ${payload.error}` : 'expected an error but got data'}`);
    failures++;
    continue;
  }
  const summary = isError ? payload.error : (payload.narrative || Object.keys(payload).join(','));
  console.log(`OK   ${label} ${String(summary).slice(0, 96)}`);
}

child.stdin.end();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed - the demo is ready.');
process.exit(failures ? 1 : 0);
