import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fetch } from "undici";
import { z } from "zod";
import { Tool } from "../types.js";

const inputSchema = z.object({ url: z.string().url() });
const maxResponseBytes = 5_000_000;
const requestTimeoutMs = 30_000;

export const webFetchTool: Tool = {
  name: "WebFetch",
  description: "Fetch text content from a URL",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  async execute(input) {
    const parsed = inputSchema.parse(input);
    await assertPublicHttpUrl(parsed.url);
    const response = await fetch(parsed.url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) return { error: `HTTP ${response.status}`, exit_code: 1 };
    return { output: await readCapped(response.body as ByteStream | null), exit_code: 0 };
  }
};

// The model chooses this URL, so without these checks WebFetch is an SSRF primitive: it would
// happily read a cloud metadata endpoint or an admin port bound to localhost.
async function assertPublicHttpUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WebFetch supports only http and https, got ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) throw new Error(`WebFetch refuses to reach the private address ${blocked}`);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === "::" || value === "::1" || /^f[cd]/.test(value) || value.startsWith("fe80")
      || value.startsWith("::ffff:") && isPrivateAddress(value.slice("::ffff:".length));
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return true;
  const [first, second] = octets as [number, number, number, number];
  return first === 0 || first === 10 || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127)
    || first >= 224;
}

type ByteStream = { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(reason?: unknown): Promise<unknown> } };

async function readCapped(body: ByteStream | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      received += value.byteLength;
      if (received > maxResponseBytes) {
        text += decoder.decode();
        return `${text}\n... truncated at ${maxResponseBytes} bytes`;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await Promise.resolve(reader.cancel?.()).catch(() => undefined);
  }
}
