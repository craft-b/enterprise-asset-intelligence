// server/services/predictive-maintenance.ts
//
// Thin HTTP client — delegates all ML inference to the FastAPI service.
// Maintains the same public interface as the previous rule-based implementation
// so routes.ts requires zero changes.
//
// Flow:
//   routes.ts → predictiveMaintenanceService → FastAPI /predict → DB

import { db } from "../db";
import { assetRiskPredictions, equipmentRiskScores, equipment } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { enhancedFeatureService as featureEngineeringService } from "./feature-engineering-enhanced";
import { IMPUTATION_DEFAULTS, COLD_START, isColdStart } from "./imputation";
import { mlFetch, ML_SERVICE_URL, describeMlFailure } from "./ml-client";
import { getSimulationDate } from "./simulation-clock";
// Request timeouts for the ML plane, overridable because the right value is a
// property of the deployment, not the code. Alongside a warm container 10s is
// generous. On a host that suspends an idle instance (Render free, Fly
// scale-to-zero) the first request after a sleep pays a 30-60s cold start, so
// the defaults below would fail every prediction until something else woke the
// service -- raise both there.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[ML] ignoring invalid ${name}=${raw}; using ${fallback}ms`);
    return fallback;
  }
  return parsed;
}

const ML_TIMEOUT_MS        = envMs("ML_TIMEOUT_MS", 10_000);
const ML_HEALTH_TIMEOUT_MS = envMs("ML_HEALTH_TIMEOUT_MS", 3_000);

// ── Public types (unchanged from previous implementation) ─────────────────────

