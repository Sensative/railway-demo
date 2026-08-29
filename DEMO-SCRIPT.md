# Stage script

Twelve questions, roughly ten minutes, building from "what is this?" to "what
do we do next?". Type them in English into Claude running in this directory.
Each block gives the question, the number to look for, and the line to say
while the audience reads it.

Every figure comes from the shipped data - if a number in the answer does not
match, the data has been regenerated with different parameters.

**Three things not to get wrong on stage:**

1. Observed revenue is up **2.4%**; the SeatSense number is **0.758%**. The rest
   is market growth. Quote the small one.
2. **The premium earns nothing** (−£3,181). The money lands on the discounted
   departures either side. If you present this as a peak fare rise, you have
   described the opposite of what happened.
3. Nothing comes from overselling or from reselling a no-show seat.

---

## 0. Before the visitor arrives

```bash
cd railway-demo            # the repo root
node src/selftest.mjs      # must end with "All checks passed"
claude                     # approve the yggio MCP server when asked
```

Optionally on a second screen: `node src/yggio-api.mjs` at
`http://localhost:8787`.

Setup line:

> A British operator, reserved seats, one ticket per seat - so no overselling.
> SeatSense on every coach since 1 January. Ask it anything.

---

## 1. "What data do you have?"

**Tool:** `yggio_overview`

Look for: three routes, 58 daily departures, **241 SeatSense nodes**, 2025 =
ticket sales only, 2026 = ticket sales *plus* measured cabin factor, and the
sales policy: **one ticket per seat, overselling not permitted.**

> The policy first, because it's what makes this a rail problem and not an
> airline one.

## 2. "How big are the trains? Do they vary?"

**Tool:** `list_services` (with `route_id=NBR2` for the extreme case)

Look for `formations_by_route_and_demand_class`: NBR2 runs **3 units, 12 cars,
672 seats** at 07:48 and **1 unit, 4 cars, 224 seats** at 12:18. NBR1 runs 8
cars at peak, 4 off-peak. NBR3 runs 6 and 3.

> Right-sized formations, which is why this network runs at a 67% cabin factor
> and not the forty-odd percent you get from hauling full-length trains around
> at eleven in the morning. It also means "how full is it" only means anything
> if you know what was coupled up.

## 3. "A train sold out at 100% can't take another passenger. What did that cost?"

**Tool:** `capacity_pressure`

Look for 2025: peak core closed sales on **67.5%** of weekdays, evening peak
**43.8%**, and **31 passengers a weekday** refused.

> Every one of those is a fare that didn't happen. An airline absorbs them by
> overbooking and prices the denied-boarding risk in. Selling reserved seats you
> can't: the seat is contractually somebody's. So the only way to keep those
> passengers is to make sure the train never fills.

## 4. "So what did they change?"

**Tool:** `pricing_actions`, then back to `capacity_pressure`

Look for the principle - **"it must always be possible to travel on the
departure you want; it may cost more"** - the parameters (target cabin factor
**88%**, sold ceiling **97%**, premium cap **4.5%**), and the realised moves:
peak **+1.4 to +1.8%**, shoulders **−4.5%**.

Result: peak core closing sales **67.5% → 2.4%**, evening peak **43.8% →
3.9%**, turn-aways **31.5 → 0.5 a weekday**, shoulder sold **58.0% → 62.6%**.

> Under two percent on the peak. That's the whole intervention. The fare is
> solved against each day's demand, so a quiet Tuesday in August carries no
> premium at all.

## 5. "How much is it worth?"

**Tool:** `seatsense_attribution`

Look for: observed **+2.4%** (£1.89m) split into **£1,289,613 market growth**
and **£596,914 SeatSense = 0.758% of total revenue**, against a business case
of **0.75%**. Annualised **£904,307**.

Then the part worth pausing on - `two_halves_of_the_policy`:

| | |
| --- | --- |
| Premium on the departures held below full | **−£3,181** |
| Discount on the departures either side | **+£600,095** |

> The premium earns nothing. It's solved to land sales on target, so the fare it
> adds and the volume it sheds cancel out. All the money is on the trains either
> side - those are the seats that now get sold. The premium is the instrument;
> the shoulder is the till. Which settles the first objection anyone raises:
> this is not a fare rise. A fare rise would show the gain on the peak.

## 6. "What did the sensors cost? What's the payback?"

**Tool:** `seatsense_attribution` with `cost_per_coach_gbp`

With no cost passed it says plainly that no sensor price is stored and reports
**241 coaches instrumented**. Pass your own figure and it returns capex,
payback and a five-year net. At £1,800 a coach: **£433,800 capex, payback 5.8
months, five-year net £4.09m.**

> Use your own number here. The tool carries none, on purpose - and it flags
> that the figure is capex only: no install, no connectivity, no integration.

## 7. "Why do you need a sensor? The booking system knows what's sold."

**Tool:** `fullness_ranking` with `month=6` - **the proof**

Look for: ticket sales spread these eight peak departures across 3.6 points,
measured occupancy across **6.2 points**, and **seven of eight change rank**.
**NBR1-0741** goes from 4th by tickets sold to **8th** by actual fullness -
12% of its ticket holders don't turn up.

