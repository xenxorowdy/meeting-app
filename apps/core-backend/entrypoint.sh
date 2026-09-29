#!/bin/sh
# Fly mounts the volume root-owned, but the backend runs as the unprivileged
# `kesami` user. Take ownership of the data directory once per boot, then drop
# privileges for the server itself.
set -e

chown kesami:kesami /data
exec setpriv --reuid=kesami --regid=kesami --clear-groups \
    /usr/local/bin/kesami-core-backend
