---
name: pdf-parse CJS loading in ESM esbuild bundle
description: pdf-parse ships CJS only and fails when Node's ESM loader resolves its "exports" field; must use createRequire and mark external in esbuild.
---

# pdf-parse in an ESM esbuild bundle

**Rule:** In any ESM server bundle, load pdf-parse via `createRequire`, not `import pdfParse from "pdf-parse"`.

**Why:** pdf-parse publishes an `exports.import` ESM entry that lacks a default export. When the esbuild output is `.mjs` and pdf-parse is externalized, Node's ESM loader picks the `exports.import` entry and throws `SyntaxError: The requested module 'pdf-parse' does not provide an export named 'default'`.

**How to apply:**
```typescript
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
type PdfParseResult = { text: string; numpages: number };
const pdfParse: (buf: Buffer) => Promise<PdfParseResult> = _require("pdf-parse");
```

Also add `"pdf-parse"` to the `external` array in `build.mjs` so esbuild does not attempt to bundle it (which also fails due to the same ESM entry mismatch).