> It does know what's sold. What it can't know is who turns up, because the
> revenue is booked either way. And the sold-target is the occupancy target
> *plus that departure's own no-show rate* - so you can't set it without
> measuring.

## 8. "Show me two departures where that changes the price."

**Tool:** `list_services` with `route_id=NBR1`

- **NBR1-0711**: no-show **7.2%** → held to **95.2%** sold → premium **+1.7%**
- **NBR1-0741**: no-show **12.0%** → sold to **97%** → premium **+1.4%**

> Thirty minutes apart, both 8-car, both about as sold. The one with more
> no-shows gets the *smaller* increase, because it can safely be sold closer to
> the cap. Ticket data would have done the exact opposite.

## 9. "Which route benefited most?"

**Tool:** `compare_years` with `group_by=route`

| Route | Attributable |
| --- | --- |
| **NBR2 Great Northern** | **0.951% (£457,630)** |
| NBR1 Anglia Metro | 0.510% (£123,414) |
| NBR3 Pennine Shuttle | **0.246% (£15,870)** |

> NBR2 is the peakiest - twelve cars at 07:48, four at midday - so it had the
> most rationing to fix. And say the third line before someone finds it: the
> Pennine Shuttle earned almost nothing, because its evening peak was never
> rationed in the first place. Where nothing is scarce, measuring it is worth
> very little.

## 10. "Break it down by month."

**Tool:** `capacity_pressure` or `compare_years group_by=month`

Look for: Jan **0.11%**, Mar 1.33%, Jun **1.61%**, Aug **0.02%** - next to how
often the peak sold out in 2025: 3%, 99%, 100%, 0%.

> My favourite number here. The fare is solved per day, so a departure that
> wouldn't have filled carries no premium. August earns 0.02% because in August
> nothing was being rationed. **You only get paid for pricing a train that
> would otherwise have refused someone.**

Note if asked: individual months hold different numbers of working days, so use
`revenue_pct_calendar_adjusted`. The attributable figure is immune - it compares
each departure with itself.

## 11. "How many paid seats travelled empty on the 07:48 on 17 March?"

**Tool:** `seatsense_snapshot`, `service_id=NBR2-0748`, `date=2026-03-17`

Look for: **661 of 672 sold, sales still open, nobody refused**, formation
**NBR2-U021 + U015 + U009 - twelve cars**, 616 seats occupied, cabin factor
**91.7%** against the reported 98.4%, **45 ghost seats worth £1,907**, and the
rear unit emptiest: **U009-D with 14 free seats of 56.**

> Forty-five seats paid for and empty, and they're all in the back unit. We
> can't sell them - they're already sold, to people who didn't come. We can't
> oversell to cover them. What we can do is know it, and that's what set this
> departure's price.

## 12. "What still needs attention?"

**Tool:** `repricing_candidates`

Look for the two `lengthen_the_train` and one `premium_cap_is_binding` on
**NBR2's evening peak** - the only place still closing sales more than 10% of
weekdays.

> Same answer a revenue meeting would reach: on this route price has done what
> it can, and the next step is steel, not tariff. Note what's not on the list,
> because it isn't legal: overselling, and reselling the empty seats.

---

## If the visitor goes off-script

- *"What was the cabin factor in 2025?"* → the tools **refuse**: `null` with an
  explanation. The best moment in the demo.
- *"So how many actually travelled in 2025?"* → `ticket_data_blind_spot` with
  `demand_class="all"`: 3,877,840 weekday journeys ticketed, most likely
  **3.41-3.53 million** people, flagged `inference: true`.
- *"Couldn't you resell the empty seat mid-journey?"* → no; the reservation
  belongs to its buyer for the whole journey.
- *"So no-shows went down?"* → no. Identical in both years by construction.
- *"Did crowding improve?"* → `capacity_pressure` claims no service-quality
  improvement. What improved is that almost nobody meets a closed sale.
- *"Aren't you just putting peak fares up?"* → the premium earned −£3,181. See
  question 5.
- *"Show me one train over time."* → `service_history`
- *"Are all the sensors working?"* → `yggio_list_iotnodes`
- *"What's the legal basis in my market?"* → the demo frames it contractually
  and cites no statute. Say that plainly and offer to follow up.

## Recovery

- **Claude doesn't see the tools** - wrong directory, or the MCP server wasn't
  approved. Quit, `cd` to the repo root, restart, approve.
- **A number looks wrong** - `node src/selftest.mjs` calls every tool and prints
  each headline.
- **The model quotes 2.4% as the SeatSense figure** - ask "how much of that is
  attributable rather than market growth?"
- **The model says the peak premium earned the money** - ask it for
  `two_halves_of_the_policy`.
- **The model quotes a 2025 cabin factor** - it invented it. Send it to
  `ticket_data_blind_spot`.
- **Someone asks whether this is real** - the operator is fictional and the data
  synthetic, generated to be internally consistent. The constraint, the blind
  spot and the pricing mechanism are real.
