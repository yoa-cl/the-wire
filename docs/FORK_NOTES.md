# Fork notes

Why The Wire exists, what was specified, and where the finished work departed
from that specification.

This is the engineering record. For how the app *behaves*, see
**What The Wire changes** in the [README](../README.md); for how to run it, see
[DEPLOYMENT.md](DEPLOYMENT.md). This document deliberately does not repeat
either — it explains the reasoning behind them.

Upstream: [mreflow/control-center](https://github.com/mreflow/control-center).

---

## Why this fork exists

Upstream Control Center runs a background scheduler (`lib/server/scheduler.ts`)
that wakes every 15 minutes and refreshes every collector. One of those
collectors is `/api/live/audience`, which fetched every configured social
profile **concurrently** — a `Promise.all` across the whole account list.

Those are unauthenticated scrapes of public profile pages. A burst of
simultaneous signed-out requests arriving from a single IP address is precisely
the pattern platform anti-bot systems are built to catch, and it results in that
IP being rate-limited or banned. The behaviour is worst on Instagram, TikTok and
LinkedIn.

That is not a bug in upstream so much as a design that assumes a handful of
accounts and a forgiving network position. It stops being viable as soon as you
track more than a few profiles, and it fails hardest on a server, where the IP
may already be flagged.

The goal of this fork is narrow: **stop the app from scraping social platforms
on a timer, and put collection back under human control** — without breaking the
existing charts, without diverging from upstream more than necessary, and
without leaving gaps where a platform simply refuses to answer.

Everything else upstream does is untouched.

---

## The original specification

Preserved verbatim as written before implementation began. Three parts of it
were changed during the build; those are recorded in the next section, and the
text below is deliberately **not** edited to match.

> **The Core Problem:** The original repository relies on a background scheduler
> (`lib/server/scheduler.ts`) that loops through API endpoints every 15 minutes.
> The `/api/live/audience` route batch-processes unauthenticated scrapes for
> every configured social media account simultaneously. This rapid concurrent
> scraping triggers anti-bot IP bans. We need to decouple the audience metrics
> from the automated background loop and introduce a hybrid manual/on-demand
> system that supports granular single-account scraping, a staggered bulk refresh
> with a strict 10-second delay, and an intelligent manual data entry system with
> robust validation and parsing, while minimizing upstream merge conflicts.
>
> **Step 1: Decouple the Scheduler (Backend)**
>
> - Locate `lib/server/scheduler.ts` and `components/control-center.tsx`.
> - Change the server-side interval constant (`COLLECTION_INTERVAL_MS`) from 15
>   minutes (`15 * 60 * 1000`) to 4 hours (`4 * 60 * 60 * 1000`).
> - In `components/control-center.tsx`, update the client-side polling hook
>   default and its four call sites from 15 minutes to 4 hours.
> - In `lib/server/scheduler.ts`, remove `"/api/live/audience"` from the
>   automated `Promise.allSettled` array inside `refreshAllCollectors()`.
>
> **Step 2: Upgrade the API Route with Staggered Batch Logic & Validation**
>
> - Locate `app/api/live/audience/route.ts`.
> - Modify GET Handler:
>   - Accept URL query parameters (e.g. `?platform=youtube&handle=mychannel`) for
>     single-account execution. If parameters are present, execute the scraping
>     logic only for that specific target row.
>   - If no parameters are present (bulk "Refresh All"), fetch all configured
>     accounts and process them sequentially (one by one) rather than
>     concurrently.
>   - Implement an intentional, respectful delay of exactly 10 seconds between
>     each sequential request to prevent platform throttling.
>   - Wrap each individual loop iteration in a `try/catch` block: if a request
>     times out or fails, gracefully skip updating that specific record, leave
>     historical database values completely intact, and continue the batch.
> - Create POST Handler: Add a new POST handler designed to accept manual
>   entries. Implement backend safeguards:
>   - Reject negative numbers or non-numeric values.
>   - Prevent duplicate timestamp entries for the same account on the exact same
>     calendar day.
>   - Write valid data directly to the SQLite database without triggering
>     external network requests.
>
> **Step 3: Create Isolated UI Components with Advanced UX (Frontend)**
>
> - Create a brand new file named `components/audience-refresh-actions.tsx`. Do
>   not put this logic directly into the existing UI files.
> - Build a React component exporting the following advanced UI elements:
>   1. **Global & Granular Controls:** A "Refresh All" button with loading states
>      accounting for the 10-second staggered pauses, alongside individual
>      account refresh buttons (`?platform=...&handle=...`).
>   2. **Smart Input Parsing:** Automatically parse shorthand abbreviations and
>      formatting (e.g. converting `10.5k` or `1,500` into raw integers) to
>      prevent NaN errors.
>   3. **Real-time Visual Delta:** Instantly display an inline badge next to the
>      input showing net difference and percentage change compared to the last
>      recorded entry before submitting.
>   4. **Fat-Finger & Trend Warnings:** Warn the user via confirmation prompt if
>      an input represents an extreme anomalous spike/drop, while allowing
>      natural decreases (unfollows/purges) without a hard block.
>   5. **Stale Data & Shortcuts:** Softly highlight rows in yellow if they have
>      not been updated in over 30 days, and support saving via the `Enter` key.
>   6. **Optional Context Note:** Include a small text field to attach custom
>      notes to manual entries.
>
> **Step 4: Inject UI into the Dashboard (Frontend)**
>
> - Locate `components/audience-insights.tsx`.
> - Import the new `<AudienceRefreshActions/>` component.
> - Inject the global controls at the top of the audience view and map the
>   granular refresh and smart input components to their respective account rows.
>   Keep inline modifications in this file to an absolute minimum to prevent
>   future merge conflicts with the upstream repository.

---

## Where the build departed from the specification

Three substantive changes. Each was a decision taken because the specification
turned out to be describing something the codebase could not do, or something
that would have undermined the fork's own goal.

### 1. A bare GET does not scrape

**Specified:** *"If no parameters are present (bulk Refresh All), fetch all
configured accounts and process them sequentially."*

**Built:** `GET /api/live/audience` with no parameters is **read-only**. It
returns stored readings and makes no outbound request whatsoever. The staggered
sweep is on `?refresh=1`.

**Why:** the dashboard calls that bare endpoint every time the Audience tab is
opened. Under the specified behaviour, merely looking at the page would start a
sequential scrape of every account — roughly ninety seconds of traffic, held
behind a single-flight lock that blocks the page while it runs. The fork exists
to stop unrequested scraping; making page load trigger it would have defeated
the purpose.

Scraping now happens on exactly two paths, both explicit:

| Request | Behaviour |
| --- | --- |
| `GET /api/live/audience` | Reads local storage. No network. |
| `GET /api/live/audience?refresh=1` | Sequential sweep, 10s between accounts. |
| `GET /api/live/audience?platform=…&handle=…` | That one account only. |

### 2. Readings are not stored in SQLite alone

**Specified:** *"Write valid data directly to the SQLite database."*

**Built:** a manual entry writes to **both** `snapshots.json` and SQLite.

**Why:** the premise was wrong about where audience history lives. Upstream keeps
it in `snapshots.json`, read and written by `lib/server/audience.ts`. SQLite
exists in this app, but it backs the content archive, workspace, brief, industry,
collector cache and newsletter stores — audience has never been in it. Writing a
manual reading only to SQLite would have produced a number invisible to the
charts, the 24–36 hour baseline, and the recorded-values table.

So the split is deliberate:

- **`snapshots.json`** receives the numeric sample, so a hand-entered value flows
  through every existing chart exactly like a scraped one. It also takes
  precedence over a scraped sample in the same 12-hour bucket.
- **`control-center.sqlite`** gains an `audience_manual_entries` table holding the
  ledger — account, value, note, local calendar day, timestamp. This is what
  satisfies "write to SQLite", and it gives the note and the per-day uniqueness
  rule somewhere to live. `AudienceSample` has no `note` field, and its parser
  whitelists keys, so a note written into the JSON would be silently dropped on
  the next read.

The table is created additively and the schema version is unchanged, so the same
data directory still opens in an upstream build — it simply ignores the extra
table.

### 3. The duplicate rule applies to manual entries only

**Specified:** *"Prevent duplicate timestamp entries for the same account on the
exact same calendar day."*

**Built:** a second **manual** entry for the same account on the same local
calendar day is rejected with `409`, and the UI offers an explicit **Replace
today's entry** action. Scraped readings never block a manual entry.

**Why:** taken literally, any reading that day would block manual entry — so a
single **Refresh all** would lock the feature out until midnight, on exactly the
accounts most likely to need it. The `409`-plus-replace path also means a typo
can be corrected the same day rather than being frozen in until tomorrow.

"Calendar day" is the server's local day, because that is the day the person
typing sees. History itself is stored as UTC timestamps.

### Smaller departures

- **`&id=` is accepted** alongside `platform` and `handle`. Handles can be
  renamed and labels can collide; the account id cannot. `platform`+`handle` is
  tried first, exactly as specified, with `id` as a fallback.
- **The stale tint is on the controls block** inside each account card rather
  than the whole card, using the existing `--watch` palette so it is theme-aware
  in both light and dark.
- **`components/control-center.tsx` needed changes too.** The specification
  scoped UI edits to `audience-insights.tsx`, which held — four small edits
  there. But updated data has to reach the view after a refresh or a save, so
  `control-center.tsx` gained a `mutate` destructure, two payload fields, and one
  callback prop.

---

## What shipped

Implementation commit: `601469b`.

New files — all of the real logic lives here, so upstream has nothing to conflict
with:

| File | Purpose |
| --- | --- |
| `lib/server/audience-refresh.ts` | Targeted and staggered refresh, read-only reads, manual entry recording |
| `lib/audience-manual-store.ts` | The `audience_manual_entries` SQLite table |
| `components/audience-refresh-actions.tsx` | Global and per-account controls, smart input |
| `components/audience-refresh-actions.module.css` | Its styles |

Changed files, kept as small as possible:

| File | Change |
| --- | --- |
| `lib/server/scheduler.ts` | Interval constant; removed audience from the loop |
| `components/control-center.tsx` | Interval at 5 sites; `mutate`, 2 fields, 1 prop |
| `components/audience-insights.tsx` | 1 import, 3 optional props, 2 JSX injections |
| `app/api/live/audience/route.ts` | Rewritten: targeted GET, staggered GET, new POST |
| `lib/server/audience.ts` | Five `export` keywords added. No logic changed |
| `lib/server/database.ts` | One line, registering the new table |

`lib/server/audience.ts` was deliberately left alone beyond making five existing
helpers importable. `collectAudience()` and `collectAudienceNow()` are byte-for-
byte upstream, and are no longer called by this fork's routes.

Verified with `npm run check` — lint clean, 214 of 215 tests passing (1 skipped,
0 failing), production build succeeding.

---

## What deliberately did not change

- **Every other collector.** Industry, Mentions and Newsletters still run on the
  background scheduler. Only its interval moved.
- **The scraping logic itself.** How a profile is parsed, how identity is
  verified, the API-credential fallbacks — all untouched upstream code.
- **The chart and history pipeline.** `lib/audience-growth.ts` and
  `lib/audience-charts.ts` are unmodified. Manual readings are fed through the
  same 12-hour bucketing and 24–36 hour baseline as scraped ones.
- **The security model.** `proxy.ts` still rejects any non-loopback `Host`. No
  authentication was added and none was removed.
- **The database schema version.** Still 6.

---

## Known limitations

- **The 4-hour client poll still sweeps.** `useLiveData` always polls its manual
  endpoint, which for audience is `?refresh=1`. With the Audience tab left open,
  a staggered sweep therefore fires every four hours. It is sequential and paced,
  and it stops when the tab closes — but it is not zero. Making it fully passive
  means changing `useLiveData`, which four other views share.
- **Access requires an SSH tunnel.** A consequence of upstream's loopback-only
  `Host` check, not of this fork. A configurable trusted-host setting, paired
  with real authentication, is the obvious future change — see DEPLOYMENT.md.
- **`npm test` fails on Windows shells.** `tsx --test tests/*.test.ts` relies on
  glob expansion that cmd.exe and PowerShell do not perform. Works from bash.
  Pre-existing upstream, unfixed here.
- **Datacenter IPs still get blocked.** Pacing helps; it cannot disguise where
  traffic comes from. Manual entry is the fallback, by design.
