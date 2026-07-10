import { DEFAULT_LIMITS } from '@thenewlabs/entangle-protocol';

// Upper bound for any untrusted control-plane string (machineId, socketId, …)
// before it is placed in a map or a log line.
export const MAX_CONTROL_STRING = 256;

/**
 * A capability id is base64url; real ids are 43 chars. Bound the charset and
 * length so an attacker cannot push very large or log-injecting values through
 * the relay's routing maps. Kept permissive on the low end so short ids used in
 * tests/tools still pass — the goal here is a DoS/injection bound, not auth.
 */
export function isValidCapId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** A non-empty string within the control-plane length bound. */
export function isBoundedString(value: unknown, max = MAX_CONTROL_STRING): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function validateArguments(argv: string[], maxCount: number, maxLen: number): void {
  if (argv.length > maxCount) {
    throw new Error(`Too many arguments: ${argv.length} > ${maxCount}`);
  }
  
  for (const arg of argv) {
    if (arg.length > maxLen) {
      throw new Error(`Argument too long: ${arg.length} > ${maxLen}`);
    }
    
    if (arg.includes('\0')) {
      throw new Error('Arguments cannot contain NUL bytes');
    }
    
    for (let i = 0; i < arg.length; i++) {
      const code = arg.charCodeAt(i);
      if ((code >= 0xD800 && code <= 0xDBFF) && (i + 1 >= arg.length || 
          arg.charCodeAt(i + 1) < 0xDC00 || arg.charCodeAt(i + 1) > 0xDFFF)) {
        throw new Error('Arguments cannot contain unpaired surrogates');
      }
    }
  }
}

export function validateCwd(cwd: string, allowedPrefixes?: string[]): void {
  if (!allowedPrefixes || allowedPrefixes.length === 0) {
    return;
  }
  
  // Normalize path separators
  const normalized = cwd.replace(/\\/g, '/');
  
  // Resolve relative path components like '../' to prevent traversal
  const resolved = resolvePath(normalized);
  
  const allowed = allowedPrefixes.some(prefix => {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    // Remove trailing slash from prefix for consistent comparison
    const cleanPrefix = normalizedPrefix.endsWith('/') ? normalizedPrefix.slice(0, -1) : normalizedPrefix;
    return resolved.startsWith(cleanPrefix + '/') || resolved === cleanPrefix;
  });
  
  if (!allowed) {
    throw new Error(`CWD not in allowed directories: ${cwd}`);
  }
}

// Simple path resolution to handle '..' and '.' components
function resolvePath(path: string): string {
  if (!path.startsWith('/')) {
    // Convert relative paths to absolute by prefixing with '/'
    path = '/' + path;
  }
  
  const parts = path.split('/').filter(Boolean);
  const resolved: string[] = [];
  
  for (const part of parts) {
    if (part === '..') {
      // Go up one directory (remove last component)
      if (resolved.length > 0) {
        resolved.pop();
      }
      // If we're already at root, ignore additional '..'
    } else if (part !== '.') {
      // Add normal directory component (ignore '.')
      resolved.push(part);
    }
  }
  
  return '/' + resolved.join('/');
}

export function validateLimits(limits?: {
  cpuMs?: number;
  memMB?: number;
  wallMs?: number;
  maxOutBytes?: number;
}): void {
  if (!limits) return;
  
  if (limits.cpuMs !== undefined && (limits.cpuMs <= 0 || limits.cpuMs > DEFAULT_LIMITS.MAX_CPU_MS)) {
    throw new Error(`Invalid CPU limit: ${limits.cpuMs}`);
  }
  
  if (limits.memMB !== undefined && (limits.memMB <= 0 || limits.memMB > DEFAULT_LIMITS.MAX_MEM_MB)) {
    throw new Error(`Invalid memory limit: ${limits.memMB}`);
  }
  
  if (limits.wallMs !== undefined && (limits.wallMs <= 0 || limits.wallMs > DEFAULT_LIMITS.MAX_WALL_MS)) {
    throw new Error(`Invalid wall time limit: ${limits.wallMs}`);
  }
  
  if (limits.maxOutBytes !== undefined && (limits.maxOutBytes <= 0 || limits.maxOutBytes > DEFAULT_LIMITS.MAX_OUT_BYTES)) {
    throw new Error(`Invalid output limit: ${limits.maxOutBytes}`);
  }
}