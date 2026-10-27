
import { db } from "../db";
import { 
  equipment, 
  rentals, 
  maintenanceEvents, 
  assetFeatureSnapshots,
  vendors,
  jobSites
} from "@shared/schema";
import { eq, and, sql, gte, lte, count, sum, avg } from "drizzle-orm";
import { enhancedFeatureService } from './feature-engineering-enhanced';

export interface FeatureSnapshot {
  equipmentId: number;
  snapshotTs: Date;
  
  // Asset metadata
  assetAgeYears: number;
  category: string;
  
  // Usage features
  totalHoursLifetime: number;
  hoursUsed30d: number;
  hoursUsed90d: number;
  
  // Rental intensity
  rentalDays30d: number;
  rentalDays90d: number;
  avgRentalDuration: number;
  
  // Maintenance features
  maintenanceEvents90d: number;
  maintenanceCost180d: number;
  avgDowntimePerEvent: number;
  daysSinceLastMaintenance: number | null;
  
  // Reliability
  meanTimeBetweenFailures: number | null;
  
  // Context
  vendorReliabilityScore: number;
  jobSiteRiskScore: number;

  // Derived scores
  usageIntensity: number;
  usageTrend: number;
  utilizationVsExpected: number;
  wearRate: number;
  agingFactor: number;
  maintOverdue: number;
  costPerEvent: number;
  maintBurden: number;
  mechanicalWearScore: number;
  abuseScore: number;
  neglectScore: number;

  // Trend velocity features (v2)
  wearRateVelocity: number;
  maintFrequencyTrend: number;
  costTrend: number;
  hoursVelocity: number;
  neglectAcceleration: number;
  sensorDegradationRate: number | null;
}

/** Assets built at once. The mysql2 pool defaults to ten connections. */
export const DEFAULT_SNAPSHOT_CONCURRENCY = 6;

/**
 * How many assets to build at once, overridable per deployment.
 *
 * Read per call rather than at module load so a value set after import still
 * applies -- the seed is the only caller that would want to tune it, and it
 * runs long after this module is first imported.
 */
