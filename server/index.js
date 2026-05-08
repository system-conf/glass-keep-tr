// server/index.js
// Express + Turso (libSQL) + JWT auth API for Glass Keep

const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const crypto = require("crypto");
const { client, initSchema } = require("./db");
const { processImages, deleteNoteImages } = require("./cdn");

// Transformers.js for server-side AI
let pipeline;
let env;
let aiGenerator = null;

async function initServerAI() {
  if (aiGenerator) return;
  try {
    // Dynamic import since transformers is ESM and this is CJS
    const transformers = await import('@huggingface/transformers');
    pipeline = transformers.pipeline;
    env = transformers.env;

    // Configure env for server
    env.allowLocalModels = false;
    // Cache directory in Docker
    env.cacheDir = path.join(__dirname, '..', 'data', 'ai-cache');

    console.log("Loading high-stability AI model (Llama-3.2-1B)...");
    // Llama-3.2-1B-Instruct-ONNX is highly compatible and excels at instruction following
    aiGenerator = await pipeline('text-generation', 'onnx-community/Llama-3.2-1B-Instruct-ONNX', {
      dtype: 'q4', // 4-bit quantization (~0.7GB RAM)
    });
    console.log("Llama AI model loaded on server.");
  } catch (err) {
    console.error("Failed to load AI on server:", err);
  }
}
// Start loading AI in background (disabled by default - will load on first use)
// initServerAI().catch(console.error);

const app = express();
const PORT = Number(process.env.API_PORT || process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-please-change";
const NODE_ENV = process.env.NODE_ENV || "development";

// ---------- Body parsing ----------
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// ---------- CORS (dev only) ----------
if (NODE_ENV !== "production") {
  app.use(
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: false,
    })
  );
}

// ---------- Helpers ----------
const nowISO = () => new Date().toISOString();
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function signToken(user) {
  return jwt.sign(
    {
      uid: user.id,
      email: user.email,
      name: user.name,
      is_admin: !!user.is_admin,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token eksik" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.uid,
      email: payload.email,
      name: payload.name,
      is_admin: !!payload.is_admin,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Geçersiz token" });
  }
}

// Auth that also supports token in query string for EventSource
function authFromQueryOrHeader(req, res, next) {
  const h = req.headers.authorization || "";
  const headerToken = h.startsWith("Bearer ") ? h.slice(7) : null;
  const queryToken = req.query && typeof req.query.token === "string" ? req.query.token : null;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: "Token eksik" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.uid,
      email: payload.email,
      name: payload.name,
      is_admin: !!payload.is_admin,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Geçersiz token" });
  }
}

// Optionally promote admins from env (comma-separated)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Function to promote user to admin if they're in the admin list
async function promoteToAdminIfNeeded(email) {
  if (ADMIN_EMAILS.length && ADMIN_EMAILS.includes(email.toLowerCase())) {
    await client.execute({
      sql: "UPDATE users SET is_admin=1 WHERE lower(email)=?",
      args: [email.toLowerCase()],
    });
    console.log(`Promoted user ${email} to admin`);
    return true;
  }
  return false;
}

// ---------- Admin settings helpers ----------
async function getAdminSetting(key) {
  const result = await client.execute({
    sql: "SELECT value FROM admin_settings WHERE key = ?",
    args: [key],
  });
  if (result.rows.length === 0) return null;
  const val = result.rows[0].value;
  if (val === "true") return true;
  if (val === "false") return false;
  return val;
}

async function setAdminSetting(key, value) {
  const val = typeof value === "boolean" ? String(value) : value;
  await client.execute({
    sql: "INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)",
    args: [key, val],
  });
}

// ---------- Realtime (SSE) ----------
// Map of userId -> Set of response streams
const sseClients = new Map();

function addSseClient(userId, res) {
  let set = sseClients.get(userId);
  if (!set) {
    set = new Set();
    sseClients.set(userId, set);
  }
  set.add(res);
}

function removeSseClient(userId, res) {
  const set = sseClients.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(userId);
}

function sendEventToUser(userId, event) {
  const set = sseClients.get(userId);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const toRemove = [];
  for (const res of set) {
    try {
      res.write(payload);
    } catch (error) {
      // Remove dead connections
      toRemove.push(res);
    }
  }
  // Clean up dead connections
  for (const res of toRemove) {
    removeSseClient(userId, res);
  }
}

async function getCollaboratorUserIdsForNote(noteId) {
  try {
    const result = await client.execute({
      sql: `SELECT u.id FROM note_collaborators nc
            JOIN users u ON nc.user_id = u.id
            WHERE nc.note_id = ?`,
      args: [noteId],
    });
    return result.rows.map((r) => r.id);
  } catch {
    return [];
  }
}

async function broadcastNoteUpdated(noteId) {
  try {
    const noteResult = await client.execute({
      sql: "SELECT * FROM notes WHERE id = ?",
      args: [noteId],
    });
    if (noteResult.rows.length === 0) return;
    const note = noteResult.rows[0];
    const collabIds = await getCollaboratorUserIdsForNote(noteId);
    const recipientIds = new Set([note.user_id, ...collabIds]);
    const evt = { type: "note_updated", noteId };
    for (const uid of recipientIds) sendEventToUser(uid, evt);
  } catch { }
}

