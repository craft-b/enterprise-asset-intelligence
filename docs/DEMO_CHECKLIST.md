# Demo checklist

One cold pass before sharing the link. Run it in a **private window**, so you
see what a stranger sees rather than what your session remembers.

The point of this file is to make the pass *bounded*: note everything, fix
nothing until the end, and know in advance which empty panels are defects and
which are documented limits. Chasing them one at a time is how a demo never
ships.

---

## 0. Warm both services first

Free instances suspend after ~15 minutes idle, and they sleep independently.

```bash
curl -s -o /dev/null -w "ml  %{http_code} in %{time_total}s\n" --max-time 150 https://eai-ml.onrender.com/health & curl -s -o /dev/null -w "api %{http_code} in %{time_total}s\n" --max-time 150 https://eai-api-q3u3.onrender.com/api/health & wait
```

Both at once, so you pay one wait instead of two. Wait for both lines, then
open the app.

**Measured, not estimated.** ML cold starts, seven observations across several
days: **42, 51, 61.5, 62, 62.9, 63.1, 71.9 seconds** — so budget 75s and do
not conclude anything is broken before then. A cold start after hours idle
sits at the top of that range because the image may need pulling again.

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

**Last observed on the ten-asset seed, 2026-10-21 — not re-measured.** Kept
because a stale observation is still a fact about a known past state, where a
prediction is nothing. Do not treat these as what the app should show now:

| | Last observed (ten-asset seed) |
|---|---|
| Equipment | 10 units across 9 categories (only Crane had two) |
| Rentals / invoices / swaps | 15 / 10 / 2 |
| Job sites / vendors | 6 / 4 |
| Feature snapshots | 240 |
| Maintenance events | 18 |
| Model metrics | v1.17, 96 rows, **dataset_size 10,828** |
| Simulation cursor | 2026-10-21, 90 days run |
| Users | 2 (admin, viewer) |

**To close the gap:** read those eight numbers off once during the pass and
replace the table. Every one is on a page sections 3 and 5 already visit, so it
costs only the writing down.

They are blank rather than filled with plausible values because the production
database is reachable only from Render's own environment — the repository's
`.env` points at a development instance — so no one has measured them. Writing
down what they probably are is exactly what produced the column this section
replaced.

---

## 3. Page by page

- **Fleet / equipment** — 60 units across 9 categories, statuses populated,
  no blank cells.
- **Risk queue** — 60 rows, three bands present; 15 HIGH as of 2026-10-28. A
  queue with no LOW row or no HIGH row is worth noting. A uniform LOW queue at
  probability 0.05 is the cold-start rule, not the model — see `COLD_START` in
  `server/services/imputation.ts`.
- **Equipment detail** — SHAP drivers (three per asset) and a recommendation
  string. The recommendation is the deterministic template, not an LLM.
- **Rentals** — with the equipment swaps visible and same-category. Count
  unverified on the current fleet.
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

1. Go through sections 1–4 without fixing anything. Write down what you see.
2. Sort each note into **wrong** (the system says or does something false) or
   **limited** (a real data constraint). Wrong gets fixed; limited gets
   documented.
3. Fix in one batch, one commit per category.
4. Re-run sections 0–4 once.

**Done when every empty state explains which of its reasons applies, and the
README's limitations section matches what the app shows.** Not when there is
nothing left to improve.
