# AGENTS.md — Chatbot_ (service_chat_bot)

> **MANDATORY CONTRACT.** Every AI agent (and every human contributor) working in this
> repository MUST read this file completely before writing a single line of code, and
> MUST keep every change compliant with it. If a task seems to require breaking a rule
> here, stop and ask the owner instead of improvising.

---

## 0. TL;DR — the three active missions

| # | Mission | Status |
|---|---------|--------|
| M1 | **Swap Ollama → LM Studio** (local AI, OpenAI-compatible), chat model pinned to `google/gemma-3-1b` | ACTIVE |
| M2 | **New beautiful login page** (split-panel glassmorphism, no Google login, no forgot-password, no "10M+ users") | ACTIVE |
| M3 | **Modernise the whole admin UI** (sidebar shell, design tokens, cards/tables/forms) | ACTIVE |

---

## 1. Project facts — read this before touching anything

### 1.1 Stack

* **Runtime:** Node.js `>= 20` (dev machine has v24). ESM only — `"type": "module"` in `package.json`.
  **Always use `import` / `export`. Never `require()`.**
* **Framework:** Express 4, server-rendered **EJS**. There is **no SPA, no bundler, no
  build step, no `public/` static directory, no React/Vue, no Tailwind, no chart library.**
* **DB:** SQLite via `better-sqlite3` + `sqlite-vec` (RAG vectors). Single file
  `project/data/app.db`, WAL mode.
* **Views:** `project/src/admin/views/*.ejs` — 17 files.
* **Styling:** one inline `<style>` block in `views/layout.ejs` = the design system.
  Page-specific extras go in a page-local `<style>`. Vanilla CSS, hand-written.
* **Client JS:** ES5 style (`var`, `function`, IIFE, `.then/.catch`). **Never `innerHTML`** —
  use `textContent`. No external CDN, no webfonts, no `<script src=…>`.
* **i18n:** none. Copy is hardcoded **Vietnamese** (English allowed for technical labels).
* **App root:** `project/`. Repo root is one level up and contains `project/` + `AGENTS.md`.

### 1.2 File map (hot files)

```
project/src/config.js               env -> config mapping (single source of truth)
project/src/server.js               express bootstrap, adminAuth, route mounting
project/src/admin/routes.js         ALL 44 admin routes (no controllers/services split)
project/src/admin/views/layout.ejs  design system + top nav  <-- redesign epicentre
project/src/core/chatEngine.js      customer-facing AI agent loop
project/src/core/adminAgent.js      admin AI operator loop (23 tools)
project/src/rag/embed.js            embeddings
project/src/rag/retriever.js        sqlite-vec KNN search
project/src/rag/indexer.js          chunk + embed writer
project/src/db/migrate.js           schema runner + kb_vectors creation
project/src/core/systemPrompt.js    system-prompts/*.md loader
project/system-prompts/default.md   customer persona (Vietnamese)
project/.env                        LIVE SECRETS — never commit, never print
project/.env.example                committed template
```

### 1.3 Hard rules (violating any of these is a bug)

1. **Never print, log, echo or commit secret values.** Only key *names* may appear in
   docs/code. `.env` is gitignored — leave it that way.
2. **Never break existing routes.** All 44 admin routes, their HTTP verbs, their form
   field names and their redirect targets are a public contract with the views.
3. **Never change the meaning of existing CSS class names** (`.btn`, `.card`, `.table`,
   `.badge`, `.alert-*`, `.form-control`, `.grid`, `.muted`, `.num`…). Views depend on
   them. You may *restyle*, add variants, and add new classes — never repurpose.
4. **All user-facing copy is Vietnamese.**
5. **Do not add runtime dependencies** without explicit owner approval. Use Node's
   built-in `fetch` and `node:crypto` (see M1 for why this matters).
6. **Do not delete the `.bat` launchers** — repurpose them (see M1.6). Renaming is
   allowed and expected when the old name names something the project no longer uses:
   the Ollama launchers were renamed to `0-Cai-Dat-LM-Studio-Model.bat` /
   `1-Kiem-Tra-LM-Studio.bat`, and every reference updated in the same commit. Leaving
   a dead provider in a filename is a bug, not nostalgia.
