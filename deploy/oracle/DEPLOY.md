# Native Kesami backend on the existing Oracle VM

The existing `README.md` describes the temporary webhook tunnel. A full
backend deployment runs the Rust executable under systemd and proxies all API
and WebSocket traffic through Caddy. The desktop app still captures audio and
recordings locally.

## Prerequisites

The VM currently runs Ubuntu 20.04 with glibc 2.31, GCC 9, and Rust 1.75.
The locked backend dependencies require Rust 1.88 or newer, and the prebuilt
ONNX library requires a newer C++ runtime. Upgrade to a supported Ubuntu
release before building or running the native executable. The release upgrade
reboots the VM and temporarily interrupts the current webhook tunnel.

The VM has about 1 GB RAM. A 6 GB swap file was added for compilation and
configured in `/etc/fstab`; compilation will still be slow. Keep port 48900
closed in OCI ingress rules and the VM firewall. Caddy uses ports 80 and 443.

## Build and install

The source files in `apps/core-backend/` are copied to
`/home/ubuntu/kesami-deploy/apps/core-backend/` on the VM. Do not copy local
SQLite files, credentials, recordings, or `.env.local`.

After the OS upgrade, install a current Rust toolchain, `build-essential`, and
`ca-certificates`. Build from the copied source:

```sh
cd /home/ubuntu/kesami-deploy/apps/core-backend
CARGO_BUILD_JOBS=1 cargo build --release --locked
sudo install -m 0755 target/release/kesami-core-backend /usr/local/bin/kesami-core-backend
```

Create a dedicated `kesami` system user. Store the backend environment at
`/etc/kesami/backend.env` with mode `0600`, and its data under
`/srv/kesami/data`, owned by `kesami`. The environment needs:

```dotenv
KESAMI_DATA_DIR=/srv/kesami/data
CORE_BACKEND_HOST=0.0.0.0
CORE_BACKEND_PORT=48900
KESAMI_BACKEND_TOKEN=<random token of at least 32 characters>
KESAMI_ALLOW_NULL_ORIGIN=true
KESAMI_AUTH_PROVIDER=supabase
KESAMI_SUPABASE_URL=https://<project-ref>.supabase.co
KESAMI_SUPABASE_PUBLISHABLE_KEY=<publishable key>
KESAMI_SUPABASE_SYNC_USERS=true
```

Provider and webhook keys belong in the same root-owned file. Never copy it
into a public web build. A non-loopback bind activates the backend's hosted
security checks; the network firewall must still block direct access to 48900.

Install `kesami-backend.service` at `/etc/systemd/system/`, then run
`sudo systemctl daemon-reload` and `sudo systemctl enable --now kesami-backend`.
Check `systemctl status kesami-backend` and
`curl -fsS http://127.0.0.1:48900/health` on the VM before changing Caddy.

## Upgrading a server that already runs the Alpha backend

A VM set up before the rename runs `alpha-backend.service` as the `alpha` user,
with `/etc/alpha/backend.env` and data in `/srv/alpha/data`. The new binary
still reads every `ALPHA_*` variable when the `KESAMI_*` one is unset, and on
first start it renames `.alpha-meeting-assistant` to `.kesami` and
`Alpha Meetings` to `Kesami Meetings` inside its data directory, so the
existing environment file keeps working unchanged. To finish the move:

```sh
sudo systemctl disable --now alpha-backend
sudo install -m 0755 target/release/kesami-core-backend /usr/local/bin/kesami-core-backend
sudo useradd --system --no-create-home --shell /usr/sbin/nologin kesami
sudo mkdir -p /etc/kesami /srv/kesami
sudo mv /etc/alpha/backend.env /etc/kesami/backend.env
sudo mv /srv/alpha/data /srv/kesami/data
sudo sed -i 's#/srv/alpha/data#/srv/kesami/data#; s/^ALPHA_/KESAMI_/' /etc/kesami/backend.env
sudo chown -R kesami:kesami /srv/kesami/data
sudo install -m 0644 kesami-backend.service /etc/systemd/system/kesami-backend.service
sudo systemctl daemon-reload && sudo systemctl enable --now kesami-backend
```

Supabase needs no manual step: the first migration run renames the
`alpha_migrations` schema to `kesami_migrations`.

The existing site name is `144-24-109-107.sslip.io`. Replace the webhook-only
Caddy configuration with `Caddyfile.full` after the local health check passes;
the all-path proxy also forwards the Razorpay webhook. Validate Caddy and
reload it, then check `https://144-24-109-107.sslip.io/health` externally.

Connect the desktop client to that HTTPS URL and enter the workspace token
under **Settings → Connection**. Verify Google sign-in, live transcription,
saved meetings, summary generation, and persistence after a backend restart.
Back up `/srv/kesami/data`; the meeting library, accounts, and billing state
are still local to this single backend.
