# Stage script

Twelve questions, roughly ten minutes, building from "what is this?" to "what
do we do next?". Type them in English into Claude running in this directory.
Each block gives the question, the number to look for, and the line to say
while the audience reads it.

Every figure comes from the shipped data - if a number in the answer does not
match, the data has been regenerated with different parameters.

**Three things not to get wrong on stage:**

1. Observed revenue is up **2.4%**; the SeatSense number is **0.816%**. The
   rest is market growth. Quote the small one.
2. **This is not a fare rise.** The booking-class ladder is identical in both
   years; the gain is volume - seats the old forecasts wrongly protected used
   to fly empty *and unsold*. If someone frames it as peak fares going up,
   send it to `where_the_gain_lands`.
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

> A British operator, Azuma fleet, reserved seats - one ticket per seat, so no
> overselling. Seats are allocated by the standard airline RM model, EMSRb.
> SeatSense on every coach since 1 January. Ask it anything.

---

## 1. "What data do you have?"

**Tool:** `yggio_overview`

Look for: three routes, 58 daily departures, **343 SeatSense nodes**, 2025 =
ticket sales only, 2026 = ticket sales *plus* measured cabin factor, the
sales policy (**one ticket per seat, overselling not permitted**) and the RM
model: **EMSRb, fare ladder identical in both years.**

> The policy first, because it's what makes this a rail problem and not an
> airline one - and then note the model *is* the airline one. What they can't
> copy from airlines is the overbooking.

## 2. "How big are the trains? Do they vary?"

**Tool:** `list_services` (with `route_id=NBR2` for the extreme case)

Look for `formations_by_route_and_demand_class`: NBR2 runs a **9-car Azuma,
593 seats** at 07:48 and a **5-car, 302 seats** at 12:18. NBR1 couples two
5-cars (604) at the peak. NBR3 runs the long train only in the evening.

> Real Azuma coach layouts, seat for seat - a 5-car is 302, a 9-car 593,
> First and Standard separate pools. "How full is it" only means anything if
> you know what was coupled up.

## 3. "What revenue-management model do you run?"

**Tool:** `pricing_actions`

Look for: **EMSRb** (Weatherford & Belobaba, *JORS* 2002), five nested
booking classes per cabin - on NBR2 from **Anytime £64.40** down to
**Advance £15.46** - 15 booking checkpoints, and the assumptions stated
plainly: no cancellations, no buy-up, a refused request is lost.

> Nothing exotic - it's the seat-allocation model out of the literature, the
> one most airline YM systems descend from. Which matters for what's next:
> that paper's whole point is that the model is only as good as its demand
> forecast.

## 4. "So what went wrong in 2025?"

**Tool:** `ticket_data_blind_spot`

Look for: the operator reported an **89.5%** load factor on weekday peak-core
departures, sold out **34.6%** of them, refused **82.5 walk-ups a weekday** -
and the punchline: the demand forecasts behind the booking limits were
calibrated on ticket data, which **counts every no-show as a passenger and
never sees a refused walk-up**. Result: **~25% mean forecast error**, per
departure, persistent.

> Revenue is booked whether you travel or not. So the forecast learned from
> ghosts: the trains full of no-shows looked stronger than they were and got
> over-forecast; the trains turning people away looked weaker than they were
> and got under-forecast. The booking limits inherited both errors.

## 5. "And what did SeatSense change?"

**Tool:** `capacity_pressure`

Look for: the forecasts recalibrated on measured occupancy - **~25% error
down to ~12.5%**, the fare ladder untouched - and the operational read:
walk-ups refused on the morning peak fell from **75.9 to 50.0 a weekday**
(-34%).

Also say the honest wrinkle before anyone finds it: the evening peak **sells
out more often now** (21.1% → 30.9% of weekdays).

> That last number is deliberate. Those trains used to depart with wrongly
> protected seats - empty and unsold. Now they're sold. Under this model a
> sell-out isn't the failure; the failure is the walk-up refused, and that's
> what fell where it mattered.

## 6. "How much is it worth?"

**Tool:** `seatsense_attribution`

Look for: observed **+2.4%** (£1.87m) split into **£1,227,706 market growth**
and **£639,737 SeatSense = 0.816% of total revenue**, against a business case
of **0.75%**. Annualised **£969,183**.

Then the part worth pausing on - `where_the_gain_lands` and `decomposition`:

| | |
| --- | --- |
| Departures ticket data **under-forecast** (24) | **+£467,820** |
| Departures ticket data **over-forecast** (34) | **+£171,917** |
| Volume (tickets that could not be sold before) | **+£658,553** |
| Class mix | -£23,977 |

> Not a fare rise - the ladder is byte-identical in both years. And not a mix
> trick either: it's volume. Seats the old forecasts wrongly reserved used to
> fly empty and unsold; now they carry passengers. The other half is walk-ups
> who used to be refused and now find a protected seat.

## 7. "What did the sensors cost? What's the payback?"

**Tool:** `seatsense_attribution` with `cost_per_coach_gbp`

With no cost passed it says plainly that no sensor price is stored and reports
**343 coaches instrumented**. Pass your own figure and it returns capex,
payback and a five-year net. At £1,800 a coach: **£617,400 capex, payback 7.6
months, five-year net £4.23m.**

> Use your own number here. The tool carries none, on purpose - and it flags
> that the figure is capex only: no install, no connectivity, no integration.

## 8. "Why do you need a sensor? The booking system knows what's sold."

**Tool:** `fullness_ranking` with `month=6` - **the proof**

