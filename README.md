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
three routes, 58 daily departures, ~4.6 million journeys and ~£119m of ticket
revenue a year, 241 instrumented coaches.

### The fleet, because train length is half the story

Peak departures run units coupled together; off-peak they run singles. Ask the
demo about train size and it answers per route *and* per time of day:

| Route | Unit | Peak core | Peak shoulder | Off-peak |
| --- | --- | --- | --- | --- |
| NBR1 Anglia Metro | 4-car, 240 seats | 2 units, 8 cars, **480** | 2 units, 480 | 1 unit, 240 |
| NBR2 Great Northern | 4-car, 224 seats | 3 units, 12 cars, **672** | 2 units, 448 | 1 unit, 224 |
| NBR3 Pennine Shuttle | 3-car, 204 seats | 2 units, 6 cars, **408** | 1 unit, 204 | 1 unit, 204 |

Right-sized formations are why the network runs at a **67% cabin factor** rather
than the 40-odd percent you get from running full-length trains all day. They
also mean demand is expressed as a share of each route's *longest* formation, so
the number keeps its meaning when a departure runs short.

### The problem: a full train is a lost sale

**One ticket per seat. No overselling.** A reservation is a contractual right
to that specific seat, and denied boarding triggers passenger-rights
obligations, so the deliberate overbooking an airline prices into its yield
model is not available.

So **a departure sold to 100% cannot take another passenger.** In 2025 the
morning peak closed sales on **67.5%** of weekdays and the evening peak on
**43.8%**, refusing **31 passengers a weekday** across the network. An airline
absorbs those. This operator cannot.

### The policy: never let it fill

> **It must always be possible to travel on the departure you want. It may cost
> more.**

From 1 January 2026 each popular departure's fare is **solved against that
day's demand** so predicted sales land on a measured-occupancy target and never
reach the sales cap. The departures either side are discounted in proportion to
the premium the peak is carrying. A quiet Tuesday in August carries no premium
at all, because nothing would have filled.

| Parameter | Value |
| --- | --- |
| Target cabin factor | 88% measured occupancy |
| Sold ceiling | 97% of seats - never higher, so it cannot fill |
| Maximum premium | 4.5% |
| Substitution between adjacent departures | elasticity 5.5 |
| Not travelling at all | elasticity 0.3 |
| Share of refused demand that takes a neighbour | 88% |

Realised fare moves are **+1.4% to +1.8%** on the peak and **−4.5%** on the
shoulders. That is the whole intervention.

### What it did

Like-for-like, 1 January - 31 August, weekdays:

| | 2025 | 2026 |
| --- | --- | --- |
| Peak core sold | 98.5% | **96.3%** |
| Peak core cabin factor | *unknown* | **87.5%** |
| Peak core closing sales | 67.5% of weekdays | **2.4%** |
| Evening peak closing sales | 43.8% | **3.9%** |
| Passengers turned away | 31.5 a weekday | **0.5** |
| Peak core fare | £29.97 | £30.74 |
| Peak shoulder sold | 58.0% | **62.6%** |
| Peak shoulder fare | £26.28 | £26.05 |

### The result nobody expects

| | |
| --- | --- |
| Observed revenue change | +2.4% (£1.89m) |
| of which market growth | £1,289,613 |
| **attributable to SeatSense** | **£596,914 = 0.758% of total revenue** |
| Business case | 0.75% |
| Annualised | **£904,307** |

Now split that £596,914 by where it landed:

| | |
| --- | --- |
| The premium on the departures held below full | **−£3,181** |
| The discount on the departures either side | **+£600,095** |

**The premium earns nothing.** It is solved to land sales on target, so the
fare it adds and the volume it sheds cancel by construction. The money appears
on the trains either side - those are the seats that now get sold, to
passengers who previously paid a peak fare or were refused outright.

The premium is the instrument. The shoulder is the till. Which also settles the
first objection anyone raises: **this is not a fare rise.** A fare rise would
show the gain on the peak, and it does not.

### Why it needs SeatSense

The sold-target is the cabin-factor target **plus that departure's own no-show
rate**, and ticket data cannot see a no-show, because revenue is booked whether
the passenger travels or not.

June 2026 weekdays, peak core. Ticket sales spread these eight departures
across 3.6 points. Measured occupancy spreads them across **6.2 points**, and
**seven of eight change rank**:

