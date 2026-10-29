# Enterprise Asset Intelligence — Enterprise Design Specification

**Status:** v1.0 (Stage 1 deliverable) · companion to [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md)
**Audience:** builder model / engineering team + technical-diligence reviewers.
Finding IDs (ML-1, SEC-1, …) reference the audit; every design decision here states which gap it closes.

---

## 1. Product Vision & Users

### Vision

**The vendor-agnostic asset-intelligence layer for mixed construction fleets.** Every OEM sells a
telematics silo (Cat VisionLink, Komatsu KOMTRAX, Deere JDLink); none of them scores a *mixed* fleet,
and none covers the 30–60% of rental iron that has no telematics at all. Enterprise Asset
Intelligence unifies telemetry, maintenance history, and rental operations across brands — including
un-telematized assets via operational proxies (rental hours, service events) — into one risk model,
one work queue, and one ROI narrative.

**The wedge is economic, not algorithmic.** For an equipment-rental company, an unplanned failure on
rent is: lost rental revenue (the unit's daily rate × downtime), a stranded jobsite (customer's crew
idle → churn), an emergency service call at premium cost, and a possible swap dispatch. A predicted
failure converted to a scheduled PM during a rental gap costs one service visit. The product's core
KPI is therefore **avoided downtime dollars**, computed per intervention and rolled up per fleet —
not model AUC.

### Personas & jobs-to-be-done

| Persona | JTBD | Product surface |
|---|---|---|
| **Fleet / maintenance manager** (primary) | "Tell me which of my 400 units will hurt me next, why, and what to do this week within my shop capacity." | Fleet command center: ranked risk queue, explanation panel, one-click work-order creation, weekly PM plan. |
| **Ops / rental dispatcher** | "Don't let me send a unit that will die on a customer's site." | Dispatch risk guard at rental creation (exists today — keep), swap suggestions. |
| **Service technician** | "What am I inspecting and why on this unit?" | Work order with the model's drivers translated to inspection points; outcome capture (`eventSource`, findings) that feeds labels. |
| **Ops director / owner** | "Prove this subscription pays for itself." | ROI report: interventions taken, failures avoided vs. baseline, downtime dollars saved, utilization. |
| **(Internal) ML operator** | "Is the model healthy; can I promote the challenger?" | ML ops dashboard (exists — fix metric honesty per ML-9). |

### Value narrative (the demo storyline)

1. Connect (or simulate) a mixed fleet → unified asset registry.
2. Risk queue ranks 400 units; top unit is HIGH with drivers a mechanic recognizes (hours since
   service, wear trend, jobsite severity).
3. Manager schedules PM in the unit's rental gap; technician logs outcome.
4. ROI card shows the counterfactual: expected failure cost vs. PM cost actually spent.
5. Dispatcher tries to rent a HIGH unit → guard forces acknowledgement or swap.

---

## 2. System Architecture

### Shape (target = today's shape, hardened)

Three deployables + one database; the ML service is a versioned, swappable component behind a stable
inference contract. No new infrastructure until Phase B; the fixes are at the boundaries.

```
Browser ── React SPA (Vite)
   │ /api/*  (session cookie)
   ▼
Node/Express API gateway ──────────────── MySQL 8  (sole DDL owner: Drizzle migrations)
   │  • authN/authZ, RBAC, audit log            ▲
   │  • domain CRUD (equipment/rentals/maint)   │ read-only (training snapshots)
   │  • feature assembly (single TS module)     │
   │  • persistence of predictions              │
   ▼ S2S token, internal network only           │
FastAPI ML service ─────────────────────────────┘
   • /predict/multi-horizon[/batch]  (stable contract, versioned)
   • /train, /models/*, /drift/*     (admin plane)
   • registry/ artifact store (versioned bundles)
   • Groq LLM (optional, flagged)
```

### Boundary decisions (each maps to an audit gap)

1. **Single DDL owner (closes ARCH-1).** Drizzle generates real migrations (baseline from current
   schema, then `sensor_data_logs` and the three drift tables move into `shared/schema.ts`). The
   Python service gets DB *DML* access only; its `CREATE TABLE IF NOT EXISTS` blocks are deleted.
   Quickstart uses `drizzle-kit migrate` and actually works from a clean database.
