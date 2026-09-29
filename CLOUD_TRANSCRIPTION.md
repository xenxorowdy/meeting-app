# Hosted transcription relay

The packaged desktop app keeps its meeting library and recordings on each Mac. Its
local Rust backend uses the user's renewable Supabase Google session to open a
WebSocket to the cloud relay. Only the relay receives the Sarvam API key. The
relay verifies each access token with Supabase Auth before opening a provider
socket. It does not save audio or meeting data.

This service is separate from the existing hosted core backend. Do not point
multiple customers at the hosted core backend: its meeting library and active
session are shared across accounts.

## Server setup

The public address must be an HTTPS origin with a certificate trusted by macOS.
For an initial deployment without a purchased domain, a fixed-IP `sslip.io`
name can point to the existing Oracle VM. Replace it with a domain you control
before a broad release. Keep the relay on the VM's loopback interface; allow
public traffic only through Caddy on port 443.

Build the small Node image with `apps/core-backend/Dockerfile.cloud` from the
repository root. On Apple Silicon, build for `linux/amd64` locally or in CI,
then load the image on the VM; do not build the large Rust/ONNX image on the VM.
For the existing Oracle VM, the initial DNS name can be
`api.144-24-109-107.sslip.io` if that public IP remains assigned. Confirm the
VM's address before packaging, since the hostname is embedded in the DMG.

```bash
docker buildx build --platform linux/amd64 --load -f apps/core-backend/Dockerfile.cloud -t kesami-cloud-relay:1 .
docker save kesami-cloud-relay:1 | ssh ubuntu@144.24.109.107 docker load
```

Run the relay with a private, owner-readable environment file containing:

```text
KESAMI_SUPABASE_URL=https://<your-project>.supabase.co
KESAMI_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
KESAMI_SARVAM_API_KEY=<private-key>
```

Bind the Docker port to `127.0.0.1:48901:48901` on the VM. Configure Caddy to
reverse proxy the chosen HTTPS hostname to `127.0.0.1:48901`. Keep the existing
core backend on private port 48900. Confirm `/health` answers over HTTPS and
that the relay rejects an unauthenticated WebSocket before distributing a DMG.

```text
api.144-24-109-107.sslip.io {
    reverse_proxy 127.0.0.1:48901
}
```

The relay can be started separately from the existing backend with a private
`/home/ubuntu/cloud.env` and a host-only port mapping:

```bash
docker run -d --name kesami-cloud-relay --restart unless-stopped \
  --env-file /home/ubuntu/cloud.env \
  -p 127.0.0.1:48901:48901 kesami-cloud-relay:1
```

## Desktop package

Set `KESAMI_CLOUD_URL=https://<chosen-hostname>` in the ignored `apps/ui/.env`
or in the packaging command's environment. `prepareAuthConfig.js` validates it
and bundles only the public URL plus public Supabase auth values. Never bundle
the Sarvam key, a Supabase secret key, or a workspace token. A build without a
cloud URL still supports explicitly configured local provider keys; it is not
a zero-setup client build.

The hosted relay currently covers Sarvam realtime only. Batch transcription,
Gemini-backed summaries and chat, connector OAuth, and one-click MCP setup
still require separate implementation before the full zero-setup plan is ready.
The relay's daily audio allowance is currently held in memory and resets if the
service restarts; move it to durable storage before opening this beta broadly.
