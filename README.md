# Cashflow Telegram Bot

A 24/7 Telegram expense tracker designed for free hosting on Cloudflare Workers with Cloudflare D1.

Cloudflare Workers do not run as a permanent process. Telegram sends each bot update to `/webhook`, the Worker handles it, stores data in D1, replies to Telegram, then exits. This keeps the bot available without paying for an always-on server.

## Commands

```text
/start
/menu
/add 5000 food
/today
/transactions
/summary
/month
/categories
/total
/clear
```

## Bot Flow

- `/menu` opens the main dashboard.
- `Quick Add` lets you pick a category and a preset amount without typing.
- `/add 5000 food` records a custom expense.
- `Today` shows today's total, entry count, average, biggest expense, and top categories.
- `Month` shows the same summary for the current month.
- `Categories` shows the monthly category breakdown.
- `Transactions` lists today's entries.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Log in to Cloudflare:

```bash
npx wrangler login
```

3. Create a D1 database:

```bash
npx wrangler d1 create cashflow_bot
```

4. Copy the generated `database_id` into `wrangler.toml`.

5. Create the table:

```bash
npm run db:migrate:remote
```

6. Set Cloudflare Worker secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Use any random long string for `WEBHOOK_SECRET`.

7. Deploy:

```bash
npm run deploy
```

8. Register the Telegram webhook:

```bash
$env:TELEGRAM_BOT_TOKEN="your-bot-token"
$env:WEBHOOK_SECRET="same-secret-from-step-6"
$env:WORKER_URL="https://cashflow-bot.your-subdomain.workers.dev"
npm run set:webhook
```

On macOS/Linux, use `export TELEGRAM_BOT_TOKEN=...` instead of `$env:...`.

The webhook setup drops pending Telegram updates, so old messages should not replay after deployment.

## Local Development

Create `.dev.vars` from `.dev.vars.example`, then run:

```bash
npm run db:migrate:local
npm run dev
```

For real Telegram testing, deploy first and use the public Worker URL as the webhook.

## Important Security Note

If your Telegram token was ever committed, shared, or printed in logs, rotate it in BotFather before deploying.
