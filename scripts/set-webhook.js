const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrl = process.env.WORKER_URL;
const secret = process.env.WEBHOOK_SECRET;

if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN.");
    process.exit(1);
}

if (!workerUrl) {
    console.error("Missing WORKER_URL. Example: https://cashflow-bot.your-name.workers.dev");
    process.exit(1);
}

const webhookUrl = `${workerUrl.replace(/\/$/, "")}/webhook`;
const body = {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
};

if (secret) {
    body.secret_token = secret;
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
});

const data = await response.json();

if (!response.ok || !data.ok) {
    console.error("Failed to set webhook:", data);
    process.exit(1);
}

console.log(`Webhook set to ${webhookUrl}`);