app.get("/api/events", authFromQueryOrHeader, (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Help Nginx/Proxies not to buffer SSE
  try { res.setHeader("X-Accel-Buffering", "no"); } catch { }
  // If served cross-origin (e.g. static site + separate API host), allow EventSource
  if (req.headers.origin) {
    try { res.setHeader("Access-Control-Allow-Origin", req.headers.origin); } catch { }
  }
  res.flushHeaders?.();

  // Initial hello
  res.write(`event: hello\n`);
  res.write(`data: {"ok":true}\n\n`);

  addSseClient(req.user.id, res);

  // Keepalive ping
  const ping = setInterval(() => {
    try {
      res.write("event: ping\ndata: {}\n\n");
    } catch (error) {
      clearInterval(ping);
      removeSseClient(req.user.id, res);
      try { res.end(); } catch { }
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    removeSseClient(req.user.id, res);
    try { res.end(); } catch { }
  });
});

// ---------- Async startup ----------
async function startup() {
  // Initialize DB schema
  await initSchema();

  // Seed default admin user if none exist
  const countResult = await client.execute("SELECT COUNT(*) as count FROM users");
  if (Number(countResult.rows[0].count) === 0) {
    const adminEmail = "admin";
    const adminPass = "admin";
    const hash = bcrypt.hashSync(adminPass, 10);
    const insertResult = await client.execute({
      sql: "INSERT INTO users (name,email,password_hash,created_at) VALUES (?,?,?,?)",
      args: ["Admin", adminEmail, hash, nowISO()],
    });
    await client.execute({
      sql: "UPDATE users SET is_admin=1 WHERE id=?",
      args: [insertResult.lastInsertRowid],
    });
    console.log(`Default admin user created: ${adminEmail} / ${adminPass}`);
  }

  // Promote existing users to admin on startup
  if (ADMIN_EMAILS.length) {
    console.log(`Admin emails configured: ${ADMIN_EMAILS.join(', ')}`);
    for (const e of ADMIN_EMAILS) {
      const result = await client.execute({
        sql: "UPDATE users SET is_admin=1 WHERE lower(email)=?",
        args: [e],
      });
      if (result.rowsAffected > 0) {
        console.log(`Promoted existing user ${e} to admin`);
      }
    }
  }

  // Initialize admin settings from DB
  const regSetting = await getAdminSetting("allowNewAccounts");
  if (regSetting === null) {
    // Seed with default from env
    const defaultVal = process.env.ALLOW_REGISTRATION === "true" || false;
    await setAdminSetting("allowNewAccounts", defaultVal);
  }
}

// Fire and forget startup; errors will surface on first request if DB is unreachable.
startup().catch((err) => {
  console.error("Startup error:", err);
});

// ---------- Auth ----------
app.post("/api/register", async (req, res) => {
  try {
    // Check if new account creation is allowed
    const allowNew = await getAdminSetting("allowNewAccounts");
    if (!allowNew) {
      return res.status(403).json({ error: "Yeni hesap oluşturma şu anda devre dışı." });
    }

    const { name, email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: "E-posta ve şifre gereklidir." });

    const existingUser = await client.execute({
      sql: "SELECT * FROM users WHERE lower(email)=lower(?)",
      args: [email],
    });
    if (existingUser.rows.length > 0)
      return res.status(409).json({ error: "Bu e-posta zaten kayıtlı." });

    const hash = bcrypt.hashSync(password, 10);
    const insertResult = await client.execute({
      sql: "INSERT INTO users (name,email,password_hash,created_at) VALUES (?,?,?,?)",
      args: [name?.trim() || "User", email.trim(), hash, nowISO()],
    });

    // Check if this user should be promoted to admin
    await promoteToAdminIfNeeded(email.trim());

    const userResult = await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [insertResult.lastInsertRowid],
    });
    const user = userResult.rows[0];
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Kayıt başarısız oldu." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    let user = null;
    if (email) {
      const result = await client.execute({
        sql: "SELECT * FROM users WHERE lower(email)=lower(?)",
        args: [email],
      });
      if (result.rows.length > 0) user = result.rows[0];
    }
    if (!user) return res.status(401).json({ error: "Bu e-posta ile hesap bulunamadı." });
    if (!bcrypt.compareSync(password || "", user.password_hash)) {
      return res.status(401).json({ error: "Yanlış şifre." });
    }
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Giriş başarısız oldu." });
  }
});

// ---------- Secret Key (Recovery) ----------
function generateSecretKey(bytes = 32) {
  const buf = crypto.randomBytes(bytes);
  try {
    return buf.toString("base64url");
  } catch {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
}

// Create/rotate a user's secret key
app.post("/api/secret-key", auth, async (req, res) => {
  try {
    const key = generateSecretKey(32);
    const hash = bcrypt.hashSync(key, 10);
    await client.execute({
      sql: "UPDATE users SET secret_key_hash = ?, secret_key_created_at = ? WHERE id = ?",
      args: [hash, nowISO(), req.user.id],
    });
    res.json({ key });
  } catch (err) {
    console.error("Secret key error:", err);
    res.status(500).json({ error: "Gizli anahtar oluşturulamadı." });
  }
});

// Login with secret key
app.post("/api/login/secret", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || typeof key !== "string" || key.length < 16) {
      return res.status(400).json({ error: "Geçersiz anahtar." });
    }
    const result = await client.execute(
      "SELECT id, name, email, is_admin, secret_key_hash FROM users WHERE secret_key_hash IS NOT NULL"
    );
    for (const u of result.rows) {
      if (u.secret_key_hash && bcrypt.compareSync(key, u.secret_key_hash)) {
        const token = signToken(u);
        return res.json({
          token,
          user: { id: u.id, name: u.name, email: u.email, is_admin: !!u.is_admin },
        });
      }
    }
    return res.status(401).json({ error: "Gizli anahtar tanınmadı." });
  } catch (err) {
    console.error("Secret login error:", err);
    res.status(500).json({ error: "Gizli anahtar girişi başarısız oldu." });
  }
});

