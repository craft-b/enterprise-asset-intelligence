# Demo checklist

One cold pass before sharing the link. Run it in a **private window**, so you
see what a stranger sees rather than what your session remembers.

The point of this file is to make the pass *bounded*: note everything, fix
nothing until the end, and know in advance which empty panels are defects and
which are documented limits. Chasing them one at a time is how a demo never
ships.

---

## 0a. Before warming anything: what a stranger sees

**Run this first or not at all.** Every other step in this document warms the
services, and once warmed they stay warm for about fifteen minutes, so this
measurement is available only on the first attempt of a session.

The pass used to begin by warming both services, which meant it could not see
the path a visitor actually takes. A link sent to someone who opens it that
evening lands on two suspended containers. That is the common case for a shared
demo and it was the one case never tested.

1. Leave both services idle at least fifteen minutes. Touching either one —
   including a health check — restarts that clock.
2. Open the site the way a stranger would: a private window, no session.
3. Record: how long until anything renders, what the startup screen says, and
   whether it explains itself or merely spins.
4. Then sign in and record the second wait, for the ML service, separately.

The two waits are independent. ApiGate covers the Node API; the ML service
suspends on its own schedule and is not consulted until a page asks it for
something, so a visitor can clear the first wait and meet a second one with no
explanation. See section 7.

---

## 0. Warm both services first

Free instances suspend after ~15 minutes idle, and they sleep independently.

```bash
curl -s -o /dev/null -w "ml  %{http_code} in %{time_total}s\n" --max-time 150 https://eai-ml.onrender.com/health & curl -s -o /dev/null -w "api %{http_code} in %{time_total}s\n" --max-time 150 https://eai-api-q3u3.onrender.com/api/health & wait
```

Both at once, so you pay one wait instead of two. Wait for both lines, then
open the app.

**Measured, not estimated.** ML cold starts, eight observations across several
days: **42, 51, 61.5, 61.5, 62, 62.9, 63.1, 71.9 seconds** — so budget 75s and
do not conclude anything is broken before then. A cold start after hours idle
sits at the top of that range because the image may need pulling again.

What those seconds are, from one wake measured against the build stamp: a
request at 02:49:44 reached a container whose process started at 02:50:06 and
answered 38.7s later. So **~22s of host-side scheduling and image pull before
Python runs at all, then ~39s of application boot** — loading three models,
the encoder and the clip thresholds. Neither half is a hang, and the first
half is not something the service can report on, because it is not running
yet. That split only became visible once /health carried `booted_at` and
`uptime_seconds`; before `3aab1c5` the whole interval was one opaque wait.

Warm, once both are up — three samples each, 2026-10-28:

| | TTFB |
|---|---|
| ML `/health` | 0.38 / 0.48 / 0.68s |
| API `/api/health` | 0.29 / 0.38 / 0.50s |
| Frontend | 0.26 / 0.32 / 0.34s |

The distance between those two tables is the entire reason this section exists.

**Let the command above run to completion.** Interrupting a wake is not a
neutral observation of it: the request being held open is what keeps the
container booting, and killing it starts the boot from nothing. A browser tab
polling every ten seconds held one cold start off for **640 seconds** before
this was fixed in `7a67e5c`, while a plain `curl` against the same service woke
it in 71.9. The app no longer does that — one unbounded request holds the boot
and everything else waits on it — but a terminal still can, so let the curl
finish rather than Ctrl-C'ing and retrying.

**What is deployed, in three unauthenticated requests.** All three tiers answer
in the same vocabulary, so a mismatch is visible without logging in:

```bash
curl -s https://eai-api-q3u3.onrender.com/api/health | grep -o '"commit":"[^"]*"'
curl -s https://eai-ml.onrender.com/health | grep -o '"commit":"[^"]*"'
curl -s https://enterprise-asset-intelligence.vercel.app/ | grep -o 'build-commit" content="[^"]*"'
```

Three different commits is not necessarily wrong — Render's build filters mean
a client-only change never rebuilds the ML service — but it is the first thing
to check when behaviour does not match the code you just read.

There is deliberately no keep-alive pinger: free instance hours are pooled
across the account, so warming both continuously would exhaust the monthly
allowance. See `render.yaml`.

---

## 1. Sign in

- Account: **`viewer` / `viewer123`** — the advertised account, read-only at the
  route layer, not by convention.
- Expect the dashboard.
- **Wrong if** you land on `/setup`: that screen only appears on an unseeded
  database, so seeing it means the data is gone.

The `admin` password has been rotated and is **not** the one in
`server/seeds/demo-users.ts`. That constant is still correct for a fresh
database; it is no longer correct for this deployment.

---

## 2. What should be there

Every figure here carries how it was obtained. The version of this table that
this replaces had a column headed "expected (sixty-asset seed, unmeasured)",
which is the one thing a checklist must not contain: checking an observation
against a guess teaches you nothing about the system, and it is how the rest of
this table went stale without anyone noticing.

