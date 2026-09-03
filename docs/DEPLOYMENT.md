# Deploying The Wire

Target: a headless **Ubuntu machine** — a mini PC on your own LAN, or a remote
VPS — running the app in Docker and reached from a workstation over an SSH
tunnel. A bare-metal systemd alternative is in the
[appendix](#appendix-running-without-docker).

---

## What changed from the pre-fork plan

If you are adapting a Dockerfile written before this fork existed, it almost
certainly patched the upstream source at build time with `sed`. **Delete all of
those lines.** They are no longer merely redundant — they will break the build:

| Old build-time patch | Status now |
| --- | --- |
| `grep -q "15 * 60 * 1000" lib/server/scheduler.ts` | **Fails the build.** That string no longer exists; the interval is already 4 hours. |
| `sed -i 's/15 * 60 * 1000/4 * 60 * 60 * 1000/'` | Redundant. Already committed to the fork. |
| `sed -i '/{ id: "audience" ... }/d'` | **Remove this.** It deleted the Audience tab, which is now where the staggered refresh and manual entry live. Keeping it hides every feature this fork adds. |

The fork ships the fix in its source, so the image builds from clean, unpatched
code. `Dockerfile`, `.dockerignore`, and `compose.yaml` are tracked in this
repository — you do not need to write them on the server.

---

## 1. Requirements

On the server:

- Docker Engine and the Compose plugin (Dockge optional, it just wraps them)
- Git
- Roughly 2 GB free disk for the image and build cache

Nothing else. Node is inside the image; you do not install it on the host.

## 2. Get the source

```bash
cd /opt/stacks
git clone https://github.com/yoa-cl/the-wire.git
cd the-wire
mkdir -p data
```

`data/` is where everything durable lives — settings, OAuth tokens, API keys,
the SQLite database, and audience history. It is bind-mounted into the
container and git-ignored. It is also the only directory you need to back up.

## 3. Build and start

```bash
docker compose up -d --build
```

Using Dockge instead: create a stack pointing at `/opt/stacks/the-wire` and
paste the contents of `compose.yaml`. The first build takes a few minutes,
mostly `npm ci`; later rebuilds are much faster because dependencies are cached
in their own layer.

Check it came up:

```bash
docker compose ps
docker compose logs -f
```

You want `healthy` in the status column. The health check polls
`/api/health` every 60 seconds after a 40-second grace period.

## 4. Reach it from your workstation

**The app is deliberately unreachable over the network.** Two independent locks
enforce this, and you need to understand both before changing anything:

1. `compose.yaml` publishes the port as `127.0.0.1:3000:3000`, so the server
   only accepts connections from itself.
2. `proxy.ts` rejects any request whose `Host` header is not loopback, returning
   `403 Control Center only accepts requests from this computer.` on every
   `/api/*` route.

This is intentional. The app has no login screen and holds your API keys and
Gmail OAuth tokens in plaintext on disk. Exposing it is exposing those.

Open a tunnel from your workstation:

```bash
ssh -L 3000:127.0.0.1:3000 youruser@your-server
```

Leave that session open and browse to **http://127.0.0.1:3000**.

Traffic travels inside SSH, and the app sees a genuine loopback request, so both
locks are satisfied with no code changes. Use `127.0.0.1`, not `localhost` — on
some systems `localhost` resolves to IPv6 `::1` first and the tunnel will not
answer.

> **Do not** put this behind Nginx or Caddy to "make it easier to reach" unless
> you add real authentication in front of it. Removing the loopback binding
> without adding auth publishes your credentials to anyone who finds the port.

## 5. First-run configuration

Everything starts empty. In **Settings**:

1. **Industry** — homepages, RSS/Atom feeds, topic phrases.
2. **Mentions** — names, brands, handles, owned domains, identity anchors, and
   known false-positive contexts.
3. **Audience** — public profile URLs for the platforms you track.
4. **AI curation** (optional) — a cloud provider key, or a local model.
5. **Newsletters** (optional) — Gmail OAuth client, read-only.

## 6. Audience collection on a server — read this

This fork made audience collection manual and paced. Two consequences are
specific to running on a server:

**Nothing refreshes on its own while nobody is watching.** Background collection
of Industry, Mentions and Newsletters runs every 4 hours inside the container.
Audience does not — it was removed from that loop, because scraping every
profile at once is what triggers bans. The Audience tab refreshes only when you
press **Refresh all**, refresh a single account, or enter a number by hand. On a
headless server you will rarely have a browser tab open, so treat audience as
fully on-demand.

**Where the machine sits changes your odds.** Instagram, TikTok and LinkedIn
block datacenter and VPS address ranges aggressively, sometimes on the first
request. A machine on a home or office connection shares that network's ordinary
residential IP and is treated far more leniently — so a mini PC on your own LAN
is the better place to run this, and most platforms should respond normally.

The trade-off is that scraping now comes from the same address as everything
else on that network. If a platform does rate-limit or block the IP, it affects
normal browsing from every device behind it, not just this app. That is the
main reason the pacing exists and why nothing collects automatically.

Test this early: open the Audience tab and press **Refresh all**. It visits each
account once, ten seconds apart, so seven accounts takes about a minute and a
half. Any account that fails keeps its previous value, labelled *last known*,
and the sweep continues.

For platforms your server cannot reach, use the manual entry on each account
card. It accepts shorthand (`10.5k`, `1,500`), shows the change against the last
reading before you commit, warns on suspicious jumps, and takes an optional
note. One entry per account per calendar day; saving again offers to replace it.

## 7. Updating

```bash
cd /opt/stacks/the-wire
git pull
docker compose up -d --build
```

`--build` is required. Without it Docker reuses the old image and your pull does
nothing. Your `data/` directory is untouched by rebuilds.

To pull in changes from the upstream project this fork is based on:

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should be rare — see the README's *Pulling in upstream changes*.

## 8. Backups

Everything that matters is in `data/`. Stop the container first so SQLite is not
mid-write:

```bash
cd /opt/stacks/the-wire
docker compose stop
tar czf ~/the-wire-backup-$(date +%F).tar.gz data
docker compose start
```

**That archive contains OAuth tokens and API keys in plaintext.** Store it
somewhere you would be comfortable storing a password file.

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `403 only accepts requests from this computer` | You reached it by server IP or hostname instead of through the tunnel. Use the SSH tunnel and browse to `127.0.0.1:3000`. |
| Browser cannot connect at all | Tunnel not open, or you used `localhost` and it resolved to IPv6. Use `127.0.0.1`. |
| Container restarts repeatedly | `docker compose logs` will say why. Most often a corrupt `data/` file — run the doctor script inside the container. |
| Audience accounts all show *Waiting* | Expected before the first refresh. Press **Refresh all**. |
| One account always fails | That platform is blocking the machine's IP, or does not expose the count to signed-out visitors. Use manual entry for it. |
| Build fails on `npm ci` | Usually a stale lockfile after a merge. `git status package-lock.json` should be clean. |
| Code changes not taking effect | You rebuilt without `--build`. |
| Files in `data/` owned by root | The container runs as root. Harmless, but use `sudo` when moving them on the host. |

Inspect a running container:

```bash
docker compose exec the-wire sh
```

---

## Appendix: running without Docker

If you would rather run it directly on the host, systemd is the supervisor
Ubuntu already uses to start programs at boot and restart them when they crash.

Install Node 24 from NodeSource — Ubuntu's packaged Node is far too old, and the
app requires the built-in `node:sqlite` module:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
```

Build and confirm it runs by hand before automating it:

```bash
cd ~/the-wire && npm ci && npm run build && npm run start
```

`Ctrl+C` once it starts cleanly, then create `/etc/systemd/system/the-wire.service`:

```ini
[Unit]
Description=The Wire dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/the-wire
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` is the point of the exercise: a crash at 3am recovers by
itself. `User=` matters because settings are stored under that user's home
directory — running as root looks for them in the wrong place and appears to
have lost your configuration.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now the-wire
systemctl status the-wire
journalctl -u the-wire -f
```

`npm run start` binds to `127.0.0.1` already, so the SSH tunnel in step 4 works
unchanged.

After every `git pull`, rebuild before restarting or you keep running old code:

```bash
cd ~/the-wire && npm ci && npm run build && sudo systemctl restart the-wire
```

The build is deliberately not in the service file: building on every restart is
slow, and a failed build would leave the dashboard refusing to start.
