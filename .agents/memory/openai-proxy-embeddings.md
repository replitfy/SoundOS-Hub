---
name: Replit OpenAI proxy — embeddings not supported
description: The Replit-managed OpenAI integration proxy explicitly does not support the /embeddings endpoint; RAG/vector search needs a real OPENAI_API_KEY.
---

# Replit OpenAI proxy does NOT support embeddings

**Rule:** Never call `openai.embeddings.create()` on the client from `@workspace/integrations-openai-ai-server`. It will fail with `400 Endpoint: 'POST /embeddings' is not supported.`

**Why:** The Replit AI Integrations proxy routes chat completions only. The embeddings endpoint is explicitly listed as unsupported in the ai-integrations-openai skill.

**How to apply:** Create a separate `embeddingClient.ts` that instantiates `new OpenAI({ apiKey: process.env.OPENAI_API_KEY })` (pointing directly at OpenAI, not the Replit proxy). When `OPENAI_API_KEY` is absent, return null embeddings and fall back to BM25-only (full-text tsvector) search. This makes the RAG system functional without a key but upgrades to full hybrid RRF when a key is provided.

The pattern in this project lives at `artifacts/api-server/src/lib/embeddingClient.ts`.
