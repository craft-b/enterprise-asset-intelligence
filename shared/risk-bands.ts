/**
 * Risk band cutoffs, per horizon. One definition for the API and the UI;
 * the ML service mirrors it in engine/predictor_multihorizon.py
 * (RISK_THRESHOLDS), and tests/test_risk_band_parity.py fails if they drift.
 *
 * Why per horizon. These used to be 30% / 60% at every horizon. That was
 * harmless while the champion rated every unit in the demo yard HIGH at 60
 * days, and wrong once the model was calibrated: an honest 10-day failure
 * probability almost never reaches 60%, so a fixed cutoff left the risk
 * queue with no HIGH rows at 10d or 30d however bad a unit was.
 *
 * MEDIUM starts at each horizon's base rate over the whole v2.0 training
 * timeline -- more likely to fail than a typical unit over that window. The
 * holdout alone (the last fifth) would have set them higher, because by then
 * the simulated fleet had aged to about nine years on average, nearly twice
 * the demo yard's age. HIGH is where the holdout's observed failure rate
 * runs 1.6-2x the base rate:
 *
 *   horizon  base rate  MEDIUM  HIGH   holdout: share HIGH  observed in HIGH
 *   10d       11%        10%    20%            19%               26%
 *   30d       27%        25%    45%            29%               56%
 *   60d       44%        45%    70%            24%               81%
 */
export const RISK_BANDS = {
  10: { MEDIUM: 0.10, HIGH: 0.20 },
  30: { MEDIUM: 0.25, HIGH: 0.45 },
  60: { MEDIUM: 0.45, HIGH: 0.70 },
} as const;

export type RiskHorizon = keyof typeof RISK_BANDS;
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export function riskBand(probability: number, horizon: RiskHorizon): RiskLevel {
  const t = RISK_BANDS[horizon];
  return probability >= t.HIGH ? "HIGH" : probability >= t.MEDIUM ? "MEDIUM" : "LOW";
}
