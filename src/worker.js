import dashboardHtml from "./dashboard_html.js";

const TIME_ZONE = "Asia/Bangkok";
const CURRENCY = "KHR";
const EXCHANGE_RATE = 4000; // 1 USD = 4000 KHR
const QUICK_CATEGORIES = ["Food", "Coffee", "Transport", "Taxi", "Rent", "Shopping", "Bills", "Other"];
const QUICK_AMOUNTS = [2000, 5000, 10000, 20000];

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET") {
            if (url.pathname === "/dashboard") {
                return new Response(dashboardHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }

            if (url.pathname === "/api/data") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                const summary = await getFinancialSummary(env.DB, userId, "all");
                const categories = await getCategoryRows(env.DB, userId, "month", 10);

                const daily = [];
                for (let i = 6; i >= 0; i--) {
                    const d = dateDaysAgo(i);
                    const dayRow = await env.DB.prepare(
                        `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total
                         FROM expenses
                         WHERE user_id = ? AND type = 'expense' AND date = ?`
                    )
                    .bind(userId, d)
                    .first();
                    daily.push({
                        date: d,
                        total: Number(dayRow?.total || 0),
                    });
                }

                const recentRows = await env.DB.prepare(
                    `SELECT id, amount, category, type, currency, date, created_at
                     FROM expenses
                     WHERE user_id = ?
                     ORDER BY date DESC, id DESC
                     LIMIT 10`
                )
                .bind(userId)
                .all();

                const settingsRow = await env.DB.prepare(
                    "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
                )
                .bind(userId)
                .first();
                const budgetKhr = settingsRow?.monthly_budget || 0;

                const monthSummary = await getFinancialSummary(env.DB, userId, "month");
                const monthExpenseKhr = monthSummary?.totalExpenseInKhr || 0;

                return json({
                    summary,
                    categories,
                    daily,
                    recent: recentRows.results || [],
                    budgetKhr,
                    monthExpenseKhr
                });
            }

            if (url.pathname === "/api/history") {
                const userId = url.searchParams.get("user_id");
                if (!userId) {
                    return json({ error: "Missing user_id parameter" }, 400);
                }

                const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
                const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));
                const offset = (page - 1) * limit;

                const type = url.searchParams.get("type"); // optional: 'income' or 'expense'
                const search = url.searchParams.get("search")?.trim(); // optional keyword search

                let query = "SELECT id, amount, category, type, currency, date, created_at FROM expenses WHERE user_id = ?";
                let countQuery = "SELECT COUNT(*) as count FROM expenses WHERE user_id = ?";
                const params = [userId];
                const countParams = [userId];

                if (type && (type === "income" || type === "expense")) {
                    query += " AND type = ?";
                    countQuery += " AND type = ?";
                    params.push(type);
                    countParams.push(type);
                }

                if (search) {
                    query += " AND (category LIKE ? OR CAST(amount AS TEXT) LIKE ?)";
                    countQuery += " AND (category LIKE ? OR CAST(amount AS TEXT) LIKE ?)";
                    const searchPattern = `%${search}%`;
                    params.push(searchPattern, searchPattern);
                    countParams.push(searchPattern, searchPattern);
                }

                query += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?";
                params.push(limit, offset);

                const countRow = await env.DB.prepare(countQuery).bind(...countParams).first();
                const total = Number(countRow?.count || 0);

                const { results } = await env.DB.prepare(query).bind(...params).all();

                return json({
                    transactions: results || [],
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                });
            }

            return json({ ok: true, service: "cashflow-bot" });
        }

        if (request.method === "POST") {
            if (url.pathname === "/api/delete") {
                const userId = url.searchParams.get("user_id");
                const txId = url.searchParams.get("id");
                if (!userId || !txId) {
                    return json({ error: "Missing parameters" }, 400);
                }

                const result = await env.DB.prepare("DELETE FROM expenses WHERE user_id = ? AND id = ?")
                    .bind(userId, txId)
                    .run();

                return json({ ok: true, changes: result.meta?.changes || 0 });
            }

            if (url.pathname === "/webhook") {
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
                await handleUpdateSafely(update, env, url.origin);

                return json({ ok: true });
            }

            return json({ ok: false, error: "Not found" }, 404);
        }

        return json({ ok: false, error: "Not found" }, 404);
    },

    async scheduled(event, env) {
        try {
            await sendWeeklyScheduledReports(env);
        } catch (error) {
            console.error("Scheduled cron task failed", error);
        }
    },
};