// ---------- Notes ----------
app.get("/api/notes", auth, async (req, res) => {
  try {
    const off = Number(req.query.offset ?? 0);
    const lim = Number(req.query.limit ?? 0);
    const usePaging = Number.isFinite(lim) && lim > 0 && Number.isFinite(off) && off >= 0;

    let rows;
    if (usePaging) {
      const result = await client.execute({
        sql: `SELECT DISTINCT n.* FROM notes n
              WHERE (n.user_id = ? OR EXISTS(
                SELECT 1 FROM note_collaborators nc
                WHERE nc.note_id = n.id AND nc.user_id = ?
              )) AND n.archived = 0
              ORDER BY n.pinned DESC, n.position DESC, n.timestamp DESC
              LIMIT ? OFFSET ?`,
        args: [req.user.id, req.user.id, lim, off],
      });
      rows = result.rows;
    } else {
      const result = await client.execute({
        sql: `SELECT DISTINCT n.* FROM notes n
              WHERE (n.user_id = ? OR EXISTS(
                SELECT 1 FROM note_collaborators nc
                WHERE nc.note_id = n.id AND nc.user_id = ?
              )) AND n.archived = 0
              ORDER BY n.pinned DESC, n.position DESC, n.timestamp DESC`,
        args: [req.user.id, req.user.id],
      });
      rows = result.rows;
    }

    // Get collaborators for each note
    const noteResults = [];
    for (const r of rows) {
      const collabResult = await client.execute({
        sql: "SELECT COUNT(*) as count FROM note_collaborators WHERE note_id = ?",
        args: [r.id],
      });
      const collabCount = Number(collabResult.rows[0]?.count || 0);
      noteResults.push({
        id: r.id,
        user_id: r.user_id,
        type: r.type,
        title: r.title,
        content: r.content,
        items: JSON.parse(r.items_json || "[]"),
        tags: JSON.parse(r.tags_json || "[]"),
        images: JSON.parse(r.images_json || "[]"),
        color: r.color,
        pinned: !!r.pinned,
        position: r.position,
        timestamp: r.timestamp,
        updated_at: r.updated_at,
        lastEditedBy: r.last_edited_by,
        lastEditedAt: r.last_edited_at,
        archived: !!r.archived,
        collaborators: collabCount > 0 ? [] : null,
      });
    }

    res.json(noteResults);
  } catch (err) {
    console.error("List notes error:", err);
    res.status(500).json({ error: "Notlar yüklenemedi." });
  }
});

app.post("/api/notes", auth, async (req, res) => {
  try {
    const body = req.body || {};
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const processedImagesJson = await processImages(JSON.stringify(rawImages));

    const n = {
      id: body.id || uid(),
      user_id: req.user.id,
      type: body.type === "checklist" ? "checklist" : body.type === "draw" ? "draw" : "text",
      title: String(body.title || ""),
      content: body.type === "checklist" ? "" : String(body.content || ""),
      items_json: JSON.stringify(Array.isArray(body.items) ? body.items : []),
      tags_json: JSON.stringify(Array.isArray(body.tags) ? body.tags : []),
      images_json: processedImagesJson,
      color: body.color && typeof body.color === "string" ? body.color : "default",
      pinned: body.pinned ? 1 : 0,
      position: typeof body.position === "number" ? body.position : Date.now(),
      timestamp: body.timestamp || nowISO(),
    };

    await client.execute({
      sql: `INSERT INTO notes (id,user_id,type,title,content,items_json,tags_json,images_json,color,pinned,position,timestamp,archived)
            VALUES (:id,:user_id,:type,:title,:content,:items_json,:tags_json,:images_json,:color,:pinned,:position,:timestamp,0)`,
      args: n,
    });

    res.status(201).json({
      id: n.id,
      type: n.type,
      title: n.title,
      content: n.content,
      items: JSON.parse(n.items_json),
      tags: JSON.parse(n.tags_json),
      images: JSON.parse(n.images_json),
      color: n.color,
      pinned: !!n.pinned,
      position: n.position,
      timestamp: n.timestamp,
    });
  } catch (err) {
    console.error("Add note error:", err);
    res.status(500).json({ error: "Not eklenemedi." });
  }
});

