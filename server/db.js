const { createClient } = require("@libsql/client");

const url = process.env.TURSO_URL || "";
const authToken = process.env.TURSO_AUTH_TOKEN || "";

let client;

if (url && authToken) {
  client = createClient({ url, authToken });
  console.log("DB: Turso (cloud)", url);
} else {
  const localPath = require("path").join(__dirname, "data.sqlite");
  client = createClient({ url: `file:${localPath}` });
  console.log("DB: Local SQLite", localPath);
}

async function initSchema() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      secret_key_hash TEXT,
      secret_key_created_at TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      items_json TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      images_json TEXT NOT NULL,
      color TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      updated_at TEXT,
      last_edited_by TEXT,
      last_edited_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS note_collaborators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      added_by INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(added_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(note_id, user_id)
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const hasAdminSettings = await client.execute("SELECT COUNT(*) as c FROM admin_settings WHERE key='allowNewAccounts'");
  if (Number(hasAdminSettings.rows[0].c) === 0) {
    await client.execute("INSERT INTO admin_settings (key, value) VALUES ('allowNewAccounts', 'true')");
  }
}

module.exports = { client, initSchema };
