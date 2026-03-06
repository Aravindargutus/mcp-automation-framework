/**
 * Session manager — separated from transport per architect review.
 *
 * Handles MCP-specific session state:
 * - Session ID tracking
 * - Session expiry detection (404 → reinit)
 * - Protocol version negotiation record
 * - Reconnection logic
 */

export interface SessionState {
  sessionId: string | null;
  negotiatedVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  capabilities: Record<string, unknown> | null;
  isInitialized: boolean;
  startedAt: number | null;
  lastActivityAt: number | null;
}

export class SessionManager {
  private state: SessionState = {
    sessionId: null,
    negotiatedVersion: null,
    serverInfo: null,
    capabilities: null,
    isInitialized: false,
    startedAt: null,
    lastActivityAt: null,
  };

  get session(): Readonly<SessionState> {
    return { ...this.state };
  }

  get isActive(): boolean {
    return this.state.isInitialized && this.state.sessionId !== null;
  }

  /**
   * Record the result of a successful initialize handshake.
   */
  recordInitialized(params: {
    sessionId: string | null;
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
  }): void {
    this.state = {
      sessionId: params.sessionId,
      negotiatedVersion: params.protocolVersion,
      serverInfo: params.serverInfo,
      capabilities: params.capabilities,
      isInitialized: true,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  /**
   * Update activity timestamp on every message exchange.
   */
  recordActivity(): void {
    this.state.lastActivityAt = Date.now();
  }

  /**
   * Handle session expiry (HTTP 404).
   * Returns true if the session was active and is now invalidated.
   */
  handleSessionExpired(): boolean {
    const wasActive = this.state.isInitialized;
    this.reset();
    return wasActive;
  }

  /**
   * Check if a specific capability was negotiated.
   */
  hasCapability(path: string): boolean {
    if (!this.state.capabilities) return false;

    const parts = path.split('.');
    let current: unknown = this.state.capabilities;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return false;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current !== undefined && current !== null;
  }

  /**
   * Check if the negotiated version supports a feature.
   */
  isVersionAtLeast(requiredVersion: string): boolean {
    if (!this.state.negotiatedVersion) return false;
    return this.state.negotiatedVersion >= requiredVersion;
  }

  /**
   * Reset session state (on disconnect or session expiry).
   */
  reset(): void {
    this.state = {
      sessionId: null,
      negotiatedVersion: null,
      serverInfo: null,
      capabilities: null,
      isInitialized: false,
      startedAt: null,
      lastActivityAt: null,
    };
  }
}
