const TIME_ZONE = "Asia/Bangkok";
const CURRENCY = "KHR";
const QUICK_CATEGORIES = ["Food", "Coffee", "Transport", "Taxi", "Rent", "Shopping", "Bills", "Other"];
const QUICK_AMOUNTS = [2000, 5000, 10000, 20000];

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET") {
            return json({ ok: true, service: "cashflow-bot" });
        }

        if (request.method !== "POST" || url.pathname !== "/webhook") {
            return json({ ok: false, error: "Not found" }, 404);
        }

        if (!env.TELEGRAM_BOT_TOKEN) {
            return json({ ok: false, error: "Missing TELEGRAM_BOT_TOKEN" }, 500);
        }

        if (env.WEBHOOK_SECRET) {
            const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
            if (secret !== env.WEBHOOK_SECRET) {
                return json({ ok: false, error: "Unauthorized" }, 401);
            }
        }

        const update = await request.json();
        await handleUpdateSafely(update, env);

        return json({ ok: true });
    },
};

async function handleUpdateSafely(update, env) {
    try {
        const isDuplicate = await wasUpdateProcessed(env.DB, update.update_id);
        if (isDuplicate) {
            return;
        }

        await handleUpdate(update, env);
    } catch (error) {
        console.error("Failed to handle Telegram update", error);
    }
}

async function wasUpdateProcessed(db, updateId) {
    if (typeof updateId !== "number") {
        return false;
    }

    try {
        const result = await db
            .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
            .bind(updateId)
            .run();

        return result.meta?.changes === 0;
    } catch (error) {
        console.error("Could not save processed update id", error);
        return false;
    }
}

async function handleUpdate(update, env) {
    if (update.message) {
        await handleMessage(update.message, env);
        return;
    }

    if (update.callback_query) {
        await handleCallback(update.callback_query, env);
    }
}

async function handleMessage(message, env) {
    const text = (message.text || "").trim();
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);

    if (text === "/start" || text === "/menu") {
        await sendMainMenu(env, chatId, userId, message.from);
        return;
    }

    if (text.startsWith("/add")) {
        await addExpenseFromCommand(env, chatId, userId, text);
        await sendMainMenu(env, chatId, userId, message.from);
        return;
    }

    if (text === "/transactions" || text === "/today") {
        await sendTransactions(env, chatId, userId);
        return;
    }

    if (text === "/summary") {
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (text === "/month") {
        await sendSummary(env, chatId, userId, "month");
        return;
    }

    if (text === "/categories") {
        await sendCategoryBreakdown(env, chatId, userId, "month");
        return;
    }

    if (text === "/total") {
        const total = await getTotalExpenses(env.DB, userId);
        await sendMessage(env, chatId, `Total expenses: ${formatMoney(total)} ${CURRENCY}`);
        return;
    }

    if (text === "/clear") {
        await askClearConfirmation(env, chatId);
        return;
    }

    if (text.startsWith("/")) {
        await sendMessage(env, chatId, "Unknown command. Use /menu to open the bot.");
    }
}

