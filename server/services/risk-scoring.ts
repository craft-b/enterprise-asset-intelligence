import { db } from "../db";
import { equipment, rentals, equipmentRiskScores, maintenanceEvents, maintenanceConfig } from "@shared/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { DEFAULT_MAINTENANCE_INTERVAL_DAYS } from "../seeds/maintenance-config";

interface RiskFeatures {
  daysRentedLast30: number;
  daysRentedLast60: number;
  equipmentAgeYears: number;
  lateReturnsLast30: number;
  status: string;
  daysSinceLastMaintenance: number;
  maintenanceOverdue: boolean;
  lastMaintenanceType: string | null;
  recommendedInterval: number;
  effectiveMaintenanceDays: number;
}

interface RiskResult {
  equipmentId: number;
  riskScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  drivers: string[];
  modelVersion: string;
}

const FEATURE_WEIGHTS = {
  utilization: 0.30,
  age: 0.15,
  lateReturns: 0.15,
  maintenance: 0.25,
  conflicts: 0.15,
};

const RESET_FACTORS = {
  INSPECTION: 0.90,
  MINOR_SERVICE: 0.60,
  MAJOR_SERVICE: 0.20,
};

export class RiskScoringService {
  
  async calculateRiskScore(equipmentId: number): Promise<RiskResult> {
    // Get equipment details
    const [equip] = await db.select().from(equipment).where(eq(equipment.id, equipmentId));
    if (!equip) throw new Error("Equipment not found");

    // Get maintenance history
    const [latestMaintenance] = await db.select()
      .from(maintenanceEvents)
      .where(eq(maintenanceEvents.equipmentId, equipmentId))
      .orderBy(desc(maintenanceEvents.maintenanceDate))
      .limit(1);

    // Get maintenance config for this category
    const [config] = await db.select()
      .from(maintenanceConfig)
      .where(eq(maintenanceConfig.equipmentCategory, equip.category));

    // Get rental history
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const recentRentals = await db.select().from(rentals)
      .where(and(
        eq(rentals.equipmentId, equipmentId),
        gte(rentals.receiveDate, sixtyDaysAgo)
      ));

    // Calculate features
    const features = this.extractFeatures(equip, recentRentals, latestMaintenance, config);
    
    // Calculate score
    const score = this.computeScore(features);
    
    // Determine risk level
    const riskLevel = this.getRiskLevel(score);
    
    // Generate explanations
    const drivers = this.explainScore(features, equip);

    return {
      equipmentId,
      riskScore: Math.round(score),
      riskLevel,
      drivers,
      modelVersion: "v1.1",
    };
  }

