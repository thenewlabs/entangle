import type WebSocket from 'ws';

/**
 * WebSocket ping/pong keepalive.
 *
 * A dropped network that never sends a TCP FIN leaves a socket "half-open": the
 * relay keeps a capId mapped to (or a viewer attached to) a peer that is gone,
 * silently black-holing traffic until the OS TCP stack eventually errors it out
 * — which can take minutes. Pinging on an interval and terminating any socket
 * that misses a pong detects that within ~2 intervals and lets the clean
 * `close` propagate so the reconnect logic on the other side kicks in.
 *
 * Browsers and the `ws` client both auto-reply to pings at the protocol layer,
 * so this is transparent to the application message stream on either end.
 *
 * @returns a disposer; also self-clears on socket close.
 */
export function installLiveness(ws: WebSocket, intervalMs: number): () => void {
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  ws.on('pong', onPong);
  const timer = setInterval(() => {
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      clearInterval(timer);
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* send failed → next tick terminates */
    }
  }, intervalMs);
  const dispose = () => {
    clearInterval(timer);
    ws.off('pong', onPong);
  };
  ws.on('close', dispose);
  return dispose;
}

/** Relay WS keepalive interval (env-overridable). Half-open detected in ~2× this. */
export function pingIntervalMs(): number {
  const raw = Number(process.env.RELAY_WS_PING_MS);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 20000;
}
