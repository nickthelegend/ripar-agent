# ripar-agent

A working paid agent, deployed at **[api.ripar.io](https://api.ripar.io)**. It
exists so that every claim Ripar makes has something you can curl.

## Try it without installing anything

Ask for the work without paying, and it tells you the price:

```bash
curl -i -X POST https://api.ripar.io/api/summarize \
  -H 'content-type: application/json' \
  -d '{"text":"a long piece of text you want shortened"}'
```

You get **HTTP 402** and a `PAYMENT-REQUIRED` header. Decode it:

```bash
curl -sD- -o/dev/null -X POST https://api.ripar.io/api/summarize \
  -H 'content-type: application/json' -d '{"text":"hello"}' \
| grep -i '^payment-required:' | cut -d' ' -f2- | tr -d '\r' | base64 -d | jq
```

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [{
    "scheme": "exact",
    "network": "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    "amount": "10000",
    "asset": "10458941",
    "payTo": "NGVUO43AXJJ2RZGYUCUKWAYAZZA6YPO5HJ6PCM6VJ6CM7KUTRM75HO3OCU",
    "maxTimeoutSeconds": 300
  }]
}
```

`10000` base units of a six-decimal asset is **$0.01**. Attach `X-PAYMENT` with a
signed transfer and the same request returns the summary.

Or let the SDK do it: `ripar quote https://api.ripar.io/api/summarize` reads the
price for free, and `ripar call` pays and invokes.

## What it serves

| Route | What it is |
| --- | --- |
| `POST /api/summarize` | The paid endpoint. $0.01 in TestNet USDC per call |
| `GET /.well-known/ripar.json` | The agent manifest — name, payout address, endpoints and prices |
| `GET /.well-known/agent.json` | A2A agent card |
| `POST /a2a` | A2A JSON-RPC. A paid skill answers `-32010` with the x402 challenge attached |
| `GET /api/health` | Agent name, payout address, facilitator, network |

## Where the money goes

Straight to the payout address in the manifest. Ripar is never in the path and
never takes custody — the caller's wallet pays the agent's address directly, and
the transaction is the receipt. There is nothing to withdraw and no balance held
on your behalf.

**This agent has been paid 0 times.** It is a demo. The 402 is real, the price is
real, and the settlement path is the same one any agent uses — but nobody has
paid it yet, and it will say so here until someone does.

## Running your own

This is a Next.js app; the interesting part is small enough to read:

```bash
npm install && npm run dev
```

`RIPAR_PAY_TO` sets the payout address. Everything else — the 402, the header
encoding, the facilitator handshake — comes from `@ripar/sdk`'s `serve()`.

To build one from scratch instead, start from a template:
`ripar init my-agent --template basic`.

## Network

TestNet, settling in USDC `10458941`, via the
[GoPlausible](https://facilitator.goplausible.xyz) facilitator.
