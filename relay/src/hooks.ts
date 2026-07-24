/**
 * Generic, account-agnostic injection seam for the blind relay.
 *
 * entangle is a standalone, publicly-published product: it knows nothing about
 * "users" or "accounts". These hooks let an embedder (e.g. locus-server, which
 * runs the relay in-process) authenticate agent registrations against its own
 * verifier and observe metering, WITHOUT the relay ever learning a domain model.
 * Identity is an OPAQUE id string — never a "user".
 *
 * The relay stays BLIND: hooks only ever receive routing ids (capId), byte
 * sizes, the self-reported machineId, and the opaque bearer token. The
 * capability secret `S`, derived keys, and frame plaintext are NEVER passed to
 * any hook.
 *
 * Defaults are empty: with no hooks injected, behaviour is byte-for-byte today's
 * (flat RELAY_AGENT_TOKEN check, no metering, zero overhead).
 */
export interface RelayHooks {
  /**
   * Authenticate an agent registration. When set, this REPLACES the flat
   * RELAY_AGENT_TOKEN string compare. Receives the opaque bearer token and the
   * self-reported machineId. Return an identity `{ id }` to accept and bind the
   * capability's future traffic to that opaque id, or `null` to reject (the
   * relay closes the socket 1008). May be sync or async.
   */
  verifyAgentToken?(
    token: string,
    machineId: string,
  ): Promise<{ id: string } | null> | ({ id: string } | null);

  /** Fired after a verified agent successfully announces a capability. */
  onCapabilityRegistered?(info: { identityId: string; capId: string; machineId: string }): void;

  /** Fired for each announced capability of a verified agent when its socket closes. */
  onCapabilityClosed?(info: { capId: string; identityId: string }): void;

  /**
   * Metering sink. Called at each relay forward site with the routing id, the
   * sub-meter source, the direction, and the wire byte count. NEVER plaintext —
   * `bytes` is the size of an opaque (ciphertext, for capabilities) frame, or a
   * proxied plaintext HTTP chunk for public shares (which are plaintext by
   * design). A no-op when undefined.
   */
  meter?(evt: {
    capId: string;
    source: 'capability' | 'share';
    direction: 'up' | 'down';
    bytes: number;
    label?: string;
  }): void;
}

// Module-level singleton. The relay reads this at message time (via
// getRelayHooks()), so setRelayHooks() may be called before or independently of
// startServer(). Hooks are functions and are NEVER read from the environment.
let hooks: RelayHooks = {};

/** Inject the relay hooks. Passing an empty object (or nothing) restores defaults. */
export function setRelayHooks(h: RelayHooks): void {
  hooks = h ?? {};
}

/** The currently injected hooks (defaults to `{}` — today's behaviour). */
export function getRelayHooks(): RelayHooks {
  return hooks;
}
