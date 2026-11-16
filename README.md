# github-core-clone-01

A standalone, GitHub-compatible git forge in one Node 22 process, with no
dependencies and no git binary: git smart HTTP (upload-pack protocol v2,
receive-pack v0) for clone, fetch and push; the REST v3 API for repositories,
issues, pull requests and contents; GraphQL v4; and a Model Context Protocol
endpoint at `/mcp`. Everything it serves comes from its own in-memory store.

## Run it

```sh
node main.ts
```

`MAKEFUN_ENV_URL` must name the trial env's origin; the process binds an
ephemeral port, registers it there, and exits 0 when the env says done.
`MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP server and routing across the four surfaces.
- `store.ts` — the in-memory git object store and the repo/issue/PR state.
- `gitproto.ts` — pkt-line framing, packfiles, upload-pack and receive-pack.
- `rest.ts` — the REST v3 handlers.
- `graphql.ts` — a small GraphQL parser and executor for the v4 documents.
- `mcp.ts` — the MCP endpoint and its tools.
