---
name: api-zod barrel — export only from generated/api, not generated/types
description: Exporting both generated/api and generated/types creates duplicate name errors when a Zod schema and a TS type share the same export name.
---

# api-zod barrel file pattern

**Rule:** `lib/api-zod/src/index.ts` must only re-export from `./generated/api`. Do NOT also export from `./generated/types`.

**Why:** Orval generates a Zod schema object (e.g. `UploadKnowledgeDocumentBody`) in `generated/api.ts` AND a TypeScript interface of the same name in `generated/types/`. Re-exporting both causes `TS2308: Module has already exported a member`. The Zod schema already exposes the TypeScript type via `z.infer<>`, so the separate type file is redundant.

**How to apply:**
```typescript
// lib/api-zod/src/index.ts — correct:
export * from "./generated/api";

// Do NOT add:
// export * from "./generated/types"; // ← causes duplicate name TS errors
```

Note: orval will append its own `export *` lines when codegen runs (with `clean: true`). If duplicates appear after codegen, deduplicate manually. The orval config appends to the barrel rather than replacing it.