7. Preserve the existing defensive coding style: input validation, `capStr` limits,
   path-traversal guards, `escapeLike`, allow-lists, same-origin CSRF check on POST.

---

## 2. House code style (match the surrounding code)

* 2-space indent, semicolons, single quotes, trailing commas in multi-line literals.
* `const`/`let`, arrow callbacks in `.map`/`.forEach` in **server** code.
* Guard clauses over nesting. Small pure helper functions near the top of the file,
  named `parseX` / `isX` / `normX` / `capX` (mirrors `routes.js` helpers).
* Comments explain **why**, not **what**. Existing files are comment-heavy and
  deliberate — match that density and tone. Do not strip existing comments.
* Vietnamese user-facing strings, English code identifiers and code comments.
* Node built-ins imported as `import crypto from 'node:crypto';` (see `server.js:3`).

---

## 3. MISSION 1 — Ollama → LM Studio (local AI)

### 3.1 Target configuration (decided, do not re-litigate)

| Setting | Value |
|---------|-------|
| Provider | **LM Studio**, local, OpenAI-compatible REST API |
| Base URL | `http://localhost:1234/v1` |
| Chat model | **`google/gemma-3-1b` — FIXED / hard-pinned** |
| API key | `lm-studio` (placeholder; LM Studio ignores it, OpenAI SDK requires non-empty) |
| Auth | None. Server binds localhost only. |

**The chat model is pinned in `src/config.js` as a constant default and must stay
`google/gemma-3-1b`.** It may still be overridden by env var for future use,
but the default must be that exact string, and no UI may offer a model picker.

### 3.2 New env keys (`.env` and `.env.example` — both files)

```dotenv
# --- AI local (LM Studio) ---
LMSTUDIO_BASE_URL=http://localhost:1234/v1
LMSTUDIO_API_KEY=lm-studio
LMSTUDIO_CHAT_MODEL=google/gemma-3-1b
# Embedding model id served by LM Studio at /v1/embeddings.
# LEAVE EMPTY to disable RAG gracefully (chat still works, no knowledge-base context).
# Example when you load an embedding model in LM Studio:
# LMSTUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
LMSTUDIO_EMBEDDING_MODEL=
# Vector width for kb_vectors. Must match the embedding model you actually load.
EMBEDDING_DIM=768
LMSTUDIO_TEMPERATURE=0.3
LMSTUDIO_MAX_TOKENS=2048
LMSTUDIO_TIMEOUT_MS=180000
# "Thinking"/reasoning hint. The local OpenAI-compatible API has no `think` flag;
# this maps to a reasoning hint in the request and is off by default.
LMSTUDIO_THINK=false
```

**Delete** every `OLLAMA_*` key from both `.env` and `.env.example`.
Also fix the pre-existing duplicate `OLLAMA_THINK` bug while you are in there.

### 3.3 Architecture — build an adapter, do not sprinkle `fetch` around

Create **`project/src/llm/client.js`** as the *only* module that talks HTTP to the LLM.
Export:

```js
chatCompletion({ messages, tools, temperature, maxTokens, think }) -> {
  content, toolCalls: [{ id, name, arguments }], raw
}
embedText(text) -> Float32Array            // throws a clear Error if no embedding model
getEmbeddingModel() -> string
listModels() -> string[]                   // diagnostics only, from GET /v1/models
healthCheck() -> { ok, error, model }
```

Rules for the adapter:
* Use **global `fetch`** (Node 20+). No new npm dependency, no `openai` SDK.
* `AbortSignal.timeout(config.llmTimeoutMs)` on every call.
* `stream: false` in the body. **The whole app is non-streaming — do not introduce
  streaming** (no SSE, no WebSocket; the frontend renders one bubble at a time).
* `tools` are already in OpenAI `function` schema shape — pass them through untouched.
* Log via the existing `src/services/logger.js` (`logger.error/info`), never `console.log`
  in `src/` (exception: `src/cli-test.js` is a CLI and may use `console.log`).
* Map HTTP/network failures to actionable Vietnamese error messages.

