import { AppError } from '@/lib/errors';

export class SSRFProtectionError extends AppError {
  constructor(message = 'Outbound network destination blocked by SSRF protection policy') {
    super(message, 403, 'SSRF_BLOCKED');
    this.name = 'SSRFProtectionError';
  }
}

const CLOUD_METADATA_IPS = [
  '169.254.169.254',
  '169.254.170.2',
  'metadata.google.internal',
  'fd00:ec2::254',
];

const PRIVATE_IP_REGEXES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\./,
  /^::1$/,
];

/**
 * Validates external outbound URLs to prevent Server-Side Request Forgery (SSRF)
 * against cloud metadata endpoints and internal private resources.
 */
export function validateOutboundUrl(
  targetUrl: string,
  options?: {
    allowLocalNetwork?: boolean;
    requireHttps?: boolean;
    allowlist?: string[];
  }
): URL {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new SSRFProtectionError('Invalid URL string provided for outbound dispatch');
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new SSRFProtectionError(`Malformed URL: ${targetUrl}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // 1. Prohibit cloud metadata endpoints unconditionally
  if (CLOUD_METADATA_IPS.includes(hostname)) {
    throw new SSRFProtectionError(`Destination '${hostname}' blocked: Cloud metadata service target`);
  }

  // 2. Enforce scheme restrictions
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFProtectionError(`Prohibited protocol '${parsed.protocol}': only HTTP/HTTPS permitted`);
  }

  if (options?.requireHttps && parsed.protocol !== 'https:') {
    throw new SSRFProtectionError(`Protocol '${parsed.protocol}' blocked: HTTPS required in production cloud mode`);
  }

  // 3. Check explicit allowlist
  if (options?.allowlist && options.allowlist.length > 0) {
    const isAllowlisted = options.allowlist.some(
      (allowed) => hostname === allowed.toLowerCase() || hostname.endsWith(`.${allowed.toLowerCase()}`)
    );
    if (!isAllowlisted) {
      throw new SSRFProtectionError(`Hostname '${hostname}' is not in the approved outbound allowlist`);
    }
    return parsed;
  }

  // 4. Block private IP addresses unless local network is permitted
  if (!options?.allowLocalNetwork) {
    if (hostname === 'localhost' || PRIVATE_IP_REGEXES.some((rx) => rx.test(hostname))) {
      throw new SSRFProtectionError(`Private / loopback network destination '${hostname}' blocked by SSRF policy`);
    }
  }

  return parsed;
}
