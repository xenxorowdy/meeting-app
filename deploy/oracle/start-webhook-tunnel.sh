#!/usr/bin/env bash
set -euo pipefail

key_path="${1:-/Users/riyamjain/Downloads/ssh-key-2026-09-23.key}"

# Keep this terminal open while testing Razorpay webhooks. The local Kesami
# backend must also be running on 127.0.0.1:48900.
exec ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=20 \
  -o ServerAliveCountMax=3 \
  -i "$key_path" \
  -R 127.0.0.1:48900:127.0.0.1:48900 \
  ubuntu@144.24.109.107