export function snapshotConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SNAPSHOT_CONCURRENCY;
  if (!raw) return DEFAULT_SNAPSHOT_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[features] ignoring invalid SNAPSHOT_CONCURRENCY=${raw}; ` +
      `using ${DEFAULT_SNAPSHOT_CONCURRENCY}`
    );
    return DEFAULT_SNAPSHOT_CONCURRENCY;
  }
  return parsed;
}

/**
 * Map with at most `limit` promises in flight, preserving input order.
 *
 * Not Promise.all over the whole list: sixty concurrent callers against a
 * ten-connection pool is queueing wearing concurrency's clothes, and it
 * starves whatever else needs a connection -- here, the endpoint that reports
 * seeding progress.
 *
 * Workers pull from a shared cursor rather than taking fixed slices, so one
 * slow asset delays only itself. Fixed slices would leave five workers idle
 * while the sixth finished its share.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error(`concurrency must be at least 1, got ${limit}`);
  if (items.length === 0) return [];

  const out = new Array<R>(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

class FeatureEngineeringService {
  /**
   * Generate a feature snapshot for a specific equipment at a specific time
   * CRITICAL: Only uses data available BEFORE snapshotTs (no future leakage)
   */
  async generateSnapshot(equipmentId: number, snapshotTs: Date): Promise<FeatureSnapshot> {
    // Get equipment metadata
    const [equip] = await db
      .select()
      .from(equipment)
      .where(eq(equipment.id, equipmentId));
    
    if (!equip) {
      throw new Error(`Equipment ${equipmentId} not found`);
    }
    
    // Calculate asset age
    const assetAgeYears = equip.createdAt 
      ? (snapshotTs.getTime() - new Date(equip.createdAt).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      : 0;
    
    // Calculate date windows (all BEFORE snapshotTs)
    const ts30dAgo = new Date(snapshotTs.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ts90dAgo = new Date(snapshotTs.getTime() - 90 * 24 * 60 * 60 * 1000);
    const ts180dAgo = new Date(snapshotTs.getTime() - 180 * 24 * 60 * 60 * 1000);
    
    // === RENTAL FEATURES ===
    const rentalsLast90d = await db
      .select({
        count: count(),
        avgDuration: avg(sql`DATEDIFF(return_date, receive_date)`),
        totalHours: sum(rentals.returnHours),
      })
      .from(rentals)
      .where(
        and(
          eq(rentals.equipmentId, equipmentId),
          lte(rentals.receiveDate, snapshotTs),
          gte(rentals.receiveDate, ts90dAgo)
        )
      );
    
    const rentalsLast30d = await db
      .select({ count: count() })
      .from(rentals)
      .where(
        and(
          eq(rentals.equipmentId, equipmentId),
          lte(rentals.receiveDate, snapshotTs),
          gte(rentals.receiveDate, ts30dAgo)
        )
      );
    
    // Calculate rental days
    const rentalDays30d = rentalsLast30d[0]?.count || 0;
    const rentalDays90d = rentalsLast90d[0]?.count || 0;
    const avgRentalDuration = Number(rentalsLast90d[0]?.avgDuration) || 0;
    
    // Usage hours
    const hoursUsed30d = 0; // Simplified - calculate from rental hours if available
    const hoursUsed90d = Number(rentalsLast90d[0]?.totalHours) || 0;
    const totalHoursLifetime = hoursUsed90d; // Simplified - would need cumulative tracking
    
    // === MAINTENANCE FEATURES ===
    const maintenanceLast90d = await db
      .select({
        count: count(),
        totalCost: sum(maintenanceEvents.cost),
      })
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          lte(maintenanceEvents.maintenanceDate, snapshotTs),
          gte(maintenanceEvents.maintenanceDate, ts90dAgo)
        )
      );
    
    const maintenanceLast180d = await db
      .select({
        totalCost: sum(maintenanceEvents.cost),
      })
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          lte(maintenanceEvents.maintenanceDate, snapshotTs),
          gte(maintenanceEvents.maintenanceDate, ts180dAgo)
        )
      );
    
    const maintenanceEvents90d = maintenanceLast90d[0]?.count || 0;
    const maintenanceCost180d = Number(maintenanceLast180d[0]?.totalCost) || 0;
    
    // Days since last maintenance
    const [lastMaintenance] = await db
      .select({ date: maintenanceEvents.maintenanceDate })
      .from(maintenanceEvents)
      .where(
        and(
          eq(maintenanceEvents.equipmentId, equipmentId),
          lte(maintenanceEvents.maintenanceDate, snapshotTs)
        )
      )
      .orderBy(sql`${maintenanceEvents.maintenanceDate} DESC`)
      .limit(1);
    
    const daysSinceLastMaintenance = lastMaintenance?.date
      ? Math.floor((snapshotTs.getTime() - new Date(lastMaintenance.date).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    
    // Simplified metrics
    const avgDowntimePerEvent = maintenanceEvents90d > 0 ? 2.5 : 0; // Placeholder
    const meanTimeBetweenFailures = daysSinceLastMaintenance || null;
    
    // === CONTEXT FEATURES ===
    // Vendor reliability (simplified heuristic)
    const vendorReliabilityScore = 0.75; // Placeholder - calculate from vendor maintenance history
    
    // Job site risk (simplified heuristic)
    const jobSiteRiskScore = 0.50; // Placeholder - calculate from site damage rates
    
    return {
      equipmentId,
      snapshotTs,
      assetAgeYears,
      category: equip.category,
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
      usageIntensity: 0,
      usageTrend: 1,
      utilizationVsExpected: 1,
      wearRate: 0,
      agingFactor: 0,
      maintOverdue: 0,
      costPerEvent: 0,
      maintBurden: 0,
      mechanicalWearScore: 0,
      abuseScore: 0,
      neglectScore: 0,
      wearRateVelocity: 0,
      maintFrequencyTrend: 1,
      costTrend: 1,
      hoursVelocity: 1,
      neglectAcceleration: 1,
      sensorDegradationRate: null,
    
    };
  }
  
  /**
   * Generate snapshots for ALL equipment at a specific time.
   *
   * Runs assets concurrently, because this is where the seed's time goes.
   * Building one snapshot issues about eleven sequential queries, and the
   * loop here ran assets one after another: sixty assets across twenty-four
   * backfill dates is on the order of 15,000 round trips taken strictly in
   * series, against a hosted database where each one costs a network hop.
   * Batching the writes that follow removed 1,400 of them; this is the other
   * eight ninths.
   *
   * Only the scheduling changes. Each asset's queries are per-asset and
   * independent, read the same committed state, and are bounded by the same
   * snapshotTs, so nothing about what is computed moves -- which is what
   * keeps this clear of the point-in-time correctness feature-engineering-pit
   * covers. A snapshot still sees only data at or before its own timestamp.
   *
   * Bounded, not unleashed: the mysql2 pool defaults to ten connections and
   * the API is still serving the seed's own status polling out of the same
   * pool. Six leaves headroom. Raising it past the pool size does not buy
   * concurrency, it buys queueing inside the driver plus the chance of
   * starving the request that reports progress.
   */
  async generateSnapshotsForAllEquipment(snapshotTs: Date): Promise<FeatureSnapshot[]> {
    const allEquipment = await db.select({ id: equipment.id }).from(equipment);

    const results = await mapWithConcurrency(
      allEquipment,
      snapshotConcurrency(),
      async equip => {
        try {
          return await enhancedFeatureService.generateSnapshot(equip.id, snapshotTs);
        } catch (error) {
          // Unchanged: a failed asset is logged and skipped rather than
          // sinking the date. The caller counts what it got, so a short
          // result is reported as a smaller number and not as success.
          console.error(`Failed to generate snapshot for equipment ${equip.id}:`, error);
          return undefined;
        }
      },
    );

    // Order follows allEquipment, as it did when this was a for loop --
    // completion order would otherwise vary run to run and make two seeds of
    // the same cursor harder to compare.
    return results.filter((s): s is FeatureSnapshot => s !== undefined);
  }
  
  /**
   * One snapshot as a row.
   *
   * Extracted so the single-row and batched writers cannot drift apart: there
   * are thirty-seven columns here, and two copies of that list is two places
   * for a feature to be added to one and not the other.
   */
  private toRow(snapshot: FeatureSnapshot) {
    return {
      equipmentId: snapshot.equipmentId,
      snapshotTs: snapshot.snapshotTs,
      assetAgeYears: snapshot.assetAgeYears.toString(),
      category: snapshot.category,
      totalHoursLifetime: snapshot.totalHoursLifetime.toString(),
      hoursUsed30d: snapshot.hoursUsed30d.toString(),
      hoursUsed90d: snapshot.hoursUsed90d.toString(),
      rentalDays30d: snapshot.rentalDays30d,
      rentalDays90d: snapshot.rentalDays90d,
      avgRentalDuration: snapshot.avgRentalDuration.toString(),
      maintenanceEvents90d: snapshot.maintenanceEvents90d,
      maintenanceCost180d: snapshot.maintenanceCost180d.toString(),
      avgDowntimePerEvent: snapshot.avgDowntimePerEvent.toString(),
      daysSinceLastMaintenance: snapshot.daysSinceLastMaintenance,
      meanTimeBetweenFailures: snapshot.meanTimeBetweenFailures,
      vendorReliabilityScore: snapshot.vendorReliabilityScore.toString(),
      jobSiteRiskScore: snapshot.jobSiteRiskScore.toString(),
      usageIntensity:        snapshot.usageIntensity.toString(),
      usageTrend:            snapshot.usageTrend.toString(),
      utilizationVsExpected: snapshot.utilizationVsExpected.toString(),
      wearRate:              snapshot.wearRate.toString(),
      agingFactor:           snapshot.agingFactor.toString(),
      maintOverdue:          snapshot.maintOverdue.toString(),
      costPerEvent:          snapshot.costPerEvent.toString(),
      maintBurden:           snapshot.maintBurden.toString(),
      mechanicalWearScore:   snapshot.mechanicalWearScore.toString(),
      abuseScore:            snapshot.abuseScore.toString(),
      neglectScore:          snapshot.neglectScore.toString(),
      wearRateVelocity:      snapshot.wearRateVelocity.toString(),
      maintFrequencyTrend:   snapshot.maintFrequencyTrend.toString(),
      costTrend:             snapshot.costTrend.toString(),
      hoursVelocity:         snapshot.hoursVelocity.toString(),
      neglectAcceleration:   snapshot.neglectAcceleration.toString(),
      sensorDegradationRate: snapshot.sensorDegradationRate?.toString() ?? null,
      willFail10d: null,
      willFail30d: null,
      willFail60d: null,
    };
  }

  /**
   * Save snapshot to database
   */
  async saveSnapshot(snapshot: FeatureSnapshot): Promise<void> {
    await db.insert(assetFeatureSnapshots).values([this.toRow(snapshot)]);
  }

  /**
   * Save many snapshots in as few statements as possible.
   *
   * The seed wrote these one at a time. At ten assets that was 240 inserts and
   * nobody noticed; at sixty it is 1,440, each a separate round trip to a
   * hosted database, and the seed step that does it is linear in the fleet.
   *
   * Chunked rather than one enormous statement: a multi-row INSERT consumes a
   * placeholder per column per row, and at thirty-seven columns a few thousand
   * rows would approach the protocol's limit. A hundred rows is 3,700
   * placeholders, comfortably inside it and still a 100:1 reduction in round
   * trips.
   *
   * Failure semantics change slightly and for the better: a row-at-a-time loop
   * that threw on the fiftieth row left forty-nine committed, so a failed seed
   * left a partial snapshot set that looked like a complete one. A chunk is a
   * single statement, so it lands or it does not.
   */
  async saveSnapshots(snapshots: FeatureSnapshot[], chunkSize = 100): Promise<number> {
    if (snapshots.length === 0) return 0;
    if (chunkSize < 1) throw new Error(`chunkSize must be at least 1, got ${chunkSize}`);

    let written = 0;
    for (let i = 0; i < snapshots.length; i += chunkSize) {
      const chunk = snapshots.slice(i, i + chunkSize);
      await db.insert(assetFeatureSnapshots).values(chunk.map(s => this.toRow(s)));
      written += chunk.length;
    }
    return written;
  }

  /**
   * Label historical snapshots with failure outcomes (ML-2 / ML-11).
   *
   * Label definition:
   *   will_fail_h = 1 iff a REACTIVE_REPAIR event (the unit actually broke down)
   *   occurs in the window (snapshot_ts, snapshot_ts + h] — day 0 is excluded
   *   because a same-day event has already influenced the snapshot's features.
   *   SCHEDULED_PM and PREDICTIVE_INTERVENTION events are never failures:
   *   planned work is the outcome the model is trying to cause, not predict.
   *
   * Censoring (label_status):
   *   - If a PREDICTIVE_INTERVENTION lands in the 60d window before any observed
   *     failure, we cannot know whether the unit would have failed — the row is
   *     marked censored_intervention with NULL labels and excluded from training.
   *     Without this, the model's own successes would become negative labels.
   *   - Rows whose 60d window hasn't elapsed yet are marked censored_horizon and
   *     re-evaluated on later runs as the simulation cursor advances.
   */
  async labelSnapshots(): Promise<number> {
    // Use simulation cursor as reference, not wall clock
    const [stateRows] = await db.execute(
      sql`SELECT cursor_date FROM simulation_state WHERE id = 1`
    ) as any;
    const simCursor = stateRows[0]?.cursor_date
      ? new Date(stateRows[0].cursor_date)
      : new Date();

    // Full 60d outcome window must have elapsed for a definitive label
    const cutoffDate = new Date(simCursor.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Candidates: never evaluated, or horizon-censored rows whose window may
    // have elapsed since the last run. (Legacy rows labeled under the old
    // any-MAJOR_SERVICE rule have label_status NULL and get relabeled too.)
    const candidates = await db
      .select()
      .from(assetFeatureSnapshots)
      .where(
        sql`(${assetFeatureSnapshots.labelStatus} IS NULL
             OR ${assetFeatureSnapshots.labelStatus} = 'censored_horizon')`
      );

    let labeled = 0;

    for (const snapshot of candidates) {
      const snapshotDate = new Date(snapshot.snapshotTs);

      if (snapshotDate > cutoffDate) {
        if (snapshot.labelStatus !== 'censored_horizon') {
          await db
            .update(assetFeatureSnapshots)
            .set({ labelStatus: 'censored_horizon' })
            .where(eq(assetFeatureSnapshots.id, snapshot.id));
        }
        continue;
      }

      const window60End = new Date(snapshotDate.getTime() + 60 * 24 * 60 * 60 * 1000);

      // First actual breakdown in (ts, ts+60] — strict > excludes day-0 events
      const [failRows] = await db.execute(sql`
        SELECT MIN(maintenance_date) AS first_event
        FROM maintenance_events
        WHERE equipment_id = ${snapshot.equipmentId}
          AND event_source = 'REACTIVE_REPAIR'
          AND maintenance_date > ${snapshotDate}
          AND maintenance_date <= ${window60End}
      `) as any;

      // First model-driven intervention in the same window
      const [intRows] = await db.execute(sql`
        SELECT MIN(maintenance_date) AS first_event
        FROM maintenance_events
        WHERE equipment_id = ${snapshot.equipmentId}
          AND event_source = 'PREDICTIVE_INTERVENTION'
          AND maintenance_date > ${snapshotDate}
          AND maintenance_date <= ${window60End}
      `) as any;

      const firstFailure: Date | null = failRows[0]?.first_event
        ? new Date(failRows[0].first_event) : null;
      const firstIntervention: Date | null = intRows[0]?.first_event
        ? new Date(intRows[0].first_event) : null;

      // Intervention before any observed failure → counterfactual unknown.
      // Censor the row entirely rather than record a negative we can't defend.
      if (firstIntervention && (!firstFailure || firstIntervention < firstFailure)) {
        await db
          .update(assetFeatureSnapshots)
          .set({
            willFail10d: null,
            willFail30d: null,
            willFail60d: null,
            labelStatus: 'censored_intervention',
          })
          .where(eq(assetFeatureSnapshots.id, snapshot.id));
        labeled++;
        continue;
      }

      // Calendar-day distance from snapshot date to first failure
      const snapMidnight = new Date(
        snapshotDate.getFullYear(), snapshotDate.getMonth(), snapshotDate.getDate()
      );
      const daysToFailure = firstFailure
        ? Math.round((firstFailure.getTime() - snapMidnight.getTime()) / (24 * 60 * 60 * 1000))
        : null;

      const labelFor = (h: number) =>
        daysToFailure !== null && daysToFailure >= 1 && daysToFailure <= h ? 1 : 0;

      await db
        .update(assetFeatureSnapshots)
        .set({
          willFail10d: labelFor(10),
          willFail30d: labelFor(30),
          willFail60d: labelFor(60),
          labelStatus: 'observed',
        })
        .where(eq(assetFeatureSnapshots.id, snapshot.id));
      labeled++;
    }

    return labeled;
  }
}

export const featureEngineeringService = new FeatureEngineeringService();