# Deploying The Wire

Target: a headless **Ubuntu machine** — a mini PC on your own LAN, or a remote
VPS — running the app in Docker, managed with [Dockge](https://dockge.kuma.pet/)
if you use it, and reached from a workstation over an SSH tunnel. A bare-metal
systemd alternative is in the [appendix](#appendix-running-without-docker).

Every step below says what you should see when it works, so you can follow along
rather than guess whether something went wrong.

---

## What changed from the pre-fork plan

If you are adapting a Dockerfile written before this fork existed, it almost
certainly patched the upstream source at build time with `sed`. **Delete all of
those lines.** They are no longer merely redundant — they will break the build:

| Old build-time patch | Status now |
| --- | --- |
| `grep -q "15 * 60 * 1000" lib/server/scheduler.ts` | **Fails the build.** That string no longer exists; the interval is already 4 hours. |
| `sed -i 's/15 * 60 * 1000/4 * 60 * 60 * 1000/'` | Redundant. Already committed to this fork. |
| `sed -i '/{ id: "audience" ... }/d'` | **Remove this.** It deleted the Audience tab, which is now where the staggered refresh and manual entry live. Keeping it hides every feature this fork adds. |

Two more steps from that plan are gone entirely:

- **You no longer create the Dockerfile by hand.** `Dockerfile`, `.dockerignore`
  and `compose.yaml` are committed to this repository.
- **You no longer "Add Stack" in Dockge.** Dockge discovers the cloned directory
  by itself. See [step 4](#4-let-dockge-adopt-the-stack).

---

## 0. Requirements

On the server:

- Docker Engine and the Compose plugin
- Git
- About 2 GB free disk for the image and build cache

Nothing else. Node 24 lives inside the image, so there is nothing to install on
the host and nothing that can conflict with your other stacks.

On your workstation: an SSH client. Windows 10/11 has one built in.

---

## 1. Get the source

```bash
cd /opt/stacks
git clone https://github.com/yoa-cl/the-wire.git
cd the-wire
```

Docker creates the `data/` bind mount on first start, so there is nothing to
create by hand. It holds everything durable — settings, OAuth tokens, API keys,
the SQLite database, and audience history. It is git-ignored, and it is the only
directory you need to back up. Its contents are written by the container as
root, so back it up with `sudo`.

**You should see:** a `the-wire` directory alongside `dockge`, `ollama` and
`open-webui`, containing `Dockerfile` and `compose.yaml`.

---

## 2. Build the image

```bash
docker compose build
```

Run this on its own rather than as `up --build`. The build log is where failures
explain themselves, and `up` truncates it.

**You should see:** several minutes of output, most of it `npm ci`, ending with
a line naming the built image. Later rebuilds are much faster because
dependencies sit in their own cached layer.

**If it fails:** the useful error is usually a few lines above where it stopped.
Keep the whole output.

---

## 3. Start it

```bash
docker compose up -d
```

**You should see:** a container named `the-wire` created and started. Then:

```bash
docker compose ps
```

Status goes from `starting` to **`healthy`** within about a minute — the health
check has a 40-second grace period before its first probe.

Watch the logs if you want to see it boot:

```bash
docker compose logs -f
```

`Ctrl+C` stops watching; it does not stop the container.

---

## 4. Let Dockge adopt the stack

**Do not use Dockge's "Add Stack" button.** That flow creates the stack
directory itself and will fail with *directory already exists*, because `git
clone` already made it.

Instead, refresh Dockge. It scans `/opt/stacks` and lists any directory
containing a compose file, which is how your other stacks appear.

**You should see:** `the-wire` in the stack list, showing as active if you
completed step 3.

**If it does not appear:** refresh again — Dockge does not always notice new
directories immediately. Then confirm Dockge's stacks path is `/opt/stacks`, and
that your version reads `compose.yaml` rather than only `docker-compose.yml`; if
it wants the latter, a symlink solves it.

Dockge is a web UI over `docker compose`. If it will not cooperate, nothing here
depends on it — every command in this document works from the CLI.

---

## 5. Reach it from your workstation

**The app is deliberately unreachable over the network.** Two independent locks
enforce this, and you need to understand both before changing anything:

1. `compose.yaml` publishes the port as `127.0.0.1:3000:3000`, so the server
   only accepts connections from itself.
2. `proxy.ts` rejects any request whose `Host` header is not loopback, returning
   `403 Control Center only accepts requests from this computer.` on every
   `/api/*` route.

The second lock is the important one: it means a LAN IP, a hostname, Tailscale,
or a plain reverse proxy all fail the same way — the page shell loads and every
API call returns 403. This is intentional. The app has no login screen and holds
your API keys and Gmail OAuth tokens in plaintext on disk.

### Set up an SSH alias once

On your workstation, add a dedicated entry to `~/.ssh/config`
(`C:\Users\<you>\.ssh\config` on Windows) beside your normal one:

```
Host myserver
    HostName 192.168.1.100
    User youruser
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

Host wire
    HostName 192.168.1.100
    User youruser
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    LocalForward 3000 127.0.0.1:3000
```

A separate `wire` alias keeps the forward off your everyday shell. Putting
`LocalForward` on the entry you use for everything means a second concurrent
session prints `bind: Address already in use`.

### Open the tunnel

```bash
ssh wire
```

Leave that session open and browse to **http://127.0.0.1:3000**.

Traffic travels inside SSH and the app sees a genuine loopback request, so both
locks are satisfied with no code changes.

- Use `127.0.0.1`, not `localhost` — on some systems `localhost` resolves to
  IPv6 `::1` first and the tunnel will not answer.
- For a tunnel with no shell attached: `ssh -f -N wire`. It backgrounds itself.
- If port 3000 is busy on your workstation, change only the left number:
  `LocalForward 3001 127.0.0.1:3000`, then browse to `127.0.0.1:3001`. The host
  check only cares that the hostname is loopback, not the port.

> **Do not** put this behind Nginx or Caddy to make it easier to reach unless you
> add real authentication in front of it. Removing the loopback restriction
> without adding auth publishes your credentials to anything on your network.

---

## 6. First-run configuration

Everything starts empty. There are no demo records. In **Settings**:

1. **Industry** — homepages, RSS/Atom feeds, topic phrases.
2. **Mentions** — names, brands, handles, owned domains, identity anchors, and
   known false-positive contexts.
3. **Audience** — public profile URLs for the platforms you track.
4. **AI curation** (optional) — a cloud provider key, or a local model. If you
   already run Ollama, point it at that.
5. **Newsletters** (optional) — Gmail OAuth client, read-only.

---

## 7. What to expect from Audience

This fork made audience collection manual and paced. Two consequences are
specific to running on a server.

**Nothing refreshes on its own while nobody is watching.** Industry, Mentions and
Newsletters collect every 4 hours inside the container. Audience does not — it
was removed from that loop, because scraping every profile at once is what
triggers bans. It updates only when a browser is open and you press **Refresh
all**, refresh a single account, or type a number in. On a headless server you
will rarely have a tab open, so treat audience as fully on demand.

**Every account shows *Waiting* until your first refresh.** That is the
decoupling working, not a failure. Press **Refresh all**: it visits each account
once, ten seconds apart, so seven accounts takes about a minute and a half. Any
account that fails keeps its previous value labelled *last known*, and the sweep
continues to the next.

**Where the machine sits changes your odds.** Instagram, TikTok and LinkedIn
block datacenter and VPS address ranges aggressively, sometimes on the first
request. A machine on a home or office connection shares that network's ordinary
residential IP and is treated far more leniently — so a mini PC on your own LAN
is the better place to run this, and most platforms should respond normally.

The trade-off is that scraping comes from the same address as everything else on
that network. If a platform does rate-limit the IP, it affects normal browsing
from every device behind it. That is why the pacing exists and why nothing
collects automatically.

For platforms your machine cannot reach, use the manual entry on each account
card. It accepts shorthand (`10.5k`, `1,500`), shows the change against the last
reading before you commit, warns on suspicious jumps, and takes an optional
note. One entry per account per calendar day; saving again offers to replace it.

---

## 8. Updating

```bash
cd /opt/stacks/the-wire
git pull
docker compose up -d --build
```

**`--build` is not optional.** Without it Docker reuses the existing image and
your `git pull` changes nothing — with no error to tell you.

> **Dockge users:** the Start and Restart buttons run `docker compose up -d`
> *without* `--build`. After a `git pull` they will silently keep running the old
> image. Use Dockge's built-in terminal for that stack, or SSH in, and run the
> command above. This is the single most likely thing to waste an hour.

If you edit `compose.yaml` through Dockge's editor, you are editing a git-tracked
file and the next `git pull` will conflict. Either commit your edit, or
`git stash` → `git pull` → `git stash pop`.

To pull in changes from the upstream project this fork is based on:

```bash
git fetch upstream
git merge upstream/main
```

Conflicts should be rare — see *Pulling in upstream changes* in the README.

---

## 9. Backups

Everything that matters is in `data/`. Stop the container first so SQLite is not
caught mid-write:

```bash
cd /opt/stacks/the-wire
docker compose stop
sudo tar czf ~/the-wire-backup-$(date +%F).tar.gz data
docker compose start
```

**That archive contains OAuth tokens and API keys in plaintext.** Store it
somewhere you would be comfortable storing a password file.

---

## 10. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Dockge: *directory already exists* | You used **Add Stack**. Don't — Dockge adopts the cloned directory by itself. See step 4. |
| `403 only accepts requests from this computer` | You reached it by server IP or hostname instead of through the tunnel. Use `127.0.0.1:3000`. |
| Page loads but everything is empty or erroring | Same cause as above: the page is static, the API calls are being rejected. |
| Browser cannot connect at all | Tunnel not open, or you used `localhost` and it resolved to IPv6. Use `127.0.0.1`. |
| `bind: Address already in use` on SSH | A tunnel is already open, or port 3000 is taken on your workstation. Forward a different local port. |
| Code changes had no effect | You restarted without `--build`. See step 8. |
| Container restarts repeatedly | `docker compose logs` says why. Most often a corrupt file in `data/`. |
| All audience accounts show *Waiting* | Expected before the first refresh. Press **Refresh all**. |
| One account always fails | That platform is blocking the machine's IP, or does not expose the count to signed-out visitors. Use manual entry for it. |
| Build fails on `npm ci` | Usually a stale lockfile after a merge. `git status package-lock.json` should be clean. |
| Files in `data/` owned by root | The container runs as root. Harmless, but use `sudo` when moving them on the host. |

Open a shell inside the running container:

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
directory — running as root looks in the wrong place and appears to have lost
your configuration.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now the-wire
systemctl status the-wire
journalctl -u the-wire -f
```

`npm run start` binds to `127.0.0.1` already, so the SSH tunnel in step 5 works
unchanged.

After every `git pull`, rebuild before restarting or you keep running old code:

```bash
cd ~/the-wire && npm ci && npm run build && sudo systemctl restart the-wire
```

The build is deliberately not in the service file: building on every restart is
slow, and a failed build would leave the dashboard refusing to start.
