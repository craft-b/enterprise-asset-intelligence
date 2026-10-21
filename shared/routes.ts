import { z } from 'zod';
import { 
  insertEquipmentSchema, insertRentalSchema, registerUserSchema, 
  insertJobSiteSchema, insertVendorSchema, insertInvoiceSchema,
  EVENT_SOURCE_VALUES,
} from './schema';

// Types for build-time safety
import type { User, Equipment, Rental, JobSite, Vendor, Invoice, MaintenanceEvent } from './schema';

// ============================================
// SHARED ERROR SCHEMAS
// ============================================
export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
  unauthorized: z.object({
    message: z.string(),
  }),
};

// ============================================
// API CONTRACT
// ============================================
export const api = {
  riskScore: {
    calculate: {
      method: 'POST' as const,
      path: '/api/risk-score/equipment',
      input: z.object({
        equipmentId: z.number(),
        asOfDate: z.string().optional(),
      }),
      responses: {
        200: z.object({
          equipmentId: z.number(),
          riskScore: z.number(),
          riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
          drivers: z.array(z.string()),
          modelVersion: z.string(),
        }),
        404: errorSchemas.notFound,
      },
    },
    batch: {
      method: 'POST' as const,
      path: '/api/risk-score/equipment/batch',
      input: z.object({
        equipmentIds: z.array(z.number()),
      }),
      responses: {
        200: z.array(z.object({
          equipmentId: z.number(),
          riskScore: z.number(),
          riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
          drivers: z.array(z.string()),
          modelVersion: z.string(),
        })),
      },
    },
    history: {
      method: 'GET' as const,
      path: '/api/risk-score/equipment/:id/history',
      responses: {
        200: z.array(z.object({
          id: z.number(),
          equipmentId: z.number(),
          riskScore: z.number(),
          riskLevel: z.string(),
          drivers: z.string(),
          modelVersion: z.string(),
          scoredAt: z.string(),
        })),
      },
    },
  },
  auth: {
    login: {
      method: 'POST' as const,
      path: '/api/auth/login',
      input: z.object({
        username: z.string(),
        password: z.string(),
      }),
      responses: {
        200: z.custom<User>(),
        401: errorSchemas.unauthorized,
      },
    },
    logout: {
      method: 'POST' as const,
      path: '/api/auth/logout',
      responses: {
        200: z.object({ message: z.string() }),
      },
    },
    me: {
      method: 'GET' as const,
      path: '/api/auth/me',
      responses: {
        200: z.custom<User>(),
        401: errorSchemas.unauthorized,
      },
    },
    register: {
      method: 'POST' as const,
      path: '/api/auth/register',
      input: registerUserSchema,
      responses: {
        201: z.custom<User>(),
        400: errorSchemas.validation,
      },
    }
  },
  equipment: {
    list: {
      method: 'GET' as const,
      path: '/api/equipment',
      input: z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        category: z.string().optional(),
      }).optional(),
      responses: {
        200: z.array(z.custom<Equipment>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/equipment/:id',
      responses: {
        200: z.custom<Equipment>(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/equipment',
      input: insertEquipmentSchema,
      responses: {
        201: z.custom<Equipment>(),
        400: errorSchemas.validation,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/equipment/:id',
      input: insertEquipmentSchema.partial(),
      responses: {
        200: z.custom<Equipment>(),
        404: errorSchemas.notFound,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/equipment/:id',
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    }
  },
  jobSites: {
    list: {
      method: 'GET' as const,
      path: '/api/job-sites',
      responses: {
        200: z.array(z.object({
          id: z.number(),
          jobId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          contactPerson: z.string().nullable(),
          contactPhone: z.string().nullable(),
          createdAt: z.string().nullable(),
          _count: z.object({
            rentals: z.number(),
          }).optional(),
        })),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/job-sites/:id',
      responses: {
        200: z.object({
          id: z.number(),
          jobId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          contactPerson: z.string().nullable(),
          contactPhone: z.string().nullable(),
          createdAt: z.string().nullable(),
          rentals: z.array(z.object({
            id: z.number(),
            status: z.string(),
            receiveDate: z.string(),
            returnDate: z.string().nullable(),
            equipment: z.object({
              id: z.number(),
              name: z.string(),
              equipmentId: z.string(),
            }),
          })),
        }),
        404: z.object({ message: z.string() }),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/job-sites',
      input: insertJobSiteSchema,
      responses: {
        201: z.object({
          id: z.number(),
          jobId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          contactPerson: z.string().nullable(),
          contactPhone: z.string().nullable(),
          createdAt: z.string().nullable(),
        }),
        400: z.object({ message: z.string() }),
      },
    },
    update: {
      method: 'PATCH' as const,
      path: '/api/job-sites/:id',
      input: insertJobSiteSchema.partial(),
      responses: {
        200: z.object({
          id: z.number(),
          jobId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          contactPerson: z.string().nullable(),
          contactPhone: z.string().nullable(),
          createdAt: z.string().nullable(),
        }),
        404: z.object({ message: z.string() }),
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/job-sites/:id',
      responses: {
        200: z.object({ message: z.string() }),
        404: z.object({ message: z.string() }),
        409: z.object({ message: z.string() }),
      },
    },
  },
  vendors: {
    list: {
      method: 'GET' as const,
      path: '/api/vendors',
      responses: {
        200: z.array(z.object({
          id: z.number(),
          vendorId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          salesPerson: z.string().nullable(),
          contact: z.string().nullable(),
          createdAt: z.string().nullable(),
          _count: z.object({
            rentals: z.number(),
          }).optional(),
        })),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/vendors/:id',
      responses: {
        200: z.object({
          id: z.number(),
          vendorId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          salesPerson: z.string().nullable(),
          contact: z.string().nullable(),
          createdAt: z.string().nullable(),
          rentals: z.array(z.object({
            id: z.number(),
            status: z.string(),
            receiveDate: z.string(),
            returnDate: z.string().nullable(),
            equipment: z.object({
              id: z.number(),
              name: z.string(),
              equipmentId: z.string(),
            }),
          })),
        }),
        404: z.object({ message: z.string() }),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/vendors',
      input: insertVendorSchema,
      responses: {
        201: z.object({
          id: z.number(),
          vendorId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          salesPerson: z.string().nullable(),
          contact: z.string().nullable(),
          createdAt: z.string().nullable(),
        }),
        400: z.object({ message: z.string() }),
      },
    },
    update: {
      method: 'PATCH' as const,
      path: '/api/vendors/:id',
      input: insertVendorSchema.partial(),
      responses: {
        200: z.object({
          id: z.number(),
          vendorId: z.string(),
          name: z.string(),
          address: z.string().nullable(),
          salesPerson: z.string().nullable(),
          contact: z.string().nullable(),
          createdAt: z.string().nullable(),
        }),
        404: z.object({ message: z.string() }),
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/vendors/:id',
      responses: {
        200: z.object({ message: z.string() }),
        404: z.object({ message: z.string() }),
        409: z.object({ message: z.string() }),
      },
    },
  },
  rentals: {
    list: {
      method: 'GET' as const,
      path: '/api/rentals',
      input: z.object({
        search: z.string().optional(),
        jobSiteId: z.string().optional(),
        vendorId: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }).optional(),
      responses: {
        200: z.array(z.custom<Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null }>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/rentals',
      input: insertRentalSchema,
      responses: {
        201: z.custom<Rental>(),
        400: errorSchemas.validation,
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/rentals/:id',
      responses: {
        200: z.custom<Rental & { equipment: Equipment, jobSite: JobSite, vendor: Vendor | null, invoices: Invoice[] }>(),
        404: errorSchemas.notFound,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/rentals/:id',
      input: insertRentalSchema.partial(),
      responses: {
        200: z.custom<Rental>(),
        404: errorSchemas.notFound,
      },
    },
    complete: {
      method: 'POST' as const,
      path: '/api/rentals/:id/complete',
      responses: {
        200: z.custom<Rental>(),
        404: errorSchemas.notFound,
      }
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/rentals/:id',
      responses: {
        200: z.object({ message: z.string() }),
        404: errorSchemas.notFound,
        409: z.object({ message: z.string() }),
      }
    }
  },
  invoices: {
    create: {
      method: 'POST' as const,
      path: '/api/invoices',
      input: insertInvoiceSchema,
      responses: { 201: z.custom<Invoice>() },
    },
  },
  swaps: {
    create: {
      method: 'POST' as const,
      path: '/api/rentals/:id/swap',
      input: z.object({
        replacementEquipmentId: z.number(),
        reason: z.string().optional(),
        swappedBy: z.string().optional(),
        notes: z.string().optional(),
      }),
      responses: {
        200: z.object({ message: z.string() }),
        400: z.object({ message: z.string() }),
        404: z.object({ message: z.string() }),
      },
    },
    list: {
      method: 'GET' as const,
      path: '/api/rentals/:id/swaps',
      responses: {
        200: z.array(z.object({
          id: z.number(),
          rentalId: z.number(),
          originalEquipmentId: z.number(),
          replacementEquipmentId: z.number(),
          swapDate: z.string(),
          reason: z.string().nullable(),
          swappedBy: z.string().nullable(),
          notes: z.string().nullable(),
          createdAt: z.string().nullable(),
          originalEquipment: z.object({ id: z.number(), name: z.string(), equipmentId: z.string() }).optional(),
          replacementEquipment: z.object({ id: z.number(), name: z.string(), equipmentId: z.string() }).optional(),
        })),
      },
    },
  },
  reports: {
    weeklyOutstanding: {
      method: 'GET' as const,
      path: '/api/reports/weekly-outstanding',
      responses: { 200: z.array(z.any()) },
    },
    buyoutCandidates: {
      method: 'GET' as const,
      path: '/api/reports/buyout-candidates',
      responses: { 200: z.array(z.any()) },
    },
    annualRental: {
      method: 'GET' as const,
      path: '/api/reports/annual-rental',
      responses: { 200: z.array(z.any()) },
    },
  },
  ml: {
    modelMetrics: {
      method: 'GET' as const,
      path: '/api/ml/model-metrics',
      responses: {
        200: z.object({
          version: z.string(),
          trainedAt: z.string(),
          datasetSize: z.number(),
          accuracy: z.number(),
          precision: z.object({
            HIGH: z.number(),
            MEDIUM: z.number(),
            LOW: z.number(),
          }),
          recall: z.object({
            HIGH: z.number(),
            MEDIUM: z.number(),
            LOW: z.number(),
          }),
          f1Score: z.object({
            HIGH: z.number(),
            MEDIUM: z.number(),
            LOW: z.number(),
          }),
          confusionMatrix: z.object({
            HIGH: z.object({
              predictedHIGH: z.number(),
              predictedMEDIUM: z.number(),
              predictedLOW: z.number(),
            }),
            MEDIUM: z.object({
              predictedHIGH: z.number(),
              predictedMEDIUM: z.number(),
              predictedLOW: z.number(),
            }),
            LOW: z.object({
              predictedHIGH: z.number(),
              predictedMEDIUM: z.number(),
              predictedLOW: z.number(),
            }),
          }),
          featureImportance: z.array(z.object({
            feature: z.string(),
            importance: z.number(),
            description: z.string(),
          })),
          predictionHistory: z.array(z.object({
            date: z.string(),
            total: z.number(),
            high: z.number(),
            medium: z.number(),
            low: z.number(),
          })),
          hyperparameters: z.object({
            algorithm: z.string(),
            nEstimators: z.number(),
            maxDepth: z.number(),
            minSamplesSplit: z.number(),
            classWeight: z.string(),
          }),
        }),
      },
    },
    featureImportance: {
      method: 'GET' as const,
      path: '/api/ml/feature-importance',
      responses: {
        200: z.array(z.object({
          feature: z.string(),
          importance: z.number(),
          description: z.string(),
        })),
      },
    },
  },
  maintenance: {
    list: {
      method: 'GET' as const,
      path: '/api/maintenance',
      input: z.object({
        equipmentId: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }).optional(),
      responses: {
        200: z.object({
          events: z.array(z.custom<MaintenanceEvent>()),
          total: z.number(),
          limit: z.number(),
          offset: z.number(),
        }),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/maintenance',
      input: z.object({
        equipmentId: z.number(),
        maintenanceDate: z.string(),
        maintenanceType: z.enum(['INSPECTION', 'MINOR_SERVICE', 'MAJOR_SERVICE']),
        // WHY the maintenance was triggered — feeds the ML feedback loop
        eventSource: z.enum(EVENT_SOURCE_VALUES).optional().default('SCHEDULED_PM'),
        description: z.string().optional(),
        performedBy: z.string().optional(),
        cost: z.string().optional(),
        nextDueDate: z.string().optional(),
      }),
      responses: {
        201: z.custom<MaintenanceEvent>(),
        400: errorSchemas.validation,
      },
    },
    getByEquipment: {
      method: 'GET' as const,
      path: '/api/maintenance/equipment/:id',
      responses: {
        200: z.array(z.custom<MaintenanceEvent>()),
      },
    },
    dueSoon: {
      method: 'GET' as const,
      path: '/api/maintenance/due-soon',
      responses: {
        200: z.array(z.object({
          id: z.number(),
          name: z.string(),
          equipmentId: z.string(),
          category: z.string(),
          status: z.string(),
          nextDueDate: z.string(),
          daysUntilDue: z.number(),
        })),
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}