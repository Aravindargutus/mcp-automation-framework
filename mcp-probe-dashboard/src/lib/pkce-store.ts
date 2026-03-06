/**
 * In-memory PKCE code verifier store.
 * Survives the OAuth redirect round-trip within a single server process.
 * Each verifier is one-time use: retrieveVerifier deletes after reading.
 */
const verifiers = new Map<string, string>();

export function storeVerifier(serverName: string, verifier: string): void {
  verifiers.set(serverName, verifier);
}

export function retrieveVerifier(serverName: string): string | null {
  const v = verifiers.get(serverName) ?? null;
  if (v) verifiers.delete(serverName);
  return v;
}