app.put("/api/notes/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const existingResult = await client.execute({
      sql: `SELECT n.* FROM notes n
            LEFT JOIN note_collaborators nc ON n.id = nc.note_id AND nc.user_id = ?
            WHERE n.id = ? AND (n.user_id = ? OR nc.user_id IS NOT NULL)`,
      args: [req.user.id, id, req.user.id],
    });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: "Not bulunamadı" });

    const b = req.body || {};
    const rawImages = Array.isArray(b.images) ? b.images : [];
    const processedImagesJson = await processImages(JSON.stringify(rawImages));

    const updated = {
      id,
      user_id: req.user.id,
      type: b.type === "checklist" ? "checklist" : b.type === "draw" ? "draw" : "text",
      title: String(b.title || ""),
      content: b.type === "checklist" ? "" : String(b.content || ""),
      items_json: JSON.stringify(Array.isArray(b.items) ? b.items : []),
      tags_json: JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
      images_json: processedImagesJson,
      color: b.color && typeof b.color === "string" ? b.color : "default",
      pinned: b.pinned ? 1 : 0,
      position: typeof b.position === "number" ? b.position : existing.position,
      timestamp: b.timestamp || existing.timestamp,
    };

    // Use collaboration-aware update
    const result = await client.execute({
      sql: `UPDATE notes SET
              type=:type, title=:title, content=:content, items_json=:items_json, tags_json=:tags_json,
              images_json=:images_json, color=:color, pinned=:pinned, position=:position, timestamp=:timestamp
            WHERE id=:id AND (user_id=:user_id OR EXISTS(
              SELECT 1 FROM note_collaborators nc
              WHERE nc.note_id=:id AND nc.user_id=:user_id
            ))`,
      args: updated,
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Not bulunamadı veya erişim reddedildi" });
    }

    // Update editor tracking
    await client.execute({
      sql: "UPDATE notes SET updated_at = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?",
      args: [nowISO(), req.user.name || req.user.email, nowISO(), id],
    });
    broadcastNoteUpdated(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Update note error:", err);
    res.status(500).json({ error: "Not güncellenemedi." });
  }
});

app.patch("/api/notes/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const existingResult = await client.execute({
      sql: `SELECT n.* FROM notes n
            LEFT JOIN note_collaborators nc ON n.id = nc.note_id AND nc.user_id = ?
            WHERE n.id = ? AND (n.user_id = ? OR nc.user_id IS NOT NULL)`,
      args: [req.user.id, id, req.user.id],
    });
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ error: "Not bulunamadı" });

    // Process images if provided
    let imagesJson = null;
    if (Array.isArray(req.body.images)) {
      imagesJson = await processImages(JSON.stringify(req.body.images));
    }

    const p = {
      id,
      user_id: req.user.id,
      title: typeof req.body.title === "string" ? String(req.body.title) : null,
      content: typeof req.body.content === "string" ? String(req.body.content) : null,
      items_json: Array.isArray(req.body.items) ? JSON.stringify(req.body.items) : null,
      tags_json: Array.isArray(req.body.tags) ? JSON.stringify(req.body.tags) : null,
      images_json: imagesJson,
      color: typeof req.body.color === "string" ? req.body.color : null,
      pinned: typeof req.body.pinned === "boolean" ? (req.body.pinned ? 1 : 0) : null,
      timestamp: req.body.timestamp || null,
    };

    // Use collaboration-aware patch
    const result = await client.execute({
      sql: `UPDATE notes SET title=COALESCE(:title,title),
                       content=COALESCE(:content,content),
                       items_json=COALESCE(:items_json,items_json),
                       tags_json=COALESCE(:tags_json,tags_json),
                       images_json=COALESCE(:images_json,images_json),
                       color=COALESCE(:color,color),
                       pinned=COALESCE(:pinned,pinned),
                       timestamp=COALESCE(:timestamp,timestamp)
            WHERE id=:id AND (user_id=:user_id OR EXISTS(
              SELECT 1 FROM note_collaborators nc
              WHERE nc.note_id=:id AND nc.user_id=:user_id
            ))`,
      args: p,
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Not bulunamadı veya erişim reddedildi" });
    }

    // Update editor tracking
    await client.execute({
      sql: "UPDATE notes SET updated_at = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?",
      args: [nowISO(), req.user.name || req.user.email, nowISO(), id],
    });
    broadcastNoteUpdated(id);

    res.json({ ok: true });
  } catch (err) {
    console.error("Patch note error:", err);
    res.status(500).json({ error: "Not güncellenemedi." });
  }
});

