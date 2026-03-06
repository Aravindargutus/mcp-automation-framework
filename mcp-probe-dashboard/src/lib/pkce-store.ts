/**
 * In-memory PKCE code verifier store with 10-minute TTL.
 * Survives the OAuth redirect round-trip within a single server process.
 * Each verifier is one-time use: retrieveVerifier deletes after reading.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StoredVerifier {
  verifier: string;
  storedAt: number;
}

const verifiers = new Map<string, StoredVerifier>();

export function storeVerifier(serverName: string, verifier: string): void {
  verifiers.set(serverName, { verifier, storedAt: Date.now() });
}

export function retrieveVerifier(serverName: string): string | null {
  const entry = verifiers.get(serverName);
  if (!entry) return null;

  // Always delete (one-time use)
  verifiers.delete(serverName);

  // Check TTL
  if (Date.now() - entry.storedAt > TTL_MS) {
    return null; // expired
  }

  return entry.verifier;
}

// Periodic cleanup of expired entries every 60 seconds
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of verifiers) {
    if (now - entry.storedAt > TTL_MS) {
      verifiers.delete(key);
    }
  }
}, 60_000);

// Don't block process exit
if (cleanupInterval.unref) cleanupInterval.unref();