2. **The inference contract is the only ML↔gateway coupling.** One JSON schema, one place: a
   `shared/contracts/prediction.json` (JSON Schema) from which the pydantic model and a zod schema
   are both generated/validated in CI (closes the ML-10 drift and QA-1 contract gap). Contract is
   versioned (`contract_version` in payload); the ML service rejects unknown majors.
3. **ML service is private (closes SEC-1).** No host port in compose; Node reaches it by service
   DNS. All ML-service endpoints require `X-Service-Token` (from env, rotated with the rest). Admin
   verbs (`/train`, `/models/promote`, `/drift/compute-reference`) additionally log actor identity
   passed through from the Node session (`X-Actor: userId`) into an audit table.
4. **Model artifacts are a bundle, not loose files (closes ML-7).** A version = one directory
   `registry/v1.15/` containing models, encoder, clip thresholds, feature list, metadata, drift
   reference, and a `manifest.json` with content hashes. The predictor loads *only* from the pinned
   bundle; nothing is resolved latest-by-glob; nothing unversioned is ever overwritten.
5. **Failure semantics.** Node→ML calls: 10s timeout (exists), one retry on connection error only
   (never on 5xx from training), circuit-breaker state surfaced on `/api/health`. If ML is down:
   reads serve last stored predictions with a `stale: true` flag and UI banner; writes (rescore,
   train) fail loudly. No silent hardcoded fallbacks (deletes `getDefaultMetrics()` behavior, ML-9).
6. **Start-order decoupling.** Compose healthchecks exist; additionally the gateway boots without
   ML (degraded mode) instead of `depends_on` hard ordering, and the seed pipeline polls
   `running/last_result` correctly (OPS-1).
7. **Batch scoring is a job, not a request loop (closes ARCH-3).** `POST /api/ml/score-fleet`
   enqueues; the gateway assembles features set-based (one SQL pass per window, all assets), ships
   ≤500-row chunks to the batch endpoint; FastAPI vectorizes `predict_proba` + SHAP over the frame
   and runs it in a worker thread. Progress is pollable (same UX as training today).

### Reliability / scalability / adaptability / maintainability deltas

Covered as concrete patterns in §7 (the -ilities matrix). Headline: the architecture stays a
modular monolith + one model service; horizontal scale-out (queue workers, multi-tenant sharding)
is a Phase B seam, deliberately not built now.

---

## 3. ML System & Data Science (the core)

### 3.1 Leakage-free methodology — enforced and tested

**Point-in-time feature correctness (fixes ML-1).**
- Every feature query takes `snapshotTs` and applies `event_date <= snapshotTs` (and window lower
  bound). Rental-day accumulation clamps `end = min(returnDate ?? snapshotTs, snapshotTs)`.
- The feature module exposes exactly one public function:
  `buildSnapshot(equipmentId, asOf: Date): FeatureVector` — used by backfill, live scoring, cron,
  and the batch route (today four call sites duplicate payload assembly; they all converge here).
- **Enforcement test (CI):** a frozen fixture DB; assert `buildSnapshot(eq, T)` is *bit-identical*
  whether or not events after `T` exist in the DB (insert future rows, recompute, diff). This is
  the regression test that would have caught ML-1.

**Split protocol (fixes ML-3).**
- Temporal holdout: last 20% by `snapshot_ts` **with an embargo**: drop dev rows whose label window
  `[ts, ts+h]` crosses the boundary (per horizon).
- **Grouped reporting:** alongside the temporal metrics, a `GroupKFold`-by-asset evaluation is
  computed and published in the same metadata file (`by_asset` block). Deployment claim discipline:
  temporal metrics answer "same fleet, next quarter"; grouped metrics answer "new fleet, day one"
  (the sales scenario). Both go on the dashboard.
- CV stays `TimeSeriesSplit(5, gap=horizon)` on the dev set.
- **Leakage canaries (CI):** (a) shuffled-label training must produce holdout AUC ≈ 0.5 ± 0.05;
  (b) a `snapshot_ts`-only model (timestamp as sole feature) must not beat prevalence baseline
  materially — catches split-adjacent artifacts.

**Transforms fit on dev only (fixes ML-4)** — clip thresholds, encoder, caps computed inside the
split, serialized into the version bundle, applied identically at serve (see 3.4).

### 3.2 Labeling (fixes ML-2 / ML-11)