async function handleUpdateSafely(update, env, origin) {
    try {
        const isDuplicate = await wasUpdateProcessed(env.DB, update.update_id);
        if (isDuplicate) {
            return;
        }

        await handleUpdate(update, env, origin);
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

async function handleUpdate(update, env, origin) {
    if (update.message) {
        await handleMessage(update.message, env, origin);
        return;
    }

    if (update.callback_query) {
        await handleCallback(update.callback_query, env, origin);
    }
}

async function handleMessage(message, env, origin) {
    const text = (message.text || "").trim();
    const chatId = message.chat.id;
    const userId = String(message.from?.id || chatId);

    if (text === "/start" || text === "/menu") {
        await sendMainMenu(env, chatId, userId, message.from, origin);
        return;
    }

    if (text.startsWith("/add") || text.startsWith("/income")) {
        await addTransactionFromCommand(env, chatId, userId, text);
        await sendMainMenu(env, chatId, userId, message.from, origin);
        return;
    }

    if (text === "/transactions" || text === "/today") {
        await sendTransactions(env, chatId, userId);
        return;
    }

    if (text.startsWith("/budget")) {
        await handleBudgetCommand(env, chatId, userId, text);
        return;
    }

    if (text.startsWith("/history") || text === "/all") {
        const parts = text.split(/\s+/);
        let page = 1;
        if (parts.length > 1) {
            const parsedPage = parseInt(parts[1], 10);
            if (Number.isInteger(parsedPage) && parsedPage > 0) {
                page = parsedPage;
            }
        }
        await sendHistory(env, chatId, userId, page);
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

    if (text === "/week") {
        const startDate = dateDaysAgo(6);
        const endDate = today();
        await sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, "Weekly Spending Report (Rolling 7 Days)");
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

    if (text === "/help" || text === "/h") {
        await sendHelpMessage(env, chatId);
        return;
    }

    if (text.startsWith("/")) {
        await sendMessage(env, chatId, "⚠️ Unknown command. Type /help to see all available commands, or /menu to open the dashboard.");
    }
}

async function handleCallback(callback, env, origin) {
    const data = callback.data || "";
    const chatId = callback.message?.chat?.id;
    const userId = String(callback.from?.id || chatId);

    await answerCallback(env, callback.id);

    if (!chatId) return;

    if (data === "toggle_currency") {
        const currentCurrency = await getDisplayCurrency(env.DB, userId);
        const newCurrency = currentCurrency === "USD" ? "KHR" : "USD";
        await setDisplayCurrency(env.DB, userId, newCurrency);
        const flag = newCurrency === "USD" ? "🇺🇸" : "🇰🇭";
        await sendMessage(env, chatId, `${flag} Display switched to *${newCurrency}*!`, { parse_mode: "Markdown" });
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "menu") {
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

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
        let msg = `✅ *${formatMoney(amount)} ${CURRENCY}* saved to ${category}.`;
        msg += await getBudgetWarningText(env.DB, userId);
        await sendMessage(env, chatId, msg, { parse_mode: "Markdown" });
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

    if (data.startsWith("history:")) {
        const page = parseInt(data.slice(8), 10) || 1;
        await updateHistoryMessage(env, chatId, userId, callback.message.message_id, page);
        return;
    }

    if (data === "summary_today") {
        await sendSummary(env, chatId, userId, "today");
        return;
    }

    if (data === "summary_week") {
        const startDate = dateDaysAgo(6);
        const endDate = today();
        await sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, "Weekly Spending Report (Rolling 7 Days)");
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
            `⚠️ *PERMANENT DATABASE RESET* ⚠️`,
            `This action will delete all transaction records matching your ID.`,
            ``,
            `📊 *Wipe Stats:*`,
            `├─ Total transactions: \`${count}\``,
            `└─ Total spent: \`${formatMoney(total)} ៛\` (~$${formatMoney(total / EXCHANGE_RATE)})`,
            ``,
            `🔒 *Backup Safety:*`,
            `We will auto-generate and send you a *CSV backup file* in the chat before deleting anything.`,
            ``,
            `Do you wish to proceed?`
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
        await sendMainMenu(env, chatId, userId, callback.from, origin);
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
        await sendMainMenu(env, chatId, userId, callback.from, origin);
        return;
    }

    if (data === "cancel_clear") {
        await sendMessage(env, chatId, "Clear cancelled. Your data is still there.");
        return;
    }
}

async function addTransactionFromCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const type = command.startsWith("/income") ? "income" : "expense";

    if (parts.length < 3) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:*\n` +
            `• Expense: \`/add <amount> [USD/KHR] <category>\`\n` +
            `• Income: \`/income <amount> [USD/KHR] <category>\`\n\n` +
            `Example: \`/add 5 usd coffee\` or \`/income 100000 khr salary\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    const amount = Number(parts[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
        await sendMessage(env, chatId, "❌ Please enter a valid amount.");
        return;
    }

    let currency = "KHR";
    let categoryIndex = 2;

    const maybeCurrency = parts[2].toUpperCase();
    if (maybeCurrency === "USD" || maybeCurrency === "KHR") {
        currency = maybeCurrency;
        categoryIndex = 3;
    }

    const category = parts.slice(categoryIndex).join(" ").trim();
    if (!category) {
        await sendMessage(env, chatId, "❌ Please enter a category.");
        return;
    }

    await addExpenseRecord(env.DB, userId, amount, category, type, currency);

    const typeLabel = type === "income" ? "Income" : "Expense";
    const currencySymbol = currency === "USD" ? "$" : "៛";
    const formattedAmount = currency === "USD" ? amount : formatMoney(amount);

    let confirmationMsg = `✅ *${typeLabel} added!*\n` +
                          `• Category: ${capitalize(category)}\n` +
                          `• Amount: *${currencySymbol}${formattedAmount}*`;
    
    if (currency === "USD") {
        confirmationMsg += ` (~${formatMoney(amount * EXCHANGE_RATE)} ៛)`;
    } else {
        confirmationMsg += ` (~$${formatMoney(amount / EXCHANGE_RATE)})`;
    }

    if (type === "expense") {
        confirmationMsg += await getBudgetWarningText(env.DB, userId);
    }

    await sendMessage(env, chatId, confirmationMsg, { parse_mode: "Markdown" });
}

async function sendMainMenu(env, chatId, userId, from, origin) {
    const username = from?.username ? `@${from.username}` : from?.first_name || "there";
    
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const todaySummary = await getFinancialSummary(env.DB, userId, "today");
    const monthSummary = await getFinancialSummary(env.DB, userId, "month");
    const allSummary = await getFinancialSummary(env.DB, userId, "all");
    
    const text = [
        `💳 *CASHFLOW EDGE*`,
        `👤 User: *${username}*`,
        `🏳️ Display: *${displayCurrency}*`,
        ``,
        `⚖️ *Net Balance:* \`${formatAmount(allSummary.balanceKhr, displayCurrency)}\``,
        `📥 *Income:* \`${formatAmount(allSummary.totalIncomeInKhr, displayCurrency)}\` *(All-time)*`,
        `📤 *Spent:* \`${formatAmount(allSummary.totalExpenseInKhr, displayCurrency)}\` *(All-time)*`,
        ``,
        `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯`,
        `📊 *Activity Overview*`,
        `• Today Spent: \`${formatAmount(todaySummary.totalExpenseInKhr, displayCurrency)}\``,
        `• Month Spent: \`${formatAmount(monthSummary.totalExpenseInKhr, displayCurrency)}\``,
        ``,
        `Select an action below:`
    ].join("\n");

    const webAppUrl = `${origin}/dashboard?user_id=${userId}&username=${encodeURIComponent(username)}`;
    const toggleLabel = displayCurrency === "USD" ? "🇰🇭 Use KHR (៛)" : "🇺🇸 Use USD ($)";

    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "📱 Open Web Dashboard", web_app: { url: webAppUrl } }],
                [
                    { text: "📊 Today Summary", callback_data: "summary_today" },
                    { text: "📜 Daily Ledger", callback_data: "view_transactions" },
                ],
                [
                    { text: toggleLabel, callback_data: "toggle_currency" },
                    { text: "🗑️ Clear Today", callback_data: "clear_data" },
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
        "SELECT amount, category, type, currency, created_at FROM expenses WHERE user_id = ? AND date = ? ORDER BY id ASC"
    )
        .bind(userId, date)
        .all();

    if (!results.length) {
        await sendMessage(env, chatId, "No transactions recorded today.");
        return;
    }

    const lines = results.map((row) => {
        const isIncome = row.type === "income";
        const emoji = isIncome ? "💰" : "💸";
        const sign = isIncome ? "+" : "-";
        const symbol = row.currency === "USD" ? "$" : "";
        const suffix = row.currency === "KHR" ? " ៛" : "";
        const amtStr = `${sign}${symbol}${row.currency === "USD" ? row.amount : formatMoney(row.amount)}${suffix}`;
        return `${emoji} \`${amtStr}\` • ${capitalize(row.category)}`;
    });

    await sendMessage(env, chatId, [
        `📜 *DAILY TRANSACTIONS*`,
        `📅 \`${date}\``,
        ``,
        ...lines
    ].join("\n"), { 
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
            ]
        }
    });
}