| Departure | Sold | **Actually full** | No-show | Rank by sales → by fullness |
| --- | --- | --- | --- | --- |
| NBR2-0748 | 99.1% | **92.0%** | 7.3% | 1 → 1 |
| NBR2-0818 | 98.9% | 90.8% | 8.3% | 3 → 2 |
| NBR1-0711 | 95.5% | 88.9% | 7.2% | 7 → 3 |
| NBR1-0811 | 95.5% | 88.9% | 7.3% | 8 → 4 |
| NBR2-0718 | 99.0% | 87.7% | 11.6% | 2 → 5 |
| NBR3-0722 | 97.1% | 87.7% | 9.5% | 5 → 6 |
| NBR3-0752 | 97.1% | 87.1% | 10.1% | 6 → 7 |
| **NBR1-0741** | 97.1% | **85.8%** | **12.0%** | **4 → 8** |

So the 07:11, with a 7.2% no-show rate, is held to 95.2% sold and takes a
**+1.7%** premium. The 07:41 thirty minutes later, with 12%, can safely be sold
to 97% and takes only **+1.4%**. Ticket data would have ranked and priced them
the other way round.

### Where the money is, and where it is not

| Route | Attributable | Shape |
| --- | --- | --- |
| **NBR2 Great Northern** | **0.951% (£457,630)** | Peakiest: 12 cars at 07:48, 4 at 12:18 |
| NBR1 Anglia Metro | 0.510% (£123,414) | Dense commuter, useful off-peak |
| NBR3 Pennine Shuttle | **0.246% (£15,870)** | Flattest - and its evening peak was never rationed |

NBR3 is the honest counter-example: where nothing was being rationed,
measurement earns almost nothing. Say it before someone finds it.

### And by month

| | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Attributable | 0.11% | 0.50% | 1.33% | 0.77% | 1.42% | **1.61%** | 1.19% | **0.02%** |
| Peak sold out 2025 | 3% | 58% | 99% | 82% | 100% | 100% | 97% | 0% |

The fare is solved per day, so a departure that would not have filled carries
no premium. **You get paid only for pricing a train that would otherwise have
refused someone.**

### The line to have ready

From `seatsense_snapshot(NBR2-0748, 2026-03-17)`:

> 661 of 672 seats sold, sales still open, nobody refused. Formation
> NBR2-U021 + U015 + U009, twelve cars. SeatSense measured 616 seats occupied -
> a cabin factor of 91.7% against the 98.4% the ticket system reported - so
> **45 paid-for seats worth £1,907 departed empty**, and the emptiest coach was
> the rear one, U009-D with 14 free seats.

### Payback

No sensor price is stored in this dataset. Pass your own and
`seatsense_attribution` returns capex, payback and a five-year net:

```
seatsense_attribution(cost_per_coach_gbp: 1800)
→ 241 coaches, £433,800 capex, £904,307 a year, payback 5.8 months,
  five-year net £4,087,734   (capex only - no install, connectivity or integration)
```

## What this demo deliberately does not claim

Rail people will test these, so the tools state them:

- **No revenue from overselling.** Not permitted, and no row in either year
  sells more tickets than there are seats.
- **No revenue from reselling no-show seats.** The seat is still the buyer's for
  the whole journey. The 243,636 ghost seats measured in the window are worth
  £6.3m on paper and nothing in practice.
- **No claim that ticket data misses unsold seats.** It knows those exactly.
  What it misses is how many sold seats get used.
- **No reduction in the no-show rate.** Identical in both years by construction.
- **No passenger growth.** Flat (−0.04% attributable). The gain is yield.
- **No service-quality improvement**, and no modelled punctuality or complaint
  figures anywhere in the dataset. What improved is that far fewer passengers
  meet a closed sale.
- **Not a fare rise.** The premium earns −£3,181. The measured gain is on the
  discounted departures.
- **The policy does not abolish sold-out trains.** 2.4% of peak departures
  still fill because the premium is capped, and NBR2's evening peak is where
  `repricing_candidates` says to buy more seats rather than charge more.
- **No 2025 occupancy figure**, except as an explicitly flagged inference:
  ticket sales recorded 3,877,840 weekday journeys, of which most likely
  3.41-3.53 million people actually travelled.

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
demo may be running against a small local model (this repo routes Claude Code
to Ollama through LiteLLM), and a small model that only has to *read* a number
answers correctly far more often than one that has to compute it.

## How the data is generated

Departures cannot be simulated independently, because the interesting thing
happens between them. `generate.mjs` allocates each route's whole day at once:

1. **Preferred demand** per departure - who would take it if price and capacity
   were no object.
2. **Competition windows** - the morning peak plus its shoulders, the evening
   peak plus its shoulders. Inside a window, a fare change moves passengers
   between departures (elasticity 5.5 - adjacent departures of the same journey
   are near-perfect substitutes). What the window costs on average decides how
   many travel at all (elasticity 0.3). Outside a window a departure competes
   with nothing, so it is left alone: discounting a midday train buys almost no
   volume and just gives away yield.
3. **The fare solver** - for each popular departure, raise the fare until
   predicted sales land on its own sold-target (88% cabin factor plus its
   no-show rate, capped at 97% sold), or until the 4.5% premium cap. Then set
   the window's shoulder discount in proportion to the premium the peak ended up
   carrying. Ten passes.
4. **Capacity and spillover** - sales stop at 100% of seats. Of the demand
   refused, 88% takes a neighbouring departure within 90 minutes; the rest does
   not travel at all, and that is the revenue the policy exists to keep.
5. **The counterfactual** - the same day, run again on 2025's flat fares with
   the same market growth, stored on every 2026 row as `cf_*`. Attribution is
   the difference, per departure.

## The vocabulary the dataset insists on

| Term | Meaning |
| --- | --- |
| `assumed_load_factor_pct` | Tickets sold ÷ seats. What an operator without sensors reports as its load factor. Revenue is booked whether the ticket holder travels or not, so this counts every no-show as a passenger - and it is the number decisions get made on. Both years. |
| `cabin_factor_pct` | Seats SeatSense measured as physically occupied ÷ seats. The real number. **2026 only** - the tools return `null` plus an explanation for 2025. |
| `ghost_seats` | Seats paid for that travelled empty. A measurement, not recoverable inventory. |
| `sales_closed` / `demand_turned_away` | Both years: whether the departure hit the 100% cap, and how many passengers arrived after it did. |
| `cf_tickets_sold` / `cf_revenue_gbp` | 2026 only: the same departure on 2025's fares with the same market growth. Observed minus counterfactual is the business case. |
| `no_show_rate_pct` | Per departure: 2-12% network-wide, 7-12% on the peak. A property of who buys that particular train, stable enough to price against, invisible to ticket data. |
| `sold_target_pct` | Per departure, 2026: where the pricing rule aims its sales. Cabin-factor target plus that departure's no-show rate, capped at the ceiling. |
| `formation_units` / `unit_type` / `seats` | How long the train is on that departure. Peak runs 2-3 units coupled, off-peak a single unit, so `seats` differs by time of day on the same route. |
| `manual_load_survey` | 2025 only, four dates: passengers counted by hand. The single 2025 field that saw actual people. |

## Files

| Path | What it is |
| --- | --- |
| `src/model.mjs` | The whole fiction: sales policy, pricing policy, operator, network, timetable, demand classes, fares, no-show rates. Edit here to change the story. |
| `src/generate.mjs` | Writes `data/*.json`: the day allocator, the fare solver and each 2026 departure's counterfactual. Deterministic. |
| `src/dataset.mjs` | Query + aggregation layer. Shared by the MCP server and the REST API. |
| `src/mcp-server.mjs` | The Yggio tenant as an MCP server over stdio. Zero dependencies. |
| `src/yggio-api.mjs` | The same data as a Yggio-shaped REST API, for showing on a screen. |
| `src/selftest.mjs` | Pre-flight check. Drives the MCP server the way Claude does and calls every tool. |
| `.mcp.json` | Wires the MCP server into Claude Code when it starts in this directory. |
| `CLAUDE.md` | Tells Claude how to behave during the demo, including what not to claim. |
| `DEMO-SCRIPT.md` | The stage script: questions, expected answers, talking points, recovery. |
| `data/*.json` | Generated data, committed so the demo needs no build step. `operator.json` carries both policies, the business case and a data dictionary of which fields exist in which year, and why. |

## The 14 tools