### 3.4 Call sites to migrate (complete list — all of them)

| File | Change |
|------|--------|
| `src/config.js:39-45` | Replace the 5 `ollama*` keys with the `lmStudio*` block. Keep old key names working as **deprecated fallbacks** if cheap, but `.env` must use the new names. |
| `src/core/chatEngine.js:1,13,229-238,296-301` | Drop `import { Ollama }`. Use the adapter. Replace `options.num_ctx` with `maxTokens`. Handle **OpenAI tool-message shape** (see 3.5). |
| `src/core/adminAgent.js:20,973-988` | Same. Also fix the 4 user-facing Vietnamese strings that say "Ollama" (lines ~4, 17, 975, 976, 1029) → say "LM Studio". |
| `src/rag/embed.js` | Rewrite on the adapter. `response.embeddings[0]` → OpenAI `data[0].embedding`. `truncate` has no equivalent — drop it. Return `Float32Array`. Throw a *clear* error when `LMSTUDIO_EMBEDDING_MODEL` is empty. |
| `src/db/migrate.js:37-82` | **Delete the `POST /api/show` probe entirely** (that endpoint does not exist in the OpenAI API — it currently fails on every boot and logs a warning). Use the static `EMBEDDING_DIM` config value. Update/remove the stale `modelDefaults` map. |
| `src/cli-test.js:20-32` | Update printed labels: `Model: google/gemma-3-1b`, `LM Studio: http://localhost:1234/v1`. |
| `src/admin/routes.js:299,1527` | `config.ollamaChatModel` → `config.lmStudioChatModel`. |
| `package.json:24` | **Remove the `ollama` dependency.** Do not add a replacement. |

### 3.5 Tool-calling: the critical correctness fix

Ollama and OpenAI differ. Getting this wrong silently breaks the agent loop.

* **Assistant message with tool calls** must be
  `{ role: 'assistant', content: null|'', tool_calls: [{ id, type: 'function',
  function: { name, arguments: '<JSON string>' } }] }`
* **Tool result message** must be
  `{ role: 'tool', tool_call_id: '<the id>', content: '<result text>' }`
* Today `chatEngine.js:257-261` emits Ollama's `tool_name` field, and
  `adminAgent.js:1020-1023` emits no id at all. **Both must be fixed**, and
  `tool_call_id` must be threaded through from the assistant turn.
* `chatEngine.js:241` currently pushes Ollama's raw message object (which carries a
  `thinking` field) into history. Rebuild it into the OpenAI shape instead.
* Preserve the existing 5-iteration cap, the 30-message admin history cap, and the
  `executeTool` dispatch behaviour.
* Gracefully degrade: if a model returns plain text where tools were expected, answer
  with that text. Never throw an unhandled exception out of the agent loop.

**Why the graceful-degrade rule is load-bearing:** the pinned `google/gemma-3-1b` is a
1B model. It was chosen because it is tiny — it runs without a GPU, needs almost no
RAM, and replies fast. The trade-off is that a 1B model has a **noticeably weaker
ability to interpret tool definitions**. It will often answer in plain prose instead
of emitting `tool_calls`. This is expected, not a bug. The mitigation ladder, in
order: (1) enable RAG so product context is injected as a system message instead of
fetched via a tool; (2) raise `LMSTUDIO_CHAT_MODEL` to a larger model. Never "fix"
this by tightening the tool loop — a plain-text answer is a valid answer.

### 3.5b Chat-template constraints (hard-won, do not regress)

Gemma-family chat templates are far stricter than the OpenAI spec, and they fail by
**returning HTTP 400**, not by degrading:

* **Strict role alternation.** The template itself calls
  `raise_exception("Conversation roles must alternate user/assistant/...")`.
  Two consecutive `user` turns, a leading `assistant` turn, an empty turn, or a
  trailing `system` turn all produce a 400 that bricks the bot for that customer.
  This is not hypothetical: duplicate consecutive rows in `conversations` (a
  retried or double-saved inbound message) are enough, because `getHistory()`
  replays them verbatim.
  → `normalizeMessages()` in `src/llm/client.js` fixes this **in the adapter**, so
  both agent loops benefit and a future model swap needs no change. It merges
  consecutive same-role turns, drops empties, and collapses a run of `tool`
  results. Keep every path to the model going through it.