async function sendHistory(env, chatId, userId, page = 1) {
    const { text, replyMarkup } = await getHistoryMessageData(env.DB, userId, page);
    await sendMessage(env, chatId, text, {
        parse_mode: "Markdown",
        reply_markup: replyMarkup
    });
}

async function updateHistoryMessage(env, chatId, userId, messageId, page = 1) {
    const { text, replyMarkup } = await getHistoryMessageData(env.DB, userId, page);
    try {
        await telegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: "Markdown",
            reply_markup: replyMarkup
        });
    } catch (err) {
        console.error("Failed to edit history message, sending new message instead:", err);
        await sendMessage(env, chatId, text, {
            parse_mode: "Markdown",
            reply_markup: replyMarkup
        });
    }
}

async function getHistoryMessageData(db, userId, page = 1) {
    const limit = 10;
    const offset = (page - 1) * limit;

    const countRow = await db
        .prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?")
        .bind(userId)
        .first();
    const totalCount = countRow?.count || 0;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const currentPage = Math.max(1, Math.min(page, totalPages));

    const { results } = await db
        .prepare(
            `SELECT id, amount, category, type, currency, date, created_at 
             FROM expenses 
             WHERE user_id = ? 
             ORDER BY date DESC, id DESC 
             LIMIT ? OFFSET ?`
        )
        .bind(userId, limit, (currentPage - 1) * limit)
        .all();

    if (!results || results.length === 0) {
        return {
            text: "📜 *TRANSACTION HISTORY*\n\nNo transactions recorded yet.",
            replyMarkup: {
                inline_keyboard: [
                    [{ text: "⬅️ Back to Menu", callback_data: "menu" }]
                ]
            }
        };
    }

    const lines = results.map((row) => {
        const isIncome = row.type === "income";
        const emoji = isIncome ? "💰" : "💸";
        const sign = isIncome ? "+" : "-";
        const symbol = row.currency === "USD" ? "$" : "";
        const suffix = row.currency === "KHR" ? " ៛" : "";
        const amtStr = `${sign}${symbol}${row.currency === "USD" ? row.amount : formatMoney(row.amount)}${suffix}`;
        return `• \`${row.date}\` • ${emoji} \`${amtStr}\` • ${capitalize(row.category)}`;
    });

    const text = [
        `📜 *TRANSACTION HISTORY*`,
        `📖 *Page ${currentPage} of ${totalPages}* (Total: ${totalCount})`,
        ``,
        ...lines
    ].join("\n");

    const navRow = [];
    if (currentPage > 1) {
        navRow.push({ text: "⬅️ Prev", callback_data: `history:${currentPage - 1}` });
    }
    if (currentPage < totalPages) {
        navRow.push({ text: "Next ➡️", callback_data: `history:${currentPage + 1}` });
    }

    const inlineKeyboard = [];
    if (navRow.length > 0) {
        inlineKeyboard.push(navRow);
    }
    inlineKeyboard.push([{ text: "⬅️ Back to Menu", callback_data: "menu" }]);

    return {
        text,
        replyMarkup: { inline_keyboard: inlineKeyboard }
    };
}

