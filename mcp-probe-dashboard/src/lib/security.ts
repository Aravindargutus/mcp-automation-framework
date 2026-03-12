/**
 * Shared security utilities — input validation, SSRF protection,
 * OAuth state signing, rate limiting, header sanitization, and error handling.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// ─── Custom error class ───────────────────────────────────────────────
/** Thrown for user-fixable validation errors — message is safe to expose to clients. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─── Input validators ─────────────────────────────────────────────────

const SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

export function validateServerName(name: unknown): string {
  if (typeof name !== 'string' || !SERVER_NAME_RE.test(name)) {
    throw new ValidationError(
      'Server name must be 1-63 alphanumeric chars (plus . _ -), starting with a letter or digit',
    );
  }
  return name;
}

const VALID_TRANSPORT_TYPES = new Set(['stdio', 'http', 'sse']);

export function validateTransportType(type: unknown): 'stdio' | 'http' | 'sse' {
  if (typeof type !== 'string' || !VALID_TRANSPORT_TYPES.has(type)) {
    throw new ValidationError(`transport.type must be one of: ${[...VALID_TRANSPORT_TYPES].join(', ')}`);
  }
  return type as 'stdio' | 'http' | 'sse';
}

const VALID_AUTH_TYPES = new Set(['bearer', 'apikey', 'oauth']);

export function validateAuthType(type: unknown): 'bearer' | 'apikey' | 'oauth' {
  if (typeof type !== 'string' || !VALID_AUTH_TYPES.has(type)) {
    throw new ValidationError(`auth.type must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
  }
  return type as 'bearer' | 'apikey' | 'oauth';
}

// ─── SSRF-safe URL validation ─────────────────────────────────────────

/** Private IP ranges and metadata endpoints that must be blocked. */
const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80/i,
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.internal',
  '169.254.169.254',
]);

export function validateUrl(
  urlStr: unknown,
  fieldName = 'url',
  options?: { allowLocalhost?: boolean },
): string {
  if (typeof urlStr !== 'string' || urlStr.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new ValidationError(`${fieldName} is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`${fieldName} must use http or https scheme`);
  }

  // Skip SSRF checks when localhost is explicitly allowed (e.g., Ollama local LLM)
  if (!options?.allowLocalhost) {
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host)) {
      throw new ValidationError(`${fieldName} points to a blocked host`);
    }
    for (const pattern of PRIVATE_HOST_PATTERNS) {
      if (pattern.test(host)) {
        throw new ValidationError(`${fieldName} must not point to a private/internal IP`);
      }
    }
  }

  return urlStr;
}

// ─── Command & args validation (stdio) ────────────────────────────────

const SAFE_COMMAND_RE = /^[a-zA-Z0-9._\/-]+$/;

export function validateCommand(cmd: unknown): string {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    throw new ValidationError('transport.command must be a non-empty string');
  }
  if (!SAFE_COMMAND_RE.test(cmd)) {
    throw new ValidationError('transport.command contains disallowed characters');
  }
  return cmd;
}

const DANGEROUS_ARG_CHARS = /[;|&`$(){}<>!]/;

export function validateArgs(args: unknown): string[] {
  if (!Array.isArray(args)) {
    throw new ValidationError('transport.args must be an array');
  }
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new ValidationError('Each transport.args entry must be a string');
    }
    if (DANGEROUS_ARG_CHARS.test(arg)) {
      throw new ValidationError('transport.args contains disallowed shell metacharacters');
    }
  }
  return args as string[];
}

// ─── Composite server config validator ────────────────────────────────

export function validateServerConfig(body: Record<string, any>): void {
  validateServerName(body.name);

  if (!body.transport || typeof body.transport !== 'object') {
    throw new ValidationError('transport is required and must be an object');
  }

  const ttype = validateTransportType(body.transport.type);

  if (ttype === 'stdio') {
    validateCommand(body.transport.command);
    if (body.transport.args !== undefined) {
      validateArgs(body.transport.args);
    }
  } else {
    // http or sse — require a valid URL
    if (!body.transport.url) {
      throw new ValidationError('transport.url is required for http/sse transports');
    }
    validateUrl(body.transport.url, 'transport.url');
  }

  if (body.auth && typeof body.auth === 'object') {
    validateAuthType(body.auth.type);
  }
}

// ─── OAuth state HMAC signing ─────────────────────────────────────────

/**
 * Lazy-initialised secret for HMAC signing.
 * Persists for the lifetime of the server process.
 */
let _hmacSecret: string | null = null;
function getHmacSecret(): string {
  if (!_hmacSecret) {
    _hmacSecret = process.env.OAUTH_STATE_SECRET || randomBytes(32).toString('hex');
  }
  return _hmacSecret;
}

/** HMAC-SHA256 sign a state payload → `base64url_data.base64url_sig` */
export function signState(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getHmacSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify HMAC signature and return decoded payload. Throws on tamper. */
export function verifyState(state: string): Record<string, unknown> {
  const dotIndex = state.lastIndexOf('.');
  if (dotIndex === -1) {
    throw new ValidationError('State signature verification failed');
  }
  const data = state.slice(0, dotIndex);
  const sig = state.slice(dotIndex + 1);
  const expected = createHmac('sha256', getHmacSecret()).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new ValidationError('State signature verification failed');
  }
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    throw new ValidationError('State payload is corrupted');
  }
}

// ─── Rate limiting (token bucket) ─────────────────────────────────────

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
  ) {
    // Auto-cleanup stale buckets every 60s
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > 120_000) this.buckets.delete(key);
      }
    }, 60_000);
    // Don't block process exit
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Consume one token. Throws 429-friendly error if bucket is empty. */
  consume(key: string): void {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      throw new RateLimitError();
    }
    bucket.tokens -= 1;
  }
}

export class RateLimitError extends Error {
  constructor() {
    super('Too many requests — please slow down');
    this.name = 'RateLimitError';
  }
}

/** Shared rate limiters */
export const mutationLimiter = new RateLimiter(20, 2);
export const oauthLimiter = new RateLimiter(10, 1);

// ─── Header sanitization ──────────────────────────────────────────────

const BLOCKED_HEADERS = new Set([
  'host',
  'transfer-encoding',
  'content-length',
  'connection',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'keep-alive',
  'cookie',
  'set-cookie',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

/** Strip dangerous/hop-by-hop headers before forwarding. */
export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Error sanitization ───────────────────────────────────────────────

/** Return a safe error message: only expose ValidationError messages; generic for others. */
export function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof ValidationError) return err.message;
  if (err instanceof RateLimitError) return err.message;
  return 'An internal error occurred';
}

/** Remove .stack from error objects to prevent information leakage. */
export function stripStackTrace(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(stripStackTrace);
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'stack' && typeof value === 'string') continue;
    result[key] = typeof value === 'object' ? stripStackTrace(value) : value;
  }
  return result;
}
