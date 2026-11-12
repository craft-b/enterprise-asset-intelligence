# Enterprise Asset Intelligence

**[Live demo](https://enterprise-asset-intelligence.vercel.app)** — sign in with `viewer` / `viewer123` for read-only access to the full dataset.

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
- **Three-layer drift detection** — Data drift (PSI on monitored features), prediction drift (distribution shift in output scores per horizon), and bias drift (disparity in HIGH-rate across equipment categories); each persisted to its own table (`drift_metrics`, `prediction_drift_metrics`, `bias_drift_metrics`) with reference distributions in `drift_reference`; dashboard surfaces per-feature PSI with STABLE / WARNING / ALERT status. The demo fleet is sized to clear the 20-snapshot batch minimum and the 3-per-category bias minimum rather than to sit below them — [why, and why those floors stay](#deployment-status)
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
| LLM | Groq (openai/gpt-oss-20b) |

---

## ML Models — v2.0

> **⚠️ Data source: simulated.** Nothing here is field predictive performance. See
> [docs/REAL_DATA_VALIDATION.md](docs/REAL_DATA_VALIDATION.md) for what has to happen before any
> metric can be quoted as such.

Three separate binary classifiers, one per prediction horizon. Each is a Random Forest calibrated on
the **real class prevalence** (no resampling), trained on an embargoed temporal holdout split, plus a
by-asset grouped evaluation (GroupKFold over equipment). One shared feature transform runs at train
and serve time, and each model serves its own version-pinned preprocessing artifacts.

### Why v2.0 exists: v1.17 could not see maintenance

Logging a service in the app did not move v1.17's score. The cause was the data, not the model. The
simulator that generated its training set added an age term, an hours term and a "neglect" term and
capped the sum. Neglect only switched on after 120 days without service, the age term alone reached
the cap for a ten-year-old unit, and breakdown repairs were recorded as scheduled maintenance, so the
simulator's own failures never became failure labels. In that data, service almost never changed
whether a machine failed, and the model learned exactly that: `days_since_last_maintenance` carried
**1.2%** of the 30-day model's importance and `maint_overdue` **0.04%**. It rated all 60 units in the
demo yard HIGH at 60 days.

v2.0 replaces the data-generating process and retrains:

- **A hazard where maintenance is causal** ([`server/services/failure-hazard.ts`](server/services/failure-hazard.ts)).
  Daily breakdown probability = *base(age, hours)* × *condition*. Condition worsens with use and is
  restored by scheduled work: a major service most, a minor service some. An inspection restores
  nothing (it finds problems, it does not fix them), and neither does a breakdown repair (it fixes
  the failed part, not the unit's wear). One module drives both the training-history generator and
  the in-app day simulator, so the model is scored on the physics it learned.
- **A fleet with mixed maintenance habits.** [`scripts/generate-training-history.ts`](scripts/generate-training-history.ts)
  simulates 160 units for ~3 years, each kept to a diligent, average or neglectful policy. Without
  that spread, days-since-service carries no information however strongly it drives failure.
  Snapshots are taken **in step with the simulation** through the same `enhancedFeatureService` the
  API scores with (a backfill would read today's hour meter into old snapshots), then labelled with
  the same `labelSnapshots()`. Seeded, so the dataset is reproducible.
- **`days_since_last_maintenance` counts scheduled services only.** Counting monthly inspections
  held it near 30 days on every unit, and counting breakdown repairs made the units that fail most
  look the most recently serviced, a confound that hid most of the effect of service. The UI already
  labelled the feature "Days since last service"; now it is.

Observed 30-day failure rate in the v2.0 training set, by age and days since service, showing the
signal the model now has to learn:

| Age | < 30 d | 30–90 d | 90–180 d | 180 d + |
|---|---|---|---|---|
| < 4 years | 7% | 12% | 17% | 15% |
| 4–8 years | 9% | 15% | 19% | 25% |
| 8 + years | 25% | 31% | 40% | 52% |

**What logging a service does now** (one five-year-old generator, 150 days since service;
`python -m analysis.maintenance_response v1.17 v2.0`):

| Scenario | v1.17 10d / 30d / 60d | v2.0 10d / 30d / 60d |
|---|---|---|
| As is | 36% / 69% / 81% | 12% / 30% / 56% |
| After an inspection | 36% / 69% / 81% | 12% / 30% / 56% |
| After a minor service | 27% / 57% / **81%** | **5% / 15% / 36%** |
| After a major service | 25% / 54% / **81%** | **5% / 15% / 36%** |

End to end on the local stack, logging a major service on the riskiest demo unit (EQ-011) moved it
from 21% / 51% / 82% to 9% / 30% / 51% on the automatic rescore.

### v2.0 performance (simulated data)

**Training data:** 23,040 observed-outcome snapshots · 160 units · 31 features · 1,440 horizon-censored.
Labels derive only from `REACTIVE_REPAIR` breakdown events in `(ts, ts+h]`; scheduled PM and
model-driven interventions are never counted as failures.

| Horizon | Split | ROC-AUC | PR-AUC | Brier | ECE |
|---|---|---|---|---|---|
| 10d | temporal | 0.706 | 0.251 | 0.105 | 0.009 ✓ |
| 10d | by-asset | 0.711 | — | — | — |
| 30d | temporal | 0.724 | 0.541 | 0.187 | 0.037 ✓ |
| 30d | by-asset | 0.715 | — | — | — |
| 60d | temporal | 0.744 | 0.738 | 0.207 | 0.048 ✓ |
| 60d | by-asset | 0.718 | — | — | — |

ECE = expected calibration error (gate: < 0.05). The **temporal split** answers "same fleet, next
quarter"; the **by-asset split** (every asset scored by a model that never saw it) answers "a new
customer's fleet, day one". Precision@budget and lead time are on the ML dashboard per horizon.

**These AUCs are lower than v1.17's (0.80–0.93), and that is the right direction.** v1.17's task was
mostly "read the age off the record", which is easy to score well on and useless for deciding when to
service. `ml-service/analysis/bayes_ceiling.py` estimates what an oracle that knows each unit's true
condition could reach on the new process: **0.75–0.79**. The model sees condition only through
service history, so 0.71–0.74 is close to what the data allows.

```bash
cd ml-service && python -m analysis.bayes_ceiling
```

### Risk bands are per horizon

The bands used to be 30% / 60% at every horizon. Once the model was calibrated, an honest 10-day
probability almost never reached 60%, so the queue would show no HIGH units at 10d or 30d however bad
a unit was. [`shared/risk-bands.ts`](shared/risk-bands.ts) now sets them per horizon (mirrored in the
ML service, with a parity test): MEDIUM starts at the horizon's base rate across the training
timeline, and HIGH is where the holdout's observed failure rate runs 1.6–2× the base rate.

| Horizon | Base rate | MEDIUM ≥ | HIGH ≥ | Observed failure rate in HIGH (holdout) |
|---|---|---|---|---|
| 10d | 11% | 10% | 20% | 26% |
| 30d | 27% | 25% | 45% | 56% |
| 60d | 44% | 45% | 70% | 81% |

The seeded demo yard scores 1 HIGH / 16 MEDIUM / 43 LOW at 30 days (v1.17: 30 HIGH / 30 MEDIUM).
The 24-hour post-maintenance display discount the risk queue used to apply is gone: it existed
because the model ignored service, and with a model that responds it would count the same service
twice.

**Evaluation methodology:** each horizon's holdout is a single **temporal** split (most recent ~20%
of snapshots) with a per-horizon **embargo**: dev rows whose label window `[ts, ts+h]` crosses the
holdout boundary are dropped (192/672/1,312 rows for 10/30/60d). The **by-asset** numbers are pooled
out-of-fold predictions from `GroupKFold(5)` over `equipment_id`. Rows whose outcome window contains a
`PREDICTIVE_INTERVENTION` before any failure are **censored** (`label_status`), not labelled
negative, because otherwise the model's own successes would poison its future labels.
**Retrain triggers:** `monitor.py` polls `/api/agent/model-health` and auto-triggers retraining when
any monitored feature's PSI reaches the ALERT threshold (≥ 0.20) or when prediction/bias drift
crosses the same threshold; an admin can also trigger retraining manually via `POST /api/ml/train`.

**Rebuilding the champion** (into an empty database of its own; the generator refuses one that
already has equipment):

```bash
export DATABASE_URL=mysql://user:pass@localhost:3306/eai_training
npx drizzle-kit migrate
npx tsx scripts/generate-training-history.ts
cd ml-service && python training/train_model_multihorizon.py
```

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

> **⚠️ `sensor_degradation_rate` carried no information through v1.17.**
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
3. Retrain Models       →  Trains new model versions, hot-swaps on completion (~3 min)
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
│   ├── tests/                     # 280 tests total (pytest)
│   │   ├── test_ml_engine.py          # inference, monotonicity, risk ordering, batch, schema
│   │   ├── test_train_smoke.py        # full training pipeline on synthetic data
│   │   ├── test_data_quality.py       # all 8 DQ checks + report structure
│   │   └── test_model_registry.py     # champion/challenger/promote/metrics (in-memory)
│   └── registry/                  # Versioned model artifacts
│       ├── rf_{h}d_v2.0.pkl
│       ├── clip_thresholds_v2.0.json
│       ├── feature_cols_v2.0.json
│       ├── metadata_{h}d_v2.0.json
│       └── feature_importance_{h}d_v2.0.json
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
# Python — ml-service (280 tests: inference, training smoke test, point-in-time
# correctness, leakage canaries, data-quality gate, model registry, drift reference)
cd ml-service
pytest tests/ -v

# Node/TypeScript — server + shared client logic (80 files: 977 pass with no
# database; 47 more need DATABASE_URL pointed at a live one and skip without it)
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

### Run your own instance

The compose stack is self-contained: it brings its own MySQL, so there is
nothing to provision anywhere.

```bash
git clone <repo-url>
cd enterprise-asset-intelligence
npm install
npm run setup:env          # writes .env with freshly generated secrets
docker-compose up --build  # first run builds the images
```

Then open <http://localhost>.

Four containers come up: the React client on port 80, the Node API on 5000,
and the ML service and database on the internal network only — neither is
bound to a host port. `docker-entrypoint.sh` applies the Drizzle migrations
before the API starts, so the schema builds itself on an empty database.

Sign in as `admin` / `admin123`, then press **Load Demo Data**. The compose
stack sets `SEED_DEMO_USERS=true` because it publishes nothing beyond your own
machine; a deployment leaves that unset, and there the **first account you
register becomes the administrator** and every account after it is a viewer.

`npm run setup:env` exists because `cp .env.example .env` could not work: the
stack runs with `NODE_ENV=production`, and the session-secret check rejects the
example file's placeholder outright under production — correctly, since that is
the check that stops a real deployment booting with a known signing key. So the
three secrets the app refuses to start without are generated rather than
defaulted, and nothing fake is committed here.

Your fleet lives in a named Docker volume and survives `docker-compose down`.
`docker-compose down -v` is the deliberate way to throw it away.

The licence is MIT. Fork it, change it, break it — it is your instance, and it
touches nothing of anyone else's.

### Or run it from source

```bash
npm install
npm run setup:env -- --local   # same, but pointed at localhost:3306
```

Create the database named in `.env` (`enterprise_assets` by default), then:

```bash
npm run db:migrate     # applies migrations/ — creates the full schema on a clean DB
```

Drizzle migrations (`shared/schema.ts` -> `migrations/`) are the **single DDL
owner**: one `drizzle-kit migrate` builds every table (equipment, rentals,
feature snapshots, sensor logs, sessions, drift + model-metrics tables). The
Node and Python services only read and write — neither creates tables at
runtime.

```bash
# Terminal 1 — Node API + Vite dev server
npm run dev

# Terminal 2 — ML service
cd ml-service
pip install -r requirements.txt
python fetch-models.py   # extracts the committed v2.0 bundle into registry/ (the .pkl files are not in git)
uvicorn api.main:app --reload --port 8000
```

> `DATABASE_URL` and the individual `DB_*` vars must point at the same database — the Node/Drizzle server reads `DATABASE_URL` (and will refuse to start without it), while the Python ML service reads the individual `DB_*` vars via SQLAlchemy. `setup:env` writes both from one set of values so they cannot drift.

### First-time setup (onboarding screen)

On first login, the app redirects to `/setup`. Choose one of two paths:

**Load Demo Data** — recommended for evaluation and interviews. Runs the full
seed pipeline in the background and streams live progress. Budget ten to
thirty minutes: that is the two-to-five-minute ten-asset figure scaled by the
six-fold fleet, plus the ML service's two cold starts, and it has not been
measured against the larger seed.
Seeds:

- 60 heavy equipment units across nine categories, at least four in each; twelve are six years or older and five are past ten
- six months of sensor readings and maintenance history per asset, with failure events
- the fleet scored at all three horizons (10d / 30d / 60d), with SHAP attribution and a drift reference baseline

The **"Train model" step does not train by default**. The fleet is scored by the
v2.0 champion that ships inside the ML image — trained offline on 23,040
snapshots — and the step copies its metrics into `model_metrics` so the ML
dashboard shows what the system actually has. A run on the demo data could only
ever add a challenger, and on Cloud Run it outlasted the step's 7-minute limit,
so every hosted seed finished "with gaps". `SEED_TRAIN_MODEL=on` restores it;
**Retrain** in the ML pipeline controls trains on demand. Nothing here is trained on the
demo data, and the seed log says so rather than letting a green checkmark imply
otherwise.

**Start Fresh** — skip demo data and build the dataset manually with real
equipment and operational records. The dashboard surfaces guided empty states
that walk you through adding equipment, logging maintenance, running the ML
pipeline, and generating predictions in the right order.

> The onboarding screen re-appears any time the system is reset via `POST /api/admin/reset` (ADMINISTRATOR only). The reset leaves the `users` table alone, so accounts and changed passwords survive it.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Full MySQL DSN — read by the Node/Drizzle server. Must point at the same database as the `DB_*` vars below. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | ✅ | Individual MySQL connection vars — read by the Python ML service (SQLAlchemy) |
| `SESSION_SECRET` | ✅ | Express session signing key, 32+ chars. Enforced at boot: with `NODE_ENV=production` the server exits if it is unset, too short, or still a placeholder. Outside production an unset value falls back to a random per-process secret, so logins do not survive a restart. |
| `GROQ_API_KEY` | ✅ | Groq API key for LLM recommendations |
| `AGENT_API_KEY` | ✅ | Bearer token for agent API (`/api/agent/*`). Generate: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `GROQ_MODEL` | — | Groq model ID (default: `openai/gpt-oss-20b`) |
| `LLM_PROVIDER` | — | `groq` or `ollama` (default: `groq`) |
| `MLFLOW_TRACKING_URI` | — | MLflow server URI. If unset, MLflow logging is skipped (safe no-op). |
| `SLACK_WEBHOOK_URL` | — | Incoming webhook URL for `monitor.py` alerts. If unset, Slack notifications are silently skipped. |
| `ENABLE_API_DOCS` | — | Serves `/docs`, `/redoc` and `/openapi.json` on the ML service. Off unless truthy; these paths bypass the service-token check, so leave it off anywhere reachable. |
| `ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to call the API with cookies. Only needed when the SPA is hosted separately. A wildcard is refused at boot. |
| `PUBLIC_APP_URL` | — | The SPA's public origin when it is hosted separately. Set, the API answers browser page requests outside `/api` with a 308 to that origin, so a visitor on the container's own URL gets the site with the waking screen rather than a blank cold start. Unset, the container serves the SPA itself. |
| `SEED_DEMO_USERS` | — | Creates the `admin`/`viewer` accounts the login page advertises. Off unless truthy. These are published passwords on an account that can modify data, so enable it only on a demo holding synthetic data. Idempotent — existing accounts are never overwritten. |
| `VITE_API_URL` | — | Client-side, baked in at build time. API origin when the SPA is hosted separately; unset means same-origin. |
| `PYTHONIOENCODING` | — | Set to `utf-8` on Windows to avoid codec errors |

---

## Deployment Status

Deployed across four free tiers, with no monthly bill:

| Piece | Host | Notes |
|---|---|---|
| React SPA | Vercel | Static, so always instant — nothing to suspend |
| Node API + SPA proxy | Render | Suspends when idle; measured 51–73s to wake |
| FastAPI ML service | Google Cloud Run | Private, scales to zero, inside the always-free allowance behind a spend cap |
| MySQL | TiDB Cloud Serverless | Always on; Render offers Postgres only |

[`render.yaml`](render.yaml), [`vercel.json`](vercel.json), [`deploy-ml.sh`](infrastructure/cloud-run/deploy-ml.sh) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) reproduce it end to end.

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
- **Model artifacts without a disk.** Free tiers have no persistent storage, so the registry starts empty on every cold start. The champion bundle (48MB, one `.tar.gz`) is committed under `ml-service/models/` and extracted into the image at build time, so the build needs no network and a cold start has a model immediately. That reverses the original design — artifacts were fetched from a GitHub release to keep them out of git (OPS-2) — because GitHub's CDN answers Render's addresses with 502, during the build and at runtime alike, while the same URL fetches in two seconds elsewhere. Superseded versions still stay out of git; only the current champion ships. A URL fetch remains as a fallback, the digest is pinned either way, and extraction refuses path-traversing members since loading a pickle executes code.
- **A simulation clock that survives suspension.** The simulator advances seven days per real day, scheduled with a timer for 06:00. A free instance suspends after about fifteen minutes without traffic, so that timer is almost never alive when it should fire and every restart rearms it — the clock sat on its seed date while real time moved on, and the demo showed rentals from six months earlier. It now also catches up at boot, driven by elapsed real time rather than by starting, since this host starts the container on any visit after an idle period and a per-boot advance would race the clock ahead of reality. A pass is capped and carries its remainder, because each simulated day costs a feature snapshot per asset.
- **A separately hosted frontend, without touching 80 call sites.** Those call sites use relative `/api` paths, which resolve against the static host once the SPA moves. Under the proxy they stay relative and Vercel forwards them; set `VITE_API_URL` instead and a single wrapper around `fetch` ([`api-base.ts`](client/src/lib/api-base.ts)) rewrites them to the API origin at runtime. Either way no component changed and a new one cannot forget. The direct path is served by [`cors.ts`](server/services/cors.ts), which answers only origins named in `ALLOWED_ORIGINS` and refuses a wildcard at boot — with credentials, browsers reject it anyway.

**Why the ML service runs on Cloud Run.** From 2026-10-30 to 2026-11-02 it ran
on Render and could not be reached: requests from the API drew HTTP 429 with a
Cloudflare challenge page — a JavaScript interstitial server-to-server traffic
can never solve. The cause was the shared NAT address free Render services
egress through: GitHub answered that same instance's *first* unauthenticated
request with "API rate limit exceeded for 74.220.48.235", so the budget was
spent by other tenants before this service sent anything. A sustained polling
bug here (since fixed — one request a minute, exponential backoff, a shared gate
across every caller) most likely tripped the reputation threshold; the shared
address is why it did not recover. Render's supported remedy, private
networking, lets a free service send but not receive, so it needed a paid
instance. The same container now runs on Google Cloud Run as a **private**
service — reached through Workload Identity Federation, with no Google-issued
key, because new projects refuse to create one — and stays at $0.
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#3b-ml-service-google-cloud-run) has the
setup, including the three things the first real deploy ran into.

The outage left a better design behind. Risk scores, per-asset SHAP
attributions and model metrics were already persisted by each scoring run and
read from the database. The three drift layers now are too: the ML service's
handlers for them were SELECTs over tables this API already reads, so the API
reads them directly. Feature importance and hyperparameters are properties of
the pinned champion and ship in the image as the training run's own registry
output. All of those render with the ML service unreachable — asleep, refused
by a host's edge, or paused by the spend cap — and only computation waits on
it: scoring a new batch, recomputing a drift reference, the data-quality report
and the champion-challenger comparison. `GET /api/ml/diagnostics` (admin)
reports how the API authenticates, what the rate limits count a request as, and
a live probe of each path.

### Cost and abuse controls

Google Cloud is the one host here billed to a card, and the viewer password is
printed on the login page, so "free" has to hold however the public demo is
used — not just at the traffic it actually gets.

- **A private ML service.** Google refuses any request without the API's
  identity before it reaches the container, and does not bill what it refuses.
  The API proves that identity by signing its own short-lived JWT, which
  Google's STS exchanges for an ID token
  ([`google-id-token.ts`](server/services/google-id-token.ts)).
- **A ceiling on what viewers can make it do.** The private endpoint does not
  help against a script signed in as viewer, because the API holds the
  credential. So every viewer route that reaches the ML service goes through a
  cache with one shared request per key, and cache misses on the expensive ones
  draw on a global token bucket — a burst of 30, then one new computation every
  two minutes. The worst case is ~540k requests and ~144k vCPU-seconds a month,
  against a free allowance of 2M and 180k, at the slowest call time measured
  in Cloud Run's request log (4.3s), and [a test](server/services/ml-response-cache.test.ts)
  holds it there ([`ml-response-cache.ts`](server/services/ml-response-cache.ts)).
- **Rate limits on the API.** 300 requests a minute per visitor; 10 failed
  sign-ins per visitor and 30 per username per 15 minutes, checked before
  bcrypt runs; 5 registrations an hour. Through Vercel's proxy the visitor is
  the address Vercel recorded, and every limit also counts the address
  Cloudflare saw — which cannot be forged — at ten times the allowance
  ([`request-limits.ts`](server/services/request-limits.ts)).
- **A spend cap.** A Cloud Billing budget with spend-cap enforcement pauses
  Cloud Run at $5 of list-price usage a month. It should never trip; if it
  does, the dashboard falls back to everything it reads from the database.

[`route-cost-guards.test.ts`](server/route-cost-guards.test.ts) fails if a
viewer route ever calls the ML service around the cache, or if the limits come
unwired.

Honest about the free tier: the Render API suspends after ~15 minutes idle, and three successive
cold starts on that host measured 51s, 62s and 73s — the host's own dashboard warns of "50 seconds
or more", and the figure drifts upward, so anything in the code that waits on it is sized against
the slowest seen rather than the average. The ML service scales to zero on Cloud Run and pays its
own, shorter cold start on the first call after a pause. Neither free configuration trains on
demand — 512MB on Render ran out of memory, and Cloud Run's request-based billing throttles the
CPU a background training job runs on — so the deployed service loads artifacts baked into its
image. Removing the API's cold start costs ~$7/mo, documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Docker Compose (`docker-compose.yml`) runs all three
services locally, and [Quickstart](#quickstart) seeds a full fleet — two of its steps wait on the
ML service's cold start. The ten-asset fleet took two to five minutes. Sixty units is six times
the data, but the passes that carry it are no longer serial (below), so the honest answer is
several minutes plus two ML cold starts, and that it has not been measured against a sixty-asset
reseed. An estimate stated more precisely than that would be invented.

Two things carry that cost. Snapshot writes are batched a hundred rows to a statement, removing
about 1,400 round trips; and snapshot *generation*, which is the larger share — roughly eleven
sequential queries per snapshot, about 15,000 of them across a sixty-asset seed — now runs six
assets at a time rather than one. Six because the mysql2 pool defaults to ten connections and the
endpoint reporting seeding progress needs one of them; `SNAPSHOT_CONCURRENCY` overrides it.

Only the scheduling changed. Each asset's queries are independent and bounded by the same
snapshot timestamp, so a snapshot still sees only data at or before its own `snapshot_ts`. That
invariant is covered by `feature-engineering-pit.test.ts`, which needs a live database and so
does not run in CI — worth knowing, because it is the test that most directly exercises the claim
in this paragraph. No timing figure here has been measured against a reseeded database.

The seed does not train a model on free hosting. The sixty-asset fleet produces about 1,380
labelled snapshots, which clears the trainer's 500-row data-quality gate — so unlike the
ten-asset version it is no longer refused at the door; it is expected to run out of memory
instead, since 512MB serves the champion but will not fit three forests being fitted. Either
way the fleet is scored by the champion shipped in the image. The step reports itself as skipped rather than
failed, and the metrics on the model page are that champion's own, registered from its bundle and
dated to the run that produced it. Training on demand needs a dataset the demo seed is not trying
to be.

**Drift monitoring is implemented, and the sixty-asset fleet can exercise it.** All three layers run
inside `POST /predict/multi-horizon/batch`, which is the path the Run Multi-Horizon Forecast button
takes, and each persists to its own table. The reference distributions live in the
`drift_reference` table rather than a file in the container, because a free tier has no persistent
disk — and because the loader's glob previously matched the committed per-version files but never
the one the compute step wrote, so a freshly computed reference was not the one in use.

Confirmed end to end on 2026-10-28: a scoring run over sixty assets populated all three layers in
one pass, with the drift cards reporting a batch of 60. Before that the claim here was only that the
fleet *could* exercise it.

Two sample minimums used to stop it, and the fleet was grown past both. Neither floor moved:

- **A batch needs 20 snapshots to be worth a PSI.** Ten assets produced ten rows, so every run
  returned `{"status": "skipped", "reason": "batch too small (10 < 20)"}`. PSI over ten samples
  moves on noise, so the floor stays and the fleet changed instead: sixty scored assets clear it in
  a single run. The genuine readings already in `drift_metrics` came from a batch of 50, with PSI
  ranging to 0.4376 — the detector measures when given something to measure.
- **Bias drift needs three units per category.** Ten units spanned nine categories with only Crane
  holding a second, so no category could reach three and the bias reference stayed empty. Every
  category now carries at least four. A HIGH-rate computed across one or two machines is not a
  disparity statistic, which is why the answer was more machines rather than a lower floor.

The fleet was grown because ten units is not a plausible equipment rental yard, and every floor it
failed is one ordinary use clears. What was *not* done is tuning the category mix until a disparity
appeared: the proportions — twelve units in the HIGH tier, five past ten years, twelve lightly
used — are held by assertion in `server/services/seed-fleet.test.ts` precisely so that a later edit
cannot quietly reshape the data to flatter a chart.

Feature references cover four of the five monitored features. Measured on the ten-asset seed,
`mean_time_between_failures` was non-null in 1 of 240 snapshots, so it could not clear the
20-sample floor either. The sixty-asset seed produces about 1,440 snapshots over the same span
and has twelve assets old enough to draw multiple injected failures, so coverage should be
materially better — but that figure has not been re-measured against a reseeded database, and is
not claimed here until it has been. That one is
arithmetic, not a defect: a mean needs two failures before the snapshot date, and 180 days of
history gives most assets one or none. Only EQ-005 has two, 124 days apart, and only its final
snapshot carries the value. The other 239 take the trainer's `COALESCE(…, 500)`, so this feature
carries almost no signal in the demo — stated plainly because it is a real limit on one of the
model's 31 inputs, and because the fix is a longer seed rather than a code change.

None of this is reported as stability. The reference self-check that follows a recompute compares
the reference sample against the reference built from it, so its PSI is 0 by arithmetic; it is run
as a smoke test and deliberately not recorded, because when it *was* recorded it became the newest
row per feature and the dashboard displayed four features at PSI 0.000000 / STABLE — hiding the
real readings behind it and asserting a stability nothing had measured. The monitor card now names
which of the three states it is in: no reference, a reference with no qualifying batch yet, or
actual readings, shown with the batch size they came from.

---

## Key Design Decisions

**Why three separate models instead of one multi-output model?**
Each horizon has a different positive rate (10d: 19.8%, 30d: 24.0%, 60d: 27.6%) and different optimal calibration (sigmoid for 10d, isotonic for 30d/60d). Separate models allow horizon-specific tuning and independent deployment.

**Why TimeSeriesSplit instead of random CV?**
Random CV leaks future data into training folds on temporal datasets. TimeSeriesSplit ensures each fold trains on past data only, which correctly simulates the deployment scenario.

**Why recompute derived features at inference instead of storing them?**
Storing derived columns (aging_factor, wear_rate, mechanical_wear_score) creates staleness risk — if the computation logic changes, stored values become inconsistent with what the model was trained on. Recomputing from raw inputs at inference keeps the feature pipeline as the single source of truth.

**How is the risk distribution shaped, and what was not done to shape it?**

> *Written for v1.17 on the original ten-unit yard, with one 30% / 60% cut for every horizon.*
> *Under v2.0 and per-horizon bands the sixty-unit yard scores 43 LOW / 16 MEDIUM / 1 HIGH at 30*
> *days; see [ML Models](#ml-models--v20). The reasoning below about what does and does not set*
> *the floor still holds.*

A representative seeded run scores **1 LOW / 6 MEDIUM / 3 HIGH**, spanning 0.253 to 0.671.

For a long time it scored no LOW rows at all, and the reason is worth recording because the obvious
explanation was wrong. The LOW/MEDIUM cut sits at 0.30 and the 30-day model's test-split positive
rate is 0.29, so LOW means *less likely to fail than a randomly chosen asset-period* — and it is
tempting to conclude that the seeded label base rate is what sets the floor. It is not. The demo
always scores with the v2.0 champion shipped in the ML service image, trained offline on 23,040
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
the simulator was left alone, and the band thresholds were left alone. Each horizon's HIGH cut
(20%, 45% and 70% at 10, 30 and 60 days) is the operating point the published recall and lead time
are measured at, so moving one would invalidate the numbers on the model page. Recalibrating operating points to a deployment's own base
rate is a reasonable next step — it just has to be done by measuring that deployment, not by picking
a cut that makes a screenshot look better.

**Why a forward projection engine?**
Point-in-time predictions answer "what is the risk today?" The projection engine answers "when will this asset cross the HIGH threshold?" — which is the operationally useful question for scheduling maintenance windows.

---

## License

MIT