- **Failure definition:** a maintenance event with `eventSource = 'REACTIVE_REPAIR'` (unit failed in
  service), or a rental cut short with a swap whose reason is mechanical (equipment_swaps.reason
  taxonomy to be added). `SCHEDULED_PM` MAJOR_SERVICE is *not* a failure — it's the outcome we're
  trying to cause.
- **Windows:** `will_fail_h = 1` iff a failure event occurs in `(ts, ts+h]` (day-0 excluded — the
  same-day event already influenced the features).
- **Censoring:** rows with `ts + 60d > cursor` stay unlabeled (already correct today — keep), and
  *retired* assets are labeled only up to retirement date.
- **Intervention handling (the feedback-loop problem):** when a model-driven
  `PREDICTIVE_INTERVENTION` lands inside a label window, the row is **censored, not negative** —
  we don't know whether it would have failed. Store `label_status ∈ {observed, censored_intervention,
  censored_horizon}` on the snapshot so prevalence accounting stays honest. (This is the standard
  treatment-leakage guard in deployed PdM programs; without it the model degrades precisely because
  people act on it.)
- **Synthetic-data honesty:** while data comes from the simulator, every metrics surface (README,
  dashboard, metadata) carries `data_source: simulated`. Simulator metrics validate plumbing; they
  are never quoted as expected field performance. The circularity (labels generated from features)
  is documented in the README as a known property of the demo environment.

### 3.3 Evaluation & calibration (fixes ML-5, ML-9)

- **Class imbalance:** at 20–27% prevalence, drop SMOTE; keep `class_weight='balanced'`. (If real
  data lands at <5%, reconsider — inside folds only, never before calibration.)
- **Calibration:** `CalibratedClassifierCV` fit on non-resampled data; publish a **reliability
  curve + Brier score** per horizon in metadata and on the ML dashboard. Acceptance gate: expected
  calibration error < 0.05 on holdout.
- **Metrics that matter for maintenance,** reported per horizon on the temporal holdout *and*
  grouped-by-asset split:
  - Recall on failure class at the operating threshold (missed failures are the expensive error).
  - **Precision@budget:** precision within the top-K units the shop can actually service per week
    (K configurable; default 10% of fleet) — the honest "will my mechanic trust the queue" number.
  - **Lead time:** distribution of (first HIGH flag → failure event) in days; median must exceed
    the PM scheduling latency (default 7d) to be operationally useful.
  - PR-AUC, ROC-AUC, Brier — secondary, for trend tracking.
- **Storage/display:** replace the shoehorned `model_training_metrics` columns with a long-format
  `model_metrics(model_version, horizon, split ∈ {temporal, by_asset}, metric, value)` table.
  Dashboard renders per-horizon binary confusion matrices and never averages AUCs into "precision."
  Delete `getDefaultMetrics()` and the hardcoded feature-importance route — empty states instead.
- **Threshold governance:** LOW/MEDIUM/HIGH cutoffs (0.30/0.60 today) become per-horizon config
  chosen from the calibrated holdout to hit a target precision@budget, stored in the version bundle
  with the rationale; the UI shows "HIGH means ≥X% calibrated probability."

### 3.4 Feature governance — single source of truth (fixes ML-6, ML-10, ML-8)

- **One definition module:** `server/features/` (TypeScript) is the *only* implementation of raw
  feature semantics. It emits the raw `FeatureVector`.
- **One transform pipeline:** Python owns *model-space* transforms (encode, clip, log) as a single
  ordered function serialized into the version bundle (`transforms.json`: ordered steps + params).
  Training and the predictor call the same function; unit test asserts
  `predictor.transform == training.transform` on a fixture frame.
- **One imputation table:** defaults (`days_since=999`, `mtbf=500`, …) live in the shared contract;
  Node stops re-implementing them per call site.
- **Projector correctness:** `_age_snapshot` ages only *raw* fields (age, days-since, hours via
  hours_velocity) and re-derives everything else by calling the shared derivation, then the shared
  transform. Property test: projection at day 0 == live prediction for the same snapshot.
- **Contract test in CI:** Node emits a golden payload from the fixture DB → validated against the
  pydantic schema → column list asserted equal to the bundle's `feature_cols`.

### 3.5 Model lifecycle (hardens what exists)

- Registry keeps champion/challenger/retired + history (as today) but references **bundles** (§2.4).
- Promotion requires: challenger metadata present, calibration gate passed, and ≥N shadow batches
  with score-delta report (shadow scoring already exists — persist its summaries).
- Retraining triggers (keep monitor.py behavior): PSI ALERT on data/prediction/bias drift, or
  scheduled monthly, or manual. Auto-*train* is fine; auto-*promote* never.
- Drift: three-layer detection is good; add model-performance drift once real labels mature
  (rolling recall on realized outcomes — the labels arrive 10/30/60 days late by construction).
- Rollback: `POST /models/rollback` re-pins the previous champion bundle (bundle immutability makes
  this trivial).

### 3.6 Roadmap (Phase B seam, not stubbed in the hot path)

- **Richer telemetry features:** vibration/temperature trends already flow through
  `sensor_degradation_rate`; Phase B adds per-sensor rolling aggregates from the telemetry layer
  (§4) as *additional columns in the same FeatureVector contract* — no architectural change.
- **Survival / RUL models:** gradient-boosted survival or discrete-time hazard model as a second
  bundle type behind the same `/predict` contract (output adapter maps survival curve → per-horizon
  probabilities, which keeps the UI stable). The three-binary-classifier design is retained until a
  survival model beats it on precision@budget + lead time on real data.
- **Cost-optimal scheduling:** move the client-side cost model server-side, parameterize repair
  premium vs. PM cost per category (fixing the category-name mismatch), and optimize the weekly PM
  plan under shop-capacity constraints (small ILP; Phase B).

---

## 4. Vendor-Agnostic Telemetry Layer (the moat)

Design now, build in Phase B. The pattern is **ports-and-adapters into a canonical asset/telemetry
model**, mirroring how the AEMP 2.0 / ISO 15143-3 standard already frames mixed-fleet telematics —
adapters should consume AEMP feeds first (Cat, Komatsu, Deere all expose them) and vendor-native
APIs only where AEMP is insufficient.

```
Cat VisionLink ──┐  (AEMP/ISO 15143-3 pull, 15-min cadence)
KOMTRAX ─────────┤
JDLink ──────────┼──► Ingestion adapters ──► telemetry_raw (immutable, per-vendor JSON)
CSV/manual ──────┤        (per-vendor)              │ normalize + unit-convert + dedupe
Sensors/IoT ─────┘                                  ▼
                                        canonical tables:
                                        asset_identity(oem_id ↔ internal id, VIN/serial match)
                                        telemetry_readings(asset, ts, metric, value, unit, source, quality)
                                        utilization_daily(asset, date, hours, fuel, idle_pct, location)
                                                    │
                                                    ▼
                                        FeatureVector builder (§3.4) — same contract
