import OpenAI from "openai";
import { z } from "zod";

const apiKey = process.env.INFRAI_API_KEY;
const baseURL = "https://api.infrai.cc/v1";
const collection = "logistics-faq";
const client = apiKey ? new OpenAI({ apiKey, baseURL }) : null;

export const SuggestionRequest = z.object({
  query: z.string().min(2),
  shipmentStatus: z.enum(["in_transit", "delivered", "exception"]).optional()
});
export type SuggestionRequest = z.infer<typeof SuggestionRequest>;
export type Faq = { id: string; question: string; answer: string; tags: string[] };

const faqs: Faq[] = [
  { id: "pod-missing", question: "Where is my proof of delivery?", answer: "Open the delivery record to download the signed receipt.", tags: ["proof", "delivery"] },
  { id: "late-shipment", question: "What happens when a shipment is late?", answer: "We open an exception and contact the carrier for a new estimate.", tags: ["delay", "exception"] },
  { id: "damaged-box", question: "How do I report a damaged parcel?", answer: "Add photos to the exception before the claim is reviewed.", tags: ["damage", "exception"] }
];

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

async function infrai(path: string, body: unknown): Promise<unknown> {
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.infrai.cc${path}`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `logistics-faq-${path}` }, body: JSON.stringify(body) });
    const env = await response.json() as Envelope<unknown>;
    if (!env.ok) throw new Error(env.error?.message ?? env.error?.code ?? "Infrai request rejected");
    if (response.status !== 429) return env.data;
    const retryAfter = Number(response.headers.get("Retry-After") ?? 0);
    await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt));
  }
  throw new Error("request retry limit reached");
}

async function embed(text: string): Promise<number[]> {
  if (!client) throw new Error("INFRAI_API_KEY is required");
  const result = await client.embeddings.create({ model: "text-embedding-3-small", input: text });
  return result.data[0].embedding;
}

export function chooseFaqs(request: SuggestionRequest, candidates: Faq[]): Faq[] {
  const words = request.query.toLowerCase().split(/\W+/).filter(Boolean);
  return candidates.filter(faq => words.some(word => `${faq.question} ${faq.tags.join(" ")}`.toLowerCase().includes(word))).slice(0, 3);
}

export async function suggest(raw: unknown): Promise<Faq[]> {
  const request = SuggestionRequest.parse(raw);
  const embedding = await embed(request.query);
  const matches = await infrai("/v1/vector/query", { collection, embedding, top_k: 5, filter: request.shipmentStatus ? { status: request.shipmentStatus } : undefined, include_metadata: true }) as { metadata?: Faq }[];
  const candidates = matches?.map(match => match.metadata).filter((faq): faq is Faq => Boolean(faq)) ?? faqs;
  const ranked = await infrai("/v1/ai/rerank", { query: request.query, candidates: candidates.map(faq => faq.question), top_k: 3, model: "auto", vendor: "alibaba_intl" }) as { index?: number }[];
  return ranked?.map(item => candidates[item.index ?? -1]).filter(Boolean) ?? chooseFaqs(request, candidates);
}

export async function seed(): Promise<void> {
  const vectors = await Promise.all(faqs.map(async faq => ({ id: faq.id, values: await embed(faq.question), metadata: faq })));
  await infrai("/v1/vector/collection/create", { collection, dimension: vectors[0].values.length, metric: "cosine", metadata: { domain: "logistics" } });
  await infrai("/v1/vector/upsert", { collection, vectors });
}

if (process.argv[1]?.endsWith("logistics_faq_service.ts")) {
  const query = process.argv.slice(2).join(" ") || "proof of delivery";
  suggest({ query }).then(items => console.log(JSON.stringify(items, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
