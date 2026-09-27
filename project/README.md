# Messenger Chatbot - Backend Tư Vấn Khách Hàng

Backend chatbot bán hàng/tư vấn khách hàng chạy 100% bằng model AI local (LM Studio), tích hợp Facebook Messenger.

## Tính năng chính

- 🤖 **AI Local**: Chạy model `google/gemma-3-1b` qua LM Studio (API chuẩn OpenAI), không gọi API trả phí
- 🛍️ **RAG**: Tra cứu sản phẩm/FAQ từ database SQLite + sqlite-vec *(tuỳ chọn — xem mục "RAG" bên dưới)*
- 📦 **Tồn kho real-time**: Kiểm tra stock trực tiếp DB khi khách hỏi
- 🔧 **Tool Calling**: Tìm sản phẩm, check stock, web search (tùy chọn)
- 👨‍💼 **Admin UI**: Quản lý sản phẩm, FAQ, system prompt tại `/admin`
- 📱 **Messenger**: Webhook + Send API, signature verification, typing indicator
- 🔒 **Bảo mật**: trang đăng nhập + cookie phiên HMAC, HMAC signature verification, rate limiting

## Yêu cầu hệ thống

- Node.js 20+ (LTS)
- [LM Studio](https://lmstudio.ai/download) đã cài đặt, đang chạy với **Local Server** trên port `1234`
- Model chat: `google/gemma-3-1b` (đã load trong LM Studio)
- Model embedding: **không bắt buộc** — chỉ cần khi muốn bật RAG

## Cài đặt nhanh

```bash
# 1. Clone project
cd messenger-chatbot

# 2. Cài dependencies
npm install

# 3. Mở LM Studio
#    - tải + load model chat: google/gemma-3-1b
#    - bấm "Start Server" (Local Server) trên port 1234
#    - kiểm tra:  curl http://localhost:1234/v1/models

# 4. Cấu hình .env
cp .env.example .env
# Chỉnh sửa .env với các token Messenger của bạn

# 5. Khởi tạo database
npm run migrate
npm run seed

# 6. Chạy server
npm start
```

## RAG (tuỳ chọn)

Model chat `google/gemma-3-1b` **không phải** model embedding. Nên mặc
định RAG **TẮT** và bot vẫn chat bình thường — chỉ mất phần tự tra cứu
sản phẩm/FAQ trong database.

Bật RAG:

1. Trong LM Studio: tải + load một model embedding, ví dụ
   `text-embedding-nomic-embed-text-v1.5`.
2. Sửa `.env`:

   ```dotenv
   LMSTUDIO_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5
   EMBEDDING_DIM=768
   ```

3. Nạp lại toàn bộ kiến thức RAG:

   ```bash
   node -e "import('./src/rag/indexer.js').then(m => m.reindexAll())"
   ```

`EMBEDDING_DIM` phải khớp đúng số chiều của model embedding đang load. Đổi nó
sau khi đã index thì **phải** xóa `kb_vectors` + `kb_chunks` rồi index lại bằng
một model duy nhất, nếu không sẽ lỗi sai số chiều.

## Ghi chú về model 1B

`google/gemma-3-1b` được chọn vì **rất nhẹ** (~1B tham số): chạy được cả máy
không có GPU, tốn rất ít RAM, và trả lời nhanh. Đổi lại, model cỡ 1B có **khả
năng định nghĩa tool kém** — bot vẫn chat bình thường, nhưng các lệnh như *tìm
sản phẩm / kiểm tra tồn kho / đặt hàng* đôi khi không được gọi, và bot trả lời
bằng văn bản thuần.

Cách xử lý, theo thứ tự nên thử:

1. **Bật RAG** (mục trên) — bot được đẩy thêm context sản phẩm/FAQ từ database,
   giảm phụ thuộc vào việc gọi tool.
2. **Đổi sang model mạnh hơn** — sửa `.env`:
   ```dotenv
   LMSTUDIO_CHAT_MODEL=<tên-model-mạnh-hơn>
   ```
   rồi bấm **Load** model đó trong LM Studio và khởi động lại server.
   Kiểm tra danh sách model server thực sự phục vụ:
   ```bash
   curl http://localhost:1234/v1/models
   ```

> Model phải **Load** trong LM Studio, không chỉ **Download**. Chỉ Download thì
> server vẫn trả lỗi. Chạy `0-Cai-Dat-Ollama-Model.bat` → mục `[2]` để kiểm tra.

## Cấu hình Messenger

1. Tạo Facebook App tại [Meta Developer Console](https://developers.facebook.com/)
2. Thêm sản phẩm "Messenger"
3. Tạo Page Access Token
4. Cấu hình webhook: `https://your-domain.com/webhook/messenger`
5. Subscribe fields: `messages`, `messaging_postbacks`
6. Điền các giá trị vào `.env`:
   - `MESSENGER_VERIFY_TOKEN`
   - `MESSENGER_APP_SECRET`
   - `MESSENGER_PAGE_ACCESS_TOKEN`
   - `MESSENGER_PAGE_ID`

## Test local với ngrok

```bash
# Terminal 1: Chạy server
npm start

# Terminal 2: Tạo tunnel HTTPS
ngrok http 3000

# Copy URL https://xxx.ngrok-free.app/webhook/messenger vào Meta App Dashboard
```

## Admin UI

- URL: `http://localhost:3000/admin` — chuyển tới trang đăng nhập nếu chưa có phiên
- Tài khoản: `ADMIN_USERNAME` trong `.env` (mặc định `admin`)
- Mật khẩu: `ADMIN_PASSWORD` trong `.env` (mặc định `doi-mat-khau-nay`)

Phiên đăng nhập dùng **cookie HMAC ký sẵn** (`HttpOnly`, `SameSite=Lax`, tự hết hạn sau
8h, hoặc 30 ngày nếu tick "Ghi nhớ đăng nhập"). Không có bảng user, không cần database.
Bí mật ký lấy từ `SESSION_SECRET`; để trống thì app tự sinh một khoá 32 byte và lưu ở
`data/session-secret.key`.

> **Không có quên mật khẩu / không có OAuth.** Muốn đổi mật khẩu thì sửa
> `ADMIN_PASSWORD` trong `.env` rồi khởi động lại server.

HTTP Basic Auth vẫn được chấp nhận (để `curl` / ngrok / client cũ không hỏng), nhưng
trình duyệt sẽ không còn hiện hộp thoại xám nữa.

## CLI Test (không cần Messenger)

```bash
npm run cli
```

## Cấu trúc thư mục

```
project/
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── system-prompts/
│   └── default.md
├── data/
│   └── app.db
├── logs/
└── src/
    ├── server.js
    ├── config.js
    ├── llm/
    │   └── client.js
    ├── db/
    │   ├── migrate.js
    │   ├── schema.sql
    │   └── seed.js
    ├── core/
    │   ├── chatEngine.js
    │   ├── systemPrompt.js
    │   ├── history.js
    │   ├── customer.js
    │   ├── handoff.js
    │   └── dedup.js
    ├── rag/
    │   ├── embed.js
    │   ├── indexer.js
    │   └── retriever.js
    ├── tools/
    │   ├── searchProducts.js
    │   ├── checkStock.js
    │   ├── webSearch.js
    │   └── requestHuman.js
    ├── channels/
    │   └── messenger.js
    ├── services/
    │   ├── logger.js
    │   ├── messengerApi.js
    │   └── rateLimiter.js
    ├── admin/
    │   ├── routes.js
    │   └── views/
    └── cli-test.js
```

## Backup Database

```bash
# Backup
cp data/app.db data/app.db.backup.$(date +%Y%m%d)

# Restore
cp data/app.db.backup.YYYYMMDD data/app.db
```

## License

MIT

## Phase 4-7 Status

- Phase 4 (Admin UI): `src/server.js` sets `ejs` view engine (`src/admin/views`), mounts admin router defensively (server starts even if `src/admin/routes.js` is mid-construction). Requires `ejs` dep.
- Phase 5 (RAG): indexed — 18 vectors in `kb_vectors`.
- Phase 6 (Tools): `search_products` / `check_stock` / `request_human` wired in `src/core/chatEngine.js`; `web_search` (Tavily, `src/tools/webSearch.js`) conditionally added via `getWebSearchToolDefinition()` and handled in `executeTool` switch. Enabled only when `ENABLE_WEB_SEARCH=true` + `WEB_SEARCH_API_KEY` set.
- Phase 7 (Messenger): messenger router mounted defensively in `src/server.js` (`/webhook/messenger`); server starts with warning if `src/channels/messenger.js` is mid-construction.
- Cleanup: root debug files `check_db.js`, `test_vec.js`, `test_vec2.js` removed.

## Test Commands

```bash
node --check src/core/chatEngine.js
node --check src/server.js
npm ls ejs
```

## Troubleshooting

- **Webhook 401 (signature check fails):** usually a wrong `MESSENGER_APP_SECRET`, or the
  raw body was parsed before HMAC. `src/server.js` mounts `express.raw()` for
  `/webhook/messenger` *before* `express.json()` — keep that order, and never
  re-encode parsed JSON with `JSON.stringify` for verification (different bytes).
- **Webhook 404:** the routers failed to mount. `src/server.js` resolves
  `m.default ?? m.adminRouter ?? m.adminRoutes ?? m.router` (and
  `m.default ?? m.messengerRouter ?? m.messengerRoutes ?? m.router`) —
  make sure `src/admin/routes.js` still exports `adminRouter` and
  `src/channels/messenger.js` still exports `messengerRouter`.
- **RAG returns nothing / vec0 errors:** `kb_vectors` is a `vec0` table created
  with `CAST(? AS INTEGER)` for `chunk_id`; embedding blobs must be exactly
  `dimensions * 4` bytes (Float32). If you see dimension-mismatch errors, the
  stored table dimension (`EMBEDDING_DIM`, e.g. `768` for
  `text-embedding-nomic-embed-text-v1.5`) doesn't match the embedding model you
  actually loaded — drop `kb_vectors`/`kb_chunks` and reindex with one model:
  `node -e "import('./src/rag/indexer.js').then(m => m.reindexAll())"`.
- **No embedding model configured (RAG off by default):** `LMSTUDIO_EMBEDDING_MODEL`
  ships empty, so `getEmbedding()` throws a descriptive error, `retrieve()` /
  `retrieveFormatted()` return `null`, and the chat loop just omits the
  knowledge-base block — the bot keeps chatting. The degradation is logged
  **once per process**, not per message. `reindexAll()` aborts *before* clearing
  `kb_chunks` so a missing model can never wipe an existing index.
- **LM Studio down:** chat falls back to `FALLBACK_ERROR_MESSAGE`, RAG
  `retrieve()` returns `null`, and `reindexAll`/index calls throw (admin UI
  redirects with `?index_error=1`, DB save still wins). Start LM Studio, make
  sure Local Server is on port 1234 and `google/gemma-3-1b` is loaded.
  Check it with `curl http://localhost:1234/v1/models`, or from Node:
  `node -e "import('./src/llm/client.js').then(m => m.healthCheck()).then(console.log)"`.
- **Model not found (HTTP 404):** LM Studio is running but the pinned id is not
  loaded. The id in `.env` (`LMSTUDIO_CHAT_MODEL`) must match exactly what
  `GET /v1/models` returns. There is deliberately no model picker in the UI.
- **Bot answers slowly / times out:** the model runs locally. Raise
  `LMSTUDIO_TIMEOUT_MS` (default 180000) or `LMSTUDIO_MAX_TOKENS` (2048) in
  `.env`, or use a smaller model.
- **Bot disclosure:** every Messenger reply session starts once with
  `BOT_DISCLOSURE_MESSAGE` ("Đây là trợ lý ảo tự động...") so users know
  they are talking to an automated assistant.
- **CSV import:** paste CSV text into the `<textarea name="csv">` (no file
  upload). Limits: max 200000 chars / 500 rows per paste (HTTP 413 otherwise);
  name/question truncated to 200 chars, description/answer to 5000.

## Production notes

- Set `NODE_ENV=production` (strict config validation; `debug` logs off).
- Change `ADMIN_PASSWORD` from the documented default — the server logs a loud
  `SECURITY WARNING` at startup if it is still `doi-mat-khau-nay` in production.
- Set all Messenger tokens: `MESSENGER_VERIFY_TOKEN`, `MESSENGER_APP_SECRET`,
  `MESSENGER_PAGE_ACCESS_TOKEN`, `MESSENGER_PAGE_ID` (required in production).
- Backup `data/app.db` regularly (see Backup Database above) — it holds
  products, FAQs, customers, history and the RAG vectors.