**Confirmed on the sixty-asset fleet, 2026-10-28:**

| | Value | How |
|---|---|---|
| Multi-horizon forecasts | **60 assets** at 10 / 30 / 60 days | scoring run ran to completion |
| Risk bands after scoring | **15 HIGH** of 60 | read off the risk queue |
| Model serving | **v1.17**, `model_loaded: true` | `GET /health`, unauthenticated |
| Model label on the dashboard | **`ml-v1.17`** | was wrongly `rule-based`; fixed in `4342e72` |
| Drift batch size | **batch of 60** | drift card header, after `a2bb7c4` |
| Drift monitors | all three populated | first run to clear `MIN_BATCH_SIZE = 20` |
| Cold-start banner | clears unaided at **~70s** | after `7a67e5c` |
| Model page | feature importance and hyperparameters render | confirmed after `8b926d7` removed `ml-service/registry` from the API image; the data comes over HTTP from the ML service |

**Read off the deployed app during the demo pass, 2026-10-29:**

| | Measured | Ten-asset seed, 2026-10-21 |
|---|---|---|
| Equipment | **60 units, 8 categories** | 10 units across 9 categories |
| Risk bands | **14 HIGH / 27 MEDIUM / 19 LOW** | — |
| Rentals / invoices / swaps | **15 / 10 / 2** | 15 / 10 / 2 |
| Job sites / vendors | **6 / 4** | 6 / 4 |
| Model metrics | **dataset_size 10,828**, 3 horizons, 2 CV splits | v1.17, 96 rows, dataset_size 10,828 |

Two things the pass could not read, and they come out of this table rather than
being guessed at: the **metrics row count**, which the Model Performance page
does not display, and **feature snapshots / maintenance events / simulation
cursor / user count**, which were not reached before the pass was diverted into
the wake failure in section 7. A figure a doc promises and the app does not show
is a defect in the doc.

**What the measured column says that the old one did not.**

The rental, job-site and vendor counts are *identical* to the ten-asset seed,
because `server/seeds/rentals.ts` is a hardcoded fifteen-entry list whose
equipment indices run 0–9. The fleet grew to sixty and the rental data did not
come with it, so fifty units have no rental history and the rental-derived
features are degenerate for them. This is invisible on screen — the asset
History card merges maintenance with rentals and maintenance *did* scale — so
nothing looks wrong. See `docs/ML_KNOWN_WORK.md`.

`dataset_size` is also unchanged at 10,828, which means the champion was trained
on the ten-asset seed and is scoring sixty assets. That is defensible and the
by-asset CV split on the same page is the evidence for it — the model is tested
against machines it has never seen. It is worth saying out loud before someone
works it out.

---

## 3. Page by page

- **Fleet / equipment** — 60 units across **8** categories, statuses populated,
  no blank cells. (This line said nine until 2026-10-29; the nine came from the
  ten-asset seed and had never been re-read off the app.)
- **Risk queue** — 60 rows, three bands present. The split moves between
  scoring runs as borderline assets cross a threshold (15 HIGH on 2026-10-28,
  14 HIGH on 2026-10-29), so do not read a one-row difference as a fault. What
  matters is that the bands are *not uniform*: a queue that is all LOW at
  probability 0.05 is the cold-start rule rather than the model — see
  `COLD_START` in `server/services/imputation.ts`.