export interface RiskPrediction {
  equipmentId:        number;
  failureProbability: number;
  riskBand:           "LOW" | "MEDIUM" | "HIGH";
  riskScore:          number;
  confidence:         number;
  topDrivers:         Array<{ feature: string; impact: number; description: string }>;
  snapshotTs:         Date;
  modelVersion:       string;
  recommendation:     string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function callMLService(
  snapshot: Record<string, unknown>
): Promise<{
  equipment_id:  number;
  model_version: string;
  risk_trend:    string;
  predictions: {
    "10d": { failure_probability: number; risk_level: "LOW" | "MEDIUM" | "HIGH"; risk_score: number; top_risk_drivers: Record<string, number> };
    "30d": { failure_probability: number; risk_level: "LOW" | "MEDIUM" | "HIGH"; risk_score: number; top_risk_drivers: Record<string, number> };
    "60d": { failure_probability: number; risk_level: "LOW" | "MEDIUM" | "HIGH"; risk_score: number; top_risk_drivers: Record<string, number> };
  };
  recommendation: string | null;
}> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);

  try {
    const response = await mlFetch(`/predict/multi-horizon`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(snapshot),
      signal:  controller.signal,
    });

    if (!response.ok) {
      // The body goes to the server log, where a stack trace or an HTML page is
      // useful. The thrown message is summarised, because it reaches the UI --
      // interpolating the body here put an entire hosting-provider error page
      // into a dialog.
      const summary = await describeMlFailure(response.clone(), "/predict/multi-horizon");
      try {
        console.error(`[PM] ML service ${response.status} body:`, await response.text());
      } catch {}
      throw new Error(`ML service returned ${summary}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function checkMLServiceHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), ML_HEALTH_TIMEOUT_MS);
    const response   = await mlFetch(`/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

export function buildSnapshotPayload(
  equipmentId: number,
  snapshot: Record<string, unknown>
): Record<string, unknown> {
  const safe = (val: unknown, fallback: number): number => {
    const n = Number(val);
    return isNaN(n) || val === null || val === undefined ? fallback : n;
  };

  return {
    equipment_id:                equipmentId,
    asset_age_years:             safe(snapshot.assetAgeYears, 1),
    category:                    String(snapshot.category ?? "Unknown"),
    total_hours_lifetime:        safe(snapshot.totalHoursLifetime, 0),
    hours_used_30d:              safe(snapshot.hoursUsed30d, 0),
    hours_used_90d:              safe(snapshot.hoursUsed90d, 0),
    rental_days_30d:             Math.round(safe(snapshot.rentalDays30d, 0)),
    rental_days_90d:             Math.round(safe(snapshot.rentalDays90d, 0)),
    avg_rental_duration:         safe(snapshot.avgRentalDuration, 1),
    maintenance_events_90d:      safe(snapshot.maintenanceEvents90d, 0),
    maintenance_cost_180d:       safe(snapshot.maintenanceCost180d, 0),
    avg_downtime_per_event:      safe(snapshot.avgDowntimePerEvent, 0),
    days_since_last_maintenance: Math.max(0, safe(snapshot.daysSinceLastMaintenance, IMPUTATION_DEFAULTS.days_since_last_maintenance)),
    vendor_reliability_score:    safe(snapshot.vendorReliabilityScore, 0.5),
    jobsite_risk_score:          safe(snapshot.jobSiteRiskScore, 0.5),
    usage_intensity:             Math.min(safe(snapshot.usageIntensity, 1), 12),
    usage_trend:                 Math.min(Math.max(safe(snapshot.usageTrend, 1), 0.5), 3.0),
    utilization_vs_expected:     safe(snapshot.utilizationVsExpected, 1),
    wear_rate:                   safe(snapshot.wearRate, 0),
    aging_factor:                Math.min(safe(snapshot.agingFactor, 0.1), 1.0),
    maint_overdue:               safe(snapshot.maintOverdue, 0),
    cost_per_event:              safe(snapshot.costPerEvent, 0),
    maint_burden:                safe(snapshot.maintBurden, 0),
    mechanical_wear_score:       Math.min(safe(snapshot.mechanicalWearScore, 1), 10),
    abuse_score:                 Math.min(safe(snapshot.abuseScore, 1), 10),
    neglect_score:               Math.min(Math.max(0, safe(snapshot.neglectScore, 1)), 10),
    mean_time_between_failures:  safe(snapshot.meanTimeBetweenFailures, IMPUTATION_DEFAULTS.mean_time_between_failures),
  };
}

async function savePrediction(
  prediction: RiskPrediction,
  rawDrivers?: Record<string, number> | string[]
): Promise<void> {
  // Use raw impact scores from ML service if available
  const driverEntries = rawDrivers && !Array.isArray(rawDrivers)
    ? Object.entries(rawDrivers)
    : prediction.topDrivers.map(d => [d.feature, d.impact] as [string, number]);

  await db.insert(assetRiskPredictions).values({
    equipmentId:        prediction.equipmentId,
    snapshotTs:         prediction.snapshotTs,
    failureProbability: prediction.failureProbability.toFixed(4),
    riskBand:           prediction.riskBand,
    topDriver1:         driverEntries[0]?.[0] ?? null,
    topDriver1Impact:   driverEntries[0]?.[1]?.toFixed(4) ?? null,
    topDriver2:         driverEntries[1]?.[0] ?? null,
    topDriver2Impact:   driverEntries[1]?.[1]?.toFixed(4) ?? null,
    topDriver3:         driverEntries[2]?.[0] ?? null,
    topDriver3Impact:   driverEntries[2]?.[1]?.toFixed(4) ?? null,
    modelVersion:       prediction.modelVersion,
    recommendation:     prediction.recommendation,
  });
}

function convertMLResponse(
  result: Awaited<ReturnType<typeof callMLService>>,
  snapshotTs: Date
): RiskPrediction {
  const p30d = result.predictions["30d"];
  return {
    equipmentId:        result.equipment_id,
    failureProbability: p30d.failure_probability,
    riskBand:           p30d.risk_level,
    riskScore:          Math.round(p30d.failure_probability * 100),
    confidence:         0.85,
    topDrivers: Object.entries(p30d.top_risk_drivers || {}).map(([key, val]) => ({
      feature:     key,
      impact:      typeof val === 'number' ? val : Number(val),
      description: key,
    })),
    snapshotTs,
    modelVersion:  result.model_version,
    recommendation: result.recommendation,
  };
}

// ── Public service class ──────────────────────────────────────────────────────

class PredictiveMaintenanceService {

  /**
   * Primary entry point — generates a fresh snapshot, calls FastAPI,
   * persists the result, and returns the prediction.
   */
  async predictRisk(equipmentId: number): Promise<RiskPrediction> {
    const healthy = await checkMLServiceHealth();
        if (!healthy) {
          throw new Error(
            `ML service unavailable at ${ML_SERVICE_URL}. ` +
            `Ensure the FastAPI service is running: cd ml-service && python run.py`
          );
        }

        // The simulation cursor, not the wall clock. Scoring at new Date()
        // put every prediction ~6 months past the end of the seeded data, so
        // the rolling sensor features were empty and every asset looked
        // neglected. See services/simulation-clock.ts.
        const asOf = await getSimulationDate();
        const snapshot = await featureEngineeringService.generateSnapshot(equipmentId, asOf);

        // Cold-start: brand-new assets are out-of-distribution for the model, so a
        // deterministic rule scores them. Tagged with the rule modelVersion (ML-10)
        // so the stored prediction is never mistaken for a model output.
        if (isColdStart(snapshot.assetAgeYears, snapshot.totalHoursLifetime)) {
          const prediction: RiskPrediction = {
            equipmentId,
            failureProbability: COLD_START.probability,
            riskBand: COLD_START.riskBand,
            riskScore: Math.round(COLD_START.probability * 100),
            confidence: 0.95,
            topDrivers: [
              { feature: 'asset_age_years', impact: 0.01, description: 'New unit — minimal hours' },
              { feature: 'total_hours_lifetime', impact: 0.01, description: 'Recent inspection completed' },
              { feature: 'days_since_last_maintenance', impact: 0.01, description: 'Low operational age' },
            ],
            snapshotTs: snapshot.snapshotTs,
            modelVersion: COLD_START.modelTag,
            recommendation: 'Equipment is new and within safe operating parameters. Continue standard inspection schedule.',
          };
          await savePrediction(prediction);
          return prediction;
        }

        const payload = buildSnapshotPayload(equipmentId, snapshot as unknown as Record<string, unknown>);

        const invalidFields = Object.entries(payload).filter(([, v]) =>
          typeof v === 'number' && isNaN(v as number)
        );
        if (invalidFields.length > 0) {
          console.error(`[PM] NaN fields in payload for EQ-${equipmentId}:`, invalidFields.map(([k]) => k));
        }

        const result = await callMLService(payload);
        const prediction = convertMLResponse(result, snapshot.snapshotTs);
        await savePrediction(prediction, result.predictions["30d"].top_risk_drivers);

        console.log(
          `[PM] EQ-${equipmentId} → ${prediction.riskBand} ` +
          `(${(prediction.failureProbability * 100).toFixed(1)}%)`
        );
        return prediction;
  }
  

  /**
   * Returns the latest stored prediction for an equipment item.
   * If none exists, runs a fresh prediction.
   */
  async getLatestPrediction(equipmentId: number): Promise<RiskPrediction | null> {
    const [stored] = await db
      .select()
      .from(assetRiskPredictions)
      .where(eq(assetRiskPredictions.equipmentId, equipmentId))
      .orderBy(desc(assetRiskPredictions.predictedAt))      .limit(1);

    if (!stored) return null;

    // Parse stored top risk drivers
    const topDrivers: RiskPrediction["topDrivers"] = [
      stored.topDriver1 ? { feature: stored.topDriver1, impact: Number(stored.topDriver1Impact ?? 0), description: stored.topDriver1 } : null,
      stored.topDriver2 ? { feature: stored.topDriver2, impact: Number(stored.topDriver2Impact ?? 0), description: stored.topDriver2 } : null,
      stored.topDriver3 ? { feature: stored.topDriver3, impact: Number(stored.topDriver3Impact ?? 0), description: stored.topDriver3 } : null,
    ].filter(Boolean) as RiskPrediction["topDrivers"];
     
    return {
      equipmentId:        stored.equipmentId,
      failureProbability: Number(stored.failureProbability),
      riskBand:           (stored.riskBand ?? "LOW") as "LOW" | "MEDIUM" | "HIGH",
      riskScore:          Math.round(Number(stored.failureProbability) * 100),
      confidence:         0.85,
      topDrivers,
      snapshotTs:         stored.snapshotTs,
      modelVersion:       stored.modelVersion ?? "v1.0",
      recommendation:     stored.recommendation ?? null,
    };
  }

  /**
   * Runs predictions for all equipment. Skips individual failures gracefully.
   */
  /**
   * Score the whole fleet, reporting why it produced nothing when it does.
   *
   * The array-returning form below cannot distinguish "no equipment", "the ML
   * service is asleep" and "every single prediction failed" -- all three come
   * back as []. The seed pipeline then marked the step completed with
   * "0 predictions generated" and a green check, which is how a seeded fleet
   * ended up with an empty risk queue and no indication of why.
   */
  async predictAllEquipmentWithOutcome(): Promise<{
    predictions: RiskPrediction[];
    attempted: number;
    serviceAvailable: boolean;
    firstError?: string;
  }> {
      const healthy = await checkMLServiceHealth();
      if (!healthy) {
        console.warn(`[PM] ML service unavailable — skipping batch predictions`);
        return { predictions: [], attempted: 0, serviceAvailable: false };
      }
      const allEquipment = await db.select({ id: equipment.id }).from(equipment);
      const predictions: RiskPrediction[] = [];
      let firstError: string | undefined;

      for (const equip of allEquipment) {
        try {
          const prediction = await this.predictRisk(equip.id);
          predictions.push(prediction);

          // Sync to equipment_risk_scores so Risk Analytics stays aligned
          await db.insert(equipmentRiskScores).values({
            equipmentId: prediction.equipmentId,
            riskScore: prediction.riskScore,
            riskLevel: prediction.riskBand,
            drivers: JSON.stringify(prediction.topDrivers.map(d => d.description)),
            modelVersion: prediction.modelVersion,
          }).onDuplicateKeyUpdate({
            set: {
              riskScore: prediction.riskScore,
              riskLevel: prediction.riskBand,
              drivers: JSON.stringify(prediction.topDrivers.map(d => d.description)),
              modelVersion: prediction.modelVersion,
            }
          });
        } catch (err: any) {
          console.error(`[PM] Failed prediction for equipment ${equip.id}:`, err);
          // Keep the first reason. Every later one is usually the same cause,
          // and discarding all of them is what made a batch of zero silent.
          firstError ??= err?.message ?? String(err);
        }
      }

      console.log(`[PM] Batch complete — ${predictions.length}/${allEquipment.length} succeeded`);
      return {
        predictions,
        attempted: allEquipment.length,
        serviceAvailable: true,
        firstError,
      };
  }

  async predictAllEquipment(): Promise<RiskPrediction[]> {
    return (await this.predictAllEquipmentWithOutcome()).predictions;
  }

  /**
   * Returns fleet-wide risk distribution from the latest stored predictions.
   * Reads from DB rather than recalculating — fast and suitable for dashboards.
   */
  async getFleetRiskDistribution(): Promise<{
    low: number; medium: number; high: number; total: number;
  }> {
    const allEquipment = await db.select({ id: equipment.id }).from(equipment);
    let low = 0, medium = 0, high = 0;

    for (const equip of allEquipment) {
      const prediction = await this.getLatestPrediction(equip.id);
      if (!prediction) continue;

      if      (prediction.riskBand === "LOW")    low++;
      else if (prediction.riskBand === "MEDIUM") medium++;
      else                                        high++;
    }

    return { low, medium, high, total: low + medium + high };
  }
}

export const predictiveMaintenanceService = new PredictiveMaintenanceService();