| Tool | Answers |
| --- | --- |
| `yggio_overview` | "What data do you have?" - start here |
| `capacity_pressure` | The policy in operation: sold-out departures, turn-aways, and where price stops being the answer |
| `ticket_data_blind_spot` | "Operators already have ticket data" - what 2025 reported, why it could not be an occupancy figure, and what it really was. `demand_class: "all"` gives the network-level answer to "how many people actually travelled in 2025?" |
| `fullness_ranking` | The proof: departures ranked by tickets sold vs by measured occupancy, and which ones change place |
| `seatsense_attribution` | The 0.758%: market growth vs pricing effect, the premium/shoulder split, optional payback from your own sensor price, and what the demo does *not* claim |
| `pricing_actions` | The policy, its parameters, and the fare each class actually realised |
| `compare_years` | 2025 vs 2026 by total, month, route, service, demand class or day type, each with its attributable revenue |
| `morning_peak_report` | The morning peak departure by departure, before and after |
| `seatsense_snapshot` | One train, one day: which units are coupled, then per coach - sold vs occupied, turn-aways, ghost seats |
| `repricing_candidates` | "What still needs attention?" - separating capacity questions from premium judgement calls |
| `list_services` | The timetable, formations by route and time of day, each departure's no-show rate and its sold-target |
| `service_history` | Day-by-day rows for one departure |
| `yggio_list_iotnodes` | The SeatSense device estate as Yggio IoT nodes |
| `yggio_iotnode_readings` | One coach's sensor: latest values plus that day's occupancy series |

## Regenerating or changing the data

```bash
node src/generate.mjs                        # rewrite data/ from src/model.mjs
node src/generate.mjs --through 2026-09-30   # extend the 2026 window
node src/selftest.mjs                        # always re-check afterwards
```

The knobs worth knowing, all in `src/model.mjs`:

- `SALES_POLICY` - one ticket per seat, no overselling. Everything follows.
- `PRICING_POLICY` - the whole 2026 mechanism: `targetCabinFactor` (0.88),
  `soldCeiling` (0.97), `maxPremium` (0.045), `choiceElasticity` (5.5),
  `marketElasticity` (0.3), `spillShare` (0.88). There is a real tension in
  here worth understanding before you touch it: a bigger `maxPremium` clears
  the peak more completely *and* earns more, so "nobody is ever turned away"
  and "0.75% of revenue" pull against each other. The thing that reconciles
  them is a high `choiceElasticity` - passengers move readily between
  departures half an hour apart, so a 1.5% premium shifts a lot of demand.
- `ROUTES[*].unit`, `fleetUnits`, `formations` - train length per route and per
  demand class. Change a formation and that route's load factors move with it.
- `ROUTES[*].demandIndex` - demand per class as a share of that route's longest
  formation. Above 1.0 is what makes a departure ration itself, and how far
  above 1.0 sets how much premium is needed to clear it. This is the main lever
  on the headline: it currently lands the attributable figure on 0.758%.
- `noShowRate` per class and `noShowRateFor()` per departure (±40%) - the
  variation that makes the two rankings disagree, and that the sold-target is
  built from.
- `COMPETITION_WINDOWS` and `MAX_SHOULDER_DISCOUNT` - which departures compete,
  and how far each may be discounted to receive displaced demand. Note that the
  discount is where the measured gain lands, not the premium.
- `MARKET_GROWTH_2026` - background growth baked into 2026 demand, netted off
  by each departure's counterfactual.
- `TICKET_DATA` - what ticket data could and could not see, the manual survey
  dates, and the no-show range the 2025 inference uses.

## Honesty notes

- Northbank Rail does not exist and every figure is synthetic. Station names
  are real so the network reads as plausible to rail people.
- The no-oversell constraint is framed contractually - a reservation is a right
  to that seat, and denied boarding triggers passenger-rights obligations - not
  as a citation of a specific statute. If someone wants the legal basis in
  their own market, that is a conversation, not a slide.
- Revenue, tickets sold and the ticket-derived load factor are comparable
  across both years. **Cabin factor and ghost seats are 2026-only** - the tools
  return `null` with an explanation rather than inventing a baseline.
- The one place the demo estimates 2025 occupancy is `ticket_data_blind_spot`,
  where it is flagged `inference: true`, states its method and 9-12% no-show
  range, and gives a range rather than a point figure.
- The elasticities, the spill share and the indicative effects in
  `repricing_candidates` are modelling assumptions. Each tool states the one it
  used, and `pricing_actions` prints the whole parameter set. The high
  substitution elasticity (5.5) is the load-bearing one: it is what lets a
  1.5% premium clear a peak, and it is defensible for departures half an hour
  apart with the price difference visible at the point of sale.
- No sensor price is in the repo. `seatsense_attribution` computes payback only
  from a `cost_per_coach_gbp` you supply at the time.
- Every service runs every day in this model, with weekend and bank-holiday
  demand factors rather than a reduced weekend timetable.
