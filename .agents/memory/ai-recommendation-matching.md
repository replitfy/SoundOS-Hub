---
name: AI tool recommendation matching against short fields
description: How to avoid false-positive matches when an LLM tool matches free-text signals against short catalog fields (course/type/title).
---

When an LLM-callable tool matches free-text signals (e.g. extracted from a chat
message) against short catalog fields like `curso`/`tipo`/`titulo`, naive
substring/word-overlap scoring across all fields causes false positives: generic
words in the user's phrasing (e.g. "vídeo", "curso", "exemplo") match unrelated
items whose `tipo` field happens to contain the word "Video".

**Why:** short fields have low entropy, so common words in almost any request
overlap with them; the first version of Sofia's `recommendVideos` tool used this
and returned an Água video for a TaKeTiNa question because "vídeo" matched
"Video SFS".

**How to apply:** score each signal against its own matching field only (course
signal → course field, type signal → type field), require a real substring match
in both directions, and only fall back to fuzzy keyword matching (title only,
with a stopword list excluding generic words) as a smaller bonus score — never
fall back to "closest anything" when the specific signal has zero real matches.
Also return an empty result (not a fallback to unrelated items) when the tool has
no signals or no matches, so the LLM doesn't have anything to hallucinate a
recommendation from.
