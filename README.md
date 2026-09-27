# service_chat_bot — Chatbot Bán Hàng Tư Vấn Khách Hàng

Backend chatbot bán hàng / tư vấn khách hàng chạy **100% bằng model AI local**
(LM Studio — không gọi API trả phí), nói chuyện qua **Telegram** và **Facebook Messenger**.

## Tính năng chính

- 🤖 **AI Local**: chạy model `google/gemma-3-1b` qua LM Studio (API chuẩn OpenAI)
- 💬 **Đa kênh**: Telegram (long-polling) + Facebook Messenger (webhook)
- 🛍️ **RAG**: tra cứu sản phẩm/FAQ từ SQLite + sqlite-vec *(tuỳ chọn — xem mục "RAG")*
- 📦 **Tồn kho real-time**: kiểm tra stock trực tiếp DB khi khách hỏi
- 🔧 **Tool Calling**: tìm sản phẩm, check stock, đặt hàng, bàn giao người thật
- 👨‍💼 **Admin UI**: quản lý sản phẩm, FAQ, đơn hàng, system prompt, kèm trợ lý AI
- 🔒 **Bảo mật**: trang đăng nhập + cookie phiên HMAC, chữ ký HMAC webhook, rate limiting

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
> server vẫn trả lỗi. Chạy `0-Cai-Dat-LM-Studio-Model.bat` → mục `[2]` để kiểm tra.

## Cấu hình Telegram (không cần domain, không cần ngrok)

Telegram dùng **long-polling** — server tự gọi ra Telegram, nên chỉ cần chạy trên máy
local là xong. Đây là cách nhanh nhất để thử bot.

1. Mở Telegram, tìm `@BotFather` → `/newbot` → đặt tên → lấy **token**
2. Điền vào `.env`:
   ```dotenv
   TELEGRAM_ENABLED=true
   TELEGRAM_BOT_TOKEN=123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. Khởi động lại server. Bot tự kết nối — kiểm tra bằng:
   ```bash
   curl http://localhost:3000/health
   # {"status":"ok",...,"telegram":{"enabled":true,"connected":true,"username":"..."}}
   ```
4. Mở bot trên điện thoại và nhắn thử.

Bot cũng gửi thông báo tới Telegram khi có đơn hàng mới cần giao (xem
`deliverOrder` trong `src/orders/orders.js`).

> Token nằm trong `.env` — file này **không** được commit lên git.

## Cấu hình Messenger (cần domain + ngrok)

Messenger dùng **webhook**, nên Facebook phải gọi được vào máy bạn → cần HTTPS.

1. Tạo Facebook App tại [Meta Developer Console](https://developers.facebook.com/)
2. Thêm sản phẩm "Messenger"
3. Tạo Page Access Token
4. Mở tunnel HTTPS (xem mục ngrok bên dưới)
5. Cấu hình webhook: `https://<link-cua-ban>/webhook/messenger`
6. Subscribe fields: `messages`, `messaging_postbacks`
7. Điền vào `.env`:
   ```dotenv
   MESSENGER_ENABLED=true
   MESSENGER_VERIFY_TOKEN=<chuoi-tu-ban-dat>
   MESSENGER_APP_SECRET=
   MESSENGER_PAGE_ACCESS_TOKEN=
   MESSENGER_PAGE_ID=
   ```
8. Khởi động lại server.

Hướng dẫn từng bước cho người không viết code: **`project/HUONG-DAN-MESSENGER.txt`**.

> Link ngrok miễn phí **đổi mỗi lần** bật/tắt. Đổi link thì phải sửa lại Callback URL
> trên Meta. Muốn link cố định thì dùng ngrok trả phí hoặc thuê VPS + domain.

## Mở tunnel HTTPS bằng ngrok (chỉ cần cho Messenger)

```bash
# Terminal 1: chạy server
npm start

# Terminal 2: mở tunnel
ngrok http 3000
```

Hoặc trên Windows: chạy `4-Mo-Ngrok.bat` (nếu chưa có ngrok thì chạy
`0-Cai-Dat-LM-Studio-Model.bat` → mục `[4]` để cài).

Lấy link `https://xxx.ngrok-free.app` rồi dán vào Meta App Dashboard:
`https://xxx.ngrok-free.app/webhook/messenger`

