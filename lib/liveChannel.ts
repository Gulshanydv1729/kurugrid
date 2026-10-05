/**
 * Live WebSocket channel — newHeads subscription over QuickNode.
 *
 * Owner: `web3`.
 *
 * Optional by design: when `NEXT_PUBLIC_MONAD_WSS_URL` is unset this
 * is a no-op and the app keeps polling. A dropped socket retries with
 * exponential backoff (capped at 30 s) and never blocks the UI.
 *
 * The channel is the app's *clock*, not just a badge. Every `newHeads` frame
 * is a block in which the Kuru book could have changed, so the consumer treats
 * each frame as a trigger to re-read the orderbook rather than waiting on its
 * own timer — see `LIVE_FEED_FALLBACK_POLL_MS` for the safety net that runs
 * only when this socket is absent. That is what turns a 10 s mark into a
 * per-block mark, and it is the difference between a live terminal and a
 * periodically-refreshed web page.
 */

import { TELEMETRY_WSS_URL } from "./constants";

export interface LiveChannelEvents {
  /** A new block head arrived. */
  onHead?: (blockNumber: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  /**
   * The socket is open but has produced no frame for `staleAfterMs`.
   *
   * A subscription that has gone quiet is indistinguishable from a working one
   * if you only listen for `open`/`close`: intermediaries drop idle sockets
   * without ever sending a close frame, so a monitor that trusted `onopen`
   * would sit there reporting LIVE while refreshing nothing. This is the
   * heartbeat that catches it.
   */
  onStale?: () => void;
}

/** Silence after which an open subscription is presumed dead. */
const STALE_AFTER_MS = 20000;

/** Start the channel. Returns a cleanup that closes the socket. */
export function startLiveChannel(events: LiveChannelEvents): () => void {
  const url = TELEMETRY_WSS_URL;
  if (url === null) return () => {};

  let closed = false;
  let socket: WebSocket | null = null;
  let backoffMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStaleTimer = (): void => {
    if (staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
  };

  /**
   * (Re)arm the silence watchdog.
   *
   * Armed on open and re-armed on every frame, so it only ever fires when the
   * subscription has genuinely stopped producing blocks.
   */
  const armStaleTimer = (): void => {
    clearStaleTimer();
    if (closed) return;
    staleTimer = setTimeout(() => {
      events.onStale?.();
    }, STALE_AFTER_MS);
  };

  const scheduleRetry = (): void => {
    if (closed) return;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, 30_000);
      connect();
    }, backoffMs);
  };

  const connect = (): void => {
    if (closed) return;
    try {
      socket = new WebSocket(url);
    } catch {
      events.onError?.();
      scheduleRetry();
      return;
    }
    const current = socket;

    current.onopen = (): void => {
      backoffMs = 1000;
      events.onOpen?.();
      armStaleTimer();
      try {
        current.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["newHeads"],
          }),
        );
      } catch {
        events.onError?.();
      }
    };

    current.onmessage = (event: MessageEvent): void => {
      try {
        const message = JSON.parse(String(event.data)) as {
          params?: { result?: { number?: unknown } };
        };
        const hex = message.params?.result?.number;
        if (typeof hex === "string") {
          const blockNumber = Number.parseInt(hex, 16);
          if (Number.isFinite(blockNumber)) {
            // Any traffic proves the socket is alive, not just a head.
            armStaleTimer();
            events.onHead?.(blockNumber);
          }
        }
      } catch {
        // Malformed frame — ignore.
      }
    };

    current.onerror = (): void => {
      events.onError?.();
    };

    current.onclose = (): void => {
      clearStaleTimer();
      events.onClose?.();
      scheduleRetry();
    };
  };

  connect();

  return (): void => {
    closed = true;
    clearStaleTimer();
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (socket !== null) {
      // Prevent the onclose retry from firing during teardown.
      socket.onclose = null;
      socket.close();
    }
  };
}