app.delete("/api/notes/:id", auth, async (req, res) => {
  try {
    const noteId = req.params.id;

    // Get note to delete its images from CDN
    const noteResult = await client.execute({
      sql: "SELECT * FROM notes WHERE id = ? AND user_id = ?",
      args: [noteId, req.user.id],
    });
    const note = noteResult.rows[0];
    if (note) {
      await deleteNoteImages(note.images_json);
    }

    await client.execute({
      sql: "DELETE FROM notes WHERE id = ? AND user_id = ?",
      args: [noteId, req.user.id],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete note error:", err);
    res.status(500).json({ error: "Not silinemedi." });
  }
});

// Reorder within sections
app.post("/api/notes/reorder", auth, async (req, res) => {
  try {
    const { pinnedIds = [], otherIds = [] } = req.body || {};
    const base = Date.now();
    const step = 1;

    const tx = await client.transaction();
    try {
      for (let i = 0; i < pinnedIds.length; i++) {
        await tx.execute({
          sql: "UPDATE notes SET position = ?, pinned = ? WHERE id = ? AND user_id = ?",
          args: [base + step * (pinnedIds.length - i), 1, pinnedIds[i], req.user.id],
        });
      }
      for (let i = 0; i < otherIds.length; i++) {
        await tx.execute({
          sql: "UPDATE notes SET position = ?, pinned = ? WHERE id = ? AND user_id = ?",
          args: [base - step * (i + 1), 0, otherIds[i], req.user.id],
        });
      }
      await tx.commit();
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Reorder error:", err);
    res.status(500).json({ error: "Notlar sıralanamadı." });
  }
});

// ---------- Collaboration ----------
app.post("/api/notes/:id/collaborate", auth, async (req, res) => {
  try {
    const noteId = req.params.id;
    const { username } = req.body || {};

    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "Kullanıcı adı gereklidir" });
    }

    // Check if note exists and user owns it
    const noteResult = await client.execute({
      sql: "SELECT * FROM notes WHERE id = ? AND user_id = ?",
      args: [noteId, req.user.id],
    });
    const note = noteResult.rows[0];
    if (!note) {
      return res.status(404).json({ error: "Not bulunamadı" });
    }

    // Find user to collaborate with (by email or name)
    let collaborator = null;
    const byEmail = await client.execute({
      sql: "SELECT * FROM users WHERE lower(email)=lower(?)",
      args: [username],
    });
    if (byEmail.rows.length > 0) {
      collaborator = byEmail.rows[0];
    } else {
      const byName = await client.execute({
        sql: "SELECT * FROM users WHERE lower(name)=lower(?)",
        args: [username],
      });
      if (byName.rows.length > 0) {
        collaborator = byName.rows[0];
      }
    }

    if (!collaborator) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    }

    // Don't allow self-collaboration
    if (collaborator.id === req.user.id) {
      return res.status(400).json({ error: "Kendi kendinize işbirliği yapamazsınız" });
    }

    // Add collaborator
    await client.execute({
      sql: "INSERT INTO note_collaborators (note_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)",
      args: [noteId, collaborator.id, req.user.id, nowISO()],
    });

    // Update note with editor info
    await client.execute({
      sql: "UPDATE notes SET updated_at = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?",
      args: [nowISO(), req.user.name || req.user.email, nowISO(), noteId],
    });
    broadcastNoteUpdated(noteId);

    res.json({
      ok: true,
      message: `${collaborator.name} işbirlikçi olarak eklendi`,
      collaborator: {
        id: collaborator.id,
        name: collaborator.name,
        email: collaborator.email,
      },
    });
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE constraint failed")) {
      return res.status(409).json({ error: "Kullanıcı zaten işbirlikçi" });
    }
    console.error("Collaborate error:", e);
    return res.status(500).json({ error: "İşbirlikçi eklenemedi" });
  }
});

app.get("/api/notes/:id/collaborators", auth, async (req, res) => {
  try {
    const noteId = req.params.id;

    // Check if note exists and user owns it or is a collaborator
    const noteResult = await client.execute({
      sql: `SELECT n.* FROM notes n
            LEFT JOIN note_collaborators nc ON n.id = nc.note_id AND nc.user_id = ?
            WHERE n.id = ? AND (n.user_id = ? OR nc.user_id IS NOT NULL)`,
      args: [req.user.id, noteId, req.user.id],
    });
    if (noteResult.rows.length === 0) {
      return res.status(404).json({ error: "Not bulunamadı" });
    }

    const collabResult = await client.execute({
      sql: `SELECT u.id, u.name, u.email, nc.added_at, nc.added_by
            FROM note_collaborators nc
            JOIN users u ON nc.user_id = u.id
            WHERE nc.note_id = ?`,
      args: [noteId],
    });
    res.json(
      collabResult.rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        added_at: c.added_at,
        added_by: c.added_by,
      }))
    );
  } catch (err) {
    console.error("Get collaborators error:", err);
    res.status(500).json({ error: "İşbirlikçiler yüklenemedi." });
  }
});

app.delete("/api/notes/:id/collaborate/:userId", auth, async (req, res) => {
  try {
    const noteId = req.params.id;
    const userIdToRemove = req.params.userId;

    // Check if note exists
    const noteResult = await client.execute({
      sql: `SELECT n.* FROM notes n
            LEFT JOIN note_collaborators nc ON n.id = nc.note_id AND nc.user_id = ?
            WHERE n.id = ? AND (n.user_id = ? OR nc.user_id IS NOT NULL)`,
      args: [req.user.id, noteId, req.user.id],
    });
    const note = noteResult.rows[0];
    if (!note) {
      return res.status(404).json({ error: "Not bulunamadı" });
    }

    // Check if user is the owner (can remove anyone) or is removing themselves
    const isOwner = note.user_id === req.user.id;
    const isRemovingSelf = String(userIdToRemove) === String(req.user.id);

    if (!isOwner && !isRemovingSelf) {
      return res.status(403).json({ error: "Sadece not sahibi diğer işbirlikçileri kaldırabilir" });
    }

    // Remove collaborator
    const result = await client.execute({
      sql: "DELETE FROM note_collaborators WHERE note_id = ? AND user_id = ?",
      args: [noteId, userIdToRemove],
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "İşbirlikçi bulunamadı" });
    }

    // Update note with editor info
    await client.execute({
      sql: "UPDATE notes SET updated_at = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?",
      args: [nowISO(), req.user.name || req.user.email, nowISO(), noteId],
    });
    broadcastNoteUpdated(noteId);

    res.json({ ok: true, message: "İşbirlikçi kaldırıldı" });
  } catch (err) {
    console.error("Remove collaborator error:", err);
    res.status(500).json({ error: "İşbirlikçi kaldırılamadı." });
  }
});