```

Decisions:
- **Adapter contract:** each adapter implements `fetch(since) → RawRecord[]`, `normalize(RawRecord)
  → CanonicalReading[]`; adapters are config-registered per tenant fleet. Failures are per-adapter
  (one OEM outage never blocks the rest); each adapter reports freshness (`last_successful_sync`)
  surfaced on the fleet dashboard.
- **Canonical metric dictionary** with units (engine_hours, fuel_rate_lph, coolant_temp_c, …);
  vendor fields map into it; unmapped fields land in `raw` for later. Idempotent upserts keyed
  `(asset, metric, ts, source)`.
- **Asset identity resolution** is the hard, valuable part: match OEM feeds to internal assets by
  serial/VIN with a manual-review queue for ambiguous matches.
- **Un-telematized assets** are first-class: `utilization_daily` derives from rentals + operator
  hour-meter entries (mobile-friendly form); features degrade gracefully via the `quality` field —
  a per-asset **data-confidence score** shown next to risk (never present a low-data score with the
  same visual authority; see §5).
- The current `sensor_data_logs` simulator becomes just another adapter (`source='simulator'`),
  which keeps the demo path and the future real path identical.

---

## 5. UX / UI Design (investment-grade)

### Information architecture

1. **Fleet command center** (landing): KPI strip (fleet health index, HIGH count with Δ, predicted
   downtime dollars at risk, PM backlog); ranked **risk queue** (the core object: unit, category,
   risk per horizon as compact tri-band, top driver in plain words, lead-time estimate,
   data-confidence, action button); filters by category/site/status; density toggle.
2. **Asset detail**: header (identity, status, rental state) → risk panel (three horizons with
   calibrated probability + trend arrow + projection sparkline with HIGH-crossing marker) →
   **explanation panel** → maintenance/rental timeline (event-source badges) → sensor trends.
3. **Explainability surface (trust-critical):** SHAP already computed per prediction — surface it as
   a horizontal contribution bar chart: signed bars ("+21% Wear rate", "−8% Days since last
   service"), each expandable to the raw feature value vs. fleet baseline. Bar labels name the
   quantity and never a direction — the sign and colour carry that, and a label that presumes
   one ("Short time between failures") contradicts the bar whenever SHAP reports it protective. Kill the current dual
   system where heuristic "drivers" (hardcoded thresholds) masquerade as model attribution (ML-9
   adjacent): one attribution source (SHAP), one phrase dictionary mapping features → mechanic
   language. Confidence & provenance line under every score: "v1.15 · trained 2026-03-14 ·
   calibrated · data confidence: high (telemetry + full history)".
4. **Action loop:** from risk panel → "Schedule PM" creates a work order pre-filled with inspection
   points derived from top drivers; completing it writes `maintenanceEvents` with
   `eventSource='PREDICTIVE_INTERVENTION'` (closing the label loop §3.2); ROI card accrues the
   avoided-cost estimate.
5. **ML ops dashboard** (admin): keep, but honest (per-horizon binary confusion matrices,
   reliability curves, precision@budget, drift cards, champion/challenger compare, promote/rollback
   with confirmation + audit trail).

### Design language (tokens, direction)

- **Type:** Inter (UI) + JetBrains Mono (numerals/IDs); numeric tables use tabular-nums.
- **Color:** neutral slate surface ramp; **semantic risk is the only saturated color**: HIGH
  `#DC2626`, MEDIUM `#D97706`, LOW `#059669` (AA on both themes), plus a blue reserved for
  interactive elements — risk colors never used decoratively. Dark mode default for the command
  center (`data-theme` switch; tokens as CSS variables).