async function handleCallback(callback, env) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);

    await answerCallback(env, callback.id);

    if (!chatId) return;

    if (data === "add_expense") {
        await sendCategoryPicker(env, chatId);
        return;
    }

    if (data.startsWith("cat:")) {
        await sendAmountPicker(env, chatId, data.slice(4));
        return;
    }

    if (data.startsWith("quick:")) {
        const [, category, amountText] = data.split(":");
        const amount = Number(amountText);
        await addExpenseRecord(env.DB, userId, amount, category);
        await sendMessage(env, chatId, `${formatMoney(amount)} ${CURRENCY} saved to ${category}.`);
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (data === "custom_add") {
        await sendMessage(env, chatId, "Type it like this:\n/add 7500 lunch");
        return;
    }

    if (data === "view_transactions") {
        await sendTransactions(env, chatId, userId);
        return;
    }

    if (data === "summary_today") {
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (data === "summary_month") {
        await sendSummary(env, chatId, userId, "month");
        return;
    }

    if (data === "categories_month") {
        await sendCategoryBreakdown(env, chatId, userId, "month");
        return;
    }

    if (data === "clear_data") {
        await askClearConfirmation(env, chatId);
        return;
    }

    if (data === "clear_today_warn") {
        await sendMessage(env, chatId, "⚠️ Are you sure you want to clear today's expenses? This action cannot be undone.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Yes, clear today", callback_data: "confirm_clear_today" }],
                    [{ text: "Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "clear_all_warn") {
        const total = await getTotalExpenses(env.DB, userId);
        const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?").bind(userId).first();
        const count = countRow?.count || 0;

        if (count === 0) {
            await sendMessage(env, chatId, "You don't have any recorded transactions to delete.");
            return;
        }

        const warningMsg = [
            `⚠️ *WARNING: Permanent Wipe* ⚠️`,
            ``,
            `This will permanently delete *ALL* your transaction history:`,
            `- Total transactions: *${count}*`,
            `- Total spent: *${formatMoney(total)} ${CURRENCY}*`,
            ``,
            `This action cannot be undone. To safeguard your data, we will automatically send you a *CSV backup file* first.`,
            ``,
            `Do you want to proceed?`
        ].join("\n");

        await sendMessage(env, chatId, warningMsg, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Yes, Backup & Wipe All", callback_data: "confirm_clear_all" }],
                    [{ text: "❌ Cancel", callback_data: "cancel_clear" }],
                ],
            },
        });
        return;
    }

    if (data === "confirm_clear" || data === "confirm_clear_today") {
        await clearToday(env.DB, userId);
        await sendMessage(env, chatId, "Today's expenses have been cleared.");
        await sendMainMenu(env, chatId, userId, callback.from);
        return;
    }

    if (data === "confirm_clear_all") {
        try {
            await sendCSVBackup(env, chatId, userId);
        } catch (error) {
            await sendMessage(env, chatId, `❌ Backup failed: ${error.message}\n\nDeletion cancelled to protect your data.`);
            return;
        }

        await clearAllExpenses(env.DB, userId);
        await sendMessage(env, chatId, "🗑️ All historical transactions have been deleted. A backup has been sent above.");
        await sendMainMenu(env, chatId, userId, callback.from);
        return;
    }

    if (data === "cancel_clear") {
        await sendMessage(env, chatId, "Clear cancelled. Your data is still there.");
        return;
    }
}

async function addExpenseFromCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
        await sendMessage(env, chatId, "Usage: /add <amount> <category>\nExample: /add 5000 food");
        return;
    }

    const amount = Number(parts[1]);
    const category = parts.slice(2).join(" ").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage(env, chatId, "Please enter a valid amount.");
        return;
    }

    if (!category) {
        await sendMessage(env, chatId, "Please enter a category.");
        return;
    }

    const date = today();
    await addExpenseRecord(env.DB, userId, amount, category);

    await sendMessage(env, chatId, `${formatMoney(amount)} ${CURRENCY} added for ${category} on ${date}.`);
}

async function sendMainMenu(env, chatId, userId, from) {
    const username = from?.username ? `@${from.username}` : from?.first_name || "there";
    const totalToday = await getTotalToday(env.DB, userId);
    const monthTotal = await getMonthTotal(env.DB, userId);
    const topCategory = await getTopCategory(env.DB, userId, "month");

    const text = [
        `Cashflow for ${username}`,
        "",
        `Today: ${formatMoney(totalToday)} ${CURRENCY}`,
        `This month: ${formatMoney(monthTotal)} ${CURRENCY}`,
        `Top category: ${topCategory || "No spending yet"}`,
        "",
        "Choose what you want to do."
    ].join("\n");

    await sendMessage(env, chatId, text, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Quick Add", callback_data: "add_expense" }],
                [
                    { text: "Today", callback_data: "summary_today" },
                    { text: "Month", callback_data: "summary_month" },
                ],
                [
                    { text: "Transactions", callback_data: "view_transactions" },
                    { text: "Categories", callback_data: "categories_month" },
                ],
                [
                    { text: "Clear Today", callback_data: "clear_data" },
                ],
            ],
        },
    });
}

