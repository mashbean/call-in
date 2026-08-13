# Live Deck Kit

把即時難易度、隨時提問、emoji 反應、快速投票與 QR Code 放進任何網頁簡報。

參與者使用手機開啟互動頁。講者在簡報右側看到即時 dashboard，也可以把 dashboard 收起來。桌面可採右側分割，手機與 iPad 會改成可觸控的抽屜。

## 可以直接用 prompt 完成

安裝 repo 內附的 Codex skill 後，可以用這段 prompt 開始

> 幫這份網頁簡報加上 Live Deck Kit。活動名稱是「我的活動」，保留原本簡報與動畫，部署到我的 Cloudflare，桌面使用右側四分之一，手機使用抽屜。

Skill 會依序設定活動、部署即時服務、嵌入簡報、測試手機與桌面版，最後交付參與頁和 dashboard 網址。

## 功能

- 1 到 5 分的即時難易度回報與常態分布視覺
- 最新問題置頂、問題類型、送出當下的難易度與「我也想問」
- 四種可自訂 emoji，講者 dashboard 會出現 popup 動畫
- 最多八題快速投票，結果顯示票數
- Dashboard 內建 QR Code，內容永遠指向同一個服務的參與頁
- WebSocket Hibernation 即時同步，閒置時可讓 Durable Object 休眠
- 每台裝置預設最多提出 20 題，可在設定檔調整
- 管理 token 保護的匯出與清空 API
- 可重跑、可更新的 HTML 整合 CLI
- Overlay 與桌面 75/25 split 兩種嵌入模式

## 架構

```text
網頁簡報 ── live-deck-panel ── iframe ── 講者 dashboard
                                             │
參與者手機 ── 參與頁 ────────────────────────┤
                                             ▼
                              Cloudflare Worker API
                                             │
                              Durable Object + SQLite
                                             │
                              Hibernation WebSockets
```

每個活動預設使用一個 Worker deployment 和一個 Durable Object。活動之間不共用資料，也不讓單一活動拖累其他活動。這個預設比較適合免費額度與現場故障隔離。

## 快速開始

需要 Node.js 22 以上與 Cloudflare 帳號。

```bash
gh repo clone mashbean/live-deck-kit
cd live-deck-kit
npm install
npm run types
```

編輯 [`event.config.json`](./event.config.json)，接著建立管理 token 並檢查整個專案。

```bash
npm run admin-token
npm run check
npx wrangler login
npm run deploy
```

`npm run admin-token` 會把 SHA-256 hash 寫進 `wrangler.jsonc`，原始 token 只會留在被 Git 排除的 `.live-deck-admin-token`。

取得 Wrangler 回傳的 HTTPS 網址後，把 dashboard 加進既有簡報。

```bash
npm run integrate -- \
  --deck /absolute/path/to/deck/index.html \
  --service-url https://YOUR-WORKER.workers.dev \
  --mode split \
  --target-selector '.deck-stage' \
  --desktop-width '25vw'
```

如果不確定簡報的主要容器，先使用 `--mode overlay`。CLI 只會維護 `live-deck-kit:start` 到 `live-deck-kit:end` 之間的區塊，重跑不會插入第二份元件。

## 手動嵌入

```html
<script type="module" src="https://YOUR-WORKER.workers.dev/embed/live-deck-panel.js"></script>
<live-deck-panel
  service-url="https://YOUR-WORKER.workers.dev"
  mode="split"
  target-selector=".deck-stage"
  desktop-width="25vw"
></live-deck-panel>
```

## 安裝 Codex skill

從 GitHub 直接安裝套件並複製 skill。

```bash
npx --yes github:mashbean/live-deck-kit install-skill
```

也可以從已 clone 的 repo 安裝。

```bash
npm run install-skill
```

Skill 會放在 `$CODEX_HOME/skills/live-deck-kit`。未設定 `CODEX_HOME` 時使用 `~/.codex/skills/live-deck-kit`。

## 活動設定

公開文字、配色、難易度標籤、四種反應、問題分類與投票題目都在 [`event.config.json`](./event.config.json)。完整欄位說明位於 [`skills/live-deck-kit/references/configuration.md`](./skills/live-deck-kit/references/configuration.md)。

`eventId` 會參與 Durable Object 名稱。正式活動產生資料後不要任意修改，除非希望切換成一個全新的空白活動。

## 管理 API

先把 `.live-deck-admin-token` 讀進暫時的 shell 變數，完成後取消變數。

```bash
LIVE_DECK_ADMIN_TOKEN="$(tr -d '\n' < .live-deck-admin-token)"

curl -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/api/admin/export

curl -X POST -H "Authorization: Bearer $LIVE_DECK_ADMIN_TOKEN" \
  https://YOUR-WORKER.workers.dev/api/admin/reset

unset LIVE_DECK_ADMIN_TOKEN
```

清空資料無法從服務復原，執行前應先匯出並確認活動網址。

## 測試

```bash
npm run doctor
npm run typecheck
npm test
npm run deploy:dry
```

測試使用 Cloudflare 官方的 Vitest Workers integration，會在 Workers runtime 內操作真正的 Durable Object binding。預設測試只建立少量參與者，不包含壓力測試。

## 來源與模組

- 即時互動流程與 Durable Objects 路由受到 [`htlin222/kahoot-cf`](https://github.com/htlin222/kahoot-cf) 啟發，原專案採 MIT License
- 問題分類與討論閉環受到 [`audreyt/uncommon-ground`](https://github.com/audreyt/uncommon-ground) 啟發，原專案採 CC0-1.0
- 即時狀態使用 Cloudflare Workers、Durable Objects、SQLite 與 Hibernation WebSockets
- QR Code 使用 [`soldair/node-qrcode`](https://github.com/soldair/node-qrcode)

Live Deck Kit 已針對簡報旁的即時難易度、提問、反應與投票重新實作，沒有帶入 kahoot-cf 的題庫編輯器、登入、計分或遊戲週期。

## 授權

[Apache License 2.0](./LICENSE)。允許修改、散布與商業使用，並包含明確的專利授權。第三方說明見 [`NOTICE`](./NOTICE) 與 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
