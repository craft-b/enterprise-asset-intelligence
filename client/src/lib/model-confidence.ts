// Mirrors _confidence_label in ml-service/engine/predictor_multihorizon.py, for
// forecasts read back from stored rows, which do not keep the label. The page
// hardcoded "moderate", "high" and "very high" for those, on a model the service
// itself calls low at these AUCs.
export function confidenceLabel(rocAuc: number | null | undefined): string {
  if (rocAuc == null) return "unknown";
  const auc = `(holdout ROC-AUC ${rocAuc.toFixed(2)})`;
  if (rocAuc >= 0.9) return `high ${auc}`;
  if (rocAuc >= 0.8) return `moderate ${auc}`;
  return `low ${auc}`;
}
