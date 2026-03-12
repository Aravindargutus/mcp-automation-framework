/**
 * ID Registry — a family-aware ID store that replaces the plain `Map<string, unknown>`.
 *
 * The registry provides:
 *   1. Family-based storage: IDs are stored by family (e.g., "portal", "project", "record")
 *   2. Fuzzy lookup: "portal_id" resolves to family "portal" → finds the stored portal ID
 *   3. Cross-entity propagation: IDs can be shared across entity workflows
 *   4. Drop-in Map compatibility: implements `has()`, `get()`, `set()` for backward compat
 *   5. History tracking: keeps track of which step produced each ID (for debugging)
 *
 * This replaces the brittle pattern where the outputStore used fixed keys like
 * "createdRecordId" and "fetched_portal_id" with a family-aware registry that
 * understands entity relationships.
 */
import { singularize } from './crud-patterns.js';

// === Types ===

export interface StoredId {
  /** The actual ID value (string or number). */
  value: unknown;
  /** The entity family this ID belongs to (e.g., "portal", "project"). */
  family: string;
  /** The store key used to set this value (for backward compat). */
  storeKey: string;
  /** The tool that produced this ID. */
  producerTool?: string;
  /** When this ID was stored. */
  timestamp: number;
}

// === ID Registry ===

/**
 * A family-aware ID store that provides backward-compatible Map semantics
 * with added fuzzy family-based lookup.
 *
 * Usage:
 *   const registry = new IdRegistry();
 *   registry.set('fetched_portal_id', '12345');      // stores under family "portal"
 *   registry.get('fetched_portal_id');                 // exact match → '12345'
 *   registry.getByFamily('portal');                    // family lookup → '12345'
 *   registry.has('fetched_portal_id');                 // true
 */
export class IdRegistry {
  /** Primary store: key → value (backward-compatible with Map). */
  private store = new Map<string, unknown>();

  /** Family index: family → StoredId (most recent wins). */
  private familyIndex = new Map<string, StoredId>();

  /** All stored entries for debugging. */
  private history: StoredId[] = [];

  // === Map-Compatible Interface ===

  /**
   * Set a value in the registry.
   * Automatically indexes by family for fuzzy lookup.
   */
  set(key: string, value: unknown, producerTool?: string): this {
    this.store.set(key, value);

    // Extract family from key and index it
    const family = this.extractFamilyFromKey(key);
    if (family && value !== undefined && value !== null) {
      const entry: StoredId = {
        value,
        family,
        storeKey: key,
        producerTool,
        timestamp: Date.now(),
      };
      this.familyIndex.set(family, entry);
      this.history.push(entry);
    }

    return this;
  }

  /**
   * Get a value by exact key match.
   * Falls back to family-based lookup if exact key not found.
   */
  get(key: string): unknown {
    // Exact match first
    if (this.store.has(key)) {
      return this.store.get(key);
    }

    // Fuzzy family lookup: "fetched_portal_id" → family "portal"
    const family = this.extractFamilyFromKey(key);
    if (family) {
      const entry = this.familyIndex.get(family);
      if (entry) return entry.value;
    }

    return undefined;
  }

  /**
   * Check if a key exists (exact or family-based).
   */
  has(key: string): boolean {
    if (this.store.has(key)) return true;

    // Family-based check
    const family = this.extractFamilyFromKey(key);
    if (family) return this.familyIndex.has(family);

    return false;
  }

  /**
   * Delete a value by exact key.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /**
   * Get the number of entries.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Iterate over all entries (backward-compatible with Map).
   */
  entries(): IterableIterator<[string, unknown]> {
    return this.store.entries();
  }

  /**
   * Iterate over keys.
   */
  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  /**
   * Iterate over values.
   */
  values(): IterableIterator<unknown> {
    return this.store.values();
  }

  /**
   * ForEach iteration.
   */
  forEach(callback: (value: unknown, key: string) => void): void {
    this.store.forEach(callback);
  }

  // === Family-Aware Lookup ===

  /**
   * Get an ID by its entity family.
   * "portal" → returns the stored portal ID regardless of the exact key used.
   */
  getByFamily(family: string): unknown {
    const normalized = singularize(family.toLowerCase());
    const entry = this.familyIndex.get(normalized);
    return entry?.value;
  }

  /**
   * Check if a family has a stored ID.
   */
  hasFamily(family: string): boolean {
    const normalized = singularize(family.toLowerCase());
    return this.familyIndex.has(normalized);
  }

  /**
   * Get all known families.
   */
  getKnownFamilies(): string[] {
    return Array.from(this.familyIndex.keys());
  }

  /**
   * Get the full StoredId entry for a family.
   */
  getFamilyEntry(family: string): StoredId | undefined {
    const normalized = singularize(family.toLowerCase());
    return this.familyIndex.get(normalized);
  }

  // === Cross-Entity Propagation ===

  /**
   * Seed this registry with entries from a shared/parent registry.
   * Only copies entries that don't already exist in this registry.
   */
  seedFrom(source: IdRegistry): void {
    for (const [key, value] of source.store.entries()) {
      if (!this.store.has(key)) {
        this.store.set(key, value);
      }
    }
    for (const [family, entry] of source.familyIndex.entries()) {
      if (!this.familyIndex.has(family)) {
        this.familyIndex.set(family, entry);
      }
    }
  }

  /**
   * Propagate "fetched_*" entries back to a shared/parent registry.
   * Used for cross-entity ID sharing.
   */
  propagateTo(target: IdRegistry): void {
    for (const [key, value] of this.store.entries()) {
      if (key.startsWith('fetched_')) {
        target.set(key, value);
      }
    }
  }

  /**
   * Create a snapshot of the registry as a plain object (for debugging/logging).
   */
  toSnapshot(): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of this.store.entries()) {
      snapshot[key] = value;
    }
    return snapshot;
  }

  // === Internal ===

  /**
   * Extract entity family from a store key.
   *
   * Handles patterns:
   *   "fetched_portal_id" → "portal"
   *   "fetched_project_id" → "project"
   *   "createdRecordId" → "record"
   *   "searchFoundId" → null (not a family key)
   */
  private extractFamilyFromKey(key: string): string | null {
    // "fetched_{family}_id" pattern
    const fetchedMatch = key.match(/^fetched_(.+?)_id$/);
    if (fetchedMatch) {
      return singularize(fetchedMatch[1].toLowerCase());
    }

    // "createdRecordId" → "record"
    if (key === 'createdRecordId') return 'record';

    // "{family}Id" camelCase pattern
    const camelMatch = key.match(/^(.+?)Id$/);
    if (camelMatch) {
      const family = camelMatch[1].toLowerCase();
      if (family.length > 2) return singularize(family);
    }

    return null;
  }
}

/**
 * Create an IdRegistry pre-seeded with entries from a plain Map.
 * Used for backward-compatible migration from Map<string, unknown>.
 */
export function createRegistryFromMap(map: Map<string, unknown>): IdRegistry {
  const registry = new IdRegistry();
  for (const [key, value] of map.entries()) {
    registry.set(key, value);
  }
  return registry;
}
