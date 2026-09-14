#!/bin/sh
# Fly mounts the volume root-owned, but the backend runs as the unprivileged
# `alpha` user. Take ownership of the data directory once per boot, then drop
# privileges for the server itself.
set -e

chown alpha:alpha /data
exec setpriv --reuid=alpha --regid=alpha --clear-groups \
    /usr/local/bin/alpha-core-backend
