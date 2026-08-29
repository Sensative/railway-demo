# InnoTrans demo: SeatSense, Yggio, and Claude

A self-contained trade-show demo. A visitor talks to Claude in plain English;
Claude reads a **Yggio tenant** over MCP and answers with real numbers
from generated JSON files. The story it tells is what **SeatSense** - knowing
whether a seat is *physically occupied* - is worth to a European train operator
that **may not oversell**.

Everything is in this one directory. No network, no database, no npm install,
no API keys. Node 20+ is the only requirement.

---

## Getting started

Two ways to run it: **in the browser** (zero install, everything runs in a
cloud container) or **locally in the terminal** (offline-safe on the show
floor).

### Option A - Claude Code on the web (claude.ai/code)

The session gets its own cloud container that clones the repo. `.mcp.json` at
the repo root is picked up automatically and the yggio server starts without
any dialog - Node is pre-installed. The only on-site requirement is network
access to claude.ai.

1. **Connect GitHub.** The first time you open
   [claude.ai/code](https://claude.ai/code) you get *"Sign in with GitHub"* -
   sign in with a GitHub account that can see this repository (it is
   private). Can also be done later under **Settings → Connectors → GitHub**
   on claude.ai.
2. **Start a session on the repo.** Click the repository selector below the
   input box and pick **Sensative/railway-demo**, branch `main` (the
   default). Also works in the Claude mobile apps (iOS/Android) via the Code
   tab.
3. **Verify.** Send *"Run node src/selftest.mjs"* as the first message - it
   must end with `All checks passed - the demo is ready`. Then ask
   *"What data do you have?"* and approve if Claude asks to use a yggio tool.

Show-floor warning: this path lives and dies with the venue's connectivity.
If the wifi wobbles, Option B is fully offline (apart from Claude itself).

### Option B - locally in the terminal (Claude Code CLI)

Requires Node 20+ and Claude Code - if you don't have it:
`curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux; alternatively
`npm install -g @anthropic-ai/claude-code`), then run `claude` once and log
in.

```bash
git clone https://github.com/Sensative/railway-demo.git
cd railway-demo
node src/selftest.mjs        # pre-flight check - calls all 14 tools, prints OK per tool
claude                       # Claude Code picks up ./.mcp.json and connects to Yggio
```

Answer **yes** when Claude Code asks whether you trust the folder and whether
the `yggio` MCP server from the project's `.mcp.json` may be used. Check with
`/mcp` that yggio is connected with 14 tools, then ask
*"What data do you have?"* - the answer should be Northbank Rail figures from
the dataset, not general knowledge.

Optional, for showing the platform behind Claude on a second screen:

```bash
node src/yggio-api.mjs      # http://localhost:8787
curl -s localhost:8787/api/demo/capacity-pressure | jq .narrative
curl -s "localhost:8787/api/demo/fullness-ranking?month=6" | jq .narrative
```

### Troubleshooting

| Problem | Fix |
|---|---|
| Web: the repo doesn't appear in the selector | Wrong or no GitHub account connected - **Settings → Connectors**. On Team/Enterprise plans an owner may first need to enable the GitHub connector in the admin settings. |
| Web: no yggio answers | Ask Claude to *"list your yggio tools"*. If they are missing, start a fresh session on the repo; failing that, use Option B. |
| CLI: Claude sees no yggio tools | Wrong directory, or the server was declined at the first prompt. Go to the repo root, run `claude mcp reset-project-choices` and start `claude` again. |
| CLI: the self-test fails | Almost always the Node version - it needs 20+. `node --version`. |

Then work through `DEMO-SCRIPT.md` - the running order, the traps and the
recoveries. `CLAUDE.md` is read by Claude automatically, on the web and in
the CLI alike.

---

## The argument

**Northbank Rail** is a fictional British operator selling reserved seats:
three routes, 58 daily departures, ~4.9 million journeys and ~£118m of ticket
revenue a year, an all-Azuma fleet with **343 instrumented coaches**.

### The fleet: Azumas, off the real seat maps

Seat counts per coach are taken from the LNER Azuma coach layouts (V3):
a **5-car** unit seats **302** (A 56 + B 72 + C 88 + D 38+30F + E 18F,
48 First + 254 Standard) and a **9-car** seats **593** (A 48 + B 84 + C 84 +
G 70 + H 84 + J 84 + K 36+30F + L 55F + M 18F, 103 First + 490 Standard).
Two 5-cars couple into a 10-coach train of 604.

| Route | Fleet | Peak core | Peak shoulder | Off-peak | Evening peak |
| --- | --- | --- | --- | --- | --- |
| NBR1 Anglia Metro | 24 x 5-car | 2 x 5-car, **604** | 2 x 5-car, 604 | 1 x 5-car, 302 | 2 x 5-car, 604 |
| NBR2 Great Northern | 12 x 9-car + 8 x 5-car | 1 x 9-car, **593** | 1 x 5-car, 302 | 1 x 5-car, 302 | 1 x 9-car, 593 |
| NBR3 Pennine Shuttle | 15 x 5-car | 1 x 5-car, **302** | 1 x 5-car, 302 | 1 x 5-car, 302 | 2 x 5-car, **604** |

Right-sizing is why "how full is it" only means anything alongside the
formation: NBR2 runs 9 coaches at 07:48 and 5 at 12:18. First and Standard
are separate seat pools; the walk-up story is told on Standard.

### The model: EMSRb, straight from the literature

**One ticket per seat. No overselling.** A reservation is a contractual right
to that specific seat, so the deliberate overbooking an airline prices into
its yield model is not available. The *seat-allocation* model, however, is
the airline one:

> LR Weatherford and PP Belobaba, "Revenue impacts of fare input and demand
> forecast accuracy in airline yield management", *Journal of the Operational
> Research Society* 53 (2002) 1-11.

Exactly as in the paper: **five nested booking classes** per departure (the
paper's fare ratios - on NBR2: Anytime £64.40, Off-Peak £40.57, Advance
£28.34 / £21.90 / £15.46, with a two-class First ladder on top), bookings
arriving over **15 booking periods** (Poisson within each, low fares first
but interspersed), and **EMSRb protection levels re-solved at every
checkpoint** from remaining capacity and the forecast demand still to come.
No cancellations, no buy-up, a refused request is lost.

The paper's conclusion is the demo's premise: **the demand forecast is the
input that matters most** - more than the fare inputs, far more than fare
dispersion within a class - and cutting the forecast error in half is worth
over 1% of revenue where demand meets capacity.

### The problem: the 2025 forecasts were calibrated on ghosts

Ticket data books revenue whether the passenger travels or not. So the
demand history behind the RM forecasts counted every no-show as a passenger,
and never saw the walk-ups refused at the door. The result, per departure and
persistent: **~25% mean forecast error**, over-forecast where no-shows ran
high (ghosts counted as demand), under-forecast where refused demand went
unrecorded.

EMSRb inherited both errors. In 2025, on weekday peak-core departures, the
operator reported an **89.5%** load factor, sold out **34.6%** of departures,
and refused **82.5 walk-up passengers a weekday** - while other peak trains
departed with wrongly protected seats *empty and unsold*.

### What changed on 1 January 2026: the forecast, nothing else

SeatSense measures actual occupancy per seat, so the forecasts were
recalibrated per departure: **~25% error down to ~12.5%** - the paper's own
scenario pair. **The fare ladder did not move: every class fare is identical
in both years.**

> **It must always be possible to travel on the departure you want. It may
> cost more.**

The policy is kept by protection, not price: EMSRb holds seats for the top
of the ladder, so the walk-up finds an Anytime seat even when the Advance
quotas closed weeks earlier.

Like-for-like, 1 January - 31 August, weekdays, peak core:

| | 2025 | 2026 |
| --- | --- | --- |
| Sold | 89.1% | 90.3% |
| Cabin factor | *unknown* | **82.1%** |
| Sold out | 32.9% of departures | 31.6% |
| **Walk-ups refused per weekday** | **75.9** | **50.0 (-34%)** |
| Average fare (unchanged ladder) | £30.36 | £31.01 - that is mix, not tariff |

And the honest wrinkle, worth saying before someone finds it: the evening
peak **sells out more often in 2026** (21.1% -> 30.9%), because seats the old
over-forecasts wrongly protected used to depart empty and unsold - now they
carry passengers. Under EMSRb a sell-out is not by itself a failure; the
failure metric is the walk-up refused, and that is what fell where it
mattered.

### The result nobody expects

| | |
| --- | --- |
| Observed revenue change | +2.4% (£1.87m) |
| of which market growth | £1,227,706 |
| **attributable to SeatSense** | **£639,737 = 0.816% of total revenue** |
| Business case | 0.75% |
| Annualised | **£969,183** |

Now decompose it against the counterfactual (same demand, same fares,
2025-quality forecasts):

| | |
| --- | --- |
| Volume - tickets that could not be sold before | **+£658,553** |
| Class mix | -£23,977 |

**This is not a fare rise - and it is not a mix trick either. It is volume.**
The seats the old forecasts wrongly protected used to fly empty *and unsold*;
they now carry paying passengers. Split by which error each departure carried
in 2025: **£467,820** from the 24 departures ticket data under-forecast
(protection restored, full-fare walk-ups kept) and **£171,917** from the 34
it over-forecast (freed seats sold down the ladder).
`where_the_gain_lands` in `seatsense_attribution` carries the proof.

### Why it needs SeatSense

Because the forecast error *is* the ticket-data blind spot, per departure.
June 2026 weekdays, peak core - ranked by tickets sold, then by bodies on
board (7 of 8 change rank):

| Departure | Sold | **Actually full** | No-show | Rank by sales → by fullness |
| --- | --- | --- | --- | --- |
| NBR1-0811 | 94.0% | **87.4%** | 7.3% | 2 → 1 |
| NBR2-0748 | 93.2% | 86.5% | 7.3% | 3 → 2 |
| **NBR1-0741** | **97.0%** | 85.8% | **12.0%** | **1 → 3** |
| NBR1-0711 | 89.9% | 83.7% | 7.2% | 5 → 4 |
| NBR3-0722 | 91.3% | 82.6% | 9.5% | 4 → 5 |
| NBR3-0752 | 89.5% | 80.3% | 10.1% | 6 → 6 |
| NBR2-0818 | 86.7% | 79.5% | 8.3% | 8 → 7 |
| NBR2-0718 | 88.7% | 78.5% | 11.6% | 7 → 8 |

The train the ticket system calls fullest (the 07:41, 97% sold) is third by
bodies on board. Feed rankings like that into a forecast and you get 2025:

- **NBR1-0711** (no-show 7.2%) was **under-forecast 27.2%** - its refused
  walk-ups were invisible - so 2,627 of them were turned away in the window.
  Recalibrated: 462 refused, **+£63,559 (+2.36%)**.
- **NBR1-0741** (no-show 12%) was **over-forecast 21.7%** - its ghosts were
  counted as demand. Same ticket system, opposite error, thirty minutes
  apart.

### Where the money is, and where it is not

| Route | Attributable | Shape |
| --- | --- | --- |
| **NBR2 Great Northern** | **1.009% (£412,747)** | Peakiest: 9 coaches at 07:48, 5 at 12:18 |
| NBR1 Anglia Metro | 0.623% (£192,367) | Dense commuter, useful off-peak |
| NBR3 Pennine Shuttle | **0.521% (£34,623)** | Its evening peak runs two coupled units and was never rationed |

NBR3 is the honest counter-example: where the booking limits never bind, a
better forecast earns almost nothing. Say it before someone finds it.

### And by month

| | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attributable | 0.67% | 1.08% | 0.91% | 0.88% | 1.25% | **1.31%** | 1.12% | 0.64% |
| Peak sold out 2025 | 25% | 34% | 36% | 32% | 41% | 39% | 31% | 25% |

Forecast quality only earns where the limits bind - the paper found the
same, with revenue impacts concentrated at demand factors of 1.0 and above.

### The line to have ready

From `seatsense_snapshot(NBR2-0748, 2026-03-17)`:

> 593 of 593 seats sold - sold out, 29 walk-ups refused. One 9-car Azuma,
> NBR2-U001. SeatSense measured 553 seats occupied - a cabin factor of 93.3%
> against the 100% the ticket system reported - so **40 paid-for seats worth
> £1,848 departed empty**, the emptiest coach K with 10 free seats of 66.

Sold out, people refused, and forty empty seats - on the same train. That
sentence is the product. (And the case for the second unit is now a measured
number, not a guess.)

### Payback

No sensor price is stored in this dataset. Pass your own and
`seatsense_attribution` returns capex, payback and a five-year net:

```
seatsense_attribution(cost_per_coach_gbp: 1800)
→ 343 coaches, £617,400 capex, £969,183 a year, payback 7.6 months,
  five-year net £4,228,513   (capex only - no install, connectivity or integration)
```

## What this demo deliberately does not claim

Rail people will test these, so the tools state them:

- **Not a fare rise.** The booking-class ladder is byte-identical in both
  years. The average fare moves only through class mix, and the gain is
  volume.
- **No revenue from overselling.** Not permitted, and no row in either year
  sells more tickets than there are seats.
- **No revenue from reselling no-show seats.** The seat is still the buyer's
  for the whole journey. The 259,588 ghost seats measured in the window are
  worth £6.2m on paper and nothing in practice.
- **No new demand.** The extra tickets sold are requests that always existed
  and used to be refused by mis-set booking limits.
- **No claim that ticket data misses unsold seats.** It knows those exactly.
  What it misses is how many sold seats get used - which is what the demand
  forecasts were calibrated on.
- **No reduction in the no-show rate.** Identical in both years by
  construction.
- **No service-quality improvement**, and no modelled punctuality or
  complaint figures anywhere in the dataset.
- **Sold-out trains are not abolished.** 31.6% of weekday peak-core
  departures still sell out - demand exceeds the train, and
  `repricing_candidates` says lengthen it, not out-forecast it. And the
  residual forecast error still bites: NBR1-0741's 2026 error happens to
  point the wrong way and costs it £13,745 against its own counterfactual.
  Even halved errors are errors.
- **No 2025 occupancy figure**, except as an explicitly flagged inference:
  ticket sales recorded 4,029,675 weekday journeys, of which most likely
  3.55-3.67 million people actually travelled.

## How it fits together

```
   visitor
     │  plain English
     ▼
  ┌────────────┐   MCP over stdio    ┌──────────────────┐   reads   ┌──────────┐
  │  Claude    │ ──────────────────▶ │  Yggio tenant    │ ────────▶ │ data/    │
  │  Code      │ ◀────────────────── │  mcp-server.mjs  │           │ *.json   │
  └────────────┘   14 tools, JSON    │  + dataset.mjs   │           └──────────┘
                                     └──────────────────┘                ▲
                                     ┌──────────────────┐                │
   second screen ──── HTTP ─────────▶│  yggio-api.mjs   │────────────────┘
                                     └──────────────────┘
```

`dataset.mjs` does all the aggregation and hands back **pre-computed numbers
plus a one-paragraph `narrative`** for every query. That is deliberate: the
demo may be running against a small local model, and a small model that only
has to *read* a number answers correctly far more often than one that has to
compute it.

## How the data is generated

`generate.mjs` runs the paper's booking simulation for every departure, every
day, twice over (Standard and First cabins are separate pools):

1. **Class demand** - the departure's demand factor (mean demand / seats)
   split across the five classes with the paper's business or leisure
   profile, drawn stochastically per day (CV 0.35).
2. **The booking process** - arrivals land over 15 booking periods as Poisson
   counts, cheap classes early, Anytime late, interspersed within each
   period.
3. **EMSRb control** - at the start of every period the nested booking
   limits are re-solved from remaining capacity and the *forecast* of the
   demand still to come. A request books if its class is open; a walk-up
   arriving after the Standard cabin sold its last seat is
   `demand_turned_away`; a cheap request refused while dearer seats remain
   was priced, not refused.
4. **The forecast error** - the only thing that differs between the years.
   2025: 20-30% off per departure, direction correlated with its no-show rate
   (ticket-data calibration). 2026: 8-17% off, unbiased (SeatSense
   recalibration).
5. **No-shows** - applied at the platform, per departure (2-12%), identical
   process in both years. SeatSense measures them in 2026; nothing did in
   2025.
6. **The counterfactual** - every 2026 departure-day re-run over the
   *identical* arrival stream with 2025-quality forecasts, stored as `cf_*`.
   Attribution is the difference, per departure - the paper's paired design.

## The vocabulary the dataset insists on

| Term | Meaning |
| --- | --- |
| `assumed_load_factor_pct` | Tickets sold ÷ seats. What an operator without sensors reports as its load factor. Revenue is booked whether the ticket holder travels or not, so this counts every no-show as a passenger - and it is the number the forecasts were calibrated on. Both years. |
| `cabin_factor_pct` | Seats SeatSense measured as physically occupied ÷ seats. The real number. **2026 only** - the tools return `null` plus an explanation for 2025. |
| `ghost_seats` | Seats paid for that travelled empty. A measurement, not recoverable inventory. |
| `sales_closed` / `demand_turned_away` | Both years: whether the Standard cabin sold every seat, and how many walk-up (Anytime) requests were refused with no seat left. Priced-off cheap requests are not counted. |
| `cf_tickets_sold` / `cf_revenue_gbp` | 2026 only: the same day's booking requests under 2025-quality forecasts. Observed minus counterfactual is the business case. |
| `no_show_rate_pct` | Per departure: 2-12% network-wide, 7-12% on the peak. A property of who buys that particular train, invisible to ticket data - and what skewed its 2025 forecast. |
| `forecast_error_2025_pct` / `forecast_error_2026_pct` | The demand-forecast error EMSRb was fed for that departure, persistent per service. ~±25% then, ~±12.5% now - the paper's scenario pair. |
| `formation` / `unit_type` / `seats` | How long the train is on that departure: Azuma 9-car, 5-car, or two 5-cars coupled, with Standard and First seat counts from the real coach maps. |
| `manual_load_survey` | 2025 only, four dates: passengers counted by hand. The single 2025 field that saw actual people. |

## Files

| Path | What it is |
| --- | --- |
| `src/model.mjs` | The whole fiction: sales policy, the EMSRb revenue-management setup, booking classes, Azuma fleet, network, timetable, demand profiles, no-show rates, forecast errors. Edit here to change the story. |
| `src/generate.mjs` | Writes `data/*.json`: the Weatherford-Belobaba booking simulation, per departure per day, plus each 2026 departure's paired counterfactual. Deterministic. |
| `src/dataset.mjs` | Query + aggregation layer. Shared by the MCP server and the REST API. |
| `src/mcp-server.mjs` | The Yggio tenant as an MCP server over stdio. Zero dependencies. |
| `src/yggio-api.mjs` | The same data as a Yggio-shaped REST API, for showing on a screen. |
| `src/selftest.mjs` | Pre-flight check. Drives the MCP server the way Claude does and calls every tool. |
| `.mcp.json` | Wires the MCP server into Claude Code when it starts in this directory. |
| `CLAUDE.md` | Tells Claude how to behave during the demo, including what not to claim. |
| `DEMO-SCRIPT.md` | The stage script: questions, expected answers, talking points, recovery. |
| `data/*.json` | Generated data, committed so the demo needs no build step. `operator.json` carries the policies, the RM setup, the business case and a data dictionary of which fields exist in which year, and why. |

## The 14 tools

| Tool | Answers |
| --- | --- |
| `yggio_overview` | "What data do you have?" - start here |
| `capacity_pressure` | The policy in operation: sell-outs, walk-ups refused, and where RM stops being the answer |
| `ticket_data_blind_spot` | "Operators already have ticket data" - what 2025 reported, why it could not be an occupancy figure, and what it did to the forecasts. `demand_class: "all"` gives the network-level answer to "how many people actually travelled in 2025?" |
| `fullness_ranking` | The proof: departures ranked by tickets sold vs by measured occupancy, and which ones change place |
| `seatsense_attribution` | The 0.816%: market growth vs forecast effect, where the gain lands (over- vs under-forecast departures), volume vs mix, optional payback from your own sensor price, and what the demo does *not* claim |
| `pricing_actions` | The revenue-management setup: EMSRb, the fare ladder (identical in both years), and the forecast recalibration |
| `compare_years` | 2025 vs 2026 by total, month, route, service, demand class or day type, each with its attributable revenue |
| `morning_peak_report` | The morning peak departure by departure, before and after |
| `seatsense_snapshot` | One train, one day: which Azuma units are coupled, then per coach - sold vs occupied, walk-ups refused, ghost seats |
| `repricing_candidates` | "What still needs attention?" - capacity cases, residual forecast errors, and quotas rationing nothing |
| `list_services` | The timetable, Azuma formations by route and time of day, each departure's fare ladder, no-show rate and forecast errors |
| `service_history` | Day-by-day rows for one departure |
| `yggio_list_iotnodes` | The SeatSense device estate as Yggio IoT nodes, seat counts per real Azuma coach |
| `yggio_iotnode_readings` | One coach's sensor: latest values plus that day's occupancy series |

## Regenerating or changing the data

```bash
node src/generate.mjs                        # rewrite data/ from src/model.mjs
node src/generate.mjs --through 2026-09-30   # extend the 2026 window
node src/selftest.mjs                        # always re-check afterwards
```

The knobs worth knowing, all in `src/model.mjs`:

- `SALES_POLICY` - one ticket per seat, no overselling. Everything follows.
- `RM_POLICY` - the model itself: EMSRb, 15 booking periods, the paper
  reference, and the forecast-error story per year.
- `BOOKING_CLASSES` and route `anytimeStandardGbp` - the fare ladder (the
  paper's fare ratios). Identical in both years by design; if you change it,
  change it for both.
- `DEMAND_MIX` and `DEMAND_CV` - the paper's business/leisure class profiles
  and the day-to-day demand noise.
- `forecastError25()` / `forecastError26()` - the whole intervention: 20-30%
  vs 8-17% per departure, 2025's direction tied to the no-show rate. This is
  the main lever on the headline: it currently lands the attributable figure
  on 0.816%.
- `UNIT_TYPES` and `ROUTES[*].formations` - the Azuma coach maps and what is
  coupled when. Change a formation and that route's demand factors move with
  it.
- `ROUTES[*].demandFactor` - mean demand / seats per class, the paper's
  demand-factor parameter. Above 1.0 is where forecast quality earns; the
  paper simulates 0.9-1.3 and so do the peaks here.
- `noShowRate` per class and `noShowRateFor()` per departure (±40%) - what
  SeatSense measures, and what poisoned the 2025 forecasts.
- `MARKET_GROWTH_2026` - background growth baked into 2026 demand, netted off
  by each departure's counterfactual.
- `TICKET_DATA` - what ticket data could and could not see, the manual survey
  dates, and the no-show range the 2025 inference uses.

## Honesty notes

- Northbank Rail does not exist and every figure is synthetic. Station names
  are real, and the trains and seat counts are real Azuma coach layouts, so
  the network reads as plausible to rail people.
- The revenue-management model is not invented for the demo: it is the
  EMSRb setup of Weatherford & Belobaba (JORS 2002), including its
  assumptions - class demands independent, no cancellations, no buy-up, a
  refused request is lost rather than recaptured by the next train. Those
  assumptions are the paper's, and the tools state them.
- The 25% -> 12.5% forecast-error pair is the paper's own experiment; the
  demo's contribution is the *reason* the 2025 error existed (no-show-blind
  calibration) and the per-departure direction of it.
- The no-oversell constraint is framed contractually - a reservation is a
  right to that seat - not as a citation of a specific statute. If someone
  wants the legal basis in their own market, that is a conversation, not a
  slide.
- Revenue, tickets sold and the ticket-derived load factor are comparable
  across both years. **Cabin factor and ghost seats are 2026-only** - the
  tools return `null` with an explanation rather than inventing a baseline.
- The one place the demo estimates 2025 occupancy is `ticket_data_blind_spot`,
  where it is flagged `inference: true`, states its method and 9-12% no-show
  range, and gives a range rather than a point figure.
- No sensor price is in the repo. `seatsense_attribution` computes payback
  only from a `cost_per_coach_gbp` you supply at the time.
- Every service runs every day in this model, with weekend and bank-holiday
  demand factors rather than a reduced weekend timetable.
