<div align="center">

# ⚔️ Open Code War

**A leaderboard game where Claude Code users compete on "who types the most."**

A plugin hook counts your input activity anonymously → stores it on Cloudflare → shows daily / weekly / weekend rankings and a per-country map on the web.

**English** · [한국어](README.md)

[![website](https://img.shields.io/badge/opencodewar.dev-1a1a1a?style=for-the-badge)](https://opencodewar.dev)
[![status](https://img.shields.io/badge/status-early%20development-e08a2e?style=for-the-badge)](#-roadmap)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6c5ce7?style=for-the-badge)](#-install-the-plugin)

<sub>Codename: <b>OCW</b> · First target 🇰🇷 Korea → eventually a worldwide per-country globe ranking</sub>

</div>

---

## 🔒 Privacy first

Open Code War **never collects prompt content.** It only counts the number of submissions and the character count (a number).

| ✅ Collected | ❌ Not collected |
|--------------|------------------|
| Anonymous `userId` (auto-generated on device, irreversible) | Prompt **content** |
| Number of prompt **submissions** | Code · files · paths |
| Prompt **character count** (a single integer) | Email · real name or other PII |
| (server-side) request country `cf.country` | Raw IP storage |

> Even though the hook receives the raw prompt, it **computes only the character count and sends that — never the text.** It runs **fail-open** (short timeout + background fire-and-forget) so it never blocks or slows down your use of Claude Code, even if the network fails.

---

## 🧩 How it works

```
┌──────────────────────────────┐   POST /track      ┌───────────────────────────┐
│  Claude Code plugin           │  ─ userId,chars ─▶ │  Cloudflare Worker         │
│  · UserPromptSubmit hook      │                    │  · detects cf.country      │
│  · /ocw nickname command      │  ─ POST /register ▶│  · records events + aggreg.│
│  · ~/.open-code-war/config    │                    │  · Cron snapshot (KV)      │
└──────────────────────────────┘                    └───────────┬───────────────┘
                                                                 │ D1 (SQLite)
                                    GET /leaderboard             ▼
┌──────────────────────────────┐   GET /countries    ┌───────────────────────────┐
│  Leaderboard web (static)     │  ◀──── JSON ─────── │  daily/weekly/weekend/by  │
│  daily·weekly·weekend · map   │                    │  country ranking snapshot │
└──────────────────────────────┘                    └───────────────────────────┘
```

- **Collection** — the plugin's `UserPromptSubmit` hook sends an event to the Worker on every submission (content excluded).
- **Storage / aggregation** — the Worker attaches the request country (`cf.country`) and records to D1, aggregating by KST (UTC+9) day. The leaderboard is served from a **Cron batch snapshot** (KV) rather than live, reducing D1 load.
- **Display** — the static web calls the Worker's read API to render rankings / the map.

---

## 📂 Repository layout (monorepo)

```
open-code-war/
├── plugin/            # Claude Code plugin (collection hook + /ocw command)
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json          # UserPromptSubmit → track.mjs (async·non-blocking)
│   ├── commands/ocw.md           # /ocw slash command
│   └── scripts/                  # track.mjs, ocw-cli.mjs, lib/
├── backend/           # Cloudflare Worker + D1 API
│   ├── src/                      # Worker source
│   ├── migrations/               # D1 schema
│   ├── seed/                     # test seed
│   └── wrangler.jsonc
├── web/               # static leaderboard web (daily·weekly·weekend + map)
├── mockups/           # web design mockups
└── DESIGN.md          # detailed design doc (v0.1)
```

---

## 🚀 Install the plugin

### From the marketplace (recommended)

```
/plugin marketplace add dodohankim/opencodewar
/plugin install open-code-war@opencodewar
```

Manage/enable it under the **Installed** tab of the `/plugin` menu.

### Turn on auto-update (recommended)

The plugin is **unpinned and tracks the latest commit**, so once you enable auto-update it picks up every new release automatically at Claude Code startup.

```
/plugin   →   Marketplaces tab   →   select opencodewar   →   enable auto-update
```

To update right now manually:

```
/plugin marketplace update opencodewar
/reload-plugins
```

> ℹ️ The backend is **deployed and live (beta)** with its URL baked into the plugin, so collection works right after install. (The `/plugin marketplace add` command requires this repo to be pushed to GitHub.)

### Development (local load)

```bash
export OCW_API_URL="http://localhost:8787"   # local backend (cd backend && npm run dev)
claude --plugin-dir ./plugin
```

Register a nickname / check status / turn collection on-off:

```
/ocw nickname <name>     # register or change your leaderboard display name
/ocw status              # show your userId · nickname · collection state
/ocw enable | disable    # turn collection on/off
```

- Config file: `~/.open-code-war/config.json` (userId · nickname · on/off)
- ⚠️ Your `userId` is **both your identity and your secret key.** Don't share it.

---

## 🛠️ Local development

### Backend (Cloudflare Worker + D1)

```bash
cd backend
npm install
npm run db:migrate:local     # apply schema to local D1
npm run db:seed:local        # seed test data
npm run dev                  # wrangler dev (http://localhost:8787)
```

Other scripts: `npm run typecheck` · `npm run test` (vitest) · `npm run deploy`.

### Web

Serve `web/index.html` with any static server (it connects to the backend read API).

---

## 🔌 API (Worker endpoints)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/track` | collect an input event (rate-limit, attaches `cf.country`) |
| `POST` | `/register` | register/change nickname (uniqueness · profanity check) |
| `GET`  | `/leaderboard?type=daily\|weekly\|weekend&metric=prompts\|chars&limit=100` | ranking (snapshot cache) |
| `GET`  | `/countries?type=…` | per-country totals (for the globe) |

All aggregation windows are **KST (UTC+9)**; weekend = Fri · Sat · Sun.

---

## 🗺️ Roadmap

| Stage | What | Status |
|-------|------|--------|
| **M1** | Backend skeleton — Worker + D1 schema + `/track` `/leaderboard` | ✅ |
| **M2** | Collection plugin — `UserPromptSubmit` hook, anonymous ID, `/register` nickname | ✅ |
| **M3** | Connect leaderboard web to the real API + KV snapshot caching | ✅ |
| **Next** | Marketplace release · globe per-country ranking · stronger anti-abuse (rate-limit) | ⬜ |

See [`DESIGN.md`](./DESIGN.md) for detailed design and decisions.

### Non-goals (out of scope for v1)
- Collecting/storing prompt **content** (never, for privacy)
- Cash / monetary rewards (abuse-verification burden — discussed separately)
- Real-time PvP / multiplayer (v1 is batch-aggregated ranking)

---

## 📄 License

**Business Source License 1.1 (BSL)** — see [`LICENSE`](./LICENSE) for full terms.

- The source is **public** so anyone can read and audit it. (Important for verifying the privacy claims.)
- **Personal, educational, and internal plugin use, and non-commercial self-hosting are free.**
- However, offering it as an ad/sponsorship-based **commercial or competing service**, or **removing/circumventing the ad · sponsorship · attribution features**, is not permitted.
- On the **Change Date (2030-07-09)** it automatically converts to the **Apache License 2.0**.

> BSL is not an OSI-approved open-source license; it is 'source-available'. The name/logo (Open Code War, opencodewar) and the domain trademark are protected independently of the license.

<div align="center">
<sub>Made for the Claude Code community · <a href="https://opencodewar.dev">opencodewar.dev</a></sub>
</div>
