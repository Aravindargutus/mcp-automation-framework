/**
 * Test Suite Registry — allows dynamic registration of test suites.
 * Users can register custom suites without modifying the framework source.
 */
import type { TestSuite } from './types.js';

export class TestSuiteRegistry {
  private suites = new Map<string, TestSuite>();

  /** Register a test suite. Overwrites if same name exists. */
  register(suite: TestSuite): void {
    this.suites.set(suite.name, suite);
  }

  /** Unregister a test suite by name. */
  unregister(name: string): boolean {
    return this.suites.delete(name);
  }

  /** Get a suite by name. */
  get(name: string): TestSuite | undefined {
    return this.suites.get(name);
  }

  /** Get all registered suites. */
  getAll(): TestSuite[] {
    return Array.from(this.suites.values());
  }

  /** Get suites filtered by include/exclude lists. */
  getFiltered(include: string[], exclude: string[]): TestSuite[] {
    return this.getAll().filter((suite) => {
      if (exclude.includes(suite.name)) return false;
      if (include.length > 0) return include.includes(suite.name);
      return true;
    });
  }

  /** Get suite names. */
  names(): string[] {
    return Array.from(this.suites.keys());
  }

  /** Check if a suite is registered. */
  has(name: string): boolean {
    return this.suites.has(name);
  }

  /** Number of registered suites. */
  get size(): number {
    return this.suites.size;
  }
}

/** Global default registry with built-in suites */
export function createDefaultRegistry(): TestSuiteRegistry {
  const registry = new TestSuiteRegistry();
  // Built-in suites are registered by the runner during initialization
  return registry;
}
