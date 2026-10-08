import { requireValue } from './errors.js';

// A cloud backup is not proof of a purchase or a source of paid coins.
// Paid balances and permanent paid entitlements stay in the separate ledger.
export function validateProgress(progress) {
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  requireValue(progress && typeof progress === 'object' && !Array.isArray(progress), 400, 'invalid_progress');
  requireValue(progress.version === 1 && progress.adminTesting === false, 400, 'invalid_progress');
  requireValue(integer(progress.index, 0, 60) && integer(progress.lives, 0, 3) && integer(progress.hints, 0, 999), 400, 'invalid_progress');
  for (const key of ['removed', 'completed']) {
    requireValue(Array.isArray(progress[key]) && progress[key].length <= 2500 &&
      progress[key].every(x => integer(x, 0, key === 'completed' ? 60 : 100000)), 400, 'invalid_progress');
  }
  requireValue(progress.rewards && integer(progress.rewards.coins, 0, 100000000), 400, 'invalid_progress');
  requireValue(progress.shop && typeof progress.shop === 'object' && !Array.isArray(progress.shop), 400, 'invalid_progress');
  requireValue(!('balance' in progress) && !('paidBalance' in progress) && !('token' in progress), 400, 'invalid_progress');
  const json = JSON.stringify(progress);
  requireValue(Buffer.byteLength(json) <= 65536, 413, 'progress_too_large');
  return json;
}
