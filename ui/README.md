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
