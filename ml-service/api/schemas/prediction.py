# ml-service/api/schemas/prediction.py
# Contract layer — defines exactly what goes in and out of the ML service.
# Both FastAPI and the Node.js orchestrator depend on this shape.

from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


class RiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


# ─────────────────────────────────────────────────────────────────────────────
# INPUT — matches asset_feature_snapshots columns + prepare_features() transforms
# Default values mirror the COALESCE fallbacks in train_model.py load_training_data()
# ─────────────────────────────────────────────────────────────────────────────

class SnapshotInput(BaseModel):
    equipment_id: int

    # Asset metadata
    asset_age_years: float = Field(..., ge=0, le=100)
    category: str
    total_hours_lifetime: float = Field(..., ge=0)

    # Usage features
    hours_used_30d: float = Field(..., ge=0)
    hours_used_90d: float = Field(..., ge=0)
    rental_days_30d: int = Field(..., ge=0)
    rental_days_90d: int = Field(..., ge=0)
    avg_rental_duration: float = Field(..., ge=0)

    # Maintenance features
    maintenance_events_90d: int = Field(..., ge=0)
    maintenance_cost_180d: float = Field(..., ge=0)
    avg_downtime_per_event: float = Field(default=0.0, ge=0)
    days_since_last_maintenance: float = Field(default=999.0, ge=0)
    mean_time_between_failures: float = Field(default=500.0, ge=0)

    # Context scores
    vendor_reliability_score: float = Field(default=0.85, ge=0, le=1)
    jobsite_risk_score: float = Field(default=0.60, ge=0, le=1)

    # Derived features — computed by feature_engineering.py
    usage_intensity: float = Field(..., ge=0, le=12)   # capped at 12 hrs/day
    usage_trend: float = Field(..., ge=0.5, le=3.0)
    utilization_vs_expected: float = Field(..., ge=0)
    wear_rate: float = Field(..., ge=0)
    aging_factor: float = Field(..., ge=0, le=1)
    maint_overdue: int = Field(..., ge=0, le=1)
    cost_per_event: float = Field(..., ge=0)
    maint_burden: float = Field(..., ge=0)

    # Composite scores (0-10) — computed by feature_engineering.py
    mechanical_wear_score: float = Field(..., ge=0, le=10)
    abuse_score: float = Field(..., ge=0, le=10)
    neglect_score: float = Field(..., ge=0, le=10)

    # Sensor data — optional, not always available
    avg_vibration: Optional[float] = None
    max_vibration: Optional[float] = None
    avg_engine_temp: Optional[float] = None
    avg_oil_pressure: Optional[float] = None
    avg_hydraulic_pressure: Optional[float] = None
    error_code_count: Optional[int] = None
    warning_count: Optional[int] = None
    
    # Velocity features — rate-of-change signals (v1.6+)
    wear_rate_velocity: float = Field(default=0.0)
    maint_frequency_trend: float = Field(default=1.0)
    cost_trend: float = Field(default=1.0)
    hours_velocity: float = Field(default=1.0)
    neglect_acceleration: float = Field(default=1.0)
    sensor_degradation_rate: float = Field(default=0.0)

    class Config:
        json_schema_extra = {
            "example": {
                "equipment_id": 42,
                "asset_age_years": 4.5,
                "category": "Excavator",
                "total_hours_lifetime": 3200.0,
                "hours_used_30d": 160.0,
                "hours_used_90d": 480.0,
                "rental_days_30d": 20,
                "rental_days_90d": 60,
                "avg_rental_duration": 3.0,
                "maintenance_events_90d": 1,
                "maintenance_cost_180d": 850.0,
                "days_since_last_maintenance": 75.0,
                "mean_time_between_failures": 320.0,
                "vendor_reliability_score": 0.85,
                "jobsite_risk_score": 0.60,
                "usage_intensity": 8.0,
                "usage_trend": 1.1,
                "utilization_vs_expected": 1.0,
                "wear_rate": 0.04,
                "aging_factor": 0.30,
                "maint_overdue": 0,
                "cost_per_event": 850.0,
                "maint_burden": 1.77,
                "mechanical_wear_score": 4.2,
                "abuse_score": 2.1,
                "neglect_score": 2.5
            }
        }


# ─────────────────────────────────────────────────────────────────────────────
# OUTPUT
# ─────────────────────────────────────────────────────────────────────────────

class PredictionOutput(BaseModel):
    equipment_id: int
    failure_probability: float = Field(..., ge=0, le=1)
    predicted_failure: bool
    risk_level: RiskLevel
    model_version: str
    top_risk_drivers: dict[str, float]     # from feature importance, human-readable
    recommendation: Optional[str]      # from genai_advisor — may be None if LLM unavailable


class BatchInput(BaseModel):
    snapshots: list[SnapshotInput]


class BatchOutput(BaseModel):
    predictions: list[PredictionOutput]
    total: int
    high_risk_count: int
    medium_risk_count: int
    low_risk_count: int


class HealthResponse(BaseModel):
    status: str
    model_version: str
    model_loaded: bool
    llm_provider: str
    llm_available: bool
    # Which commit built this container, and how long it has been serving.
    # Unauthenticated on purpose: see api/build_info.py.
    commit: str
    booted_at: str
    uptime_seconds: float


class ModelInfoResponse(BaseModel):
    version: str
    algorithm: str
    trained_at: str
    dataset_size: int
    accuracy: float
    roc_auc: float
    feature_count: int
    top_features: list[str]
