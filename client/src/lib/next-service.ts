/**
 * Days to a unit's next service: the scheduled date, brought forward to the
 * earliest horizon the model rates High when that comes first.
 *
 * `due` comes from the due-soon list, which only holds services due within
 * 30 days; a unit missing from it is due later than that, or has no date.
 */
export function nextService(
  due: { daysUntilDue: number | string } | undefined,
  prediction: Record<string, unknown> | undefined,
): { days: number; moveUp: boolean } | null {
  const scheduled = due ? Number(due.daysUntilDue) : null;
  const high = prediction
    ? ([10, 30, 60] as const).find((h) => prediction[`risk_level_${h}d`] === "HIGH") ?? null
    : null;
  const sooner = scheduled === null ? high !== null && high <= 30 : high !== null && high < scheduled;
  if (sooner) return { days: high!, moveUp: true };
  return scheduled === null ? null : { days: scheduled, moveUp: false };
}
