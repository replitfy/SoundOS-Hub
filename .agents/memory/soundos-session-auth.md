---
name: soundos API identity must come from a signed session token
description: Server-side identity/auth in the api-server must never trust a raw client header.
---

**Rule:** any endpoint that records who did something (human confirmations, audit
trails, role checks) must derive the caller's identity from a signed, server-verified
session token (`Authorization: Bearer <token>`, issued by `POST /auth/login`,
verified with `SESSION_SECRET`) — never from a raw client-supplied header like
`X-User-Id`, which any caller can set to any value.

**Why:** this app previously trusted `X-User-Id` directly almost everywhere (a caller
could impersonate any active user). `SESSION_SECRET` already existed as a provisioned
env secret but was unused — signing/verifying session tokens with it is the intended
fix.

**How to apply:** new authenticated routes/features should reuse the existing
`requireAuth`/`requireAdminRole` middleware (api-server) rather than reading
`x-user-id` themselves; frontend should read the token from the user-session context
instead of building headers from the raw user id.
