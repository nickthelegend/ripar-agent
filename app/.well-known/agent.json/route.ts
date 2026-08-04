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
const REGISTRIES = { identityApp: 768547159, reputationApp: 768559198, validationApp: 768547172 };

/** This agent's id in the IdentityRegistry, minted by new_agent in
 *  36UXKE5JK75BY2QRE46XKKIZQCVLNNZYTKLZ5G74ORRLWSZCXSYA. The contract takes the
 *  owner from Txn.sender, so the address that registered is the address paid
 *  below — which is the whole point: resolve the domain, get this id, read its
 *  reputation, and only then decide to pay. */
const AGENT_ID = 2;

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
        streaming: false,
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
              package: "ripar-skills",
              transport: "stdio",
              command: "npx",
              args: ["-y", "ripar-skills", "mcp"],
              tools: [
                "ripar_search_agents",
                "ripar_get_agent",
                "ripar_get_reputation",
                "ripar_quote_call",
                "ripar_compose_job",
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