async function sendCategoryPicker(env, chatId) {
    const rows = [];
    for (let i = 0; i < QUICK_CATEGORIES.length; i += 2) {
        rows.push(
            QUICK_CATEGORIES.slice(i, i + 2).map((category) => ({
                text: category,
                callback_data: `cat:${category}`,
            }))
        );
    }

    rows.push([{ text: "Custom: type /add 5000 lunch", callback_data: "custom_add" }]);

    await sendMessage(env, chatId, "Pick a category.", {
        reply_markup: { inline_keyboard: rows },
    });
}

async function sendAmountPicker(env, chatId, category) {
    const rows = QUICK_AMOUNTS.map((amount) => [
        {
            text: `${formatMoney(amount)} ${CURRENCY}`,
            callback_data: `quick:${category}:${amount}`,
        },
    ]);

    rows.push([{ text: "Custom amount: /add 7500 " + category, callback_data: "custom_add" }]);

    await sendMessage(env, chatId, `How much for ${category}?`, {
        reply_markup: { inline_keyboard: rows },
    });
}

async function sendTransactions(env, chatId, userId) {
    const date = today();
    const { results } = await env.DB.prepare(
        "SELECT amount, category, created_at FROM expenses WHERE user_id = ? AND date = ? ORDER BY id ASC"
    )
        .bind(userId, date)
        .all();

    if (!results.length) {
        await sendMessage(env, chatId, "No transactions recorded today.");
        return;
    }

    const lines = results.map((row, index) => {
        return `${index + 1}. ${capitalize(row.category)} - ${formatMoney(row.amount)} ${CURRENCY}`;
    });

    await sendMessage(env, chatId, [`Transactions for ${date}:`, "", ...lines].join("\n"));
}

async function sendSummary(env, chatId, userId, period) {
    const stats = await getPeriodStats(env.DB, userId, period);
    const breakdown = await getCategoryRows(env.DB, userId, period, 5);
    const title = period === "month" ? `Month summary (${monthLabel()})` : `Today summary (${today()})`;

    const lines = [
        title,
        "",
        `Spent: ${formatMoney(stats.total)} ${CURRENCY}`,
        `Entries: ${stats.count}`,
        `Average: ${formatMoney(stats.average)} ${CURRENCY}`,
    ];

    if (stats.maxAmount) {
        lines.push(`Biggest: ${formatMoney(stats.maxAmount)} ${CURRENCY} on ${capitalize(stats.maxCategory)}`);
    }

    if (breakdown.length) {
        lines.push("", "Top categories:");
        for (const row of breakdown) {
            const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
            lines.push(`${capitalize(row.category)}: ${formatMoney(row.total)} ${CURRENCY} (${percent}%)`);
        }
    }

    await sendMessage(env, chatId, lines.join("\n"), {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Quick Add", callback_data: "add_expense" }],
                [
                    { text: "Today", callback_data: "summary_today" },
                    { text: "Month", callback_data: "summary_month" },
                ],
                [{ text: "Transactions", callback_data: "view_transactions" }],
            ],
        },
    });
}

async function sendCategoryBreakdown(env, chatId, userId, period) {
    const rows = await getCategoryRows(env.DB, userId, period, 10);
    const stats = await getPeriodStats(env.DB, userId, period);
    const title = period === "month" ? `Category breakdown for ${monthLabel()}` : `Category breakdown for ${today()}`;

    if (!rows.length) {
        await sendMessage(env, chatId, "No category data yet.");
        return;
    }

    const lines = [title, ""];
    for (const row of rows) {
        const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
        lines.push(`${capitalize(row.category)}: ${formatMoney(row.total)} ${CURRENCY} (${percent}%)`);
    }

    await sendMessage(env, chatId, lines.join("\n"));
}

async function askClearConfirmation(env, chatId) {
    await sendMessage(env, chatId, "What would you like to clear?", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Today's expenses only", callback_data: "clear_today_warn" }],
                [{ text: "ALL history (Full Reset)", callback_data: "clear_all_warn" }],
                [{ text: "Cancel", callback_data: "cancel_clear" }],
            ],
        },
    });
}

async function getTotalToday(db, userId) {
    const row = await db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND date = ?")
        .bind(userId, today())
        .first();

    return Number(row?.total || 0);
}

