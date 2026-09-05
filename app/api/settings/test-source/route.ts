import { randomUUID } from "node:crypto";
import { readSource } from "@/lib/server/rss";

export const runtime = "nodejs";
// A single source probes its homepage, up to fourteen feed candidates, robots.txt
// and sitemap locations, so it can legitimately take a while on a slow site.
export const maxDuration = 120;

/**
 * The Wire: check one source before saving it.
 *
 * A misconfigured source is expensive — it re-probes every candidate endpoint on
 * every collection and every restart, forever, and the only feedback is a line
 * in an error box hours later. This answers the same question immediately, for
 * one URL, without touching saved settings or stored snapshots.
 *
 * `readSource` fetches through the same guarded path as collection, which
 * refuses private and loopback addresses, so an arbitrary URL cannot be used to
 * probe the machine's own network.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad body");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a JSON object containing a url." }, { status: 400 });
  }

  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw) return Response.json({ error: "Enter a URL to test." }, { status: 400 });
  if (raw.length > 2_000) return Response.json({ error: "That URL is too long." }, { status: 400 });

  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return Response.json({ error: "That is not a valid URL. Try https://example.com." }, { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return Response.json(
      { error: "Only public HTTP or HTTPS URLs without embedded credentials can be tested." },
      { status: 400 },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  try {
    // No previous snapshot is passed, so nothing on disk is read or written and
    // a sitemap source reports its baseline rather than a diff.
    const result = await readSource({ id: randomUUID(), name, url: url.toString() });
    return Response.json({
      ok: true,
      url: url.toString(),
      mode: result.status.mode,
      endpoint: result.status.endpoint,
      itemCount: result.items.length,
      message: result.status.message,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      url: url.toString(),
      error: error instanceof Error ? error.message : "The source could not be read.",
    });
  }
}