async function sendSummary(env, chatId, userId, period) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const stats = await getPeriodStats(env.DB, userId, period);
    const breakdown = await getCategoryRows(env.DB, userId, period, 5);
    const title = period === "month" ? `Month Summary (${monthLabel()})` : `Today Summary (${today()})`;

    const lines = [
        `📊 *${title.toUpperCase()}*`,
        ``,
        `💸 *Total Spent:* \`${formatAmount(stats.total, displayCurrency)}\``,
        `🧮 *Average Spend:* \`${formatAmount(stats.average, displayCurrency)}\``,
        `🛍️ *Total Entries:* \`${stats.count} items\``,
    ];

    if (stats.maxAmount) {
        const symbol = stats.maxCurrency === "USD" ? "$" : "";
        const suffix = stats.maxCurrency === "KHR" ? " ៛" : "";
        const amt = stats.maxCurrency === "USD" ? stats.maxAmount : formatMoney(stats.maxAmount);
        
        let maxStr = `🔥 *Biggest Single Spend:* \`${symbol}${amt}${suffix}\` on *${capitalize(stats.maxCategory)}*`;
        if (stats.maxCurrency === "USD") {
            maxStr += ` (~${formatMoney(stats.maxAmount * EXCHANGE_RATE)} ៛)`;
        } else {
            maxStr += ` (~$${formatMoney(stats.maxAmount / EXCHANGE_RATE)})`;
        }
        lines.push(maxStr);
    }

    if (breakdown.length) {
        lines.push(`⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯`, `🏷️ *Top Categories:*`);
        breakdown.forEach((row) => {
            const percent = stats.total > 0 ? Math.round((row.total / stats.total) * 100) : 0;
            lines.push(`• ${capitalize(row.category)}: \`${formatAmount(row.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    await sendMessage(env, chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📜 Daily Ledger", callback_data: "view_transactions" },
                    { text: "⬅️ Back to Menu", callback_data: "menu" }
                ],
            ],
        },
    });
}

async function sendCategoryBreakdown(env, chatId, userId, period) {
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
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
        lines.push(`${capitalize(row.category)}: ${formatAmount(row.total, displayCurrency)} (${percent}%)`);
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

async function getDisplayCurrency(db, userId) {
    const row = await db
        .prepare("SELECT display_currency FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first();
    return row?.display_currency || "KHR";
}

async function setDisplayCurrency(db, userId, currency) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, display_currency) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET display_currency = excluded.display_currency"
        )
        .bind(userId, currency)
        .run();
}

function formatAmount(amountInKhr, displayCurrency) {
    if (displayCurrency === "USD") {
        const usd = amountInKhr / EXCHANGE_RATE;
        return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
        return `${formatMoney(amountInKhr)} ៛`;
    }
}

async function getFinancialSummary(db, userId, period) {
    let condition = "";
    let bindParams = [userId];
    
    if (period === "today") {
        condition = "AND date = ?";
        bindParams.push(today());
    } else if (period === "month") {
        condition = "AND date LIKE ?";
        bindParams.push(`${monthPrefix()}%`);
    }

    const { results } = await db.prepare(
        `SELECT type, currency, SUM(amount) AS total
         FROM expenses
         WHERE user_id = ? ${condition}
         GROUP BY type, currency`
    )
    .bind(...bindParams)
    .all();

    let incomeUsd = 0;
    let incomeKhr = 0;
    let expenseUsd = 0;
    let expenseKhr = 0;

    if (results) {
        for (const row of results) {
            const amount = Number(row.total || 0);
            if (row.type === "income") {
                if (row.currency === "USD") incomeUsd += amount;
                else incomeKhr += amount;
            } else {
                if (row.currency === "USD") expenseUsd += amount;
                else expenseKhr += amount;
            }
        }
    }

    const totalIncomeInKhr = incomeKhr + (incomeUsd * EXCHANGE_RATE);
    const totalExpenseInKhr = expenseKhr + (expenseUsd * EXCHANGE_RATE);
    const balanceKhr = totalIncomeInKhr - totalExpenseInKhr;

    return {
        incomeKhr,
        incomeUsd,
        expenseKhr,
        expenseUsd,
        totalIncomeInKhr,
        totalExpenseInKhr,
        balanceKhr
    };
}

async function getTotalExpenses(db, userId) {
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total 
             FROM expenses 
             WHERE user_id = ? AND type = 'expense'`
        )
        .bind(userId)
        .first();

    return Number(row?.total || 0);
}

async function getTopCategory(db, userId, period) {
    const rows = await getCategoryRows(db, userId, period, 1);
    if (!rows.length) return null;
    return `${capitalize(rows[0].category)} (${formatMoney(rows[0].total)} ៛)`;
}

async function getPeriodStats(db, userId, period) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}`
        )
        .bind(userId, value)
        .first();

    const biggest = await db
        .prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
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
        maxCurrency: biggest?.currency || "KHR"
    };
}

async function getCategoryRows(db, userId, period, limit) {
    const condition = period === "month" ? "date LIKE ?" : "date = ?";
    const value = period === "month" ? `${monthPrefix()}%` : today();
    const { results } = await db
        .prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) AS total, 
                    COUNT(*) AS count
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND ${condition}
             GROUP BY LOWER(category)
             ORDER BY total DESC
             LIMIT ?`
        )
        .bind(userId, value, limit)
        .all();

    return results || [];
}

