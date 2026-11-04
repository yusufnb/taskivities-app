# Taskivities

A team's week at a glance: everyone records their daily tasks against a project. Tasks can be assigned or transferred to anyone on the project, every change is kept in an append-only history, overdue tasks roll into today until someone finishes or moves them, and every open browser updates on its own.

The design reference is [`docs/wireframes.html`](docs/wireframes.html). Open it in a browser.

## Stack

| Part | What |
|---|---|
| App | React 19 + TypeScript, built with Vite, served as static assets by the Worker |
| API | One Cloudflare Worker using [Hono](https://hono.dev) (`worker/`) |
| Database | Cloudflare D1 (SQLite). Schema in `migrations/` |
| Sign-in | Google OAuth (code + PKCE), handled in the Worker, with HttpOnly session cookies stored in D1 |
| Live updates | The browser polls `/api/sync?since=<version>` every 10s (every 60s when the tab is hidden) |
| AI assistants | Remote MCP server at `/mcp` (Streamable HTTP) on the same Worker: Cloudflare's `agents` SDK (`McpAgent`, one Durable Object per session) behind `@cloudflare/workers-oauth-provider` (OAuth 2.1 + dynamic client registration, tokens in KV) |

```
worker/   index.ts (routes + OAuth provider) · auth.ts (Google + sessions) · api.ts (REST: tasks, sync) · tasks.ts (task rules shared by REST and MCP)
          mcp.ts (MCP tools) · oauth.ts (/authorize consent page for assistants) · admin.ts (people, projects) · lib.ts
shared/   types, date helpers and rules used by both the Worker and the app
src/      React app: pages/ (Tasks, Projects, Team, Login), components/, actions.ts (all writes), keyboard.ts, focus.ts
migrations/0001_init.sql   seed/dev.sql (local sample data)
```

## Rules the code enforces

- **Every task has a project, a due date, an assignee and a priority.** The columns are `NOT NULL`, and the API rejects any attempt to clear them.
- **Rollover is computed, never stored.** An open task with a past due date is shown on today, and "days late" keeps counting (`shared/rules.ts → shownOn`). There's no nightly job.
- **History is append-only.** Every write updates `tasks` and inserts into `task_events` in the same D1 batch, and database triggers refuse any `UPDATE` or `DELETE` on `task_events`.
- **Roles:**
  - Admins see every project and are the only ones who manage people and projects.
  - Members see only the projects they're on.
  - A task's assignee must always be on that task's project.
- **Sign-in:** only email addresses added by an admin can sign in. On a brand-new install, the **first person to sign in becomes the admin** (the check is one atomic insert, so only one person can win). The optional `ADMIN_EMAILS` secret names addresses that are always let in as admins, which is useful for getting back in if you lock yourself out.
- **Writes come only from the app's own pages:** they need the same origin plus a custom header, and the session cookie is `SameSite=Lax`. The one exception is `/mcp`, which takes an OAuth bearer token instead (see below).
- **One set of task rules.** The REST API and the MCP tools both call `worker/tasks.ts` (`createTask`, `applyPatch`), so visibility, "assignee must be on the project" and "no past due dates" can't diverge.

## AI assistants (MCP)

The Worker serves a remote MCP server at `https://<your-app-host>/mcp`. In Claude, add it as a custom connector with that URL; other MCP clients take the same URL. The client registers itself, the person signs in with the same Google account (or is already signed in), and approves the assistant on a consent page at `/authorize`. From then on **the assistant acts as that person**: it sees only what they see, follows the same rules, and every change it makes is written to the task history with `task_events.via` set to the client's registered name (shown as "via Claude").

| Tool | What it does |
|---|---|
| `list_projects()` | Your projects: name, description, color, and who can be assigned there. The descriptions tell the assistant where tasks belong |
| `list_tasks(user?, project?, from?, to?, status?)` | Tasks by the day the app shows them on, with the same rollover rule (`shownOn`): "today" includes carried-over tasks. Defaults to today; at most 92 days |
| `create_task(title, project, due_date, assignee, priority, notes?)` | All five main fields required. The tool description includes the project descriptions, so the assistant can pick the project without asking |
| `update_task(id, title?, notes?, project?, due_date?, priority?, status?)` | Only the fields given change; `status: "open"` reopens |
| `complete_task(id)` | Marks it done today |
| `transfer_task(id, to, note?)` | The new assignee must be on the task's project |
| `project_day(project, date)` | What got finished in a project that day (by priority, then due date), plus what's still open |

People and projects are given by name (or email, or "me"), not ids. Access is checked on every call, so removing someone or taking them off a project applies to their assistant at once. Access tokens last an hour; a connection lasts 30 days from approval, after which the person signs in again. Removing a person (or setting them inactive) cuts their assistant off immediately.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:reset:local     # creates the local D1 database and loads the sample data
npm run dev                # http://localhost:5173
```

Open http://localhost:5173/login and use **Local development sign-in**, for example `jordan@example.com` (admin) or `sara@example.com` (member). This route only works when `DEV_LOGIN=1` is set and the request comes from localhost. Google isn't needed locally unless you want to try the real sign-in.

Useful commands: `npm run typecheck` · `npm run build` · `npm run db:migrate:local`

**Trying the MCP server locally.** With `npm run dev` running, start the MCP Inspector with `npx @modelcontextprotocol/inspector`, choose *Streamable HTTP*, enter `http://localhost:5173/mcp` and connect. It opens the consent page; if you aren't signed in, use the local development sign-in there and you'll come back to it. Changes made through the Inspector show up in the app's history as "via MCP Inspector" (or whatever name the client registered with). Local OAuth data lives in the local KV under `.wrangler/state`.

## Deploy to Cloudflare

1. **Create a Google OAuth client.** In Google Cloud Console, go to *APIs & Services → Credentials → Create credentials → OAuth client ID*.
   - Type: **Web application**.
   - Authorized redirect URIs: `https://<your-app-host>/auth/callback`, plus `http://localhost:5173/auth/callback` for local use.
   - Consent screen: *Internal* if everyone is in your Google Workspace. Otherwise use *External* and publish it, since external people such as clients are added by email. Scopes: `openid`, `email`, `profile`.
2. **Sign in to Cloudflare:** `npx wrangler login`
3. **Create the database:** `npx wrangler d1 create taskivities`, then paste the printed `database_id` into `wrangler.jsonc`.
   **Create the OAuth store for AI assistants:** `npx wrangler kv namespace create OAUTH_KV`, then paste the printed `id` into the `kv_namespaces` entry in `wrangler.jsonc`. (The MCP session Durable Object needs no setup: its binding and migration are already in `wrangler.jsonc` and are created on the first deploy.)
4. **Set the team time zone** in `wrangler.jsonc` (`TEAM_TZ`, e.g. `Europe/London`). It decides when "today" starts for everyone.
5. **Create the tables:** `npm run db:migrate:remote`
6. **Add the secrets:**
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
   Optional: `npx wrangler secret put ADMIN_EMAILS` (comma-separated addresses that are always admins).
7. **Deploy:** `npm run deploy`. You get `https://taskivities.<your-subdomain>.workers.dev`. To use your own domain, add it under *Workers → taskivities → Settings → Domains & Routes*.
8. Add the final `https://…/auth/callback` URL to the Google client if you haven't already. Then **sign in right away**: on an empty install the first person to sign in becomes the admin. Add your team on the **Team** page.
9. **Connect an assistant:** in Claude, add a custom connector with `https://<your-app-host>/mcp` and sign in. Nothing else to configure: assistants sign in through the same Google client.

`DEV_LOGIN` is never set in production, so the development sign-in route returns 404 there.

## Not built yet

- **A list of connected assistants** in the app, with a way to disconnect them. For now a connection ends after 30 days, when the person is removed, or when an admin deletes its grant from the `OAUTH_KV` namespace.
- **Invite emails.** Admins currently share the link themselves.
- **Archiving projects** from the UI. The column exists, but there's no button yet.
- **Automated tests.** So far everything has been checked by hand in the browser and with the API.