app.get("/api/notes/collaborated", auth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: `SELECT n.* FROM notes n
            JOIN note_collaborators nc ON n.id = nc.note_id
            WHERE nc.user_id = ?
            ORDER BY n.pinned DESC, n.position DESC, n.timestamp DESC`,
      args: [req.user.id],
    });
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        items: JSON.parse(r.items_json || "[]"),
        tags: JSON.parse(r.tags_json || "[]"),
        images: JSON.parse(r.images_json || "[]"),
        color: r.color,
        pinned: !!r.pinned,
        position: r.position,
        timestamp: r.timestamp,
        updated_at: r.updated_at,
        lastEditedBy: r.last_edited_by,
        lastEditedAt: r.last_edited_at,
      }))
    );
  } catch (err) {
    console.error("Collaborated notes error:", err);
    res.status(500).json({ error: "İşbirliği notları yüklenemedi." });
  }
});

// Archive/Unarchive notes
app.post("/api/notes/:id/archive", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const { archived } = req.body || {};

    // Check if note exists and user owns it
    const existingResult = await client.execute({
      sql: "SELECT * FROM notes WHERE id = ? AND user_id = ?",
      args: [id, req.user.id],
    });
    if (existingResult.rows.length === 0) {
      return res.status(404).json({ error: "Not bulunamadı" });
    }

    // Update archived status
    const result = await client.execute({
      sql: "UPDATE notes SET archived = ? WHERE id = ? AND user_id = ?",
      args: [archived ? 1 : 0, id, req.user.id],
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: "Not bulunamadı veya erişim reddedildi" });
    }

    // Update editor tracking
    await client.execute({
      sql: "UPDATE notes SET updated_at = ?, last_edited_by = ?, last_edited_at = ? WHERE id = ?",
      args: [nowISO(), req.user.name || req.user.email, nowISO(), id],
    });
    broadcastNoteUpdated(id);

    res.json({ ok: true });
  } catch (err) {
    console.error("Archive error:", err);
    res.status(500).json({ error: "Arşiv işlemi başarısız oldu." });
  }
});

// Get archived notes
app.get("/api/notes/archived", auth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: `SELECT * FROM notes WHERE user_id = ? AND archived = 1 ORDER BY timestamp DESC`,
      args: [req.user.id],
    });
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        items: JSON.parse(r.items_json || "[]"),
        tags: JSON.parse(r.tags_json || "[]"),
        images: JSON.parse(r.images_json || "[]"),
        color: r.color,
        pinned: !!r.pinned,
        position: r.position,
        timestamp: r.timestamp,
        updated_at: r.updated_at,
        lastEditedBy: r.last_edited_by,
        lastEditedAt: r.last_edited_at,
        archived: !!r.archived,
      }))
    );
  } catch (err) {
    console.error("Archived notes error:", err);
    res.status(500).json({ error: "Arşivlenmiş notlar yüklenemedi." });
  }
});

// Export/Import
app.get("/api/notes/export", auth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: `SELECT * FROM notes WHERE user_id = ? AND archived = 0 ORDER BY pinned DESC, position DESC, timestamp DESC`,
      args: [req.user.id],
    });
    res.json({
      app: "glass-keep",
      version: 1,
      user: req.user.email,
      exportedAt: nowISO(),
      notes: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: r.content,
        items: JSON.parse(r.items_json || "[]"),
        tags: JSON.parse(r.tags_json || "[]"),
        images: JSON.parse(r.images_json || "[]"),
        color: r.color,
        pinned: !!r.pinned,
        position: r.position,
        timestamp: r.timestamp,
      })),
    });
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Notlar dışa aktarılamadı." });
  }
});

app.post("/api/notes/import", auth, async (req, res) => {
  try {
    const payload = req.body || {};
    const src = Array.isArray(payload.notes)
      ? payload.notes
      : Array.isArray(payload)
        ? payload
        : [];
    if (!src.length) return res.status(400).json({ error: "İçe aktarılacak not yok." });

    const existingResult = await client.execute({
      sql: `SELECT id FROM notes WHERE user_id = ? AND archived = 0`,
      args: [req.user.id],
    });
    const existingIds = new Set(existingResult.rows.map((r) => r.id));

    const tx = await client.transaction();
    try {
      for (const n of src) {
        const id = existingIds.has(String(n.id)) ? uid() : String(n.id);
        existingIds.add(id);

        const rawImages = Array.isArray(n.images) ? n.images : [];
        const processedImagesJson = await processImages(JSON.stringify(rawImages));

        await tx.execute({
          sql: `INSERT INTO notes (id,user_id,type,title,content,items_json,tags_json,images_json,color,pinned,position,timestamp,archived)
                VALUES (:id,:user_id,:type,:title,:content,:items_json,:tags_json,:images_json,:color,:pinned,:position,:timestamp,0)`,
          args: {
            id,
            user_id: req.user.id,
            type: n.type === "checklist" ? "checklist" : n.type === "draw" ? "draw" : "text",
            title: String(n.title || ""),
            content: n.type === "checklist" ? "" : String(n.content || ""),
            items_json: JSON.stringify(Array.isArray(n.items) ? n.items : []),
            tags_json: JSON.stringify(Array.isArray(n.tags) ? n.tags : []),
            images_json: processedImagesJson,
            color: typeof n.color === "string" ? n.color : "default",
            pinned: n.pinned ? 1 : 0,
            position: typeof n.position === "number" ? n.position : Date.now(),
            timestamp: n.timestamp || nowISO(),
          },
        });
      }
      await tx.commit();
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }

    res.json({ ok: true, imported: src.length });
  } catch (err) {
    console.error("Import error:", err);
    res.status(500).json({ error: "Notlar içe aktarılamadı." });
  }
});

