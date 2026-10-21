# Enterprise Asset Intelligence

**[Live demo](https://enterprise-asset-intelligence.vercel.app)** — sign in with `admin` / `admin123`.

> The page loads instantly, but the API behind it runs on a free tier that suspends an idle
> container. If nobody has visited recently the first request waits around a minute while it wakes;
> the app shows that as a progress screen rather than a blank window, and everything is immediate
> afterwards. The ML service sleeps separately, so the first prediction can wait once more.
> Prefer to skip the wait entirely? [Quickstart](#quickstart) runs the whole stack locally in a
> couple of minutes.

Predictive maintenance platform for heavy construction equipment rental fleets — encoding the same failure-prediction and risk-scoring logic used in industrial and manufacturing equipment reliability programs. Asset degradation curves, hazard functions, and maintenance-interval optimization transfer directly from a production line's rotating equipment to a rental fleet's excavators and skid steers, which is the direct link to 26 years of CPG/manufacturing process engineering behind this project. It's a full-stack system that simulates fleet operations, engineers features from operational data, trains calibrated Random Forest models, and serves multi-horizon failure probability predictions across 10, 30, and 60-day windows — with cost-optimized intervention recommendations and a rental dispatch risk guard.

## Why This Project

This is the second of two portfolio repositories, deliberately built to be complementary rather than redundant:

- **FormulaForge** demonstrates LLM/RAG application engineering — retrieval pipelines, prompt design, grounding a model in a CPG formulation knowledge base.
- **Enterprise Asset Intelligence** (this repo) demonstrates classical ML + MLOps engineering — feature engineering from raw operational data, calibrated multi-horizon classifiers, temporal validation, drift monitoring, and model governance. This is the "practical ML floor": the skills that transfer directly from process-engineering discipline (SPC, reliability curves, maintenance scheduling) into applied ML roles, independent of any particular LLM.

---

## What It Does

- **Multi-horizon failure prediction** — Three separate calibrated Random Forest models score every asset across 10d, 30d, and 60d windows (LOW / MEDIUM / HIGH) based on 31 engineered features
- **60-day trajectory projection** — Forward-projects failure probability curves by analytically aging features at 7-day steps, with HIGH-threshold crossing detection
- **Cost model** — Identifies the optimal PM intervention day by comparing expected failure cost against scheduled maintenance cost, surfaced per-asset in the UI
- **Rental dispatch guard** — Blocks or warns dispatchers when HIGH/MEDIUM risk equipment is selected for a new rental, with mandatory risk acknowledgement for HIGH-risk dispatches
- **Fleet simulation engine** — Discrete-event simulator advances a cursor date, generates sensor readings, fires maintenance events via a Weibull-inspired hazard function, and handles fleet renewal (retirement + replacement) automatically
- **ML pipeline** — Full automated pipeline: feature snapshot generation → failure labeling → model training → inference, all triggerable from the admin UI
- **MLflow experiment tracking** — Every training run logs hyperparameters, per-horizon metrics (ROC-AUC, PR-AUC, recall, F1), per-fold CV scores, model artifacts, and feature importance JSONs under the `equipment-failure-multihorizon` experiment
- **SHAP explainability** — `TreeExplainer` runs at inference time; top 5 features by |SHAP value| are returned with every prediction for per-asset attribution. On the bundled simulator these attributions recover the generator rather than discover anything — failures are drawn from a function of age, hours and maintenance recency and the model receives all three — so the UI renders that caveat inline. The machinery is real; only the dataset makes it circular
- **Three-layer drift detection** — Data drift (PSI on monitored features), prediction drift (distribution shift in 30d output scores), and bias drift (disparity in HIGH-rate across equipment categories); all persisted to `drift_metrics` table; dashboard surfaces per-feature PSI with STABLE / WARNING / ALERT status
- **Champion-challenger model governance** — Newly trained models enter registry as challengers; shadow-score every batch alongside champion without persisting results; admin promotes challenger to champion via `POST /api/ml/models/promote` with zero downtime (in-memory hot-swap); full audit history in `model_registry.json`
- **Pre-training data quality gate** — 8-check validator (row count, label completeness, class balance, null rates, physical bounds, non-zero required features, temporal spread, duplicate snapshots) blocks training on FAIL, warns on marginal data, PASS/WARN/FAIL summary in training log
- **Prevalence-honest calibration** — Random Forests calibrated (`CalibratedClassifierCV`) on the untouched, real-prevalence dev set with `class_weight='balanced'` (no SMOTE), so the emitted failure probability isn't inflated by resampling; Brier score + expected calibration error published per horizon
- **Agent API** — Bearer-token authenticated endpoints (`GET /api/agent/model-health`, `POST /api/agent/actions`) for programmatic and LLM agent access; returns consolidated health snapshot with machine-readable `recommended_action`
- **Automated monitoring** — `monitor.py` cron script polls model health, logs three-layer drift per feature, auto-triggers retraining or reference recomputation based on drift state, and fires Slack webhook alerts when action is needed or any drift layer reaches WARNING/ALERT; supports `--loop` mode for continuous polling
- **GenAI recommendations (opt-in)** — with `GENAI_RECOMMENDATIONS=on` and a provider key, the Groq LLM turns a single asset's structured risk facts (worst horizon, drivers) into plain-English maintenance prose, validated and falling back to a deterministic template on any failure; **off by default**, and batch scoring always uses the template
- **ML metrics dashboard** — Live feature importance, confusion matrix, per-class precision/recall/F1, prediction distribution over time, hyperparameter display, drift monitor card, champion-challenger comparison table, and data quality report card

---

## Architecture

```
Browser
  │
  ▼
React SPA (Vite, port 5173)
  │
  └── /api/*  →  Node.js / Express (port 5000)
                    │
                    ├── MySQL 8
                    │
                    └── http://localhost:8000  →  FastAPI ML Service (port 8000)
                                                    │
                                                    ├── MySQL 8 (read, training)
                                                    ├── Groq API (recommendations)
                                                    └── ml-service/registry/ (model artifacts)
```

**Stack:**

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS, shadcn/ui, Recharts, TanStack Query |
| API | Node.js, Express, Drizzle ORM |
| ML Service | Python 3.12, FastAPI, scikit-learn, pandas, SQLAlchemy |
| Database | MySQL 8 |
| Experiment Tracking | MLflow 2.16 |
| Explainability | SHAP 0.51 (TreeExplainer) |
| Drift Detection | PSI (data), output distribution (prediction), category disparity (bias) |
| Model Governance | Champion-challenger registry, shadow scoring, zero-downtime promotion |
| Data Quality | 8-check pre-training gate (row count, balance, nulls, bounds, temporal spread) |
| CI | GitHub Actions — lint (ruff), ML smoke-test, TypeScript typecheck (tsc), Node unit tests (vitest) |
| LLM | Groq (llama-3.1-8b-instant) |

---

## ML Models — v1.17

> **⚠️ Data source: simulated, and the short-horizon metrics are saturated.**
>
> Operational data comes from a fleet simulator whose failures are Bernoulli draws from a
> closed-form hazard over three variables — asset age, lifetime hours, and days since
> maintenance (`server/routes.ts`). The model receives all three directly, plus features
> derived from them, plus counts and costs of prior draws from the same hazard. The learning
> task is therefore to recover a known monotone function of its own inputs.
>
> That caps how informative the AUC can be. Because labels are Bernoulli draws, even an oracle
> that knows the exact probability cannot reach 1.0. `ml-service/analysis/bayes_ceiling.py`
> computes that ceiling by reproducing the hazard verbatim:
>
> | Horizon | Ceiling (oracle) | Reported | Reading |
> |---|---|---|---|
> | 10d | 0.84 – 0.92 | 0.9272 | inside the band — **saturated** |
> | 30d | 0.86 – 0.95 | 0.8823 | inside the band — **saturated** |
> | 60d | 0.87 – 0.95 | 0.8024 | below the band — headroom remains |
>
> The ceiling is a range because the simulator's fleet risk spread is not recorded; the range
> spans plausible spreads. Note that no model can beat an oracle, so 10d landing above the
> baseline estimate means the assumed spread is too narrow, not that the model won.
>
> **What this means.** At 10d and 30d the metric confirms the snapshot → label → train → serve
> pipeline wires up correctly and *cannot distinguish a good model from an adequate one* — any
> competent learner given these features lands in the same place, and tuning against those
> numbers would mean nothing. The 60d model is the one with real headroom left, which is also
> the horizon whose lead time is operationally useful.
>
> Nothing here is field predictive performance. See
> [docs/REAL_DATA_VALIDATION.md](docs/REAL_DATA_VALIDATION.md) for what has to happen before any
> metric can be quoted as such.
>
> ```bash
> cd ml-service && python -m analysis.bayes_ceiling
> ```

Three separate binary classifiers, one per prediction horizon. Each is a Random Forest calibrated on
the **real class prevalence** (no resampling — see calibration note below), trained on an embargoed
temporal holdout split with TimeSeriesSplit cross-validation, plus a by-asset grouped evaluation
(GroupKFold over equipment). One shared feature transform runs at train and serve time, and each
model serves its own version-pinned preprocessing artifacts.

**Training data:** 10,828 observed-outcome snapshots · 31 features · 2024–2032 simulation timeline
(45 rows censored for in-window predictive interventions, 630 horizon-censored). Labels derive only
from `REACTIVE_REPAIR` breakdown events in `(ts, ts+h]` — scheduled PM and model-driven
interventions are never counted as failures.

**v1.17 performance (simulated data):**

| Horizon | Split | ROC-AUC | PR-AUC | Recall @ HIGH | Brier | ECE |
|---|---|---|---|---|---|---|
| 10d | temporal | 0.9272 | 0.8111 | 89.2% | 0.072 | 0.074 |
| 10d | by-asset | 0.9602 | — | — | — | — |
| 30d | temporal | 0.8823 | 0.8079 | 77.2% | 0.080 | **0.032** ✓ |
| 30d | by-asset | 0.9335 | — | — | — | — |
| 60d | temporal | 0.8024 | 0.7847 | 64.1% | 0.122 | 0.054 |
| 60d | by-asset | 0.9030 | — | — | — | — |

*(v1.17 = v1.16 + the ML-12 config fix — `maintenance_config.recommended_interval_days` now
actually drives `maint_overdue`/`neglect_score`. Both are low-importance features, so metrics are
within noise of v1.16; the point is that train and serve now compute them identically.)*

Recall @ HIGH = failure-class recall at the 0.60 HIGH-band operating threshold. ECE = expected
calibration error (gate: < 0.05). The **temporal split** answers "same fleet, next quarter"; the
**by-asset split** (every asset scored by a model that never saw it) answers "a new customer's fleet,
day one". Precision@budget and lead-time (operator metrics) are on the ML dashboard per horizon.

**Calibration (ML-5) — before/after dropping SMOTE.** SMOTE was applied before the calibrator, so it
fit on a ~50% synthetic prevalence and the emitted probability was systematically inflated. Measured
on the holdout (mean predicted probability − actual failure rate):

| Horizon | Inflation before (SMOTE) | Inflation after (no SMOTE) | ECE before → after |
|---|---|---|---|
| 10d | +0.025 | +0.073 | 0.027 → 0.074 |
| 30d | +0.085 | **+0.005** | 0.085 → **0.034** |
| 60d | +0.066 | **−0.001** | 0.066 → 0.053 |

Dropping SMOTE eliminates the resampling-driven inflation at 30d/60d (the 30d probability goes from
+8.5 points over-confident to essentially honest, and clears the ECE gate). The 10d row moves the
other way: its calibrator is fit on the 41%-positive dev set but the 10d holdout is only 22% positive
(the aging fleet shifts prevalence across the temporal boundary), so residual over-prediction there is
distribution shift, not resampling — the by-asset and CV numbers are the fairer read for 10d.

**Honest observations these numbers surface:**

- The 10d model's median lead time (~6 days) sits *below* the ~7-day PM scheduling latency — the
  30d model (26-day median lead) is the operationally actionable horizon.
- These metrics are substantially lower than the originally published v1.14 numbers
  (e.g. 30d holdout ROC-AUC 0.9297 → 0.8728, CV 0.9853 → 0.9232). The v1.14 numbers were inflated by
  three defects, all fixed from v1.15 on: feature windows unbounded by snapshot date (features could
  see the label event — ML-1), no embargo at the holdout boundary (ML-3), and a training set where
  52% of rows were snapshots of assets before they existed — trivially predictable filler (11,713 of
  22,585 rows, removed in regeneration).
- Positive rates (41–58%) are far above real fleet failure rates. That is the simulator's hazard
  process, and one more reason none of this is quotable as field performance.

**Evaluation methodology:** each horizon's holdout is a single **temporal** split (most recent ~20%
of snapshots) with a per-horizon **embargo** — dev rows whose label window `[ts, ts+h]` crosses the
holdout boundary are dropped (80/239/451 rows for 10/30/60d). 5-fold `TimeSeriesSplit` CV
(gap = horizon days) runs on the dev portion for a variance estimate. The **by-asset** numbers are
pooled out-of-fold predictions from `GroupKFold(5)` over `equipment_id`. Rows whose outcome window
contains a `PREDICTIVE_INTERVENTION` before any failure are **censored** (`label_status`), not
labeled negative — otherwise the model's own successes would poison its future labels.
**Retrain triggers:** `monitor.py` polls `/api/agent/model-health` and auto-triggers retraining when
any monitored feature's PSI reaches the ALERT threshold (≥ 0.20) or when prediction/bias drift
crosses the same threshold; an admin can also trigger retraining manually via `POST /api/ml/train`.

---

## Feature Engineering

31 features computed per asset per snapshot date from raw operational tables:

```
asset_age_years, rental_days_30d, rental_days_90d, avg_rental_duration,
maintenance_events_90d, days_since_last_maintenance, vendor_reliability_score,
jobsite_risk_score, usage_intensity, usage_trend, utilization_vs_expected,
wear_rate, aging_factor, maint_overdue, mechanical_wear_score, abuse_score,
neglect_score, wear_rate_velocity, maint_frequency_trend, cost_trend,
hours_velocity, neglect_acceleration, sensor_degradation_rate, category_encoded,
log_total_hours_lifetime, log_hours_used_30d, log_hours_used_90d,
log_maintenance_cost_180d, log_cost_per_event, log_maint_burden,
log_mean_time_between_failures
```

Seven skewed features are log-transformed at training and inference time. Derived columns (aging_factor, wear_rate, mechanical_wear_score, etc.) are recomputed fresh at inference rather than stored — avoids staleness from schema drift.

> **⚠️ `sensor_degradation_rate` carried no information in v1.17.**
>
> The two queries that read `sensor_data_logs` used column names from a schema
> that was replaced when Drizzle took ownership of DDL — `engine_temperature`
> for `engine_temp`, `vibration_level` for `vibration_x/y/z`. Both raised
> `ER_BAD_FIELD_ERROR` on every call, and a `catch` returned `0` and `{}`
> instead, so the failure was silent.
>
> `sensor_degradation_rate` was therefore `0.0000` in every snapshot ever
> taken, including every row v1.17 trained on. A random forest does not split
> on a constant, so the feature is listed above, was passed at inference, and
> contributed nothing. The other sensor statistics it computes — vibration,
> engine temperature, oil and hydraulic pressure — were never model inputs;
> they feed snapshot and display fields only.
>
> The queries are fixed and a test now checks every `sensor_data_logs` column
> reference against the schema. The fix does not change v1.17's predictions,
> because a model trained on a constant ignores it whatever you feed it later.
> The feature becomes real on the next training run.
>
> Noted here rather than quietly corrected, for the same reason the oracle
> ceiling and the SHAP circularity are: a model card that only mentions the
> findings that flatter the model is not a model card. It is also a fair
> illustration of why the paragraph above this one exists — stale derived
> state is precisely what went wrong, and recomputing at inference did not
> help when the read itself was broken.

---

## ML Pipeline

All four stages are triggerable from the admin panel in the UI (ADMINISTRATOR role required):

```
1. Generate Snapshots   →  Backfills feature vectors across full simulation timeline (7-day intervals)
2. Label Snapshots      →  Marks 10d/30d/60d failure outcomes on each snapshot
3. Retrain Models       →  Trains v1.17+ models, hot-swaps on completion (~3 min)
4. Run Predictions      →  Scores all active fleet units with latest models
```

Training uses TimeSeriesSplit CV (5 folds, gap = horizon days) to prevent label leakage. Version is auto-incremented from the last DB record. Artifacts written to `ml-service/registry/`.

---

## Simulation Engine

A discrete-event simulator advances a cursor date day by day:

- **Sensor data** generated per equipment per day (engine temp, RPM, vibration, hydraulic pressure, etc.)
- **Maintenance events** fired probabilistically via a Weibull-inspired hazard function combining age hazard + hours hazard + neglect hazard
- **Fleet renewal** — equipment retired at age >10y OR (age >8y AND hours >8,000), replaced with `EQ-R{id}-{year}` pattern
- **Simulation cursor** — currently at 2032-04-08, 60 days run

---

## Project Structure

```
.
├── client/                        # React frontend (Vite)
│   └── src/
│       ├── components/            # Shared UI components
│       ├── hooks/
│       │   └── use-predictive-maintenance.ts  # TanStack Query hooks (predictions, drift, training)
│       ├── lib/
│       │   └── cost-model.ts      # Optimal PM intervention calculator
│       └── pages/
│           ├── predictive-maintenance-dashboard.tsx  # Fleet prediction UI + SHAP modal
│           └── ml-dashboard.tsx                      # Model metrics, drift monitor, MLflow stats
│
├── server/                        # Node.js API gateway
│   ├── routes.ts                  # All Express routes incl. agent API + drift proxy
│   └── services/
│       ├── feature-engineering-enhanced.ts       # Full 31-feature computation + velocity features
│       ├── feature-engineering-enhanced.test.ts  # Unit tests — pure derived-feature formulas
│       ├── feature-engineering.ts                # Base snapshot persistence
│       ├── risk-scoring.ts                       # Legacy heuristic risk score (pre-ML)
│       └── risk-scoring.test.ts                  # Unit tests — scoring/classification/explanation
│
├── ml-service/                    # Python FastAPI ML service
│   ├── api/
│   │   └── main.py                # FastAPI app — inference, drift, training endpoints
│   ├── engine/
│   │   ├── predictor_multihorizon.py  # Multi-horizon inference + SHAP attribution
│   │   ├── model_registry.py          # Champion-challenger registry — JSON-backed, numeric sort
│   │   ├── data_quality.py            # 8-check pre-training data quality gate
│   │   ├── drift_detector.py          # Three-layer drift detection (data/prediction/bias)
│   │   ├── projector.py               # 60-day forward projection engine
│   │   └── genai_advisor.py           # Groq recommendation generation
│   ├── training/
│   │   └── train_model_multihorizon.py  # Training pipeline — TimeSeriesSplit CV + MLflow logging + DQ gate
│   ├── tests/                     # 115 tests total (pytest)
│   │   ├── test_ml_engine.py          # inference, monotonicity, risk ordering, batch, schema
│   │   ├── test_train_smoke.py        # full training pipeline on synthetic data
│   │   ├── test_data_quality.py       # all 8 DQ checks + report structure
│   │   └── test_model_registry.py     # champion/challenger/promote/metrics (in-memory)
│   └── registry/                  # Versioned model artifacts
│       ├── rf_{h}d_v1.17.pkl
│       ├── clip_thresholds_v1.17.json
│       ├── feature_cols_v1.17.json
│       ├── metadata_{h}d_v1.17.json
│       └── feature_importance_{h}d_v1.17.json
│
├── monitor.py                     # Local cron script — polls agent API, auto-triggers retrain; --loop mode
├── .github/workflows/ml-ci.yml   # CI: lint (ruff), ML smoke-test, typecheck (tsc), Node unit tests (vitest)
└── shared/
    ├── schema.ts                  # Drizzle table definitions (source of truth)
    └── routes.ts                  # Shared API route/type definitions
```

---

## API Reference

Full interactive docs at **http://localhost:8000/docs** when running with
`ENABLE_API_DOCS=true` (set in `.env.example` and `docker-compose.yml`).
They are off by default because Swagger has to bypass the service-token
check to load its own schema, so on a reachable deployment it would publish
the whole API surface of an otherwise gated service.

### Inference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/risk-score/multi-horizon/batch` | Score fleet with 10d/30d/60d models |
| `GET` | `/api/risk-score/multi-horizon/latest` | Latest stored multi-horizon predictions |
| `GET` | `/api/equipment/:id/projection` | 60-day failure trajectory curve |

### Pipeline

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/predictive-maintenance/generate-snapshots` | Backfill feature snapshots |
| `POST` | `/api/predictive-maintenance/label-snapshots` | Label failure outcomes |
| `POST` | `/api/ml/train` | Trigger model retrain (admin only) |
| `GET` | `/api/ml/train/status` | Poll training progress + log |
| `GET` | `/api/ml/pipeline-status` | Snapshot counts, model version, readiness |
| `GET` | `/api/ml/model-metrics` | Accuracy, confusion matrix, feature importance |

### Drift Monitoring

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ml/drift/latest` | Most recent PSI per monitored feature |
| `POST` | `/api/ml/drift/compute-reference` | Recompute reference baseline from training data |

### Model Governance

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ml/models/registry` | Champion, challenger, retired versions + audit history |
| `GET` | `/api/ml/models/compare` | Per-horizon metric comparison (champion vs challenger) |
| `POST` | `/api/ml/models/promote` | Promote challenger to champion (admin only) |
| `GET` | `/api/ml/data-quality/report` | Latest pre-training data quality report (8 checks) |

### Agent API

Authenticated with `Authorization: Bearer <AGENT_API_KEY>`. Designed for programmatic access by scripts or LLM agents.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agent/model-health` | Consolidated model + drift + pipeline health with `recommended_action` |
| `POST` | `/api/agent/actions` | Trigger `retrain` or `compute_drift_reference` |

### Simulation

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/simulate/state` | Current cursor date + days run |
| `POST` | `/api/simulate/day` | Advance simulation N days (max 30) |

---

## Testing

```bash
# Python — ml-service (180 tests: inference, training smoke test, point-in-time
# correctness, leakage canaries, data-quality gate, model registry)
cd ml-service
pytest tests/ -v

# Node/TypeScript — server + shared client logic (571 tests across 43 files)
npm test

# TypeScript type-check
npx tsc --noEmit
```

All three run in CI (`.github/workflows/ml-ci.yml`) on every push/PR touching `ml-service/`, `server/`, `client/`, or `shared/`.

The Node suite runs in three tiers, and which ones run depends on what is
configured — a clean checkout with no database still runs the first tier and
passes:

| Tier | Needs | Covers |
|---|---|---|
| Pure logic | nothing | Feature maths, risk banding, calibration, the simulation clock, error formatting, and source-level guards against bugs that have recurred (raw HTML in error bodies, cacheable `/api` responses, TiDB-incompatible SQL) |
| Read paths | `DATABASE_URL` | Point-in-time snapshot correctness, and an HTTP smoke test that asks every read endpoint whether it actually answers with JSON |
| Write paths | `TEST_DATABASE_URL` | Creating, updating, completing and deleting rentals over HTTP, with the equipment status changes each is supposed to cause |

The write tier needs a database it is allowed to damage, so it uses a separate
DSN and **refuses to run** — rather than skipping quietly — if that DSN does not
name a database with `test` in it. Set it up once:

```bash
# create the database on your server, then:
DATABASE_URL="$TEST_DATABASE_URL" npm run db:push
```

> **`drizzle-kit push` is interactive, and against TiDB it asks a misleading
> question.** It offers to add unique constraints that are already present —
> `users_username_unique`, `equipment_equipment_id_unique` and the rest all
> exist and all reject duplicates with `ER_DUP_ENTRY`, verified by probing
> them — and one of the options it offers alongside is to **truncate the
> table**. Answering "yes" would destroy data to make room for a constraint
> that is already there. Say no, or close the prompt.
>
> Run it only in a terminal you can answer. Piped or scripted it receives no
> answer, applies nothing, and still **exits 0** — a migration that looks like
> it succeeded and did nothing. Nothing in the deploy path runs it.
>
> There is no migration history or rollback here either; `docs/DESIGN_SPEC.md`
> records that as a known limitation rather than a decision.

The HTTP tiers authenticate through `POST /api/test-login`, which issues a
session for an existing user id without a password. It is registered only when
`TEST_LOGIN_SECRET` is set and at least 24 characters, refuses outright under
`NODE_ENV=production`, compares the secret in constant time, and can only adopt
a user that already exists — it never creates one, and takes the role from the
database row rather than the request.

---

## Quickstart

### 1. Clone and configure

```bash
git clone <repo-url>
cd enterprise-asset-intelligence
cp .env.example .env
```

Fill in `.env`:

```env
DATABASE_URL=mysql://root:yourpassword@localhost:3306/asset_inventory
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=asset_inventory
SESSION_SECRET=<openssl rand -hex 32>
GROQ_API_KEY=gsk_...
AGENT_API_KEY=<python -c "import secrets; print(secrets.token_hex(32))">
```

> `DATABASE_URL` and the individual `DB_*` vars must point at the same database — the Node/Drizzle server reads `DATABASE_URL` (and will refuse to start without it), while the Python ML service reads the individual `DB_*` vars via SQLAlchemy.

### 2. Install and migrate

```bash
npm install
npm run db:migrate     # applies migrations/ — creates the full schema on a clean DB
```

Drizzle migrations (`shared/schema.ts` → `migrations/`) are the **single DDL owner**:
one `drizzle-kit migrate` builds every table (equipment, rentals, feature
snapshots, sensor logs, sessions, drift + model-metrics tables). The Node and Python
services only read and write — neither creates tables at runtime.

### 3. Start services

```bash
# Terminal 1 — Node API + Vite dev server
npm run dev

# Terminal 2 — ML service
cd ml-service
pip install -r requirements.txt
uvicorn api.main:app --reload --port 8000
```

### 4. First-time setup (onboarding screen)

On first login, the app automatically redirects to `/setup`. Choose one of two paths:

**Load Demo Data** — recommended for evaluation and interviews. Runs the full seed pipeline in the background (~60–90 seconds) and streams live progress. Seeds:
- 10 heavy equipment units across four categories
- 6 months of sensor readings per asset
- Maintenance history with realistic failure events
- Trained multi-horizon ML model (10d / 30d / 60d)
- SHAP attribution, MLflow run, drift reference baseline

**Start Fresh** — skip demo data and build the dataset manually with real equipment and operational records. The dashboard surfaces guided empty states that walk you through adding equipment, logging maintenance, running the ML pipeline, and generating predictions in the right order.

> The onboarding screen re-appears any time the system is reset via `POST /api/admin/reset` (ADMINISTRATOR role only).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Full MySQL DSN — read by the Node/Drizzle server. Must point at the same database as the `DB_*` vars below. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | ✅ | Individual MySQL connection vars — read by the Python ML service (SQLAlchemy) |
| `SESSION_SECRET` | ✅ | Express session signing key, 32+ chars. Enforced at boot: with `NODE_ENV=production` the server exits if it is unset, too short, or still a placeholder. Outside production an unset value falls back to a random per-process secret, so logins do not survive a restart. |
| `GROQ_API_KEY` | ✅ | Groq API key for LLM recommendations |
| `AGENT_API_KEY` | ✅ | Bearer token for agent API (`/api/agent/*`). Generate: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `GROQ_MODEL` | — | Groq model ID (default: `llama-3.1-8b-instant`) |
| `LLM_PROVIDER` | — | `groq` or `ollama` (default: `groq`) |
| `MLFLOW_TRACKING_URI` | — | MLflow server URI. If unset, MLflow logging is skipped (safe no-op). |
| `SLACK_WEBHOOK_URL` | — | Incoming webhook URL for `monitor.py` alerts. If unset, Slack notifications are silently skipped. |
| `ENABLE_API_DOCS` | — | Serves `/docs`, `/redoc` and `/openapi.json` on the ML service. Off unless truthy; these paths bypass the service-token check, so leave it off anywhere reachable. |
| `ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to call the API with cookies. Only needed when the SPA is hosted separately. A wildcard is refused at boot. |
| `SEED_DEMO_USERS` | — | Creates the `admin`/`viewer` accounts the login page advertises. Off unless truthy. These are published passwords on an account that can modify data, so enable it only on a demo holding synthetic data. Idempotent — existing accounts are never overwritten. |
| `VITE_API_URL` | — | Client-side, baked in at build time. API origin when the SPA is hosted separately; unset means same-origin. |
| `PYTHONIOENCODING` | — | Set to `utf-8` on Windows to avoid codec errors |

---

## Deployment Status

Deployed across three free tiers, with no monthly bill:

| Piece | Host | Notes |
|---|---|---|
| React SPA | Vercel | Static, so always instant — nothing to suspend |
| Node API + SPA proxy | Render | Suspends when idle; measured 51–73s to wake |
| FastAPI ML service | Render | Suspends independently |
| MySQL | TiDB Cloud Serverless | Always on; Render offers Postgres only |

[`render.yaml`](render.yaml), [`vercel.json`](vercel.json) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) reproduce it end to end.

Splitting the SPA onto static hosting is what makes a free tier presentable. Served from the API
container, a cold start would be a blank browser window for a minute or more — indistinguishable from a
broken site. Static hosting has nothing to suspend, so the page paints immediately and
[an explained gate](client/src/components/api-gate.tsx) holds the app back until the API answers.
The wait becomes a stated, bounded one instead of an apparent outage.

Vercel proxies `/api/*` through to Render rather than the browser calling it cross-origin. That
is a cookie decision: this app authenticates with a session cookie, and a cookie set by
`onrender.com` on a page served from `vercel.app` is a third-party cookie, which Safari blocks by
default. Proxying keeps it first-party, and removes CORS from the picture entirely.

Five things that deployment needed, and now has:

- **Migrations run on start.** The Node image ships `migrations/` and applies them before the server listens, so a clean database gets the full schema (including `sessions`) on first deploy. A migration failure exits non-zero instead of running against a mismatched schema.
- **One DSN for both services.** The Python side prefers `DATABASE_URL` over the `DB_*` vars and rewrites `mysql2`'s TLS parameter into `pymysql`'s spelling ([`ml-service/engine/db_url.py`](ml-service/engine/db_url.py)), so a managed host that mandates TLS works without per-service config drift.
- **Model artifacts without a disk.** Free tiers have no persistent storage, so the registry starts empty on every cold start. The champion bundle (16MB, one `.tar.gz`) is committed under `ml-service/models/` and extracted into the image at build time, so the build needs no network and a cold start has a model immediately. That reverses the original design — artifacts were fetched from a GitHub release to keep them out of git (OPS-2) — because GitHub's CDN answers Render's addresses with 502, during the build and at runtime alike, while the same URL fetches in two seconds elsewhere. Superseded versions still stay out of git; only the current champion ships. A URL fetch remains as a fallback, the digest is pinned either way, and extraction refuses path-traversing members since loading a pickle executes code.
- **A simulation clock that survives suspension.** The simulator advances seven days per real day, scheduled with a timer for 06:00. A free instance suspends after about fifteen minutes without traffic, so that timer is almost never alive when it should fire and every restart rearms it — the clock sat on its seed date while real time moved on, and the demo showed rentals from six months earlier. It now also catches up at boot, driven by elapsed real time rather than by starting, since this host starts the container on any visit after an idle period and a per-boot advance would race the clock ahead of reality. A pass is capped and carries its remainder, because each simulated day costs a feature snapshot per asset.
- **A separately hosted frontend, without touching 80 call sites.** Those call sites use relative `/api` paths, which resolve against the static host once the SPA moves. Under the proxy they stay relative and Vercel forwards them; set `VITE_API_URL` instead and a single wrapper around `fetch` ([`api-base.ts`](client/src/lib/api-base.ts)) rewrites them to the API origin at runtime. Either way no component changed and a new one cannot forget. The direct path is served by [`cors.ts`](server/services/cors.ts), which answers only origins named in `ALLOWED_ORIGINS` and refuses a wildcard at boot — with credentials, browsers reject it anyway.

Honest about the free tier: both Render services suspend after ~15 minutes idle. Three successive
cold starts of the ML service measured 51s, 62s and 73s — the host's own dashboard warns of "50
seconds or more", and the figure drifts upward, so anything in the code that waits on it is sized
against the slowest seen rather than the average. and 512MB serves the champion model (measured ~340MB resident) but will not train one — so
the deployed instance loads artifacts baked into its image rather than training on demand. The
~$33/mo configuration that removes the cold starts is documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Docker Compose (`docker-compose.yml`) runs all three
services locally, and [Quickstart](#quickstart) seeds a full fleet in two to five minutes —
two of its steps wait on the ML service's cold start.

The seed does not train a model, anywhere. It produces 40 labeled snapshots and the trainer's
data-quality gate refuses anything under 500 rows, so that step is skipped by design and the fleet
is scored by the champion shipped in the image. The step reports itself as skipped rather than
failed, and the metrics on the model page are that champion's own, registered from its bundle and
dated to the run that produced it. Training on demand needs a dataset the demo seed is not trying
to be.

---

## Key Design Decisions

**Why three separate models instead of one multi-output model?**
Each horizon has a different positive rate (10d: 19.8%, 30d: 24.0%, 60d: 27.6%) and different optimal calibration (sigmoid for 10d, isotonic for 30d/60d). Separate models allow horizon-specific tuning and independent deployment.

**Why TimeSeriesSplit instead of random CV?**
Random CV leaks future data into training folds on temporal datasets. TimeSeriesSplit ensures each fold trains on past data only, which correctly simulates the deployment scenario.

**Why recompute derived features at inference instead of storing them?**
Storing derived columns (aging_factor, wear_rate, mechanical_wear_score) creates staleness risk — if the computation logic changes, stored values become inconsistent with what the model was trained on. Recomputing from raw inputs at inference keeps the feature pipeline as the single source of truth.

**How is the risk distribution shaped, and what was not done to shape it?**

A representative seeded run scores **1 LOW / 6 MEDIUM / 3 HIGH**, spanning 0.253 to 0.671.

For a long time it scored no LOW rows at all, and the reason is worth recording because the obvious
explanation was wrong. The LOW/MEDIUM cut sits at 0.30 and the 30-day model's test-split positive
rate is 0.29, so LOW means *less likely to fail than a randomly chosen asset-period* — and it is
tempting to conclude that the seeded label base rate is what sets the floor. It is not. The demo
always scores with the v1.17 champion shipped in the ML service image, trained offline on 10,828
snapshots; a seed produces a couple of hundred labelled rows and the data-quality gate fails
training below 500, so **the seeded labels never train anything**. They exist so the pipeline has a
training set to display.

What actually moved it was the demo fleet's breakdown rate. The seeder was injecting 18 reactive
repairs across ten machines in six months — a failure every five weeks for the oldest crane, which
no rental yard would recognise. Cutting that to six (a 30-day label rate of 10.0%, from 33.5%)
cleared recent-repair history off the younger units, and that is a *feature*, not a prior:
`maintenance_events_90d` is 1 for each of the three HIGH assets and 0 for every other. Reshaping the
fleet directly — giving two units a third of the duty cycle, halving their lifetime hours — moved
those units by about 0.09 and never moved the floor at all.

The ordering is informative but not a simple wear ranking, and it would be dishonest to present it
as one. The top of the queue is clean: the three assets over ten years old sit at 0.66–0.67 with
`mechanical_wear_score` saturated at 10.0 and a reactive repair behind them. Lower down it is less
tidy — EQ-006 carries more hours and a higher wear rate than EQ-009, with identical maintenance
recency, and still scores lower (0.253 against 0.328). Category and the sensor terms are doing work
there that a single-feature story does not capture.

Two things were deliberately not done to produce a tidier distribution: the age-weighted hazard in
the simulator was left alone, and the band thresholds were left alone. The HIGH cut of 0.60 is the
operating point the published recall and precision-at-budget were measured at, so moving it would
invalidate the numbers on the model page. Recalibrating operating points to a deployment's own base
rate is a reasonable next step — it just has to be done by measuring that deployment, not by picking
a cut that makes a screenshot look better.

**Why a forward projection engine?**
Point-in-time predictions answer "what is the risk today?" The projection engine answers "when will this asset cross the HIGH threshold?" — which is the operationally useful question for scheduling maintenance windows.

---

## License

MIT