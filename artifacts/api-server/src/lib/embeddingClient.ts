import OpenAI from "openai";

// The Replit OpenAI proxy (AI_INTEGRATIONS_OPENAI_BASE_URL) does NOT support
// the embeddings endpoint. We need a direct OpenAI client using a real key.
// When OPENAI_API_KEY is absent the RAG system degrades gracefully to full-text
// search only (BM25 via tsvector GIN) — no vector component.

let _embeddingClient: OpenAI | null = null;

export function getEmbeddingClient(): OpenAI | null {
  if (_embeddingClient) return _embeddingClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  _embeddingClient = new OpenAI({ apiKey });
  return _embeddingClient;
}

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export async function generateEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
  const client = getEmbeddingClient();
  if (!client || texts.length === 0) return texts.map(() => null);

  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  return res.data.map((d: { embedding: number[] }) => d.embedding);
}

export async function generateQueryEmbedding(text: string): Promise<number[] | null> {
  const client = getEmbeddingClient();
  if (!client) return null;

  const res = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  return res.data[0]?.embedding ?? null;
}

export function embeddingsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}
