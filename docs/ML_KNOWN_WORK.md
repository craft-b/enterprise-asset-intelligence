# Known modelling work

Defects found in the feature set that are real, understood, and deliberately
not fixed yet. Each one needs a retrain, which is a scored change — the
champion is v1.17 and its metrics are recorded against the current columns.

Written down rather than quietly carried, because an unlisted problem is
indistinguishable from an unnoticed one.

---

## 1. `vendor_reliability_score` does not measure a vendor

`server/services/feature-engineering-enhanced.ts` computes it as the unit's own
maintenance events per year, inverted and scaled to [0.40, 0.95]:

```
0.95 - (allMaint.length / assetAgeYears - 4) * 0.04
```

The `vendors` table is never read. The name asserts a cause — the supplier —
that the pipeline has no evidence for.

**Why it mattered.** This feature surfaces on the per-asset SHAP panel, the
part of the app a reader is most likely to trust and least able to check. It
rendered as "Lower-reliability vendor, 29% of this score", attributing nearly a
third of an explanation to a third party who was never consulted. On a system
whose selling point is explainability, a feature that misattributes causation
is worse than a feature that is merely weak.

**Done:** display label and API description now read "Maintenance frequency
index" and state plainly that no vendor data is involved.

**Outstanding:** rename the column to `maintenance_frequency_index` and retrain.
It is also largely redundant with `maintenance_events_90d`,
`maint_frequency_trend` and `mean_time_between_failures`, so the better fix may
be to drop it rather than rename it — worth testing both.

---

## 2. `jobsite_risk_score` is collinear by construction

```
0.30 + utilizationVsExpected * 0.30 + (min(usageTrend, 3) - 1) * 0.15
```

Both inputs are already separate model features. This is a deterministic linear
combination of two columns the model receives anyway, so it is perfectly
collinear with them and carries no information they do not.

The `jobSites` table is never read, so the name misattributes in the same way
as (1).

**Why it matters beyond the name.** A tree ensemble will split attribution
between a derived feature and its own components arbitrarily, depending on
which the trees happened to pick. So this feature does not merely add nothing —
it *dilutes* the attribution of `utilization_vs_expected` and `usage_trend`,
making the SHAP panel less faithful than it would be with the feature removed.
The explanation surface is degraded by a column that contributes no signal.

**Done:** display label and API description now read "Utilization exposure
index" and disclose the construction.

**Outstanding:** drop the feature and retrain. Expect the two component
features to absorb its attribution. Metrics should be unchanged within noise;
if they move materially, that is itself informative and worth understanding
before shipping the change.

---

## 3. Rental-derived features are sparse outside the first ten units

`server/seeds/rentals.ts` is a hardcoded 15-entry spec list whose equipment
indices run 0–9. With sixty assets, rentals only ever attach to the first ten.

So `rental_days_30d`, `rental_days_90d` and `avg_rental_duration` are
degenerate for 50 of 60 units.

This is invisible in the UI — the asset History card merges maintenance and
rentals, and maintenance events do cover the whole fleet, so no panel renders
empty. It is recorded here because it is a property of the training data, not
of the display.

**Outstanding:** scale the rental seed with the fleet, or accept the sparsity
and document it where the features are defined. Not urgent: it degrades three
features rather than misrepresenting anything.