// ---------- Admin ----------
async function adminOnly(req, res, next) {
  const result = await client.execute({
    sql: "SELECT * FROM users WHERE id = ?",
    args: [req.user.id],
  });
  const row = result.rows[0];
  if (!row || !row.is_admin) return res.status(403).json({ error: "Sadece yönetici" });
  next();
}

// Get admin settings
app.get("/api/admin/settings", auth, adminOnly, async (_req, res) => {
  try {
    const allowNewAccounts = await getAdminSetting("allowNewAccounts");
    res.json({ allowNewAccounts: !!allowNewAccounts });
  } catch (err) {
    console.error("Get admin settings error:", err);
    res.status(500).json({ error: "Ayarlar yüklenemedi." });
  }
});

// Update admin settings
app.patch("/api/admin/settings", auth, adminOnly, async (req, res) => {
  try {
    const { allowNewAccounts } = req.body || {};

    if (typeof allowNewAccounts === 'boolean') {
      await setAdminSetting("allowNewAccounts", allowNewAccounts);
    }

    const currentVal = await getAdminSetting("allowNewAccounts");
    res.json({ allowNewAccounts: !!currentVal });
  } catch (err) {
    console.error("Update admin settings error:", err);
    res.status(500).json({ error: "Ayarlar güncellenemedi." });
  }
});

// Check if new account creation is allowed (public endpoint)
app.get("/api/admin/allow-registration", async (_req, res) => {
  try {
    const allowNewAccounts = await getAdminSetting("allowNewAccounts");
    res.json({ allowNewAccounts: !!allowNewAccounts });
  } catch (err) {
    console.error("Allow registration check error:", err);
    res.json({ allowNewAccounts: false });
  }
});

// List all users with storage usage estimate
app.get("/api/admin/users", auth, adminOnly, async (_req, res) => {
  try {
    const result = await client.execute(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.created_at,
        u.is_admin,
        COUNT(n.id) AS notes,
        COALESCE(SUM(
          COALESCE(LENGTH(n.title),0) +
          COALESCE(LENGTH(n.content),0) +
          COALESCE(LENGTH(n.items_json),0) +
          COALESCE(LENGTH(n.tags_json),0) +
          COALESCE(LENGTH(n.images_json),0)
        ), 0) AS storage_bytes
      FROM users u
      LEFT JOIN notes n ON n.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        is_admin: !!r.is_admin,
        notes: Number(r.notes || 0),
        storage_bytes: Number(r.storage_bytes || 0),
        created_at: r.created_at,
      }))
    );
  } catch (err) {
    console.error("List users error:", err);
    res.status(500).json({ error: "Kullanıcılar yüklenemedi." });
  }
});

// Search users endpoint for collaboration
app.get("/api/users/search", auth, async (req, res) => {
  try {
    const query = req.query.q || "";
    const searchTerm = `%${query}%`;
    const result = await client.execute({
      sql: `SELECT id, name, email
            FROM users
            WHERE (name LIKE ? OR email LIKE ?)
            ORDER BY name ASC
            LIMIT 50`,
      args: [searchTerm, searchTerm],
    });
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
      }))
    );
  } catch (err) {
    console.error("Search users error:", err);
    res.status(500).json({ error: "Kullanıcı aranamadı." });
  }
});

app.delete("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: "Kendinizi silemezsiniz." });
    }
    const targetResult = await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [id],
    });
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

    const adminCountResult = await client.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1");
    const adminCount = Number(adminCountResult.rows[0].c);
    if (target.is_admin && adminCount <= 1) {
      return res.status(400).json({ error: "Son yönetici silinemez." });
    }

    await client.execute({
      sql: "DELETE FROM users WHERE id = ?",
      args: [id],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: "Kullanıcı silinemedi." });
  }
});

// Create user from admin panel
app.post("/api/admin/users", auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, is_admin } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: "İsim, e-posta ve şifre gereklidir." });
    }

    const existingResult = await client.execute({
      sql: "SELECT * FROM users WHERE lower(email)=lower(?)",
      args: [email],
    });
    if (existingResult.rows.length > 0) {
      return res.status(409).json({ error: "Bu e-posta zaten kayıtlı." });
    }

    const hash = bcrypt.hashSync(password, 10);
    const insertResult = await client.execute({
      sql: "INSERT INTO users (name,email,password_hash,created_at) VALUES (?,?,?,?)",
      args: [name.trim(), email.trim(), hash, nowISO()],
    });

    // Set admin status if specified
    if (is_admin) {
      await client.execute({
        sql: "UPDATE users SET is_admin=1 WHERE id=?",
        args: [insertResult.lastInsertRowid],
      });
    }

    const userResult = await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [insertResult.lastInsertRowid],
    });
    const user = userResult.rows[0];
    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      is_admin: !!user.is_admin,
      created_at: user.created_at,
    });
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ error: "Kullanıcı oluşturulamadı." });
  }
});