- **Equipment detail** — the "Why this risk score" card, with up to **five**
  SHAP attributions per horizon across **three** horizons (the old "three per
  asset" here was the horizon count written down as a driver count). Labels name
  the quantity measured and never a direction; the sign and colour carry that.
  Also a recommendation string, which is the deterministic template, not an LLM.
- **Rentals** — 15 rentals, 2 swaps, same-category. Covers only the first ten
  assets; see the note under section 2.
- **Model page** — v1.17, Training Dataset Size **10,828**, metrics across
  three horizons and two CV splits (temporal and by-asset).
- **ML dashboard** — all three drift monitors should now carry readings, and
  each alerting card should explain why it is alerting. See section 4 before
  deciding anything is broken.
- **Simulation** — cursor at 2026-10-21.

---

## 4. Empty by design — do not chase these

Every one of these is documented in the README's limitations section. The thing
to check is **not** whether the panel has data; it is whether the panel
**explains itself**.

The three drift panels have left this section for good. They were listed here
as empty-by-design because a ten-asset fleet could not reach the drift floors;
sixty assets clear them, and **all three were confirmed populated on
2026-10-28**. They are now in section 2 as measured values. If any of them is
blank after a scoring run on the current fleet, that is a defect to report, not
a documented limit — which is the opposite of what this file said a week ago.

| Panel | Why it is empty |
|---|---|
| "Train model" seed step | Expected to report **skipped, with a reason**. 1,380 labelled rows clear the 500-row data-quality gate, so it attempts a real run and is expected to run out of memory on a 512MB instance. If it reports success, the metrics on the model page are a model trained here; read them as such. |
| MLflow run | `MLFLOW_TRACKING_URI` unset — logging is a deliberate no-op. |
| LLM recommendations | `GENAI_RECOMMENDATIONS=off`. Deterministic template only. |

A drift card **ALERT** is not an entry for this section either way. The seeded
fleet is weighted toward aged, high-duty units, so its distributions really do
differ from the training sample and the detectors are right to say so. Each
alerting card carries that explanation itself as of `e778f35`; a red card with
no explanation is the defect, not the red card.

**A panel that is blank with no explanation IS a defect.** A panel that states
its own reason is the system working. That distinction is the whole checklist.

---

## 5. Optional: the admin pass

Only if you want to exercise the write paths. Use the rotated password.

- **Refresh Risk Queue** — expect completion and a rescored fleet.
- **Run Multi-Horizon Forecast** — expect completion in roughly 40-90s on a
  warm service, and **all three drift monitors to populate**. Drift no longer
  stays skipped: sixty assets clear `MIN_BATCH_SIZE = 20` in a single batch,
  which ten never could. Expect ALERT states, and expect them to be correct —
  the fleet is seeded toward aged, high-duty units, so it genuinely differs
  from the training distribution. Each card says so itself.
- If this fails with "still waking", the service was asleep; the client retries
  and the second or third attempt lands. A failure after the banner has cleared
  is a real failure and worth reporting.
- **Load Demo Data** — appends rather than truncates. Pressing it on a seeded
  database gives you a second fleet. Use **Reset** first if you mean to rebuild.

---

## 6. How to run the pass

1. Run section **0a** first, from cold, or skip it for this session — it
   cannot be recovered once anything is warmed.
2. Go through sections 1–4 without fixing anything. Write down what you see.
3. Sort each note into **wrong** (the system says or does something false) or
   **limited** (a real data constraint). Wrong gets fixed; limited gets
   documented.
4. Fix in one batch, one commit per category.
5. Re-run sections 0–4 once.

A figure this document asserts and the app does not display is itself a defect:
it sends the next reader hunting for something that is not there. Three of the
ten faults found on 2026-10-29 were stale numbers in this file rather than
faults in the app, so check the doc against the screen in both directions.

**Done when every empty state explains which of its reasons applies, and the
README's limitations section matches what the app shows.** Not when there is
nothing left to improve.


---

## 7. The wake path, and why it kept being wrong

The ML service suspends after about fifteen minutes and takes 42–72.5 seconds
to come back (ten observations). The build stamp splits that: a request on
2026-10-29 reached a container whose process started 34 seconds later and
answered 39.9 seconds after that. Roughly half the wait is the host scheduling
and pulling an image before any application code exists, which is why no
instrumentation inside the service can report it.

Three production failures have come out of this path, all with one shape: **the
component reporting on the cold start was the thing preventing it.**

1. **Probes aborted into the boot.** The banner polled `/api/ml/health` every
   five seconds and the route turned each poll into a request aborted at four
   seconds. An abort tears down the request the host uses to hold a cold start
   open. One tab reached 370 seconds.
2. **Caching halved the rate of the same abort.** One aborted probe every ten
   seconds instead of every five. A seventy-second boot was still torn down
   seven times per attempt. One tab reached 640 seconds, while a plain `curl`
   woke the same service in 71.9. *Reducing the rate of a fatal interruption is
   not a fix*, and it read as one for most of a day.
3. **The API locked itself out of the host.** Suppressing the nudge under a 429
   was right; leaving the probes at a ten-second TTL was not. The probe drew a
   429, the 429 cancelled the nudge, nothing asked the container to start, and
   the next probe kept the limit alive. One tab reached 2300 seconds against a
   service that was merely asleep and that answered every other address
   normally. Fixed in `9fbe7e5`: a rate-limited reading is held for a minute.

**If the banner climbs past ~120 seconds, do not assume a cold start.** Read
`/api/ml/health` directly — signed in, against the API origin, not the static
host, which has no session cookie:

```
https://eai-api-q3u3.onrender.com/api/ml/health
```

The `reason` field names the branch taken: `rate-limited by the host` is the
API locked out, `unreachable` is a wrong `ML_SERVICE_URL`, `no answer within
4000ms` and `starting up` are both ordinary.

**A warning about measuring this at all.** A direct probe from anywhere wakes
the service, so a probe run to diagnose a wake failure destroys the evidence
for it — and will make the next banner clear on time for a reason that has
nothing to do with any fix. Every clean clear observed on 2026-10-29 followed a
diagnostic `curl` from the machine doing the diagnosing, which is how the
second fix above was mistaken for a working one. When testing a wake, touch
nothing and let the app do it.