async function getTotalExpenses(db, userId) {
    const row = await db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ?")
        .bind(userId)
        .first();

    return Number(row?.total || 0);
}

async function getMonthTotal(db, userId) {
    const row = await db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = ? AND date LIKE ?")
        .bind(userId, `${monthPrefix()}%`)
        .first();

    return Number(row?.total || 0);
}

async function getTopCategory(db, userId, period) {
    const rows = await getCategoryRows(db, userId, period, 1);
    if (!rows.length) return null;
    return `${capitalize(rows[0].category)} (${formatMoney(rows[0].total)} ${CURRENCY})`;
}

async function getPeriodStats(db, userId, period) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(amount), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(amount), 0) AS average,
                    COALESCE(MAX(amount), 0) AS maxAmount
             FROM expenses
             WHERE user_id = ? AND ${condition}`
        )
        .bind(userId, value)
        .first();

    const biggest = await db
        .prepare(
            `SELECT amount, category
             FROM expenses
             WHERE user_id = ? AND ${condition}
             ORDER BY amount DESC, id DESC
             LIMIT 1`
        )
        .bind(userId, value)
        .first();

    return {
        total: Number(row?.total || 0),
        count: Number(row?.count || 0),
        average: Number(row?.average || 0),
        maxAmount: Number(biggest?.amount || 0),
        maxCategory: biggest?.category || "",
    };
}

async function getCategoryRows(db, userId, period, limit) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    const { results } = await db
        .prepare(
            `SELECT category, SUM(amount) AS total, COUNT(*) AS count
             FROM expenses
             WHERE user_id = ? AND ${condition}
             GROUP BY LOWER(category)
             ORDER BY total DESC
             LIMIT ?`
        )
        .bind(userId, value, limit)
        .all();

    return results || [];
}

async function addExpenseRecord(db, userId, amount, category) {
    await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category) VALUES (?, ?, ?, ?)")
        .bind(userId, today(), amount, normalizeCategory(category))
        .run();
}

async function clearToday(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ? AND date = ?")
        .bind(userId, today())
        .run();
}

async function clearAllExpenses(db, userId) {
    await db
        .prepare("DELETE FROM expenses WHERE user_id = ?")
        .bind(userId)
        .run();
}

async function sendCSVBackup(env, chatId, userId) {
    const { results } = await env.DB.prepare(
        "SELECT date, category, amount, created_at FROM expenses WHERE user_id = ? ORDER BY date ASC, id ASC"
    )
        .bind(userId)
        .all();

    if (!results || results.length === 0) {
        throw new Error("No transactions found to backup.");
    }

    // Build CSV content
    let csvContent = "Date,Category,Amount,Created At\n";
    for (const row of results) {
        const escapedCategory = String(row.category || "").replace(/"/g, '""');
        csvContent += `"${row.date}","${escapedCategory}",${row.amount},"${row.created_at}"\n`;
    }

    // Send document to Telegram
    const formData = new FormData();
    formData.append("chat_id", chatId);
    const file = new File([csvContent], `cashflow_backup_${today()}.csv`, { type: "text/csv" });
    formData.append("document", file);
    formData.append("caption", "Here is a CSV backup of your expenses before wiping.");

    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
        {
            method: "POST",
            body: formData,
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram sendDocument failed with status ${response.status}: ${detail}`);
    }
}

async function sendMessage(env, chatId, text, extra = {}) {
    return telegram(env, "sendMessage", {
        chat_id: chatId,
        text,
        ...extra,
    });
}

async function answerCallback(env, callbackQueryId) {
    if (!callbackQueryId) return;
    return telegram(env, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
    });
}

async function telegram(env, method, payload) {
    const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }
    );

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram ${method} failed: ${response.status} ${detail}`);
    }

    return response.json();
}

function today() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function monthPrefix() {
    return today().slice(0, 7);
}

function monthLabel() {
    return new Intl.DateTimeFormat("en-US", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "long",
    }).format(new Date());
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString("en-US", {
        maximumFractionDigits: 2,
    });
}

function capitalize(value) {
    if (!value) return "";
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeCategory(value) {
    const category = String(value || "").trim().replace(/\s+/g, " ");
    if (!category) return "Other";
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}