- **Recharts styling:** one shared theme module (axis/grid at 40% neutral, 1.5px series strokes,
  risk-band reference areas on projection charts, tooltip = card tokens). Sparklines inline in the
  queue rows.
- **Components:** shadcn/ui as today; add `RiskBadge` (tri-horizon compact), `DriverBar`,
  `ConfidenceTag`, `FreshnessDot` (telemetry staleness).
- **Empty/degraded states:** every ML surface has a real empty state ("no model yet — run
  pipeline") instead of fabricated defaults; stale predictions get a visible banner (§2.5).

---

## 6. Enterprise Non-Negotiables

| Concern | Decision (Phase A unless marked B) |
|---|---|
| **AuthN** | Keep session auth; enforce `SESSION_SECRET` (fail fast), persistent session store (mysql/redis-backed, not MemoryStore), bcrypt cost 12, rate-limit login. Remove unused passport/JWT deps or actually adopt them (decision: remove; JWT_SECRET is dead config today). SSO/OIDC = Phase B. |
| **AuthZ / RBAC** | Roles: ADMINISTRATOR, FLEET_MANAGER (new: can act on risk, schedule PM; cannot train/promote/reset), VIEWER. Server-side middleware per route group; ML admin verbs require ADMINISTRATOR + are proxied only (SEC-1: ML port private, S2S token). Fix `/api/admin/seed` to admin-only. |
| **Audit logging** | `audit_log(actor, action, entity, before/after, ts)` for: model promote/rollback/train, threshold changes, overrides (table exists — wire it into UI), resets, dispatch acknowledgements (currently a UI-only checkbox — persist who accepted HIGH-risk dispatch and when; it's the liability trail). |
| **Multi-tenancy** | Phase B: `tenant_id` on every table + row scoping middleware + per-tenant model bundles. Phase A prepares by never hardcoding fleet-wide singletons in new code (e.g., simulation_state id=1 pattern is quarantined to demo mode). |
| **Data lineage** | Every prediction row already stores model version — add `feature_snapshot_id` FK and `contract_version`; every snapshot stores `builder_version` (git sha). Bundles content-hashed (§2.4). That closes the loop: score → snapshot → code version. |
| **Observability** | Structured JSON logs (pino Node / structlog Python) with request IDs propagated Node→Python; drop full response-body logging (SEC-2); metrics endpoints (p95 latency, batch durations, drift status) — Prometheus format; Sentry-class error capture both services. Health endpoints already exist — extend with dependency status. |
| **Secrets** | Rotate everything in the current `.env` (SEC-2); `.env.example` only in repo; runtime injection via platform env; startup validation of required vars (Node & Python); timing-safe agent-key compare. |
| **CI/CD + IaC** | Keep the four CI jobs; add: leakage canaries + contract test + calibration gate (§3), `docker compose config` lint, image builds on tag. Add MySQL service to compose (today's compose can't actually run the stack); one-command `make demo`. Railway/host IaC = Phase B. |
| **MLOps** | Versioned immutable bundles; challenger-by-default with gated manual promotion (exists — harden per §3.5); drift → auto-train never auto-promote; rollback endpoint; MLflow optional as today; retention policy for prediction tables. |

---

## 7. Engineering-Principles Matrix

| -ility | Pattern adopted | Where it lands | Gap it closes | Trade-off rejected |
|---|---|---|---|---|
| **Reliability** | Immutable versioned model bundles + pinned resolution | `ml-service/registry/vX.Y/` + predictor loader | ML-7 (champion serving challenger's transforms) | "Latest file wins" convenience; also rejected DB-stored blobs (harder to inspect/diff) |
| **Reliability** | Degraded-mode reads + explicit staleness, no fabricated fallbacks | gateway `/api/ml/*` + UI banners | ML-9 (hardcoded default metrics), silent failure masking | Fail-closed everywhere (would blank the dashboard on every ML restart) |
| **Reliability** | Set-based labeling & batched scoring as jobs with progress | `labelSnapshots` SQL rewrite; score-fleet job | ARCH-3 (N+1 at fleet scale) | Full message-queue infra now (premature for 3 services; seam kept for Phase B) |
| **Reliability** | Leakage canaries + point-in-time fixture test in CI | `ml-ci.yml` new jobs | ML-1/ML-3 regression risk, QA-1 | Relying on code review to catch temporal bugs (it demonstrably didn't) |
| **Adaptability** | Ports-and-adapters for telemetry sources (AEMP-first) | §4 ingestion layer | vendor lock-in; simulator/real-data divergence | Per-OEM bespoke pipelines (moat becomes maintenance burden) |
| **Adaptability** | Stable inference contract + versioned schema, survival models as new bundle type behind same port | `shared/contracts/prediction.json` | ML-10 payload drift; future RUL migration cost | Letting each caller shape its own payload (three already diverged) |
| **Adaptability** | Config-as-data for thresholds/imputation in bundle | `transforms.json`, threshold config | ML-12 (dead config table), scattered constants | Hardcoded constants "for simplicity" |
| **Maintainability** | Single feature-definition module + single transform pipeline shared train/serve | `server/features/` + bundle transforms | ML-6 (transform-order skew), triplicated payload assembly, ML-8 (projector formulas) | Duplicating features in Python "to keep ML self-contained" — the duplication is the bug factory |
| **Maintainability** | One DDL owner (Drizzle migrations), Python DML-only | migrations baseline; delete runtime DDL | ARCH-1 (schema in 4 places, broken quickstart) | drizzle-kit push forever (no history, no rollback, no CI verify) |
| **Maintainability** | Typed contracts end-to-end (zod ↔ JSON Schema ↔ pydantic, CI-verified) | shared contracts + CI contract test | QA-1, ML-10 | Trusting field-name convention across languages |
| **Maintainability** | Dead-code and artifact hygiene budget (repo ≤ small MBs; artifacts external) | delete legacy risk-scoring path, orphan pyc, 250MB pickles → store/LFS | OPS-2 | Keeping history "for reference" inside the deployable repo |
| **Scalability** | Vectorized batch inference + SHAP off the event loop | FastAPI batch endpoint rewrite | ARCH-3 (per-row loop blocks asyncio) | Per-request SHAP microservice (overkill at this stage) |
| **Scalability** | Append tables get retention + `latest` views + real upserts | prediction/risk-score tables | ARCH-2 (unbounded duplicate growth) | Unbounded audit-everything storage |
| **Scalability** | Tenant-scoped data model as Phase B seam (tenant_id, per-tenant bundles) | schema evolution plan | single-fleet assumptions (simulation_state id=1) | Building multi-tenant now before first real tenant |
| **Security (cross-cutting)** | Private ML plane + S2S token + audit of admin verbs | compose network, FastAPI middleware | SEC-1 | mTLS/service mesh now (three services, one host) |

---

## 8. Migration / Refactor Plan

Phase A is **verify–harden–polish** of an already-built system; nothing here is a rewrite.
Ordering within phases is dependency order.

### Phase A — demo-polish / credibility (target: 2–3 focused weeks)

**A0 — Stop the bleeding (day 1)**
1. Rotate all secrets in `.env`; verify public-repo history (SEC-2). Fail-fast on missing secrets.
2. Fix `trainAndPoll` status polling (OPS-1) — demo onboarding must succeed end-to-end.
3. Remove ML-service host port; add S2S token middleware (SEC-1). Add MySQL to compose.

**A1 — ML correctness (the core of the phase)**
4. Bound every feature query to `snapshotTs` (ML-1); converge the four payload-assembly sites onto
   `buildSnapshot()`; add the point-in-time fixture test.
5. Labeling v2: eventSource-aware labels, day-0 exclusion, intervention censoring (ML-11/§3.2).
6. Split hygiene: embargo at holdout boundary; grouped-by-asset metrics reported (ML-3); transforms
   fit on dev only (ML-4).
7. Calibration fix: drop SMOTE, calibrate on real prevalence, publish reliability curves (ML-5).
8. Unify transforms into the bundle pipeline; fix predictor ordering; fix projector aging + day-0
   property test (ML-6, ML-8).
9. Bundle-ify the registry with pinned resolution (ML-7).
10. **Regenerate snapshots → retrain → publish honest metrics** with `data_source: simulated`
    framing everywhere (ML-2). Expect the AUCs to drop; that drop is the deliverable.

**A2 — Metric honesty & UX**
11. Long-format metrics table; dashboard: per-horizon confusion matrices, reliability curve,
    precision@budget; delete `getDefaultMetrics()` + hardcoded importance route; fix confidence
    labels (ML-9).
12. Explanation panel: SHAP-only attribution with plain-language dictionary; provenance line.
13. Risk queue upgrade + action loop writing `PREDICTIVE_INTERVENTION` events; persist dispatch
    acknowledgements.
14. Design tokens pass (semantic risk color, dark mode, chart theme).

**A3 — Repo & pipeline hygiene**
15. Drizzle migration baseline; move runtime DDL into schema (ARCH-1).
16. Set-based labeling; vectorized batch endpoint (ARCH-3); unique key + upsert or retention on
    prediction tables (ARCH-2).
17. Delete dead code (legacy risk scorer route usage, empty orchestrator file, orphan pyc, unused
    deps, duplicate seed scripts); move pickles out of git (OPS-2); README rewrite to match reality
    (metrics framing, quickstart that works, remove GenAI claim or wire it behind a flag — LLM-1).
18. CI additions: leakage canaries, contract test, calibration gate, compose lint (QA-1).

**Exit criteria for Phase A:** clean-clone quickstart works; seed completes; all CI gates green;
metrics on dashboard = metrics in metadata = metrics in README, all labeled simulated; no
unauthenticated path can mutate models.

### Phase B — enterprise / investment scale

1. **Telemetry ingestion layer** (§4): AEMP adapter framework, canonical model, identity
   resolution, data-confidence scoring; simulator becomes an adapter.
2. **Real-data validation program:** design partner fleet(s); labels from REACTIVE_REPAIR;
   baseline vs. calendar-PM comparison; the first honest field metrics (this, not features, is what
   converts diligence).
3. **Multi-tenancy:** tenant_id scoping, per-tenant bundles/thresholds, tenant admin.
4. **MLOps depth:** performance-drift on realized labels, scheduled retrains, shadow-report
   automation, canary scoring windows, model cards per bundle.
5. **Richer models:** sensor time-series aggregates → discrete-time hazard / survival bundle behind
   the same contract; capacity-constrained weekly PM optimizer; server-side cost model with repair
   premiums.
6. **Platform:** SSO/OIDC, Prometheus + tracing, IaC for the hosting target, backup/DR policy,
   uptime SLOs.

---

## Open questions & assumptions (running log)

See final report; key assumptions: MySQL stays (no Postgres migration in scope); Node remains the
feature-assembly owner (alternative — Python-side feature building against the DB — rejected to
keep one implementation next to the operational data model); demo/simulator remains a supported
first-class mode after Phase A.
