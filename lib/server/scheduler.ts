import "server-only";

const COLLECTION_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5_000;

declare global {
  var controlCenterCollectorTimer: NodeJS.Timeout | undefined;
  var controlCenterCollectorStartupTimer: NodeJS.Timeout | undefined;
  var controlCenterCollectorRunning: boolean | undefined;
}

function localBaseUrl() {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function refreshAllCollectors() {
  if (globalThis.controlCenterCollectorRunning) return;
  globalThis.controlCenterCollectorRunning = true;
  try {
    const baseUrl = localBaseUrl();
    await Promise.allSettled([
      "/api/live/industry?refresh=1",
      "/api/live/mentions?refresh=1",
      "/api/live/newsletters?refresh=1",
    ].map(async (path) => {
      const response = await fetch(`${baseUrl}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(path.startsWith("/api/live/newsletters") ? 300_000 : 60_000),
      });
      await response.body?.cancel();
    }));
  } finally {
    globalThis.controlCenterCollectorRunning = false;
  }
}

export function startLocalCollectorScheduler() {
  if (globalThis.controlCenterCollectorTimer || globalThis.controlCenterCollectorStartupTimer) return;
  globalThis.controlCenterCollectorStartupTimer = setTimeout(() => {
    globalThis.controlCenterCollectorStartupTimer = undefined;
    void refreshAllCollectors();
    globalThis.controlCenterCollectorTimer = setInterval(() => void refreshAllCollectors(), COLLECTION_INTERVAL_MS);
    globalThis.controlCenterCollectorTimer.unref();
  }, STARTUP_DELAY_MS);
  globalThis.controlCenterCollectorStartupTimer.unref();
}
