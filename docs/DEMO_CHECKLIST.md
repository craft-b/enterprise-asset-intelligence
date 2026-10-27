# Demo checklist

One cold pass before sharing the link. Run it in a **private window**, so you
see what a stranger sees rather than what your session remembers.

The point of this file is to make the pass *bounded*: note everything, fix
nothing until the end, and know in advance which empty panels are defects and
which are documented limits. Chasing them one at a time is how a demo never
ships.

---

## 0. Warm both services first

Free instances suspend after ~15 minutes idle. The API wakes in ~30s and the
ML service in ~60s, and they sleep independently.

```bash
curl -s -o /dev/null -w "ml  %{http_code} in %{time_total}s\n" https://eai-ml.onrender.com/health & curl -s -o /dev/null -w "api %{http_code} in %{time_total}s\n" https://eai-api-q3u3.onrender.com/api/health & wait
```

Both at once, so you pay one wait instead of two. Wait for both lines, then
open the app. There is deliberately no keep-alive pinger: free instance hours
are pooled across the account, so warming both continuously would exhaust the
monthly allowance. See `render.yaml`.

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

Measured against the live database on 2026-10-21, when the seed built a
ten-asset fleet. The seed now builds sixty, so **every count below is the old
fleet's and has to be re-measured after the next reseed** — they are left here
as the last figures actually observed rather than replaced with predictions.
The right-hand column says what the sixty-asset seed should produce; nothing in
it has been measured.

| | Measured (ten-asset seed) | Expected (sixty-asset seed, unmeasured) |
|---|---|---|
| Equipment | 10 units across 9 categories (only Crane has two) | 60 across the same 9, at least 4 each |
| Rentals / invoices / swaps | 15 / 10 / 2 | 15 / 10 / more — a swap needs a same-category spare, and now every category has one |
| Job sites / vendors | 6 / 4 | unchanged |
| Feature snapshots | 240 | ~1,440 |
| Maintenance events | 18 | ~68 (one pre-seed inspection per unit, plus injected failures) |
| Risk queue | 10 scored — **HIGH 3, MEDIUM 6, LOW 1** | 60 scored, ~12 HIGH by fleet age |
| Multi-horizon forecasts | 10 | 60 |
| Model metrics | v1.17, 96 rows, **dataset_size 10,828** | unchanged unless training succeeds |
| Simulation cursor | 2026-10-21, 90 days run | unchanged |
| Users | 2 (admin, viewer) | unchanged |

If the risk bands differ, something rescored the fleet — not necessarily
wrong, but it means these numbers moved and the ones here are stale.

---

## 3. Page by page

- **Fleet / equipment** — 10 units, statuses populated, no blank cells.
- **Risk queue** — 10 rows, three bands present. A queue with no LOW row or no
  HIGH row is worth noting.
- **Equipment detail** — SHAP drivers (three per asset) and a recommendation
  string. The recommendation is the deterministic template, not an LLM.
- **Rentals** — 15, with the two equipment swaps visible and same-category.
- **Model page** — v1.17, Training Dataset Size **10,828**, metrics across
  three horizons and two CV splits (temporal and by-asset).
- **ML dashboard** — see section 4 before deciding anything is broken.
- **Simulation** — cursor at 2026-10-21.

---

## 4. Empty by design — do not chase these

Every one of these is documented in the README's limitations section. The thing
to check is **not** whether the panel has data; it is whether the panel
**explains itself**.

Three rows that used to live here have moved out of it. The ten-asset fleet
could not reach the drift floors; sixty can, so those panels are no longer
expected to be empty **once the database has been reseeded**. On a database
still holding the old fleet they stay blank, and the cards say so themselves.

| Panel | Why it is empty |
|---|---|
| Feature drift | Baseline present (4 features, 3 horizons). A PSI needs 20 snapshots in a batch — reached at 60 assets, not at 10. |
| Prediction drift | Same floor. Populates after a scoring run on the sixty-asset fleet; blank on a stale ten-asset database. |
| Bias drift | Needs 3 units in a category. Every category now has at least 4, so this populates after a scoring run — it was impossible, not merely unreached, on the old fleet. |
| "Train model" seed step | Still expected to report **skipped, with a reason** — but a different reason. 1,380 labelled rows clear the 500-row data-quality gate, so it now attempts a real run and is expected to run out of memory on a 512MB instance. If it reports success, the metrics on the model page are a model trained here; read them as such. |
| MLflow run | `MLFLOW_TRACKING_URI` unset — logging is a deliberate no-op. |
| LLM recommendations | `GENAI_RECOMMENDATIONS=off`. Deterministic template only. |

**A panel that is blank with no explanation IS a defect.** A panel that states
its own reason is the system working. That distinction is the whole checklist.

---

## 5. Optional: the admin pass

Only if you want to exercise the write paths. Use the rotated password.

- **Refresh Risk Queue** — expect completion and a rescored fleet.
- **Run Multi-Horizon Forecast** — expect completion; drift stays skipped, for
  the reasons in section 4.
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