* **`tools` is accepted** on this runtime (verified against a live
  `/v1/chat/completions`), so tool calling still works — just unreliably, per the
  1B caveat above.

### 3.5c Rendering model output (Markdown → the channel's format)

The model writes Markdown by habit. Every channel must translate it, or customers
see literal `**Tồn kho:**`:

* **Telegram** (`src/channels/telegram.js`): `mdToTelegramHtml()` maps `**b**`,
  `_i_`/`*i*`, `` `code` `` and fenced blocks, flattens Markdown tables into
  `a  ·  b` lines, and HTML-escapes everything **first** so a `<` in a product
  name cannot break the parse. Sends with `parse_mode: 'HTML'` and falls back to
  plain text if Telegram rejects the message — a malformed reply must never be
  silently dropped.
* **Admin AI chat** (`src/admin/views/agent.ejs`): `fillBubble()` /
  `inlineNodes()` build real `strong` / `em` / `code` elements via
  `createElement` + `textContent`. **No `innerHTML`** — see §1.1. Escaping first
  would have made `innerHTML` safe, but the DOM route keeps the rule absolute.
* A new channel must do the same. Sending raw model text is a bug, not a shortcut.

### 3.6 Graceful RAG degradation (required)

`google/gemma-3-1b` is a **chat** model, not an embedding model. The user may
not have any embedding model loaded in LM Studio.

Therefore:
* With `LMSTUDIO_EMBEDDING_MODEL` empty (the default we ship), `getEmbedding()` /
  `getEmbeddingsBatch()` must throw a *descriptive* error, and every **caller** must
  catch it and continue **without** RAG context. The bot must still chat.
* `retrieveFormatted()` must return `null` on any embedding failure.
* Indexing writes (`indexProduct`, `indexFaq`, `reindexAll`) must catch the error and
  report a clear, actionable message in the admin UI instead of crashing the request.
  The views already render `index_error` — reuse that channel.
* `kb_vectors` is created with `FLOAT[EMBEDDING_DIM]`. Changing `EMBEDDING_DIM`
  requires dropping and rebuilding that table; document the reindex command
  (`node -e "import('./src/rag/indexer.js').then(m=>m.reindexAll())"`) in the docs.
* Log the degradation **once per process** (or rate-limited), not on every message.

### 3.7 Launchers (`.bat`) — repurpose, never delete