async function addExpenseRecord(db, userId, amount, category, type = "expense", currency = "KHR") {
    await db
        .prepare("INSERT INTO expenses (user_id, date, amount, category, type, currency) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, today(), amount, normalizeCategory(category), type, currency)
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

async function answerCallback(env, callbackQueryId, extra = {}) {
    if (!callbackQueryId) return;
    return telegram(env, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...extra,
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

function dateDaysAgo(days) {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

async function sendWeeklyScheduledReports(env) {
    const sevenDaysAgo = dateDaysAgo(7);
    const oneDayAgo = dateDaysAgo(1);

    const { results } = await env.DB.prepare(
        "SELECT DISTINCT user_id FROM expenses WHERE date >= ? AND date <= ?"
    )
        .bind(sevenDaysAgo, oneDayAgo)
        .all();

    if (results && results.length > 0) {
        for (const row of results) {
            try {
                await sendWeeklyReportForUser(
                    env,
                    row.user_id,
                    row.user_id,
                    sevenDaysAgo,
                    oneDayAgo,
                    "Weekly Spending Report (Last Week)"
                );
            } catch (err) {
                console.error(`Failed to send weekly scheduled report to ${row.user_id}`, err);
            }
        }
    }
}

async function sendWeeklyReportForUser(env, chatId, userId, startDate, endDate, titleLabel) {
    const row = await env.DB
        .prepare(
            `SELECT COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS total,
                    COUNT(*) AS count,
                    COALESCE(AVG(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END), 0) AS average
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`
        )
        .bind(userId, startDate, endDate)
        .first();

    const total = Number(row?.total || 0);
    const count = Number(row?.count || 0);
    const average = Number(row?.average || 0);

    if (count === 0) {
        await sendMessage(env, chatId, `📊 *${titleLabel}*\n\n📅 \`${startDate}\` to \`${endDate}\`\n\nYou didn't record any expenses during this period.`, {
            parse_mode: "Markdown"
        });
        return;
    }

    const biggest = await env.DB
        .prepare(
            `SELECT amount, category, currency
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             ORDER BY (CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) DESC, id DESC
             LIMIT 1`
        )
        .bind(userId, startDate, endDate)
        .first();

    const categories = await env.DB
        .prepare(
            `SELECT category, 
                    SUM(CASE WHEN currency = 'USD' THEN amount * ${EXCHANGE_RATE} ELSE amount END) AS total
             FROM expenses
             WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
             GROUP BY LOWER(category)
             ORDER BY total DESC`
        )
        .bind(userId, startDate, endDate)
        .all();

    const catResults = categories.results || [];
    const displayCurrency = await getDisplayCurrency(env.DB, userId);
    const totalSpentStr = formatAmount(total, displayCurrency);
    const chartUrl = generatePieChartUrl(catResults, totalSpentStr);

    const textLines = [
        `📊 *${titleLabel.toUpperCase()}*`,
        `📅 \`${startDate}\` to \`${endDate}\``,
        ``,
        `💰 *Total Spent*`,
        `└─ \`${formatAmount(total, displayCurrency)}\``,
        ``,
        `🧮 *Average Spend*`,
        `└─ \`${formatAmount(average, displayCurrency)}\``,
        ``,
        `🛍️ *Activity:* \`${count} entries\``,
    ];

    if (biggest) {
        const symbol = biggest.currency === "USD" ? "$" : "";
        const suffix = biggest.currency === "KHR" ? " ៛" : "";
        const amt = biggest.currency === "USD" ? biggest.amount : formatMoney(biggest.amount);
        
        let maxStr = `🔥 *Biggest Single Spend:* \`${symbol}${amt}${suffix}\` on *${capitalize(biggest.category)}*`;
        if (biggest.currency === "USD") {
            maxStr += ` (~${formatMoney(biggest.amount * EXCHANGE_RATE)} ៛)`;
        } else {
            maxStr += ` (~$${formatMoney(biggest.amount / EXCHANGE_RATE)})`;
        }
        textLines.push(maxStr);
    }

    if (catResults.length > 0) {
        textLines.push(``, `🏷️ *Category Breakdown:*`);
        catResults.forEach((cat, idx) => {
            const percent = total > 0 ? Math.round((cat.total / total) * 100) : 0;
            const branch = idx === catResults.length - 1 ? "└─" : "├─";
            textLines.push(`${branch} ${capitalize(cat.category)}: \`${formatAmount(cat.total, displayCurrency)}\` (${percent}%)`);
        });
    }

    const caption = textLines.join("\n");
    const payload = {
        chat_id: chatId,
        photo: chartUrl,
        caption: caption,
        parse_mode: "Markdown",
    };

    try {
        const response = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }
        );

        if (!response.ok) {
            const detail = await response.text();
            console.error(`Telegram sendPhoto failed: ${response.status} ${detail}`);
            await sendMessage(env, chatId, caption, { parse_mode: "Markdown" });
        }
    } catch (err) {
        console.error("Error sending photo to Telegram", err);
        await sendMessage(env, chatId, caption, { parse_mode: "Markdown" });
    }
}

function generatePieChartUrl(categories, totalSpentStr) {
    const labels = categories.map(c => capitalize(c.category));
    const data = categories.map(c => c.total);

    const limit = 5;
    let finalLabels = labels;
    let finalData = data;
    if (categories.length > limit) {
        finalLabels = labels.slice(0, limit);
        finalData = data.slice(0, limit);
        const otherTotal = data.slice(limit).reduce((a, b) => a + b, 0);
        finalLabels.push("Other");
        finalData.push(otherTotal);
    }

    const chart = {
        type: "doughnut",
        data: {
            labels: finalLabels,
            datasets: [{
                data: finalData,
                backgroundColor: [
                    "#6366f1",
                    "#ec4899",
                    "#f59e0b",
                    "#10b981",
                    "#06b6d4",
                    "#64748b"
                ],
                borderWidth: 3,
                borderColor: "#0d0f14"
            }]
        },
        options: {
            cutoutPercentage: 72,
            legend: {
                position: "bottom",
                labels: {
                    fontSize: 12,
                    fontColor: "#9ca3af",
                    fontFamily: "Arial",
                    padding: 12
                }
            },
            plugins: {
                datalabels: {
                    display: false
                },
                doughnutlabel: {
                    labels: [
                        {
                            text: "Total Spent",
                            font: { size: 13, family: "Arial", weight: "bold" },
                            color: "#9ca3af"
                         },
                         {
                            text: totalSpentStr,
                            font: { size: 19, family: "Arial", weight: "bold" },
                            color: "#ffffff"
                         }
                    ]
                }
            }
        }
    };

    const encodedChart = encodeURIComponent(JSON.stringify(chart));
    return `https://quickchart.io/chart?c=${encodedChart}&w=500&h=350&bkg=%230d0f14`;
}

async function handleBudgetCommand(env, chatId, userId, text) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
        await sendMessage(
            env,
            chatId,
            `💡 *Usage:*\n` +
            `• Set Budget: \`/budget <amount> [USD/KHR]\`\n` +
            `• Disable Budget: \`/budget 0\`\n\n` +
            `Example: \`/budget 300 usd\` or \`/budget 1200000 khr\``,
            { parse_mode: "Markdown" }
        );
        return;
    }

    const amount = Number(parts[1]);
    if (!Number.isFinite(amount) || amount < 0) {
        await sendMessage(env, chatId, "❌ Please enter a valid non-negative amount.");
        return;
    }

    if (amount === 0) {
        await setMonthlyBudget(env.DB, userId, 0);
        await sendMessage(env, chatId, "🎯 *Monthly budget disabled.*", { parse_mode: "Markdown" });
        return;
    }

    let currency = "KHR";
    if (parts.length >= 3) {
        const maybeCurrency = parts[2].toUpperCase();
        if (maybeCurrency === "USD" || maybeCurrency === "KHR") {
            currency = maybeCurrency;
        } else {
            await sendMessage(env, chatId, "❌ Please specify a valid currency (USD or KHR).");
            return;
        }
    } else {
        currency = await getDisplayCurrency(env.DB, userId);
    }

    const budgetInKhr = currency === "USD" ? amount * EXCHANGE_RATE : amount;

    await setMonthlyBudget(env.DB, userId, budgetInKhr);

    const formattedAmount = currency === "USD" ? `$${formatMoney(amount)}` : `${formatMoney(amount)} ៛`;
    const altAmount = currency === "USD" ? `${formatMoney(budgetInKhr)} ៛` : `$${formatMoney(amount / EXCHANGE_RATE)}`;
    await sendMessage(
        env,
        chatId,
        `🎯 *Monthly budget set to ${formattedAmount}* (~${altAmount})!`,
        { parse_mode: "Markdown" }
    );
}

async function setMonthlyBudget(db, userId, budgetInKhr) {
    await db
        .prepare(
            "INSERT INTO user_settings (user_id, monthly_budget) VALUES (?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET monthly_budget = excluded.monthly_budget"
        )
        .bind(userId, budgetInKhr)
        .run();
}

async function getBudgetWarningText(db, userId) {
    const settingsRow = await db.prepare(
        "SELECT monthly_budget FROM user_settings WHERE user_id = ?"
    )
    .bind(userId)
    .first();
    
    const budgetKhr = settingsRow?.monthly_budget || 0;
    if (budgetKhr <= 0) return "";

    const monthSummary = await getFinancialSummary(db, userId, "month");
    const totalSpentInKhr = monthSummary.totalExpenseInKhr;
    const displayCurrency = await getDisplayCurrency(db, userId);
    
    const percent = Math.round((totalSpentInKhr / budgetKhr) * 100);
    
    if (percent >= 100) {
        const overageInKhr = totalSpentInKhr - budgetKhr;
        const formattedOverage = formatAmount(overageInKhr, displayCurrency);
        return `\n\n🚨 *OVER BUDGET ALERT!*\n└─ You have exceeded your monthly budget by *${formattedOverage}* (${percent}% spent).`;
    } else if (percent >= 90) {
        const formattedRemaining = formatAmount(budgetKhr - totalSpentInKhr, displayCurrency);
        return `\n\n⚠️ *BUDGET WARNING!*\n└─ You have spent *${percent}%* of your monthly budget (only *${formattedRemaining}* remaining).`;
    }
    return "";
}

async function sendHelpMessage(env, chatId) {
    const text = [
        `💡 *CASHFLOW EDGE — BOT COMMANDS*`,
        ``,
        `📊 *Summaries*`,
        `• /menu — Opens the main visual dashboard.`,
        `• /today — Today's total spending summary.`,
        `• /week — Rolling 7-day spending report + doughnut chart.`,
        `• /month — Current month's spending summary.`,
        `• /transactions — Ledger of today's itemized entries.`,
        `• /history — View full paginated transaction ledger (all-time).`,
        ``,
        `✍️ *Logging Transactions*`,
        `• /add <amount> [USD/KHR] <category>`,
        `  _Example:_ /add 5 usd coffee`,
        `  _Example:_ /add 12000 lunch`,
        `• /income <amount> [USD/KHR] <category>`,
        `  _Example:_ /income 500 usd salary`,
        ``,
        `⚙️ *Management*`,
        `• /budget <amount> [USD/KHR] — Set monthly spending limit (0 to disable).`,
        `• /clear — Wipe records (sends a CSV backup first).`,
        `• /help — Lists all available commands.`,
    ].join("\n");

    await sendMessage(env, chatId, text, { parse_mode: "Markdown" });
}