  private extractFeatures(
    equip: any, 
    recentRentals: any[],
    latestMaintenance: any,
    config: any
  ): RiskFeatures {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rentalsLast30 = recentRentals.filter(r => 
      new Date(r.receiveDate) >= thirtyDaysAgo
    );

    const equipmentAge = equip.createdAt 
      ? (Date.now() - new Date(equip.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 365)
      : 0;

    const lateReturns = recentRentals.filter(r => 
      r.returnDate && r.status === 'COMPLETED' && 
      new Date(r.returnDate) > new Date(r.receiveDate)
    ).length;

    // Maintenance features (FR-4, FR-5, FR-6)
    const daysSinceLastMaintenance = latestMaintenance
      ? Math.floor((Date.now() - new Date(latestMaintenance.maintenanceDate).getTime()) / (1000 * 60 * 60 * 24))
      : 9999;

    const recommendedInterval = config?.recommendedIntervalDays || DEFAULT_MAINTENANCE_INTERVAL_DAYS;
    
    // Apply reset factor based on maintenance type
    const resetFactor = latestMaintenance?.maintenanceType 
      ? RESET_FACTORS[latestMaintenance.maintenanceType as keyof typeof RESET_FACTORS] || 1.0
      : 1.0;
    
    const effectiveMaintenanceDays = daysSinceLastMaintenance * resetFactor;
    const maintenanceOverdue = effectiveMaintenanceDays > recommendedInterval;

    return {
      daysRentedLast30: rentalsLast30.length,
      daysRentedLast60: recentRentals.length,
      equipmentAgeYears: equipmentAge,
      lateReturnsLast30: lateReturns,
      status: equip.status,
      daysSinceLastMaintenance,
      maintenanceOverdue,
      lastMaintenanceType: latestMaintenance?.maintenanceType || null,
      recommendedInterval,
      effectiveMaintenanceDays,
    };
  }

  private computeScore(features: RiskFeatures): number {
    let score = 0;

    // Utilization component (0-30 points)
    const utilizationScore = Math.min(30, (features.daysRentedLast60 / 45) * 30);
    score += utilizationScore * FEATURE_WEIGHTS.utilization / 0.30;

    // Age component (0-15 points)
    const ageScore = Math.min(15, (features.equipmentAgeYears / 10) * 15);
    score += ageScore * FEATURE_WEIGHTS.age / 0.15;

    // Late returns component (0-15 points)
    const lateReturnScore = Math.min(15, features.lateReturnsLast30 * 5);
    score += lateReturnScore * FEATURE_WEIGHTS.lateReturns / 0.15;

    // Maintenance component with continuous time-decay (FR-4, FR-5, FR-6)
    const maintenanceRiskRatio = Math.min(1.0, features.effectiveMaintenanceDays / features.recommendedInterval);
    const maintenanceScore = maintenanceRiskRatio * 25; // 0-25 points
    score += maintenanceScore * FEATURE_WEIGHTS.maintenance / 0.25;

    // Additional penalty for overdue maintenance
    if (features.maintenanceOverdue) {
      const daysOverdue = features.effectiveMaintenanceDays - features.recommendedInterval;
      const overduePenalty = Math.min(15, (daysOverdue / features.recommendedInterval) * 15);
      score += overduePenalty;
    }

    return Math.min(100, score);
  }

  private getRiskLevel(score: number): "LOW" | "MEDIUM" | "HIGH" {
    if (score <= 30) return "LOW";
    if (score <= 60) return "MEDIUM";
    return "HIGH";
  }

  private explainScore(features: RiskFeatures, equip: any): string[] {
    const drivers: string[] = [];

    // Utilization
    if (features.daysRentedLast60 > 30) {
      drivers.push(`High utilization: ${features.daysRentedLast60} days rented in last 60 days`);
    }

    // Age
    if (features.equipmentAgeYears > 5) {
      drivers.push(`Equipment age: ${features.equipmentAgeYears.toFixed(1)} years old`);
    }

    // Late returns
    if (features.lateReturnsLast30 > 0) {
      drivers.push(`${features.lateReturnsLast30} late return(s) in last 30 days`);
    }

    // Maintenance (FR-8: Explainability)
    if (features.maintenanceOverdue) {
      const daysOverdue = features.effectiveMaintenanceDays - features.recommendedInterval;
      drivers.push(`⚠️ Maintenance overdue by ${Math.round(daysOverdue)} days`);
    } else if (features.effectiveMaintenanceDays > features.recommendedInterval * 0.8) {
      drivers.push(`Approaching maintenance due in ${Math.round(features.recommendedInterval - features.effectiveMaintenanceDays)} days`);
    }

    if (features.lastMaintenanceType) {
      const typeDisplay = features.lastMaintenanceType.replace('_', ' ').toLowerCase();
      drivers.push(`Last service: ${typeDisplay} (${features.daysSinceLastMaintenance} days ago)`);
    } else {
      drivers.push(`⚠️ No maintenance history recorded`);
    }

    // Status
    if (features.status === 'MAINTENANCE') {
      drivers.push('Currently in maintenance');
    }

    if (drivers.length === 0) {
      drivers.push('Low activity, well maintained');
    }

    return drivers;
  }

  // DEPRECATED: batch route in routes.ts now calls FastAPI directly
  // This method is no longer called in production
  async batchCalculate(equipmentIds: number[]): Promise<RiskResult[]> {
    const results: RiskResult[] = [];
    
    for (const id of equipmentIds) {
      try {
        const result = await this.calculateRiskScore(id);
        results.push(result);
        
        // Store in database
        await db.insert(equipmentRiskScores).values({
          equipmentId: id,
          riskScore: result.riskScore,
          riskLevel: result.riskLevel,
          drivers: JSON.stringify(result.drivers),
          modelVersion: result.modelVersion,
        });
      } catch (error) {
        console.error(`Failed to score equipment ${id}:`, error);
      }
    }
    
    return results;
  }
}

export const riskScoringService = new RiskScoringService();