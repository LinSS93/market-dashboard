// Shared, intentionally narrow policy for earnings-calendar risk overlays.
// It controls entry timing only; it must never alter technical scores or weaken exits.

export const DEFAULT_EARNINGS_POLICY = Object.freeze({
  calendarMaxAgeHours: 18,
  stockEntryBlackoutDays: 1,
  etfPreBlackoutDays: 1,
  etfPostObserveDays: 1,
});

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeEarningsPolicy(input = {}, fallback = DEFAULT_EARNINGS_POLICY) {
  const base = { ...DEFAULT_EARNINGS_POLICY, ...(fallback || {}) };
  const source = input && typeof input === 'object' ? input : {};
  return {
    calendarMaxAgeHours: boundedInt(source.calendarMaxAgeHours, base.calendarMaxAgeHours, 6, 72),
    stockEntryBlackoutDays: boundedInt(source.stockEntryBlackoutDays, base.stockEntryBlackoutDays, 0, 7),
    etfPreBlackoutDays: boundedInt(source.etfPreBlackoutDays, base.etfPreBlackoutDays, 0, 7),
    etfPostObserveDays: boundedInt(source.etfPostObserveDays, base.etfPostObserveDays, 0, 7),
  };
}

export function isEligibleEarningsEvent(summary) {
  return !!summary
    && summary.is_fresh === true
    && summary.event_gate_verified === true
    && summary.entry_gate_eligible === true
    && summary.days_to_earnings != null
    && Number.isFinite(Number(summary.days_to_earnings));
}
