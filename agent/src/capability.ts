import { generateCapId, generateSecret, initCrypto } from '@thenewlabs/entangle-crypto';
import { type Policy } from '@thenewlabs/entangle-protocol';
import { promises as fs } from 'fs';
import { chmod, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { OutputHandler, parseOutputMode } from '@thenewlabs/entangle-utils';

const output = new OutputHandler({ mode: parseOutputMode(process.env.OUTPUT_MODE || 'text') });

export interface CapabilityInfo {
  capId: string;
  S: string;
  policy: Policy;
}

export async function createCapability(options: {
  singleRun?: boolean;
  outputMode?: string;
}): Promise<CapabilityInfo> {
  await initCrypto();
  
  const { capId } = generateCapId();
  const S = generateSecret();
  
  const policy: Policy = {
    singleRun: options.singleRun ?? false,
    maxStreams: 1, // Default to single stream for backward compatibility
  };
  
  const cap: CapabilityInfo = {
    capId,
    S,
    policy,
  };
  
  await storeCapability(cap);
  
  return cap;
}

async function storeCapability(cap: CapabilityInfo): Promise<void> {
  const configDir = join(homedir(), '.entangle');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  
  const capsFile = join(configDir, 'capabilities.json');
  
  let caps: CapabilityInfo[] = [];
  try {
    const data = await fs.readFile(capsFile, 'utf-8');
    caps = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }
  
  caps.push(cap);
  
  await fs.writeFile(capsFile, JSON.stringify(caps, null, 2), { mode: 0o600 });
  try {
    await chmod(capsFile, 0o600);
  } catch {}
}

export async function loadCapabilities(): Promise<CapabilityInfo[]> {
  const configDir = join(homedir(), '.entangle');
  const capsFile = join(configDir, 'capabilities.json');
  
  try {
    const data = await fs.readFile(capsFile, 'utf-8');
    try {
      const s = await stat(capsFile);
      const mode = s.mode & 0o777;
      if (mode !== 0o600) {
        output.warn(`Insecure capability file permissions: ${capsFile} has mode ${mode.toString(8)}; expected 600`);
      }
    } catch {}
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function findCapability(capId: string): Promise<CapabilityInfo | undefined> {
  const caps = await loadCapabilities();
  return caps.find(c => c.capId === capId);
}
