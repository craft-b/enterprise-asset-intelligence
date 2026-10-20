import { users, equipment, rentals, jobSites, vendors, invoices, type User, type InsertUser, type Equipment, type InsertEquipment, type Rental, type InsertRental, type JobSite, type InsertJobSite, type Vendor, type InsertVendor, type Invoice, type InsertInvoice, EquipmentRiskScore, equipmentRiskScores, InsertRiskScore, InsertMaintenanceEvent, MaintenanceConfig, MaintenanceEvent, InsertModelTrainingMetrics, ModelTrainingMetrics, equipmentSwaps } from "@shared/schema";
import { db } from "./db";
import { eq, ilike, and, or, inArray, SQL, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { maintenanceEvents, maintenanceConfig, modelTrainingMetrics } from "@shared/schema";

// A DATE column wants a calendar day, and `new Date("2026-01-05")` is not one:
// it is midnight UTC, which mysql2 then formats in the server's local zone. On
// a machine in New York that writes 2026-01-04 — the completed rental comes
// back a day before it was returned. Render runs in UTC so the deployed app
// never showed it, which is exactly what makes it worth pinning down: the value
// depended on which machine wrote it. Pass the day through as a string and
// MySQL parses the literal.
function dateOnly(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return value;
}

function generateJobId(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `JOB-${year}${month}-${random}`;
}

function generateVendorId(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `VEND-${year}${month}-${random}`;
}


export interface IStorage {
  // Auth
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Job Sites
  getJobSite(id: number): Promise<JobSite | undefined>;
  listJobSites(): Promise<JobSite[]>;
  createJobSite(site: InsertJobSite): Promise<JobSite>;
  updateJobSite(id: number, updates: Partial<InsertJobSite>): Promise<JobSite>; 
  deleteJobSite(id: number): Promise<void>;

  // Vendors
  getVendor(id: number): Promise<Vendor | undefined>;
  listVendors(): Promise<Vendor[]>;
  createVendor(vendor: InsertVendor): Promise<Vendor>;
  updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor>;
  deleteVendor(id: number): Promise<void>; 

  // Equipment
  getEquipment(id: number): Promise<Equipment | undefined>;
  listEquipment(search?: string, status?: string): Promise<Equipment[]>;
  createEquipment(equip: InsertEquipment): Promise<Equipment>;
  updateEquipment(id: number, equip: Partial<InsertEquipment>): Promise<Equipment>;
  deleteEquipment(id: number): Promise<void>;

  // Rentals
  getRental(id: number): Promise<(Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null, invoices: Invoice[] }) | undefined>;
  listRentals(): Promise<(Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null, invoices: Invoice[] })[]>;
  createRental(rental: InsertRental): Promise<Rental>;
  updateRental(id: number, rental: Partial<InsertRental>): Promise<Rental>;
  deleteRental(id: number): Promise<void>;

  // Invoices
  createInvoice(invoice: InsertInvoice): Promise<Invoice>;

  // Risk Scores
  createRiskScore(score: InsertRiskScore): Promise<EquipmentRiskScore>;
  getRiskScoreHistory(equipmentId: number): Promise<EquipmentRiskScore[]>;
  getLatestRiskScore(equipmentId: number): Promise<EquipmentRiskScore | undefined>;

  createMaintenanceEvent(event: InsertMaintenanceEvent): Promise<MaintenanceEvent>;
  updateMaintenanceEvent(id: number, data: Partial<InsertMaintenanceEvent>): Promise<MaintenanceEvent>;
  deleteMaintenanceEvent(id: number): Promise<void>;
  getMaintenanceHistory(equipmentId: number): Promise<MaintenanceEvent[]>;
  getMaintenanceConfig(category: string): Promise<MaintenanceConfig | undefined>;

  // Model Metrics
  saveModelMetrics(metrics: any): Promise<ModelTrainingMetrics>;
  getLatestModelMetrics(): Promise<any | undefined>;
  getModelMetricsHistory(): Promise<any[]>;

  // Swaps
  listSwapsByRental(rentalId: number): Promise<any[]>;

}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser);
    const [user] = await db.select().from(users).where(eq(users.id, result[0].insertId));
    return user!;
  }

  async getJobSite(id: number): Promise<JobSite | undefined> {
    const [site] = await db.select().from(jobSites).where(eq(jobSites.id, id));
    return site;
  }

  async listJobSites(): Promise<JobSite[]> {
    return await db.select().from(jobSites);
  }

  async createJobSite(site: InsertJobSite): Promise<JobSite> {
    // Generate unique jobId
    let jobId = generateJobId();
    let attempts = 0;
    
    // Ensure uniqueness (retry if collision)
    while (attempts < 5) {
      const [existing] = await db
        .select()
        .from(jobSites)
        .where(eq(jobSites.jobId, jobId))
        .limit(1);
      
      if (!existing) break;
      jobId = generateJobId();
      attempts++;
    }

    const result = await db.insert(jobSites).values({
      ...site,
      jobId,
    });
    
    const [newSite] = await db.select().from(jobSites).where(eq(jobSites.id, result[0].insertId));
    return newSite!;
  }

  async updateJobSite(id: number, updates: Partial<InsertJobSite>): Promise<JobSite> {
    await db.update(jobSites).set(updates).where(eq(jobSites.id, id));
    const [updated] = await db.select().from(jobSites).where(eq(jobSites.id, id));
    return updated!;
  }

  async deleteJobSite(id: number): Promise<void> {
    await db.delete(jobSites).where(eq(jobSites.id, id));
  }


  async getVendor(id: number): Promise<Vendor | undefined> {
    const [v] = await db.select().from(vendors).where(eq(vendors.id, id));
    return v;
  }

  async listVendors(): Promise<Vendor[]> {
    return await db.select().from(vendors);
  }

  async createVendor(vendor: InsertVendor): Promise<Vendor> {
    // Generate unique vendorId
    let vendorId = generateVendorId();
    let attempts = 0;
    
    // Ensure uniqueness (retry if collision)
    while (attempts < 5) {
      const [existing] = await db
        .select()
        .from(vendors)
        .where(eq(vendors.vendorId, vendorId))
        .limit(1);
      
      if (!existing) break;
      vendorId = generateVendorId();
      attempts++;
    }

    const result = await db.insert(vendors).values({
      ...vendor,
      vendorId,
    });
    
    const [newVendor] = await db.select().from(vendors).where(eq(vendors.id, result[0].insertId));
    return newVendor!;
  }
  
  async updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor> {
    await db.update(vendors).set(updates).where(eq(vendors.id, id));
    const [updated] = await db.select().from(vendors).where(eq(vendors.id, id));
    return updated!;
  }

  async deleteVendor(id: number): Promise<void> {
    await db.delete(vendors).where(eq(vendors.id, id));
  }

  async getEquipment(id: number): Promise<Equipment | undefined> {
    const [equip] = await db.select().from(equipment).where(eq(equipment.id, id));
    return equip;
  }

  async listEquipment(search?: string, status?: string): Promise<Equipment[]> {
    let q = db.select().from(equipment);
    
    let conditions: SQL[] = [];
    if (status) {
      conditions.push(eq(equipment.status, status as any));
    }
    
    if (search) {
      conditions.push(or(
        sql`${equipment.name} LIKE ${`%${search}%`}`,
        sql`${equipment.equipmentId} LIKE ${`%${search}%`}`
      )!);
    }
    
    if (conditions.length > 0) {
      q = q.where(and(...conditions)) as any;
    }
    
    return await q;
  }

  async createEquipment(equip: InsertEquipment): Promise<Equipment> {
    const insertData: any = { ...equip };

    if (insertData.purchaseDate != null) {
      insertData.purchaseDate = dateOnly(insertData.purchaseDate);
    }

    // Auto-generate equipmentId if not provided — use numeric-only max to
    // avoid collision with replacement IDs like EQ-R5-2032
    if (!insertData.equipmentId) {
      const [last] = await db
        .select({ equipmentId: equipment.equipmentId })
        .from(equipment)
        .where(sql`equipment_id REGEXP '^EQ-[0-9]+$'`)
        .orderBy(sql`CAST(SUBSTRING(equipment_id, 4) AS UNSIGNED) DESC`)
        .limit(1);
      const lastNum = last ? parseInt(last.equipmentId.replace('EQ-', ''), 10) : 0;
      insertData.equipmentId = `EQ-${String((isNaN(lastNum) ? 0 : lastNum) + 1).padStart(3, '0')}`;
    }

    const result = await db.insert(equipment).values(insertData);
    const [newEquip] = await db.select().from(equipment).where(eq(equipment.id, result[0].insertId));
    return newEquip!;
  }

  async updateEquipment(id: number, equip: Partial<InsertEquipment>): Promise<Equipment> {
    const updateData: any = { ...equip };
    if (updateData.purchaseDate != null) {
      updateData.purchaseDate = dateOnly(updateData.purchaseDate);
    }
    await db.update(equipment).set(updateData).where(eq(equipment.id, id));
    const [updated] = await db.select().from(equipment).where(eq(equipment.id, id));
    return updated!;
  }

  async deleteEquipment(id: number): Promise<void> {
    await db.delete(equipment).where(eq(equipment.id, id));
  }

  async getRental(id: number): Promise<(Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null, invoices: Invoice[] }) | undefined> {
    const [row] = await db
      .select({ rental: rentals, equipment, jobSite: jobSites, vendor: vendors })
      .from(rentals)
      .leftJoin(equipment, eq(rentals.equipmentId, equipment.id))
      .leftJoin(jobSites, eq(rentals.jobSiteId, jobSites.id))
      .leftJoin(vendors, eq(rentals.vendorId, vendors.id))
      .where(eq(rentals.id, id))
      .limit(1);

    if (!row) return undefined;
    const rentalInvoices = await db.select().from(invoices).where(eq(invoices.rentalId, id));
    return {
      ...row.rental,
      equipment: row.equipment,
      jobSite: row.jobSite,
      vendor: row.vendor,
      invoices: rentalInvoices,
    } as any;
  }

  async listRentals(): Promise<(Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null, invoices: Invoice[] })[]> {
    // Explicit joins, not db.query.rentals.findMany({ with: ... }).
    //
    // Drizzle's relational query API compiles `with` into LEFT JOIN LATERAL,
    // which TiDB does not implement -- every call raised ER_PARSE_ERROR, and
    // the route had no try/catch, so GET /api/rentals answered 500 and the
    // rentals page could never load. Same for getRental and listSwapsByRental.
    //
    // Invoices are fetched separately rather than joined: a rental with three
    // invoices would otherwise come back as three rental rows.
    const rows = await db
      .select({ rental: rentals, equipment, jobSite: jobSites, vendor: vendors })
      .from(rentals)
      .leftJoin(equipment, eq(rentals.equipmentId, equipment.id))
      .leftJoin(jobSites, eq(rentals.jobSiteId, jobSites.id))
      .leftJoin(vendors, eq(rentals.vendorId, vendors.id))
      .orderBy(desc(rentals.receiveDate));

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.rental.id);
    const allInvoices = await db.select().from(invoices).where(inArray(invoices.rentalId, ids));
    const byRental = new Map<number, Invoice[]>();
    for (const inv of allInvoices) {
      const list = byRental.get(inv.rentalId) ?? [];
      list.push(inv);
      byRental.set(inv.rentalId, list);
    }

    return rows.map(r => ({
      ...r.rental,
      equipment: r.equipment,
      jobSite: r.jobSite,
      vendor: r.vendor,
      invoices: byRental.get(r.rental.id) ?? [],
    })) as any;
  }

  async createRental(rental: InsertRental): Promise<Rental> {
    const insertData: any = { ...rental };

    if (insertData.receiveDate != null) insertData.receiveDate = dateOnly(insertData.receiveDate);
    if (insertData.returnDate != null) insertData.returnDate = dateOnly(insertData.returnDate);

    // Auto-populate receiveHours from equipment's current mileage if not provided
    if (!insertData.receiveHours && insertData.equipmentId) {
      const [equip] = await db
        .select({ currentMileage: equipment.currentMileage })
        .from(equipment)
        .where(eq(equipment.id, insertData.equipmentId))
        .limit(1);
      if (equip?.currentMileage) insertData.receiveHours = equip.currentMileage;
    }

    const result = await db.insert(rentals).values(insertData);
    const [newRental] = await db.select().from(rentals).where(eq(rentals.id, result[0].insertId));
    return newRental!;
  }

  async updateRental(id: number, rental: Partial<InsertRental>): Promise<Rental> {
    const updateData: any = { ...rental };
    if (updateData.receiveDate != null) updateData.receiveDate = dateOnly(updateData.receiveDate);
    if (updateData.returnDate != null) updateData.returnDate = dateOnly(updateData.returnDate);
    await db.update(rentals).set(updateData).where(eq(rentals.id, id));
    const [updated] = await db.select().from(rentals).where(eq(rentals.id, id));
    return updated!;
  }

  async deleteRental(id: number): Promise<void> {
    await db.delete(rentals).where(eq(rentals.id, id));
  }

  async createInvoice(invoice: InsertInvoice): Promise<Invoice> {
    const result = await db.insert(invoices).values(invoice);
    const [newInvoice] = await db.select().from(invoices).where(eq(invoices.id, result[0].insertId));
    return newInvoice!;
  }

  async createRiskScore(score: InsertRiskScore): Promise<EquipmentRiskScore> {
    const result = await db.insert(equipmentRiskScores).values(score);
    const [newScore] = await db.select().from(equipmentRiskScores).where(eq(equipmentRiskScores.id, result[0].insertId));
    return newScore!;
  }

  async getRiskScoreHistory(equipmentId: number): Promise<EquipmentRiskScore[]> {
    return await db.select()
      .from(equipmentRiskScores)
      .where(eq(equipmentRiskScores.equipmentId, equipmentId))
      .orderBy(sql`${equipmentRiskScores.scoredAt} DESC`)
      .limit(10);
  }

  async getLatestRiskScore(equipmentId: number): Promise<EquipmentRiskScore | undefined> {
    const [score] = await db.select()
      .from(equipmentRiskScores)
      .where(eq(equipmentRiskScores.equipmentId, equipmentId))
      .orderBy(sql`${equipmentRiskScores.scoredAt} DESC`)
      .limit(1);
    return score;
  }

  async createMaintenanceEvent(event: any): Promise<MaintenanceEvent> {
    const eventData: any = { ...event };

    console.log('Storage: Creating maintenance event', eventData); // Debug log

    
    // Keep DATE fields as 'YYYY-MM-DD' strings — converting to Date objects
    // causes timezone-offset shifts (e.g. UTC-5 turns 2032-04-08 → 2032-04-07).
    if (eventData.maintenanceDate && typeof eventData.maintenanceDate === 'string') {
      eventData.maintenanceDate = eventData.maintenanceDate.substring(0, 10);
    }
    if (eventData.nextDueDate && typeof eventData.nextDueDate === 'string') {
      eventData.nextDueDate = eventData.nextDueDate.substring(0, 10);
    }
    
    const result = await db.insert(maintenanceEvents).values(eventData);
    const [newEvent] = await db.select().from(maintenanceEvents).where(eq(maintenanceEvents.id, result[0].insertId));
    return newEvent!;
  }

  async updateMaintenanceEvent(id: number, data: Partial<InsertMaintenanceEvent>): Promise<MaintenanceEvent> {
    // maintenanceDate is deliberately kept as a 'YYYY-MM-DD' string (see createMaintenanceEvent
    // above) to avoid timezone-offset shifts — Drizzle's inferred update type expects Date|SQL.
    await db.update(maintenanceEvents).set(data as any).where(eq(maintenanceEvents.id, id));
    const [updated] = await db.select().from(maintenanceEvents).where(eq(maintenanceEvents.id, id));
    return updated!;
  }

  async deleteMaintenanceEvent(id: number): Promise<void> {
    await db.delete(maintenanceEvents).where(eq(maintenanceEvents.id, id));
  }

  async getMaintenanceHistory(equipmentId: number): Promise<MaintenanceEvent[]> {
    return await db.select()
      .from(maintenanceEvents)
      .where(eq(maintenanceEvents.equipmentId, equipmentId))
      .orderBy(desc(maintenanceEvents.maintenanceDate));
  }

  async getMaintenanceConfig(category: string): Promise<MaintenanceConfig | undefined> {
    const [config] = await db.select()
      .from(maintenanceConfig)
      .where(eq(maintenanceConfig.equipmentCategory, category));
    return config;
  }

  async saveModelMetrics(metrics: InsertModelTrainingMetrics): Promise<ModelTrainingMetrics> {
    const result = await db.insert(modelTrainingMetrics).values(metrics);
    const [newMetrics] = await db
      .select()
      .from(modelTrainingMetrics)
      .where(eq(modelTrainingMetrics.id, result[0].insertId));
    return newMetrics!;
  }

  async getLatestModelMetrics(): Promise<ModelTrainingMetrics | undefined> {
    const [metrics] = await db
      .select()
      .from(modelTrainingMetrics)
      .orderBy(desc(modelTrainingMetrics.trainedAt))
      .limit(1);
    return metrics;
  }

  async getModelMetricsHistory(limit: number = 10): Promise<ModelTrainingMetrics[]> {
    return await db
      .select()
      .from(modelTrainingMetrics)
      .orderBy(desc(modelTrainingMetrics.trainedAt))
      .limit(limit);
  }

  async listSwapsByRental(rentalId: number): Promise<any[]> {
    // Two aliases of the same table, because a swap names both the unit that
    // left and the one that replaced it. Relational `with` would be neater and
    // does not run on TiDB; see the note on listRentals.
    const original = alias(equipment, "original_equipment");
    const replacement = alias(equipment, "replacement_equipment");

    const rows = await db
      .select({ swap: equipmentSwaps, originalEquipment: original, replacementEquipment: replacement })
      .from(equipmentSwaps)
      .leftJoin(original, eq(equipmentSwaps.originalEquipmentId, original.id))
      .leftJoin(replacement, eq(equipmentSwaps.replacementEquipmentId, replacement.id))
      .where(eq(equipmentSwaps.rentalId, rentalId))
      .orderBy(desc(equipmentSwaps.createdAt));

    return rows.map(r => ({
      ...r.swap,
      originalEquipment: r.originalEquipment,
      replacementEquipment: r.replacementEquipment,
    }));
  }
}

export const storage = new DatabaseStorage();