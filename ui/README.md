# ui/ — operator dashboard

A loopback web dashboard over the host gateway. **Not part of the reconstruction**:
nothing here claims to recover shipped Grok Bot behavior, and it does not touch
`frontend/`, which remains the Electron renderer's tree.

    node ui/server.mjs        # http://127.0.0.1:7777

`server.mjs` exists because `source/host/gateway-server.ts:23` refuses any request
carrying an `Origin` header, so a browser can never call the gateway directly. This
process relays without one and holds the bearer token, which the browser never sees.

It reads that token from the local-docker connector's credential file
(`<profile>/sand-data/local-docker-vm.json`). Point it elsewhere with
`SAND_PROFILE_DIRS`, or override with `SAND_HOST_GATEWAY_TOKEN` /
`SAND_HOST_GATEWAY_URL` / `SAND_UI_PORT`.

Loopback only. The token is in this process; do not bind it off-box.

## The box is shared

The desktop app connects to this same gateway. Whatever you create, prompt, or delete
here lands in its roster too — one host, one set of agents. `GET /clients` resolves the
pids on the gateway port to real app names (lsof truncates COMMAND to 9 chars, so
`First Mate.app` shows up as `Grok B`; the endpoint asks `ps` instead), and the page
shows a Shared box card whenever something else is attached.
