import { DEFAULT_LIMITS } from '@sunpix/entangle-protocol';

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
  
  const normalized = cwd.replace(/\\/g, '/');
  const allowed = allowedPrefixes.some(prefix => 
    normalized.startsWith(prefix.replace(/\\/g, '/'))
  );
  
  if (!allowed) {
    throw new Error(`CWD not in allowed directories: ${cwd}`);
  }
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