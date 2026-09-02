---
name: Sofia human handoff mechanism
description: Where the Sofia-to-human escalation lives and how to reuse it from other conduct/decision logic.
---

## Where it lives
- `artifacts/api-server/src/services/handoff.ts` — `detectPreTrigger(userMessage)` (checked before calling the AI), `detectPostTrigger(fullResponse, priorAssistantMessages)` (checked after the AI replies), `buildHandoffSummary(...)`, `handoffTransitionMessage(reason)`, `HANDOFF_ALREADY_ACTIVE_MESSAGE`.
- `conversations` table (`lib/db/src/schema/conversations.ts`) has `status` (`ativa` / `aguardando_humano` / `atendimento_humano`), `handoffReason`, `handoffSummary` (JSON string), `handoffTriggeredAt`, `handoffResolvedAt`, `handoffResolvedBy`.
- `/sofia/chat` in `artifacts/api-server/src/routes/sofia.ts` short-circuits entirely (skips the AI call, replies with `HANDOFF_ALREADY_ACTIVE_MESSAGE`) whenever the conversation's status isn't `ativa`.
- Staff-facing assume/resolve endpoints: `POST /sofia/conversations/:id/handoff/assume` and `.../handoff/resolve`.

## How to apply
Any new Sofia conduct/escalation logic (e.g. commercial-mode ambiguity, eligibility gaps) should call into this existing mechanism (reuse `detectPreTrigger`/`detectPostTrigger`-style checks feeding into the same `conversations.status` update path) rather than building a second escalation/status system. Add new `HandoffReason` values to the existing enum instead of inventing a parallel one.
