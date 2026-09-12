# RGB Proxy

[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

An implementation of **rgb-http-json-rpc v0.2**. This one runs on Cloudflare Workers, with R2 for
the files and D1 for the metadata: no server to run, no container to keep alive.

An RGB transfer is peer to peer: the sender has to hand a consignment file to the recipient, who
validates it locally. A proxy is the drop box in between. It stores and forwards, and that is all
it does — **no cryptography, no chain access, no validation**. Seven JSON-RPC methods over what is
essentially `recipient_id → {file, txid, ack}`.

| What | Where | Why |
|---|---|---|
| consignment files | R2 | content-addressed by sha256, no egress fees |
| txid / vout / ack | D1 | small rows, one per recipient id |
| JSON-RPC | Worker | always on, no cold storage to warm up |

This is interchangeable with the reference implementation
([rgb-proxy-server](https://github.com/RGB-Tools/rgb-proxy-server)) as far as a client can tell:
the error codes, the response shapes and the idempotency semantics are matched deliberately, down
to one upstream bug that clients may depend on (see below).

## Two differences from the reference implementation

**Consignments expire.** The reference implementation keeps them forever. A consignment carries a
complete transfer history, so holding every one indefinitely means holding sensitive data about
everyone who ever used the proxy. This one deletes anything past `CONSIGNMENT_TTL_DAYS` (30 by
default) on a daily cron. R2 is content-addressed, so an object is removed only once no other
recipient id still references it.

**It runs on someone else's infrastructure.** That is the point — there is nothing to operate —
but it means the operator of a deployment can see the files passing through. Run your own if that
matters to you; the whole thing is four source files.

## Running your own

```sh
npm install
npx wrangler r2 bucket create rgb-proxy-consignments
npx wrangler d1 create rgb-proxy              # put the database_id into wrangler.jsonc
npx wrangler d1 execute rgb-proxy --remote --file=schema.sql
npx wrangler deploy
```

Then point a wallet at it. In an RGB invoice the endpoint is written as
`rpc://your-proxy.example.com/json-rpc`.

🚨 **The domain goes into every invoice your users issue.** Changing it later invalidates every
invoice still outstanding, so pick one you intend to keep.

Locally:

```sh
npx wrangler d1 execute rgb-proxy --local --file=schema.sql
npx wrangler dev --port 8787 --local
```

## Layout

```
src/index.js     routing, CORS, multipart parsing, the TTL cron
src/methods.js   the seven methods
src/params.js    parameter validation
src/errors.js    error codes
schema.sql       the D1 tables
test/conformance.mjs   response-by-response comparison against the reference server
```

## Conformance

The tests compare this implementation against the reference server, case by case, error paths
included. It needs both running:

```sh
docker start rgb-proxy                  # the reference server on :3000
npx wrangler dev --port 8787 --local    # this one on :8787
node test/conformance.mjs
```

Passing that is necessary but not sufficient. **Other people's wallets talk to this over
rgb-lib**, so a real client is the test that counts: issue an invoice pointing at your deployment,
send an asset to it, and check that the recipient's wallet accepts the consignment.

## Five things worth knowing if you reimplement this

| # | |
|---|---|
| 1 | On a multipart upload, `params` arrives as a **JSON string**, not an object. Miss this and every `consignment.post` fails |
| 2 | On Workers, `Date.now()` returns **0 during module initialisation** (a timing side-channel defence). Take the start time lazily, or `server.info` reports an uptime of a whole epoch |
| 3 | A top-level `result` of `undefined` serialises to **`null`**, not an omitted field. `ack.get` before an ACK is the case that hits it — the only difference the conformance run ever found |
| 4 | Idempotency returns **`false`, not an error**: re-posting identical content, or repeating the same ACK, both return false |
| 5 | **`-303` is used twice** upstream, for `MissingFile` and `MissingTxid`. It is copied as is, because clients may branch on the code; only the message tells them apart |

## Not done

- Rate limiting. Anyone can upload a consignment to an open proxy
- A size cap per consignment, beyond the Worker's own request limit
- A follow-up procedure for when `protocol_version` moves past `0.2`

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
