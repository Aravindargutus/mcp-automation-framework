/**
 * Secret masking utilities — used by API routes and UI components.
 *
 * Pattern:
 *   - GET endpoints mask secrets before returning to the browser
 *   - PUT/POST endpoints detect the sentinel and preserve stored originals
 *   - Frontend sends `__MASKED__` when a secret field was not edited
 */

/** Sentinel value the frontend sends when a secret was not changed. */
export const MASKED_SENTINEL = '__MASKED__';

/** Mask a secret string: show first 6 chars + bullet dots. */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length <= 8) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
  return value.slice(0, 6) + '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
}

/** Returns true when the value is a masked placeholder (sentinel or bullet-masked). */
export function isMasked(value: string | undefined | null): boolean {
  if (!value) return false;
  return value === MASKED_SENTINEL || value.includes('\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
}

/** Known query-parameter names that carry secrets. */
const SENSITIVE_PARAM_NAMES = new Set([
  'key', 'apikey', 'api_key', 'token', 'secret',
  'access_token', 'client_secret', 'api-key',
]);

/** Mask query-param values in a URL that look like secrets. */
export function maskUrlSecrets(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    let result = urlStr;
    for (const [param, value] of url.searchParams) {
      if (SENSITIVE_PARAM_NAMES.has(param.toLowerCase()) && value.length > 4) {
        // Replace directly in the string to avoid URL-encoding the bullet chars
        result = result.replace(
          `${param}=${encodeURIComponent(value)}`,
          `${param}=${value.slice(0, 4)}****`,
        );
        // Also handle the case where the value wasn't encoded
        result = result.replace(
          `${param}=${value}`,
          `${param}=${value.slice(0, 4)}****`,
        );
      }
    }
    return result;
  } catch {
    return urlStr; // not a valid URL — return as-is
  }
}

/** Known JSON field names that carry secrets. */
const SENSITIVE_FIELD_NAMES = new Set([
  'apikey', 'apiKey', 'api_key',
  'token', 'access_token', 'accessToken', 'refreshToken', 'refresh_token',
  'secret', 'clientSecret', 'client_secret',
  'authorization', 'Authorization',
  'password', 'passwd',
]);

/**
 * Recursively walk an object/array and mask:
 *   - field values whose key is in SENSITIVE_FIELD_NAMES
 *   - string values that look like URLs with secret query params
 */
export function sanitizeMetadata(data: unknown): unknown {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    // Try to mask URL secrets
    if (data.startsWith('http://') || data.startsWith('https://')) {
      return maskUrlSecrets(data);
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeMetadata);
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_NAMES.has(key) && typeof value === 'string' && value.length > 0) {
        result[key] = maskSecret(value);
      } else {
        result[key] = sanitizeMetadata(value);
      }
    }
    return result;
  }

  return data;
}