## Tắt bớt kênh

Mỗi kênh có công tắc riêng trong `.env`. Tắt kênh không cần thì kệ webhook không
được mount, nhẹ hơn:

```dotenv
TELEGRAM_ENABLED=false    # tắt Telegram
MESSENGER_ENABLED=false   # tắt Messenger
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
Chatbot_/                      <- repo root
├── AGENTS.md                  <- hợp đồng cho AI agent: đọc file này trước khi sửa code
├── README.md                  <- file bạn đang đọc
└── project/                   <- toàn bộ mã nguồn
    ├── .env.example           <- mẫu cấu hình (KHÔNG có secret)
    ├── .env                   <- cấu hình thật + secret (không commit)
    ├── package.json
    │
    ├── 0-Cai-Dat-LM-Studio-Model.bat   <- cài LM Studio + model + ngrok (1 lần)
    ├── 1-Kiem-Tra-LM-Studio.bat        <- kiểm tra LM Studio + model đã Load chưa
    ├── 2-Khoi-Dong-Server.bat          <- chạy server + bot
    ├── 3-Chat-Thu.bat                  <- thử bot trong terminal
    ├── 4-Mo-Ngrok.bat                  <- mở tunnel HTTPS (cho Messenger)
    ├── Khoi-Dong-Tat-Ca.bat            <- mở cả LM Studio + server
    ├── Sao-Luu-Du-Lieu.bat             <- backup database
    │
    ├── HUONG-DAN.txt                   <- hướng dẫn cho người không biết code
    ├── HUONG-DAN-MESSENGER.txt         <- hướng dẫn nối bot vào Fanpage
    │
    ├── system-prompts/
    │   └── default.md                  <- persona/system prompt của bot
    ├── data/                           <- app.db, uploads (không commit)
    ├── products/                       <- kho tài khoản số (không commit)
    ├── logs/
    └── src/
        ├── server.js                   <- bootstrap Express, auth, mount channel
        ├── config.js                   <- đọc .env -> config
        ├── cli-test.js                 <- `npm run cli`
        │
        ├── llm/
        │   └── client.js               <- adapter LM Studio DUY NHẤT gọi AI
        │
        ├── db/
        │   ├── schema.sql
        │   ├── migrate.js
        │   └── seed.js
        │
        ├── core/
        │   ├── chatEngine.js           <- vòng lặp agent cho khách
        │   ├── adminAgent.js           <- trợ lý AI trong Admin (23 tool)
        │   ├── systemPrompt.js         <- đọc/ghi system-prompts/*.md
        │   ├── history.js
        │   ├── customer.js
        │   ├── handoff.js
        │   └── dedup.js
        │
        ├── channels/
        │   ├── telegram.js             <- long-polling
        │   └── messenger.js            <- webhook + HMAC verify
        │
        ├── rag/
        │   ├── embed.js                <- gọi /v1/embeddings
        │   ├── indexer.js
        │   └── retriever.js            <- tìm vector gần nhất (sqlite-vec)
        │
        ├── orders/
        │   ├── orders.js
        │   └── stock.js
        │
        ├── tools/
        │   ├── index.js                <- định nghĩa + dispatch tool của khách
        │   └── webSearch.js            <- tool Tavily (tuỳ chọn)
        │
        ├── services/
        │   ├── logger.js
        │   ├── messengerApi.js
        │   └── rateLimiter.js
        │
        └── admin/
            ├── routes.js               <- toàn bộ route /admin
            └── views/                  <- 18 file EJS (layout + login + các trang)
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
- **Telegram không phản hồi:** kiểm tra `/health` xem `telegram.connected` có `true`
  không. Nếu `false`, thường do token sai hoặc chưa bật `TELEGRAM_ENABLED=true`.
  Bot chỉ nhận tin khi **server đang chạy** — đây là long-polling, không có webhook
  nên tắt server là bot chết. Nếu token bị thu hồi thì lấy token mới từ `@BotFather`.
- **Messenger 404:** webhook chưa mount vì `MESSENGER_ENABLED=false`. Bật lên rồi
  khởi động lại server, và nhớ link ngrok đã đổi thì phải sửa lại Callback URL.
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