// Update user from admin panel
app.patch("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, email, password, is_admin } = req.body || {};

    // Cannot update yourself to non-admin if you're the only admin
    if (id === req.user.id && is_admin === false) {
      const adminCountResult = await client.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1");
      const adminCount = Number(adminCountResult.rows[0].c);
      if (adminCount <= 1) {
        return res.status(400).json({ error: "Son yöneticiden yönetici durumu kaldırılamaz." });
      }
    }

    // Check if user exists
    const existingResult = await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [id],
    });
    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    }

    // Check if email is already taken by another user
    if (email && email !== existing.email) {
      const emailCheckResult = await client.execute({
        sql: "SELECT * FROM users WHERE lower(email)=lower(?)",
        args: [email],
      });
      const emailCheck = emailCheckResult.rows[0];
      if (emailCheck && emailCheck.id !== id) {
        return res.status(409).json({ error: "Bu e-posta başka bir kullanıcı tarafından kullanılıyor." });
      }
    }

    // Prepare update query
    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name.trim());
    }

    if (email !== undefined) {
      updates.push("email = ?");
      params.push(email.trim());
    }

    if (password) {
      updates.push("password_hash = ?");
      params.push(bcrypt.hashSync(password, 10));
    }

    if (is_admin !== undefined) {
      updates.push("is_admin = ?");
      params.push(is_admin ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "Güncellenecek geçerli alan yok." });
    }

    // Execute update
    params.push(id);
    await client.execute({
      sql: `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      args: params,
    });

    // Return updated user data
    const updatedResult = await client.execute({
      sql: "SELECT * FROM users WHERE id = ?",
      args: [id],
    });
    const updatedUser = updatedResult.rows[0];
    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      is_admin: !!updatedUser.is_admin,
      created_at: updatedUser.created_at,
    });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: "Kullanıcı güncellenemedi." });
  }
});


// ---------- AI Assistant (Server side) ----------
// Check AI status
app.get("/api/ai/status", auth, (req, res) => {
  res.json({
    initialized: !!aiGenerator,
    modelSize: "~700MB",
    modelName: "Llama-3.2-1B-Instruct-ONNX"
  });
});

// Initialize AI (on-demand)
app.post("/api/ai/initialize", auth, async (req, res) => {
  try {
    if (aiGenerator) {
      return res.json({ ok: true, message: "AI zaten başlatıldı" });
    }

    await initServerAI();

    if (!aiGenerator) {
      return res.status(500).json({ error: "AI modeli başlatılamadı" });
    }

    res.json({ ok: true, message: "AI başarıyla başlatıldı" });
  } catch (err) {
    console.error("AI initialization error:", err);
    res.status(500).json({ error: "AI modeli başlatılamadı" });
  }
});

app.post("/api/ai/ask", auth, async (req, res) => {
  const { question, notes } = req.body || {};
  if (!question) return res.status(400).json({ error: "Soru eksik" });

  try {
    if (!aiGenerator) {
      // Try to init if not ready
      await initServerAI();
      if (!aiGenerator) {
        return res.status(503).json({ error: "AI Asistanı hâlâ başlatılıyor veya yüklenemedi." });
      }
    }

    // Limit context strictly - better search logic
    const relevantNotes = (notes || []).filter(n => {
      const q = question.toLowerCase().replace(/[^\w\s]/g, ' '); // Strip punctuation for searching
      const words = q.split(/\s+/).filter(w => w.length >= 2); // At least 2 chars
      const t = (n.title || "").toLowerCase();
      const c = (n.content || "").toLowerCase();

      return words.some(word => t.includes(word) || c.includes(word) || word.includes(t) && t.length > 2);
    }).slice(0, 5); // Take up to 5 relevant notes

    const notesToUse = relevantNotes.length > 0 ? relevantNotes : (notes || []).slice(0, 4);
    const context = notesToUse
      .map(n => `TITLE: ${n.title}\nCONTENT: ${n.content.substring(0, 1500)}`)
      .join('\n\n---\n\n');

    const prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are a private assistant for the Glass Keep notes app.
Use ONLY the provided Note Context to answer the user.
If the answer is not in the notes, say "Notlarınızda bu konuyla ilgili bilgi bulamadım."
Be direct, helpful, and concise.
Answer in Turkish.

Note Context:
${context}<|eot_id|><|start_header_id|>user<|end_header_id|>
${question}<|eot_id|><|start_header_id|>assistant<|end_header_id|>
`;

    const output = await aiGenerator(prompt, {
      max_new_tokens: 300,
      temperature: 0.1,
      repetition_penalty: 1.1,
      do_sample: false,
      return_full_text: false,
    });

    res.json({ answer: output[0].generated_text.trim() });
  } catch (err) {
    console.error("Server AI Error:", err);
    res.status(500).json({ error: "AI işleme sunucuda başarısız oldu." });
  }
});

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.json({ ok: true, env: NODE_ENV }));

// ---------- Static (production) ----------
if (NODE_ENV === "production") {
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

// ---------- Listen (local only) ----------
if (!process.env.VERCEL) {
  startup().then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`API listening on http://0.0.0.0:${PORT}  (env=${NODE_ENV})`);
    });
  }).catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

// ---------- Export for Vercel Serverless ----------
module.exports = app;