**The local runtime on port 1234 is not necessarily LM Studio.** It is
`Bionic.exe` on the owner's machine, which serves the same OpenAI-compatible
`/v1` surface with the same model ids. Every script only probes
`http://localhost:1234/v1/models`, so they work for both — but any message that
tells the owner to "open LM Studio / download the model" is wrong for a Bionic
user. Keep such wording conditional ("máy chạy LM Studio hoặc server OpenAI
tương thích khác"), or state the assumption instead of asserting one product.
`Bionic.exe` also already serves `text-embedding-nomic-embed-text-v1.5`, so RAG
can be enabled with **zero downloads** on that setup.

| File | New behaviour |
|------|---------------|
| `0-Cai-Dat-LM-Studio-Model.bat` | The installer menu. **Reads `LMSTUDIO_CHAT_MODEL` out of `.env` at runtime** (fallback `google/gemma-3-1b`) so the script can never drift from the real config. Menu: `[1]` how to load the chat model · `[2]` **verify the model is actually LOADed** (greps `/v1/models`, then fires a throwaway chat completion) · `[3]` RAG on/off · `[4]` ngrok · `[5]` list served models. No `winget install Ollama`, no `ollama pull`. |
| `1-Kiem-Tra-LM-Studio.bat` | Two-stage check: HTTP `200` on `http://localhost:1234/v1/models` **and** the pinned model present in the served list. Distinguishes "server not running" from "model downloaded but not LOADed" — the single most common failure. Opens the LM Studio download page when down. |
| `2-Khoi-Dong-Server.bat:24-33` | Probe `http://localhost:1234/v1/models` instead of `http://localhost:11434/api/tags`. |
| `Khoi-Dong-Tat-Ca.bat:4-6` | Update the launcher chain and any waits/messages mentioning Ollama. |
| `4-Mo-Ngrok.bat:7` | Update the reference to the renamed install script. |
| `3-Chat-Thu.bat`, `Sao-Luu-Du-Lieu.bat` | Update only if they mention Ollama. |

The launchers were **renamed** off Ollama: `0-Cai-Dat-LM-Studio-Model.bat` and
`1-Kiem-Tra-LM-Studio.bat`. Note the second one is named *Kiem-Tra* (check), not
*Khoi-Dong* (start), because it genuinely cannot start LM Studio — LM Studio is a GUI
app the owner launches by hand, so the script's only honest job is to verify and
explain.

**cmd.exe gotcha that has already bitten this repo twice — respect it when editing
`.bat`:** inside an `if ( ... )` or `for ( ... )` block, an unescaped `)` in an `echo`
aborts the script with `. was unexpected at this time.` Parentheses are safe at label
level but not inside a block. Prefer `goto` labels over `if ( ... )` blocks for anything
that prints more than one line. Separately, `del` resets `%errorlevel%` to `0`, so
capture a `findstr` result into a variable *before* deleting the file it read.

Keep the existing `.bat` house style: `chcp 65001`, `title`, Vietnamese `echo` messages,
`pause`. Scripts are written **unaccented** (ASCII) on purpose — `chcp 65001` plus
non-ASCII in `.bat` files is a reliable source of mojibake on Vietnamese Windows.

### 3.8 Docs

Update the root `README.md`, `project/HUONG-DAN.txt`, `project/HUONG-DAN-MESSENGER.txt`
— every mention of Ollama, port 11434, `ollama pull`, `qwen3.5:9b`, `bge-m3` becomes
LM Studio, port 1234, `google/gemma-3-1b`, and the RAG caveat from 3.6.
Docs must also carry the 1B tool-calling caveat from §3.5, and the login page must be
documented (the old docs still described HTTP Basic Auth).

### 3.9 Definition of done (M1)

* [ ] Zero occurrences of `ollama` / `Ollama` / `11434` in `project/src/**`, `project/.env*`,
      `project/*.bat`, `project/*.md`, `project/*.txt` (historical `project/logs/*` is
      ignored — never rewrite logs).
* [ ] `ollama` removed from `package.json`.
* [ ] `node --check` passes on every changed `.js`.
* [ ] Server boots with LM Studio **down** and still serves `/health`, `/admin/login`
      and the login page.
* [ ] `node -e "import('./src/llm/client.js').then(m=>m.healthCheck()).then(r=>console.log(r))"`
      reports the correct model name.

---

## 4. MISSION 2 — New login page

### 4.1 Reality check (already investigated — do not re-discover)

* **There is no login page today.** `/admin` is protected by **HTTP Basic Auth**
  (`server.js:54-65`), which pops the browser's native grey dialog.
* There is **no users table, no roles, no JWT, no cookie, no session, no rate limiting
  on login**. Exactly one operator account exists, defined by `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` in `.env`.
* `express.urlencoded({ extended: true })` is already mounted (`server.js:28`), so an
  HTML `<form method="post">` parses with no server change.
* A same-origin CSRF check (`routes.js:130-154`) already guards every `POST` inside
  `adminRouter`. Keep it.

### 4.2 What to build

**Backend (no new npm dependency):**

* `GET  /admin/login` → render the new view. Redirect to `/admin` if already signed in.
* `POST /admin/login` → validate against `config.adminUsername` /
  `config.adminPassword` using the existing `credentialsMatch()` helper
  (SHA-256 + `timingSafeEqual`, `server.js:47-51`). On success set a **signed cookie**;
  on failure re-render with a Vietnamese error, HTTP 401.
* `POST /admin/logout` → clear the cookie, redirect to `/admin/login`.
* **Session = HMAC-signed token, no server-side store, no new dependency.**
  `crypto.createHmac('sha256', secret)` over `username + '.' + issuedAt + '.' + expiresAt`,
  base64url encoded. Derive the secret from an env var
  (`SESSION_SECRET`, with a generated-and-persisted fallback written next to the DB)
  so sessions survive restarts. Document the new env key.
* Honour a "remember me" checkbox → short-lived vs long-lived cookie `maxAge`.
* Upgrade `adminAuth`:
  * Accept **either** a valid session cookie **or** legacy Basic Auth (so curl/ngrok/API
    clients keep working unchanged).
  * For **HTML GET** requests when unauthenticated → `302` to `/admin/login?next=…`
    (never the native dialog).
  * For **XHR / JSON / non-HTML** requests → keep today's `401` +
    `WWW-Authenticate` so `fetch()` callers in `agent.ejs` behave exactly as today.
  * Sanitise `next` — only allow same-origin paths starting with a single `/`.
* Add a small failed-attempt throttle (in-memory, e.g. 10 attempts / 15 min per IP) —
  cheap, no dependency, and a genuine security improvement over today.
* `/admin/login` and `/admin/logout` must be registered **before** the `adminAuth` mount
  (`server.js:92`) so they are reachable unauthenticated.

**Frontend — `project/src/admin/views/login.ejs` (NEW):**

Design brief: reproduce the *aesthetic* of the reference image — premium SaaS
split-panel glassmorphism — **but honour these content constraints**:

* **NO "Continue with Google" / any social-login button.** (And there is no Google
  auth in this app — do not add any.)
* **NO "Forgot Password?" link** and **no password-reset flow.** The project has no
  mailer; the documented recovery is editing `.env`. Do not invent one.
* **NO "Sign up" link / no register route.** (There is no user directory.)
* **NO "10 Million+ Users" / social-proof avatars block.**
* **NO stock-photo "SMART AI ASSISTANCE" wordmark lockup** — invent our own brand
  treatment for this project instead.

Everything else from the image is in scope and expected:

* Full-bleed soft gradient backdrop (purple → pink → lavender → light blue), plus
  floating blurred colour orbs and a subtle grain/vignette.
* One large **glass card** (rounded ~24px, translucent white, backdrop blur, 1px light
  border, soft outer shadow) containing a **two-column split**:
  * **Left brand panel** — project logo mark (pure CSS/SVG), the product name, a tagline
    in Vietnamese, a CSS-only 3D gradient orb/globe visual, and 2–3 short feature
    bullets relevant to *this* app (product catalogue, RAG knowledge base, order
    handling, Telegram/Messenger). Hide or collapse this panel below ~900px.
  * **Right form panel** — small square logo tile, "Chào mừng trở lại" /
    "Welcome Back" heading, one-line Vietnamese subtitle, **Email / Tài khoản** field
    with a leading icon, **Mật khẩu** field with a leading icon **and a show/hide
    password eye toggle**, a **"Ghi nhớ đăng nhập"** checkbox, and a full-width
    **gradient pill "Đăng nhập"** submit button.
* Icons: **inline SVG only**. No icon font, no external requests.
* Typography: system font stack. Optionally a `@font-face`-free `font-feature-settings`
  / tighter letter-spacing on the big wordmark. No Google Fonts (app must work offline).
* Micro-interactions: input focus ring, button hover lift + gradient sheen, card
  entrance fade/scale, orb slow float. Add `@media (prefers-reduced-motion: reduce)`
  to disable them.
* Accessibility: real `<label for>`, `autocomplete="username"` / `current-password`,
  `aria-invalid` on error, `role="alert"` on the error box, visible focus rings,
  `lang="vi"`.
* Client JS: ES5 only, IIFE, `textContent` only (never `innerHTML`). Toggle the
  password `type` and the eye icon; disable the button and show a spinner/label swap
  while submitting.
* Fully responsive down to 360px wide.

### 4.3 Definition of done (M2)

* [ ] `GET /admin` unauthenticated in a browser → lands on the pretty login page.
      **No native Basic-Auth dialog anywhere in the normal browser flow.**
* [ ] Correct credentials → `/admin` dashboard renders.
* [ ] Wrong credentials → pretty inline Vietnamese error, HTTP 401, password preserved
      as empty, username preserved.
* [ ] `POST /admin/logout` → back to login page, cookie cleared.
* [ ] "Remember me" changes the cookie lifetime observably.
* [ ] `fetch()` calls in `agent.ejs` still get JSON `401`, not an HTML redirect.
* [ ] curl with `-u admin:pass` still works (legacy Basic Auth preserved).
* [ ] No `google`, `forgot`, `reset`, `signup`, `register`, `million` anywhere in
      `login.ejs` or the new auth code.

---

## 5. MISSION 3 — Admin UI modernisation

### 5.1 Constraint that shapes everything

`layout.ejs` is a **fragment** included by all 17 views *before* `<main>`, and there is
**no `express.static`**, **no `public/`**, **no build step**. Each view hardcodes its
own `<!DOCTYPE html><html><head><title>` shell.

**Therefore: achieve the redesign through CSS on the existing `layout.ejs` output, plus
a small inline script. Do not refactor the 17 view shells.** Any change requiring
`express.static`, a bundler or a new templating convention is out of scope and must be
rejected.

### 5.2 What "modern" means here

Upgrade the **design system in `layout.ejs`** — it is the highest-leverage single file:

* **Tokens:** extend `:root` with a proper scale — surfaces (`--bg`, `--surface`,
  `--surface-2`, `--surface-3`), text ramp, `--border` + `--border-strong`, a
  brand/primary ramp, `--ring`, `--shadow-sm/-md/-lg`, `--radius-sm/-md/-lg/-xl`,
  `--font-sans`, and transition tokens. **Keep every existing variable name** so
  nothing breaks; add new ones.
* **Look & feel:** move from flat 2015-era slate/blue to a contemporary admin —
  soft neutral canvas, white cards with hairline borders and layered shadows, rounded
  `12–16px` cards, gradient accent on primary actions and active nav, better type
  scale (tighter headings, comfortable line-height), focus-visible rings everywhere.
* **Shell:** convert the existing `<nav>` into a **fixed left sidebar** using pure CSS
  (`nav { position: fixed; ... }` + `body { padding-left: … }`) so **zero views need
  editing**. Include a brand block at the top, grouped nav items with icons
  (inline SVG), and a user/footer block at the bottom containing the **logout** form
  (from M2). On `max-width: 900px` collapse to a top bar with a JS hamburger toggle.
* **Active state:** the server does not pass an "active page" local, so add a ~6-line
  inline script in `layout.ejs` that compares `location.pathname` against each nav
  link and toggles an `.active` class. Vanilla ES5, no `innerHTML`.
* **Components:** refine `.btn` (add `.btn-ghost`, `.btn-outline`, `.btn-lg`,
  consistent focus ring), `.card` (+ `.card-hover` lift), `.badge` (softer, modern
  pills), `.alert-*` (softer, left-accent-bar style), `.form-control` (bigger padding,
  focus ring, consistent radius), `.table` (softer header, better row rhythm, sticky
  header preserved), `.grid` (wider min so cards breathe), `.empty-state`, and a
  `.section-title`.
* **Dashboard:** upgrade `dashboard.ejs` — gradient-accent stat cards, inline-SVG icon
  tiles, and keep the exact same `counts.*` locals so `routes.js:272-290` needs **no
  change**.
* **Agent page:** `agent.ejs` has its own `<style>` (lines 13-27) and a broken
  `.badge-count` class with no CSS rule. Fix the missing rule and align the chat
  bubbles/session list with the new tokens so it does not look bolted on. Keep the
  `fetch` calls and the `textContent` rendering untouched.
* **Dark mode:** add a `prefers-color-scheme: dark` block that overrides **only the
  `:root` tokens**, plus a small set of `[data-theme="dark"]` overrides, and a
  user-toggle button in the sidebar footer that persists to `localStorage`. Hoist the
  ~10 hardcoded hexes currently sitting outside `:root` into tokens so dark mode can
  actually work. If this proves impossible to do cleanly, ship light-mode-only and say
  so in the report — do not ship a half-broken dark mode.
* Replace the scattered inline `style="…"` attributes in views with proper classes
  **only where the class is generic and reusable**; leave page-specific one-offs alone.

### 5.3 Definition of done (M3)

* [ ] All 17 views still render with **zero** changes to their HTML body (only
      `layout.ejs`, `dashboard.ejs`, `agent.ejs` touched).
* [ ] All 44 admin routes still work, including every POST → redirect → flash flow.
* [ ] No existing CSS class name was repurposed or removed.
* [ ] Sidebar renders, active item is highlighted, hamburger works under 900px.
* [ ] No horizontal scrollbar at 360px on dashboard, products, faqs, customers, orders.
* [ ] Keyboard-only navigation reaches every nav item and form control, focus visible.
* [ ] `prefers-reduced-motion` honoured.

---

## 6. Coordination rules for parallel agents

The three implementation missions touch **overlapping files**. To avoid clobbering
each other, ownership is exclusive:

| Owner | Files it may create/modify |
|-------|----------------------------|
| **Coder A — AI/LLM** | `src/llm/**`, `src/config.js`, `src/core/chatEngine.js`, `src/core/adminAgent.js`, `src/rag/embed.js`, `src/rag/retriever.js`, `src/rag/indexer.js`, `src/db/migrate.js`, `src/cli-test.js`, `src/admin/routes.js` **(only the 2 `chatModel` lines)**, `package.json`, `.env`, `.env.example`, `project/*.bat`, `README.md`, `HUONG-DAN*.txt` |
| **Coder B — Auth/Login** | `src/server.js`, `src/admin/views/login.ejs` **(new)**, `src/db/schema.sql` **(only if needed)**, `.env`, `.env.example` **(auth keys only)** |
| **Coder C — Admin UI** | `src/admin/views/layout.ejs`, `src/admin/views/dashboard.ejs`, `src/admin/views/agent.ejs` **(`<style>` block only)** |

**Collision rules:**
* `.env` / `.env.example` have several owners. **Only append your own block; never
  reformat or reorder existing lines.**
* If you need a file owned by another coder, **stop and report it** instead of editing.
* Do not run `npm install` or `git` commands. Do not run the dev server. The
  orchestrating agent does integration and verification.
* Do not rewrite `AGENTS.md` — only the orchestrator does that.

---

## 7. Verification checklist (run by the orchestrator, not by coders)

```powershell
# 1. Syntax check every JS file
Get-ChildItem -Recurse project\src -Filter *.js | ForEach-Object { node --check $_.FullName }

# 2. Zero Ollama residue (should print nothing)
Get-ChildItem -Recurse project -Include *.js,*.ejs,*.bat,*.md,*.txt,*.json |
  Where-Object { $_.FullName -notmatch 'node_modules|\\logs\\|package-lock' } |
  Select-String -Pattern 'ollama|11434|qwen3\.5|bge-m3'

# 3. No secrets staged
git ls-files | Select-String -Pattern '\.env$'

# 4. Boot with LM Studio down
cd project; npm.cmd start
# then: GET /health, GET /admin  -> expect 302 to /admin/login, GET /admin/login -> 200
```

> **Note:** `npm` is `npm.ps1` on this machine and PowerShell blocks it. **Always use
> `npm.cmd`** (e.g. `npm.cmd start`, `npm.cmd install`).

---

## 8. Repository & publishing

* Repo root = `C:\Users\Le Hung Lam\Desktop\Chatbot_` (contains `project/` + `AGENTS.md`).
* Remote: `https://github.com/Huynek0110/service_chat_bot`, branch `main`.
* Root `.gitignore` must exclude: `node_modules/`, `project/.env`, `project/logs/`,
  `project/data/*.db*`, `project/data/uploads/`, `project/products/*.txt`,
  `project/backup/`, `project/New folder/`, `*.log`, `boot_*.log`, `live*.log`,
  `test2_*.log`, `.claude/`.
* Commit messages: Conventional Commits, English, e.g. `feat(ai): migrate to LM Studio`,
  `feat(auth): add glassmorphism login page`, `feat(admin): modernise admin shell`.
* **Never force-push.** Never commit `.env` or any live credential.
