import { config } from '../config.js';

const buckets = new Map();

// Upper bound on tracked users so one Map can't grow without limit.
// Map preserves insertion order, so oldest entries are evicted first.
const MAX_BUCKETS = 10000;

export function allow(userId) {
  if (!userId) return true;
  const key = String(userId);
  const now = Date.now();
  const windowMs = config.rateLimitWindowMs;
  const max = config.rateLimitMaxMessages;

  // Idle-bucket eviction: drop keys whose arrays are already empty.
  for (const [k, v] of buckets) {
    if (v.length === 0) buckets.delete(k);
  }

  let timestamps = buckets.get(key);
  if (!timestamps) {
    // Cap the Map: evict oldest-first until there is room.
    while (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
    timestamps = [];
    buckets.set(key, timestamps);
  }

  // Prune timestamps outside the sliding window.
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= max) {
    return false;
  }

  timestamps.push(now);
  return true;
}

export function reset(userId) {
  if (userId === undefined || userId === null) {
    buckets.clear();
    return;
  }
  buckets.delete(String(userId));
}
