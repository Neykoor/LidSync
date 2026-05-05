export class LidCache {
  #data = new Map();
  #maxSize;
  #ttl;
  #stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
  #purgeInterval = null;

  constructor(options = {}) {
    this.#maxSize = Math.max(1, options.maxSize || 7500);
    this.#ttl = Math.max(1000, options.ttlMs || 86400000);

    if (options.autoPurge !== false) {
      this.#startAutoPurge(options.purgeIntervalMs || 900000);
    }
  }

  has(lid) {
    if (!lid || typeof lid !== "string") return false;
    const entry = this.#data.get(lid);
    if (!entry) return false;

    if (Date.now() > entry.expiry) {
      this.#data.delete(lid);
      this.#stats.expirations++;
      return false;
    }
    return true;
  }

  get(lid) {
    if (!lid || typeof lid !== "string") {
      this.#stats.misses++;
      return null;
    }

    const entry = this.#data.get(lid);
    if (!entry) {
      this.#stats.misses++;
      return null;
    }

    const now = Date.now();
    if (now > entry.expiry) {
      this.#data.delete(lid);
      this.#stats.expirations++;
      this.#stats.misses++;
      return null;
    }

    entry.expiry = Math.max(entry.expiry, now + this.#ttl * 0.2);
    this.#data.delete(lid);
    this.#data.set(lid, entry);

    this.#stats.hits++;
    return entry.jid;
  }

  set(lid, jid, customTtl = null) {
    if (!lid || !jid || typeof lid !== "string" || typeof jid !== "string") return false;

    if (this.#data.size >= this.#maxSize && !this.#data.has(lid)) {
      const firstKey = this.#data.keys().next().value;
      this.#data.delete(firstKey);
      this.#stats.evictions++;
    }

    this.#data.set(lid, { jid, expiry: Date.now() + (customTtl !== null ? customTtl : this.#ttl) });
    return true;
  }

  setMany(entries, customTtl = null) {
    let added = 0;
    for (const [lid, jid] of entries) {
      if (this.set(lid, jid, customTtl)) added++;
    }
    return added;
  }

  preload(entries) {
    return this.setMany(entries);
  }

  getStats() {
    const total = this.#stats.hits + this.#stats.misses;
    return {
      size: this.#data.size,
      maxSize: this.#maxSize,
      ...this.#stats,
      hitRate: total > 0 ? `${((this.#stats.hits / total) * 100).toFixed(2)}%` : "0%",
      memoryEstimate: `${((this.#data.size * 250) / 1024).toFixed(2)} KB`,
    };
  }

  purgeExpired(limit = 100) {
    const now = Date.now();
    let purged = 0;
    for (const [key, value] of this.#data.entries()) {
      if (now > value.expiry) {
        this.#data.delete(key);
        purged++;
        this.#stats.expirations++;
      }
      if (limit !== null && purged >= limit) break;
    }
    return purged;
  }

  #startAutoPurge(intervalMs) {
    this.#stopAutoPurge();
    this.#purgeInterval = setInterval(() => {
      if (this.#data.size > this.#maxSize * 0.85) this.purgeExpired(100);
    }, intervalMs);
    this.#purgeInterval.unref?.();
  }

  #stopAutoPurge() {
    if (this.#purgeInterval) {
      clearInterval(this.#purgeInterval);
      this.#purgeInterval = null;
    }
  }

  destroy() {
    this.#stopAutoPurge();
    this.#data.clear();
  }
}
