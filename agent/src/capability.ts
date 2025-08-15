import { generateCapId, generateSecret, initCrypto } from '@sunpix/entangle-crypto';
import { type Policy } from '@sunpix/entangle-protocol';
import { createLogger } from '@sunpix/entangle-utils';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const logger = createLogger('capability');

export interface CapabilityInfo {
  namespace: string;
  capId: string;
  S: string;
  tool: string;
  policy: Policy;
}

export async function createCapability(options: {
  namespace: string;
  tool: string;
  singleRun?: boolean;
}): Promise<CapabilityInfo> {
  await initCrypto();
  
  const { capId } = generateCapId();
  const S = generateSecret();
  
  const policy: Policy = {
    tool: options.tool,
    singleRun: options.singleRun ?? true,
  };
  
  const cap: CapabilityInfo = {
    namespace: options.namespace,
    capId,
    S,
    tool: options.tool,
    policy,
  };
  
  await storeCapability(cap);
  
  logger.info({ capId, namespace: options.namespace }, 'Capability created');
  
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