Look for: **seven of eight peak departures change rank** between the
tickets-sold list and the bodies-on-board list. **NBR1-0741** is the train
the ticket system calls fullest - **97% sold, rank 1** - and it is **third**
by actual occupancy, because **12%** of its ticket holders don't turn up.

> It does know what's sold. What it can't know is who turns up, because the
> revenue is booked either way. Now remember the forecasts are calibrated on
> exactly this ranking - price and protect off the wrong list and the error
> compounds every season.

## 9. "Show me two departures where that changed the number."

**Tool:** `list_services` with `route_id=NBR1`, or `compare_years group_by=service`

- **NBR1-0711**: no-show **7.2%**, 2025 forecast error **-27.2%** (its
  refused walk-ups were invisible) → **2,627** turned away in the window.
  Recalibrated: **462** refused, **+£63,559 (+2.36%)** attributable.
- **NBR1-0741**: no-show **12.0%**, 2025 forecast error **+21.7%** - its
  ghosts were counted as demand.

> Thirty minutes apart on the same route, same ticket system, opposite
> errors - and the direction tracks the no-show rate, which is exactly the
> number ticket data cannot see. That correlation is the product in one
> sentence.

## 10. "Which route benefited most?"

**Tool:** `compare_years` with `group_by=route`

| Route | Attributable |
| --- | --- |
| **NBR2 Great Northern** | **1.009% (£412,747)** |
| NBR1 Anglia Metro | 0.623% (£192,367) |
| NBR3 Pennine Shuttle | **0.521% (£34,623)** |

> NBR2 is the peakiest - nine coaches at 07:48, five at midday - so its
> booking limits bind hardest. And say the third line before someone finds
> it: the Pennine Shuttle earned least because its evening peak runs two
> units coupled and was never rationed. Where the limits never bind, a better
> forecast earns almost nothing - the paper found exactly that.

## 11. "Break it down by month."

**Tool:** `capacity_pressure` or `compare_years group_by=month`

Look for: June **1.31%** against August **0.64%** - tracking how hard demand
pressed on the seats each month.

> Forecast quality only pays where the booking limits bind. In a quiet month
> every class stays open and a wrong forecast costs nothing. You get paid
> where demand meets capacity - the paper's demand-factor result, live.

Note if asked: individual months hold different numbers of working days, so
use `revenue_pct_calendar_adjusted`. The attributable figure is immune - it
compares each departure with itself.

## 12. "How many paid seats travelled empty on the 07:48 on 17 March?"

**Tool:** `seatsense_snapshot`, `service_id=NBR2-0748`, `date=2026-03-17`

Look for: **593 of 593 sold - sold out, 29 walk-ups refused**, one 9-car
Azuma (NBR2-U001), 553 seats occupied, cabin factor **93.3%** against the
reported 100%, **40 ghost seats worth £1,848**, emptiest coach **K, 10 free
seats of 66**.

> Sold out, people refused, and forty empty seats - all on the same train.
> We can't resell them; they belong to people who didn't come. We can't
> oversell to cover them. What we can do is know it - and now the case for
> coupling a second unit to this diagram is a measured number, not a hunch.

## 13. "What still needs attention?"

**Tool:** `repricing_candidates`

Look for the three action types: **8 x lengthen_the_train** (genuinely full,
forecasts honest - the answer is steel), **9 x recalibrate_the_forecast**
(residual errors still worth money - **NBR1-0741 is on this list**), **19 x
open_more_advance** (limits rationing nothing).

> Same answer a revenue meeting would reach. And note what's not on the list,
> because it isn't legal: overselling, and reselling the empty seats.

---

## If the visitor goes off-script

- *"What was the cabin factor in 2025?"* → the tools **refuse**: `null` with an
  explanation. The best moment in the demo.
- *"So how many actually travelled in 2025?"* → `ticket_data_blind_spot` with
  `demand_class="all"`: 4,029,675 weekday journeys ticketed, most likely
  **3.55-3.67 million** people, flagged `inference: true`.
- *"Aren't you just putting peak fares up?"* → the fare ladder is identical in
  both years, byte for byte. `where_the_gain_lands` shows the gain is volume
  on wrongly protected seats. See question 6.
- *"Where does the EMSRb model come from?"* → Weatherford & Belobaba, *Journal
  of the Operational Research Society* 53 (2002). The demo re-stages its
  forecast-accuracy experiment: 25% error versus 12.5%, same demand, same
  fares.
- *"Why do sell-outs go UP on the evening peak?"* → because seats that used
  to be wrongly protected - and flew empty and unsold - are now sold. The
  failure metric is walk-ups refused, not sell-outs. See question 5.
- *"Couldn't you resell the empty seat mid-journey?"* → no; the reservation
  belongs to its buyer for the whole journey.
- *"So no-shows went down?"* → no. Identical in both years by construction.
  SeatSense measures them; it does not prevent them.
- *"Did crowding improve?"* → `capacity_pressure` claims no service-quality
  improvement, deliberately.
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
- **The model calls it a fare rise** - ask it for `where_the_gain_lands` in
  `seatsense_attribution`, and whether the fare ladder changed.
- **The model quotes a 2025 cabin factor** - it invented it. Send it to
  `ticket_data_blind_spot`.
- **Someone asks whether this is real** - the operator is fictional and the
  data synthetic, generated to be internally consistent. The constraint, the
  blind spot, the Azuma seat maps and the EMSRb model (Weatherford &
  Belobaba, 2002) are real.
