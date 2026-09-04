import "server-only";

import type { NextRequest } from "next/server";

/**
 * The Wire: build absolute URLs from the Host header the browser actually sent,
 * not from the address the server happens to be bound to.
 *
 * Next derives `request.url` from the listening address. Running in a container
 * that address is `0.0.0.0`, because Docker can only route traffic to a process
 * listening on every interface. That leaked into the Google OAuth redirect URI
 * as `http://0.0.0.0:3000/api/auth/google/callback`, which Google rejects with
 * `Error 400: invalid_request` — 0.0.0.0 is not a routable host.
 *
 * `proxy.ts` rejects any request to `/api/*` whose Host header is not loopback
 * before a route handler runs, so by the time this is called the header has
 * already been validated and is safe to build a URL from.
 */
export function requestOrigin(request: NextRequest) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) url.host = host;
  return url;
}
