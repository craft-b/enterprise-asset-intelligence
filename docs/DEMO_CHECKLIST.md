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

Verified against the live database on 2026-10-21:

| | |
|---|---|
| Equipment | 10 units across 9 categories (only Crane has two) |
| Rentals / invoices / swaps | 15 / 10 / 2 |
| Job sites / vendors | 6 / 4 |
| Feature snapshots | 240 |
| Maintenance events | 18 |
| Risk queue | 10 scored — **HIGH 3, MEDIUM 6, LOW 1** |
| Multi-horizon forecasts | 10 |
| Model metrics | v1.17, 96 rows, **dataset_size 10,828** |
| Simulation cursor | 2026-10-21, 90 days run |
| Users | 2 (admin, viewer) |

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

| Panel | Why it is empty |
|---|---|
| Feature drift | Baseline present (4 features, 3 horizons, 0 bias categories). No PSI reading: a batch needs 20 snapshots and scoring 10 assets produces 10 rows. |
| Prediction drift | Same 20-row floor, same 10-asset fleet. |
| Bias drift | Needs 3 units in a category. Nine categories, at most two units in any. Impossible on this dataset, not merely unreached. |
| "Train model" seed step | Reported **skipped, with a reason**. The data-quality gate refuses training below 500 labelled rows. Nothing is trained on demo data; the fleet is scored by the v1.17 champion baked into the ML image. |
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
