#!/usr/bin/env node
// Recalculate frozen stock-signal outcomes under the shared execution
// contract. This never reruns the signal algorithm and never rewrites a
// frozen decision; it archives superseded outcome rows before replacing them.
import { reconcileSignalOutcomeContract } from '../stock_engine.mjs';

try {
  const result = await reconcileSignalOutcomeContract();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('[signal-outcome-reconcile]', error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
