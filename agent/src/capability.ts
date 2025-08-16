import { generateCapId, generateSecret, initCrypto } from '@sunpix/entangle-crypto';
import { type Policy } from '@sunpix/entangle-protocol';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  await fs.mkdir(configDir, { recursive: true });
  
  const capsFile = join(configDir, 'capabilities.json');
  
  let caps: CapabilityInfo[] = [];
  try {
    const data = await fs.readFile(capsFile, 'utf-8');
    caps = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }
  
  caps.push(cap);
  
  await fs.writeFile(capsFile, JSON.stringify(caps, null, 2));
}

export async function loadCapabilities(): Promise<CapabilityInfo[]> {
  const configDir = join(homedir(), '.entangle');
  const capsFile = join(configDir, 'capabilities.json');
  
  try {
    const data = await fs.readFile(capsFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function findCapability(capId: string): Promise<CapabilityInfo | undefined> {
  const caps = await loadCapabilities();
  return caps.find(c => c.capId === capId);
}