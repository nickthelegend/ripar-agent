import { NextResponse } from "next/server";
import { FACILITATOR_URL, PAY_TO, resolveNetwork, NETWORK, USDC_ASSET } from "@/lib/x402";

/**
 * The A2A agent card.
 *
 * `/.well-known/ripar.json` is our own manifest and only a Ripar client knows
 * how to read it. This is the standard one: any A2A client can find this agent,
 * see what it does and learn what it costs without knowing Ripar exists.
 *
 * Three extensions carry what A2A itself has no field for:
 *
 *   x402      what each skill costs and how to pay for it
 *   registry  the on-chain identity, so a caller can check the domain matches
 *             and read reputation BEFORE paying rather than after
 *   mcp       which MCP server this agent exposes — the A2MCP hop, so a peer
 *             that finds this card is one step from actually invoking tools
 *
 * The shape is validated against ripar-skills' parseAgentCard in that repo's
 * tests, which is what keeps this route and the parser from drifting apart.
 */
export const dynamic = "force-dynamic";

const RIPAR_EXT = {
  x402: "https://ripar.io/a2a/ext/x402/v1",
  registry: "https://ripar.io/a2a/ext/registry/v1",
  mcp: "https://ripar.io/a2a/ext/mcp/v1",
} as const;

/** TestNet ERC-8004-shaped registries. Reputation is v2 — the one that reads
 *  the amount off the settling transfer instead of taking it as an argument. */
const REGISTRIES = { identityApp: 768572968, reputationApp: 768572969, validationApp: 768572979 };

/** This agent's id in the IdentityRegistry above.
 *
 *  new_agent takes the owner from Txn.sender, so the address that registered is
 *  the address `payTo` names below. That is the whole point of publishing it:
 *  resolve the domain, get this id, check the address matches the one you are
 *  being asked to pay, read its reputation — and only then decide.
 *
 *  A card is a file on a web server and anyone can write one. The registry
 *  entry is signed by the account that gets paid, so it is the half that
 *  cannot be forged. */
const AGENT_ID = 1;

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;

  let network: string | null = null;
  try {
    network = await resolveNetwork();
  } catch {
    /* the card is still useful without the resolved CAIP-2 id */
  }

  const asset = USDC_ASSET[NETWORK];

  return NextResponse.json(
    {
      name: "Ripar Text Tools",
      description: `Text utilities, payable per call over x402 on Algorand ${
        NETWORK === "testnet" ? "TestNet" : "MainNet"
      }.`,
      version: "0.1.0",

      // A2A 1.0 reads supportedInterfaces; 0.3 reads the flat fields below.
      // Publishing both means neither generation of client has to be told
      // which one it is looking at.
      supportedInterfaces: [
        { url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      url: `${origin}/a2a`,
      preferredTransport: "JSONRPC",
      protocolVersion: "1.0",

      provider: { organization: "Ripar", url: "https://ripar.io" },
      documentationUrl: "https://docs.ripar.io",

      capabilities: {
        // /a2a implements message/stream and answers it with a real
        // text/event-stream carrying the A2A lifecycle — an initial Task, a
        // working status, the artifact, and a final event. The work behind it
        // is synchronous, so the events are produced at once rather than spread
        // over time; what this flag claims is that the method exists and speaks
        // SSE, which it does. It stayed false until it did.
        streaming: true,
        pushNotifications: false,
        extensions: [
          {
            uri: RIPAR_EXT.x402,
            description:
              "Per-skill pricing settled over x402. Amounts are base units of `asset`; a caller pays " +
              "by signing the transfer named in the endpoint's 402 challenge.",
            required: false,
            params: {
              facilitator: FACILITATOR_URL,
              network,
              payTo: PAY_TO,
              asset: { id: asset, symbol: "USDC", decimals: 6 },
              // Base units of `asset`, keyed by skill id — 10000 is $0.01 at six
              // decimals. Quoted here so a caller can budget before it calls;
              // the 402 remains the authority on what is actually owed.
              prices: { summarize: "10000" },
            },
          },
          {
            uri: RIPAR_EXT.registry,
            description:
              "The on-chain identity behind this card. Resolve `agentId` in the IdentityRegistry to " +
              "check the domain matches, and read its reputation before paying.",
            required: false,
            params: { chain: `algorand:${NETWORK}`, agentId: AGENT_ID, ...REGISTRIES },
          },
          {
            uri: RIPAR_EXT.mcp,
            description:
              "The MCP server this agent exposes. A peer that discovers this card learns exactly " +
              "which server to connect to and which tools it will find there.",
            required: false,
            params: {
              transport: "stdio",
              // Not on npm yet, so the card points at the repo rather than a
              // package name that would 404. A `prepare` script builds the
              // checkout, which is what makes this command work today.
              command: "npx",
              args: ["-y", "github:nickthelegend/ripar-skills"],
              source: "https://github.com/nickthelegend/ripar-skills",
              // The ten tools the server actually registers. Verified by
              // speaking MCP to it over stdio, not copied from a design note.
              tools: [
                "ripar_search_agents",
                "ripar_get_agent",
                "ripar_get_reputation",
                "ripar_list_jobs",
                "ripar_settlements",
                "ripar_quote_endpoint",
                "ripar_call_endpoint",
                "ripar_post_job",
                "ripar_fund_job",
                "ripar_settle_escrow",
              ],
            },
          },
        ],
      },

      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["application/json", "text/plain"],

      skills: [
        {
          id: "summarize",
          name: "Summarise text",
          description: "Summarise any text payload into whole sentences.",
          tags: ["text", "summarisation"],
          examples: ["Summarise this article into three sentences."],
          inputModes: ["application/json"],
          outputModes: ["application/json"],
        },
      ],
    },
    {
      headers: {
        // A card is public discovery data. Caching it briefly at the edge keeps
        // a crawl from waking the function for every peer that looks.
        "cache-control": "public, max-age=60, s-maxage=300",
        "content-type": "application/json",
      },
    }
  );
}
