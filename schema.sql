CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'expense',
    currency TEXT NOT NULL DEFAULT 'KHR',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_date
ON expenses (user_id, date);

CREATE INDEX IF NOT EXISTS idx_expenses_user_created
ON expenses (user_id, created_at);

CREATE TABLE IF NOT EXISTS processed_updates (
    update_id INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    display_currency TEXT NOT NULL DEFAULT 'KHR',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
