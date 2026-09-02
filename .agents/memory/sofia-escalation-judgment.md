---
name: Sofia escalation triggers must be tool calls when they require judgment
description: When adding a new condition for Sofia to hand off to a human, decide whether it's keyword-detectable or judgment-based before picking regex vs. a model tool call.
---

Regex/keyword pre-triggers only work for conditions with predictable, literal phrasing (e.g. "quero falar com um atendente", "quanto custa"). Conditions that require judging the conversation as a whole — ambiguity, contradictory signals, insufficient eligibility for what the person is asking — cannot be reliably detected by pattern-matching a single message.

**Why:** An earlier attempt to regex-detect "ambiguity" and "eligibility" produced no reliable pattern; the model itself already has the full conversation context needed to judge these, so making it call a dedicated handoff tool (rather than trying to intercept its output) mirrors how it already decides when to answer vs. ask a clarifying question.

**How to apply:** When a new escalation/handoff condition is judgment-based, give the model a tool it can call to trigger the handoff (passing its own reasoning/summary as an argument), scoped to only when the condition is even possible (e.g. only offered in certain conversation modes). Reserve regex pre/post-triggers for conditions with predictable literal phrasing.
