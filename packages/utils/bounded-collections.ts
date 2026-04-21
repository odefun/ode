/**
 * FIFO-bounded Set and Map used to cap long-lived runtime caches that would
 * otherwise grow without bound across the daemon's lifetime (e.g. per-message
 * finalization markers, per-session provider lookup, per-session "is new"
 * flags). When the cap is reached, the oldest entry is evicted.
 *
 * Semantics:
 *   - Insertion order is preserved by the underlying `Set` / `Map`.
 *   - `BoundedSet.add(existing)` is a no-op and does NOT refresh order.
 *   - `BoundedMap.set(existingKey, v)` updates the value in place and does
 *     NOT refresh order. This matches the historical behaviour of the bespoke
 *     copy that previously lived in `packages/core/runtime/message-updates.ts`.
 *   - Eviction only happens on `add` / `set` for new keys; `get`/`has` are
 *     read-only.
 */

export class BoundedSet<T = string> {
  private readonly max: number;
  private readonly set = new Set<T>();

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`BoundedSet requires a positive max (got ${max})`);
    }
    this.max = Math.floor(max);
  }

  add(value: T): this {
    if (this.set.has(value)) return this;
    this.set.add(value);
    if (this.set.size > this.max) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    return this;
  }

  has(value: T): boolean {
    return this.set.has(value);
  }

  delete(value: T): boolean {
    return this.set.delete(value);
  }

  get size(): number {
    return this.set.size;
  }

  clear(): void {
    this.set.clear();
  }
}

export class BoundedMap<K, V> {
  private readonly max: number;
  private readonly map = new Map<K, V>();

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`BoundedMap requires a positive max (got ${max})`);
    }
    this.max = Math.floor(max);
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.set(key, value);
      return this;
    }
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return this;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
