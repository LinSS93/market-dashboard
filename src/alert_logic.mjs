export function advanceAlertState(prev, signal, options = {}) {
  const now = Number(options.now) || Date.now();
  const next = signal ? { signal, ts: now } : prev || null;
  if (!signal) return { next, notify: false, reason: 'no_signal' };
  if (!options.primed || !prev) return { next, notify: false, reason: 'baseline' };
  if (prev.signal === signal) return { next: prev, notify: false, reason: 'same_state' };
  if (!options.selected) return { next, notify: false, reason: 'tier_not_selected' };
  if (!options.allowNotify) return { next, notify: false, reason: 'not_executable' };
  // EXIT 信号豁免冷却：清仓涉及风险控制，必须立即推送，不受 cooldown 限制。
  // TRIM 也属风险信号但非清仓，保留冷却以防止减仓信号刷屏。
  if (signal !== 'EXIT') {
    const cooldownMs = Number(options.cooldownMs) || 0;
    if (cooldownMs > 0 && (now - prev.ts) < cooldownMs) {
      return { next, notify: false, reason: 'cooldown' };
    }
  }
  return { next, notify: true, reason: 'selected_transition' };
}
