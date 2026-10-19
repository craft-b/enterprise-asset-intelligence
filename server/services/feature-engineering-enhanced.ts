// server/services/feature-engineering-enhanced.ts
// Enhanced feature engineering service that reads from sensor_data_logs
// and computes ML-ready feature snapshots for each equipment item.
// v2 — adds trend velocity features, fixes rentals90 bug, dynamic context scores

import { db } from "../db";
import { equipment, rentals, maintenanceEvents, maintenanceConfig } from "../../shared/schema";
import { eq, sql, and, gte, lte, desc } from "drizzle-orm";
import { DEFAULT_MAINTENANCE_INTERVAL_DAYS } from "../seeds/maintenance-config";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface EnhancedFeatureSnapshot {
  equipmentId: number;
  snapshotTs: Date;
  category: string;

  // Age & usage
  assetAgeYears: number;
  totalHoursLifetime: number;
  hoursUsed30d: number;
  hoursUsed90d: number;

  // Rental activity
  rentalDays30d: number;
  rentalDays90d: number;
  avgRentalDuration: number;

  // Maintenance
  maintenanceEvents90d: number;
  maintenanceCost180d: number;
  avgDowntimePerEvent: number;
  daysSinceLastMaintenance: number | null;
  meanTimeBetweenFailures: number | null;

  // Context
  vendorReliabilityScore: number;
  jobSiteRiskScore: number;

  // Derived intensity features
  usageIntensity: number;
  usageTrend: number;
  utilizationVsExpected: number;
  wearRate: number;
  agingFactor: number;
  maintOverdue: number;
  costPerEvent: number;
  maintBurden: number;

  // Composite risk scores (0–10)
  mechanicalWearScore: number;
  abuseScore: number;
  neglectScore: number;

  // ── TREND VELOCITY FEATURES (v2) ──────────────────────────────────────────
  // Rate of change features — key signal for short-horizon prediction
  wearRateVelocity: number;        // change in wear rate over last 90d (per month)
  maintFrequencyTrend: number;     // ratio: maint events 30d vs 90d annualised
  costTrend: number;               // ratio: avg cost per event 90d vs 180d
  hoursVelocity: number;           // hours/day in last 30d vs last 90d
  neglectAcceleration: number;     // days_since_maint / mean_time_between — overdue ratio
  sensorDegradationRate: number;   // vibration/temp trend vs baseline (0–1)

  // Optional sensor readings
  avgVibration?: number;
  maxVibration?: number;
  avgEngineTemp?: number;
  avgOilPressure?: number;
  avgHydraulicPressure?: number;
  errorCodeCount?: number;
  warningCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE DERIVED-FEATURE FORMULAS
// Extracted so the core scoring math can be unit tested without a DB.
// ─────────────────────────────────────────────────────────────────────────────

export function computeWearRateVelocity(wearRate: number, wearRate90dAgo: number): number {
  return (wearRate - wearRate90dAgo) * 30; // per month
}

export function computeMaintFrequencyTrend(maintRate30d: number, maintRate90d: number): number {
  return maintRate90d > 0 ? maintRate30d / maintRate90d : 1.0;
}

export function computeCostTrend(avgCostRecent: number, avgCostPrior: number): number {
  return avgCostPrior > 0 ? avgCostRecent / avgCostPrior : 1.0;
}

export function computeHoursVelocity(hoursPerDay30d: number, hoursPerDay90d: number): number {
  return hoursPerDay90d > 0 ? hoursPerDay30d / hoursPerDay90d : 1.0;
}

export function computeMechanicalWearScore(totalHoursLifetime: number, assetAgeYears: number): number {
  const hoursFactor = Math.min(totalHoursLifetime / 5000, 1);
  const ageFactor = Math.min(assetAgeYears / 8, 1);
  return Math.min(hoursFactor * 5 + ageFactor * 5, 10);
}

export function computeAbuseScore(usageIntensity: number, usageTrend: number): number {
  const intensityFactor = Math.min(usageIntensity / 10, 1);
  const trendFactor = Math.max(0, Math.min((usageTrend - 1) / 0.5, 1));
  return Math.min(intensityFactor * 6 + trendFactor * 4, 10);
}

export function computeNeglectScore(daysSinceLastMaintenance: number | null, maintOverdue: number): number {
  const neglectDaysFactor = daysSinceLastMaintenance !== null
    ? Math.min(daysSinceLastMaintenance / 120, 1)
    : 0.5;
  return Math.min(Math.max(0, neglectDaysFactor * 7 + (maintOverdue ? 3 : 0)), 10);
}

export function computeNeglectAcceleration(daysSinceLastMaintenance: number | null, intervalDays: number): number {
  return daysSinceLastMaintenance !== null && intervalDays > 0
    ? Math.min(daysSinceLastMaintenance / intervalDays, 3.0)
    : 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────────────────

class EnhancedFeatureEngineeringService {

  async generateSnapshot(
    equipmentId: number,
    snapshotDate: Date
  ): Promise<EnhancedFeatureSnapshot> {
    const [equip] = await db
      .select()
      .from(equipment)
      .where(eq(equipment.id, equipmentId))
      .limit(1);

    if (!equip) {
      throw new Error(`Equipment ${equipmentId} not found`);
    }

    const now = snapshotDate;
    const d30  = new Date(now); d30.setDate(d30.getDate() - 30);
    const d90  = new Date(now); d90.setDate(d90.getDate() - 90);
    const d180 = new Date(now); d180.setDate(d180.getDate() - 180);
    const d365 = new Date(now); d365.setDate(d365.getDate() - 365);
    // ML-1: every window query below is bounded ABOVE by the snapshot date.
    // Without the upper bound, backfilled snapshots read events that happen
    // after the snapshot — including the label event itself (temporal leakage).
    const nowStr = now.toISOString().split('T')[0];

    // ── Asset age ──────────────────────────────────────────────────────────
    const equipAny = equip as any;
    let purchaseDate: Date;
    if (equipAny.purchaseDate || equipAny.purchase_date) {
      purchaseDate = new Date(equipAny.purchaseDate ?? equipAny.purchase_date);
    } else if (equipAny.yearManufactured || equipAny.year_manufactured) {
      const year = Number(equipAny.yearManufactured ?? equipAny.year_manufactured);
      purchaseDate = new Date(`${year}-01-01`);
    } else if (equipAny.createdAt || equipAny.created_at) {
      purchaseDate = new Date(equipAny.createdAt ?? equipAny.created_at);
    } else {
      purchaseDate = new Date(now);
      purchaseDate.setFullYear(purchaseDate.getFullYear() - 3);
    }

    const assetAgeYears = (now.getTime() - purchaseDate.getTime()) / (365.25 * 24 * 3600 * 1000);

    // ── Hours — prefer sensor accumulation, fall back to equipment record ──
    const sensorHours = await this.getAccumulatedHoursFromSensors(equipmentId, purchaseDate, now);
    const recordHours = Number(equipAny.currentMileage ?? equipAny.totalHours ?? 0);
    const totalHoursLifetime = sensorHours > 0 ? sensorHours : recordHours;

    // ── Rental activity — FIXED: rentals90 now uses d90 not d30 ──────────
    const rentals30 = await db
      .select()
      .from(rentals)
      .where(
        and(
          eq(rentals.equipmentId, equipmentId),
          sql`${rentals.receiveDate} >= ${d30.toISOString().split('T')[0]}`,
          sql`${rentals.receiveDate} <= ${nowStr}`
        )
      );

    const rentals90 = await db
      .select()
      .from(rentals)
      .where(
        and(
          eq(rentals.equipmentId, equipmentId),
          sql`${rentals.receiveDate} >= ${d90.toISOString().split('T')[0]}`, // FIXED: was d30
          sql`${rentals.receiveDate} <= ${nowStr}`
        )
      );

    // Rental-day accumulation is capped at the snapshot date: a rental still
    // open (or returned later) contributes only the days elapsed by snapshot.
    const rentalDaysUpTo = (r: { receiveDate: Date | string | null; returnDate: Date | string | null }) => {
      if (!r.receiveDate) return 0;
      const rawEnd = r.returnDate ? new Date(r.returnDate) : now;
      const end = rawEnd.getTime() < now.getTime() ? rawEnd : now;
      return Math.max(0, (end.getTime() - new Date(r.receiveDate).getTime()) / (24 * 3600 * 1000));
    };

    const rentalDays30d = rentals30.reduce((sum, r) => sum + rentalDaysUpTo(r), 0);
    const rentalDays90d = rentals90.reduce((sum, r) => sum + rentalDaysUpTo(r), 0);

    const avgRentalDuration = rentals90.length > 0 ? rentalDays90d / rentals90.length : 0;

    // ── Maintenance events ─────────────────────────────────────────────────
    const maint90 = await db
      .select()
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          sql`${maintenanceEvents.maintenanceDate} >= ${d90.toISOString().split('T')[0]}`,
          sql`${maintenanceEvents.maintenanceDate} <= ${nowStr}`,
          sql`${maintenanceEvents.maintenanceType} IN ('MAJOR_SERVICE', 'MINOR_SERVICE')`
        )
      );

    const maint180 = await db
      .select()
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          sql`${maintenanceEvents.maintenanceDate} >= ${d180.toISOString().split('T')[0]}`,
          sql`${maintenanceEvents.maintenanceDate} <= ${nowStr}`,
          sql`${maintenanceEvents.maintenanceType} IN ('MAJOR_SERVICE', 'MINOR_SERVICE')`
        )
      );

    // 90d split for cost trend: first half vs second half of 180d window
    const maint90to180 = maint180.filter(e => {
      const d = new Date(e.maintenanceDate!);
      return d < d90;
    });

    const maintenanceEvents90d = Math.min(maint90.length, 6);
    const rawCost180d = maint180.reduce((sum, e) => sum + Number(e.cost || 0), 0);
    const avgEventCost = maint180.length > 0 ? rawCost180d / maint180.length : 0;
    const maintenanceCost180d = avgEventCost * Math.min(maint180.length, 12);
    const avgDowntimePerEvent = maint90.length > 0 ? 8 : 0;

    // Days since last maintenance (as of the snapshot date, not "ever")
    const [lastMaint] = await db
      .select()
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          sql`${maintenanceEvents.maintenanceDate} <= ${nowStr}`
        )
      )
      .orderBy(desc(maintenanceEvents.maintenanceDate))
      .limit(1);

    const daysSinceLastMaintenance = lastMaint?.maintenanceDate
      ? Math.max(0, (now.getTime() - new Date(lastMaint.maintenanceDate).getTime()) / (24 * 3600 * 1000))
      : null;

    // Mean time between failures — history up to the snapshot date only
    const allMaint = await db
      .select()
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          sql`${maintenanceEvents.maintenanceDate} <= ${nowStr}`,
          sql`${maintenanceEvents.maintenanceType} IN ('MAJOR_SERVICE', 'MINOR_SERVICE')`
        )
      )
      .orderBy(maintenanceEvents.maintenanceDate);

    let meanTimeBetweenFailures: number | null = null;
    if (allMaint.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < allMaint.length; i++) {
        const prev = new Date(allMaint[i - 1].maintenanceDate!).getTime();
        const curr = new Date(allMaint[i].maintenanceDate!).getTime();
        gaps.push((curr - prev) / (24 * 3600 * 1000));
      }
      meanTimeBetweenFailures = Math.max(
        gaps.reduce((a, b) => a + b, 0) / gaps.length,
        14
      );
    }

    // ── Sensor data ────────────────────────────────────────────────────────
    const sensorStats    = await this.getSensorStats(equipmentId, d30, now);
    const sensorBaseline = await this.getSensorStats(equipmentId, d365, d180);

    // ── Derived features ──────────────────────────────────────────────────
    const hoursUsed30d = rentalDays30d * 8;
    const hoursUsed90d = rentalDays90d * 8;

    const usageIntensity = rentalDays30d > 0 ? Math.min(hoursUsed30d / 30, 12) : 0;
    const usageTrend = hoursUsed30d > 0 && hoursUsed90d > 0
      ? (hoursUsed30d * 3) / hoursUsed90d
      : 1.0;

    const expectedMonthlyHours = 160;
    const utilizationVsExpected = hoursUsed30d / expectedMonthlyHours;

    const wearRate = assetAgeYears > 0 ? totalHoursLifetime / (assetAgeYears * 8760) : 0;
    const agingFactor = Math.min(assetAgeYears / 10, 1.0);

    const configRecord = await db
      .select()
      .from(maintenanceConfig)
      .where(eq(maintenanceConfig.equipmentCategory, equip.category || 'Default'))
      .limit(1);

    // ML-12: read the real column (recommended_interval_days). The old code read
    // `inspectionIntervalDays`, which doesn't exist on maintenance_config — the
    // `as any` cast hid it, so intervalDays was always the 90-day fallback and
    // maintenance_config never influenced maint_overdue / neglect_acceleration.
    const intervalDays = configRecord[0]?.recommendedIntervalDays ?? DEFAULT_MAINTENANCE_INTERVAL_DAYS;
    const maintOverdue = daysSinceLastMaintenance !== null && daysSinceLastMaintenance > intervalDays ? 1 : 0;

    const costPerEvent = maintenanceEvents90d > 0 ? maintenanceCost180d / maintenanceEvents90d : 0;
    const effectiveHours = totalHoursLifetime > 0 ? totalHoursLifetime : assetAgeYears * 500;
    const maintBurden = maintenanceCost180d / Math.max(effectiveHours, 100);

    // ── Composite risk scores ──────────────────────────────────────────────
    const mechanicalWearScore = computeMechanicalWearScore(totalHoursLifetime, assetAgeYears);
    const abuseScore = computeAbuseScore(usageIntensity, usageTrend);
    const neglectScore = computeNeglectScore(daysSinceLastMaintenance, maintOverdue);

    // ── Dynamic context scores (v2) ────────────────────────────────────────
    // vendorReliabilityScore: inverse of maintenance frequency relative to age
    // More failures per year = less reliable vendor/equipment combination
    const failuresPerYear = allMaint.length > 0 && assetAgeYears > 0
      ? allMaint.length / assetAgeYears
      : 0;
    // Baseline: 4 events/year = perfectly reliable (0.80), 12+/yr = poor (0.40)
    const vendorReliabilityScore = Math.max(0.40, Math.min(0.95, 0.95 - (failuresPerYear - 4) * 0.04));

    // jobSiteRiskScore: based on rental activity intensity
    // High utilization + high usage trend = higher jobsite risk exposure
    const jobSiteRiskScore = Math.min(0.95, Math.max(0.20,
      0.30 + (utilizationVsExpected * 0.30) + (Math.min(usageTrend, 3) - 1) * 0.15
    ));

    // ── TREND VELOCITY FEATURES (v2) ──────────────────────────────────────

    // 1. Wear rate velocity: current wear rate vs wear rate 90d ago
    //    Positive = wear accelerating, negative = decelerating
    const hoursAt90dAgo = Math.max(0, totalHoursLifetime - hoursUsed90d);
    const ageAt90dAgo   = Math.max(0.01, assetAgeYears - 90 / 365.25);
    const wearRate90dAgo = hoursAt90dAgo / (ageAt90dAgo * 8760);
    const wearRateVelocity = computeWearRateVelocity(wearRate, wearRate90dAgo);

    // 2. Maintenance frequency trend: events in last 30d (annualised) vs 90d (annualised)
    const maint30Count = maint90.filter(e => new Date(e.maintenanceDate!) >= d30).length;
    const maintRate30d = maint30Count * 12;        // annualised from 30d
    const maintRate90d = maint90.length * (365 / 90); // annualised from 90d
    const maintFrequencyTrend = computeMaintFrequencyTrend(maintRate30d, maintRate90d);

    // 3. Cost trend: avg cost per event in recent 90d vs prior 90d
    const avgCostRecent = maint90.length > 0
      ? maint90.reduce((s, e) => s + Number(e.cost || 0), 0) / maint90.length
      : 0;
    const avgCostPrior = maint90to180.length > 0
      ? maint90to180.reduce((s, e) => s + Number(e.cost || 0), 0) / maint90to180.length
      : avgCostRecent;
    const costTrend = computeCostTrend(avgCostRecent, avgCostPrior);

    // 4. Hours velocity: hours/day in last 30d vs average hours/day in last 90d
    const hoursPerDay30d = rentalDays30d > 0 ? hoursUsed30d / 30 : 0;
    const hoursPerDay90d = rentalDays90d > 0 ? hoursUsed90d / 90 : 0;
    const hoursVelocity  = computeHoursVelocity(hoursPerDay30d, hoursPerDay90d);

    // 5. Neglect acceleration: how far overdue relative to expected interval
    //    0 = just serviced, 1 = exactly at interval, >1 = overdue
    const neglectAcceleration = computeNeglectAcceleration(daysSinceLastMaintenance, intervalDays);

    // 6. Sensor degradation rate: recent sensor readings vs historical baseline
    //    Compare vibration and temp — most sensitive leading indicators
    const recentVib   = sensorStats.avgVibration ?? 0;
    const baselineVib = sensorBaseline.avgVibration ?? recentVib;
    const recentTemp  = sensorStats.avgEngineTemp ?? 0;
    const baselineTemp = sensorBaseline.avgEngineTemp ?? recentTemp;

    let sensorDegradationRate = 0;
    if (baselineVib > 0) {
      sensorDegradationRate += Math.min((recentVib - baselineVib) / baselineVib, 1) * 0.5;
    }
    if (baselineTemp > 0) {
      sensorDegradationRate += Math.min((recentTemp - baselineTemp) / baselineTemp, 1) * 0.5;
    }
    sensorDegradationRate = Math.max(0, Math.min(sensorDegradationRate, 1));

    return {
      equipmentId,
      snapshotTs: now,
      category: equip.category || 'Unknown',
      assetAgeYears,
      totalHoursLifetime,
      hoursUsed30d,
      hoursUsed90d,
      rentalDays30d,
      rentalDays90d,
      avgRentalDuration,
      maintenanceEvents90d,
      maintenanceCost180d,
      avgDowntimePerEvent,
      daysSinceLastMaintenance,
      meanTimeBetweenFailures,
      vendorReliabilityScore,
      jobSiteRiskScore,
      usageIntensity,
      usageTrend,
      utilizationVsExpected,
      wearRate,
      agingFactor,
      maintOverdue,
      costPerEvent,
      maintBurden,
      mechanicalWearScore,
      abuseScore,
      neglectScore,
      // Trend velocity features
      wearRateVelocity,
      maintFrequencyTrend,
      costTrend,
      hoursVelocity,
      neglectAcceleration,
      sensorDegradationRate,
      ...sensorStats,
    };
  }

  // ── Accumulate hours from sensor data logs ─────────────────────────────────
  private async getAccumulatedHoursFromSensors(
    equipmentId: number,
    from: Date,
    to: Date
  ): Promise<number> {
    // Column names are the live ones. This read engine_temperature, which has
    // not existed since the schema moved to Drizzle under ARCH-1; the query
    // threw ER_BAD_FIELD_ERROR on every call and the catch below returned 0,
    // so sensor hours silently never counted and the caller fell through to
    // the equipment record every time.
    const result = await db.execute(sql`
      SELECT COUNT(*) as reading_count
      FROM sensor_data_logs
      WHERE equipment_id = ${equipmentId}
        AND timestamp BETWEEN ${from} AND ${to}
        AND engine_temp IS NOT NULL
    `);
    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    // Each reading represents 1 hour of operation (hourly sensor logs)
    return Number((rows as any[])[0]?.reading_count ?? 0);
  }

  private async getSensorStats(
    equipmentId: number,
    from: Date,
    to: Date
  ): Promise<Partial<EnhancedFeatureSnapshot>> {
    // vibration_level, engine_temperature, error_code and warning_flag are all
    // from the pre-ARCH-1 schema and none of them exist. Every call raised
    // ER_BAD_FIELD_ERROR and the catch returned {}, so every sensor statistic
    // was undefined and sensor_degradation_rate was 0 for every asset in every
    // snapshot ever taken -- 50 of 50 on the deployed instance.
    //
    // The table stores vibration on three axes, so the single-figure
    // equivalent is the magnitude of the vector, averaged per reading rather
    // than averaging the axes separately (which would under-report a machine
    // shaking hard in one direction).
    const result = await db.execute(sql`
      SELECT
        AVG(SQRT(POW(vibration_x,2) + POW(vibration_y,2) + POW(vibration_z,2))) as avg_vibration,
        MAX(SQRT(POW(vibration_x,2) + POW(vibration_y,2) + POW(vibration_z,2))) as max_vibration,
        AVG(engine_temp)          as avg_engine_temp,
        AVG(oil_pressure)         as avg_oil_pressure,
        AVG(hydraulic_pressure)   as avg_hydraulic_pressure,
        SUM(CASE WHEN error_codes IS NOT NULL AND error_codes != '' THEN 1 ELSE 0 END) as error_code_count,
        SUM(CASE WHEN warning_count > 0 THEN 1 ELSE 0 END) as warning_count
      FROM sensor_data_logs
      WHERE equipment_id = ${equipmentId}
        AND timestamp BETWEEN ${from} AND ${to}
    `);

    const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    const row  = (rows as any[])[0] || {};

      return {
        avgVibration:         row.avg_vibration        != null ? Number(row.avg_vibration)         : undefined,
        maxVibration:         row.max_vibration        != null ? Number(row.max_vibration)         : undefined,
        avgEngineTemp:        row.avg_engine_temp       != null ? Number(row.avg_engine_temp)       : undefined,
        avgOilPressure:       row.avg_oil_pressure      != null ? Number(row.avg_oil_pressure)      : undefined,
        avgHydraulicPressure: row.avg_hydraulic_pressure != null ? Number(row.avg_hydraulic_pressure) : undefined,
        errorCodeCount:       row.error_code_count      != null ? Number(row.error_code_count)      : 0,
        warningCount:         row.warning_count         != null ? Number(row.warning_count)         : 0,
    };
  }
}

export const enhancedFeatureService = new EnhancedFeatureEngineeringService();