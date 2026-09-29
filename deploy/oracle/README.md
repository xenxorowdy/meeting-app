# Oracle VM: Razorpay test webhook

This configuration targets the temporary Ubuntu 20.04 VM at `144.24.109.107`.
It is **not** a full hosted Kesami deployment. Caddy exposes only
`POST /api/billing/webhook/razorpay` and forwards it to the Docker backend
published on VM loopback `127.0.0.1:48900`. The container uses
`/home/ubuntu/backend.env` (owner-only, not committed) and the existing Docker
volume mounted at `/data`. `docker ps --filter name=core-backend` and
`curl http://127.0.0.1:48900/health` check the running service.

`start-webhook-tunnel.sh` is an older local-backend relay alternative. Do not
run it while the Docker backend owns VM port `48900`.

Webhook URL (Razorpay **Test Mode**):

`https://144-24-109-107.sslip.io/api/billing/webhook/razorpay`

In OCI, allow inbound TCP 80 and 443 in the instance's NSG or subnet security
list. The VM's iptables INPUT chain must also allow those ports before its
final REJECT rule. Keep port 48900 closed publicly. Caddy needs an externally
reachable HTTP or TLS challenge to issue a certificate. Verify HTTPS before
entering the URL in Razorpay. Set the webhook secret in the Razorpay dashboard
to the same value as `KESAMI_RAZORPAY_WEBHOOK_SECRET` in the VM env file; do not
commit or paste it into this directory.

The VM stores billing state in its Docker `/data` volume, separate from any
desktop backend database. The VM env currently contains only Razorpay test
settings and a backend access token; Google and Supabase credentials were not
copied. The current test Razorpay plan is INR 499/month while the app catalog
shows INR 800/month. Resolve that mismatch before running a checkout test.

Ubuntu 20.04 without extended security maintenance is suitable only for this
temporary test. Move to a supported OS image before production use.
