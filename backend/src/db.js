/**
 * SQLite persistence for extension_user_id ↔ premium + promo metadata.
 * File lives under backend/data/ (gitignored).
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "billing.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS extension_users (
    id TEXT PRIMARY KEY,
    email TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    premium INTEGER NOT NULL DEFAULT 0,
    premium_source TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_customer ON extension_users(stripe_customer_id);

  CREATE TABLE IF NOT EXISTS promo_codes (
    code TEXT PRIMARY KEY,
    max_redemptions INTEGER NOT NULL DEFAULT -1,
    redemptions INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promo_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    extension_user_id TEXT NOT NULL,
    redeemed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(code, extension_user_id)
  );
`);

export function getUser(id) {
  return db.prepare("SELECT * FROM extension_users WHERE id = ?").get(id);
}

export function upsertUserPremium({
  id,
  email = null,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  premium,
  premiumSource
}) {
  const row = getUser(id);
  if (row) {
    db.prepare(
      `UPDATE extension_users SET
        email = COALESCE(?, email),
        stripe_customer_id = COALESCE(?, stripe_customer_id),
        stripe_subscription_id = COALESCE(?, stripe_subscription_id),
        premium = ?,
        premium_source = ?,
        updated_at = datetime('now')
      WHERE id = ?`
    ).run(
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      premium ? 1 : 0,
      premiumSource ?? row.premium_source,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO extension_users (id, email, stripe_customer_id, stripe_subscription_id, premium, premium_source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      email,
      stripeCustomerId,
      stripeSubscriptionId,
      premium ? 1 : 0,
      premiumSource ?? "stripe"
    );
  }
}

export function findUserByCustomerId(stripeCustomerId) {
  return db.prepare("SELECT * FROM extension_users WHERE stripe_customer_id = ?").get(stripeCustomerId);
}

export function isPremium(id) {
  const row = getUser(id);
  return Boolean(row?.premium);
}

/** Promo: returns { ok, error? } */
export function redeemPromo(rawCode, extensionUserId) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code || !extensionUserId) {
    return { ok: false, error: "invalid_request" };
  }

  const promo = db.prepare("SELECT * FROM promo_codes WHERE code = ?").get(code);
  if (!promo || !promo.active) {
    return { ok: false, error: "invalid_code" };
  }
  if (promo.expires_at && promo.expires_at < new Date().toISOString()) {
    return { ok: false, error: "expired" };
  }
  if (promo.max_redemptions >= 0 && promo.redemptions >= promo.max_redemptions) {
    return { ok: false, error: "exhausted" };
  }

  try {
    db.prepare(
      "INSERT INTO promo_redemptions (code, extension_user_id) VALUES (?, ?)"
    ).run(code, extensionUserId);
  } catch (e) {
    if (String(e.message || e).includes("UNIQUE")) {
      return { ok: false, error: "already_redeemed" };
    }
    throw e;
  }

  db.prepare("UPDATE promo_codes SET redemptions = redemptions + 1 WHERE code = ?").run(code);
  upsertUserPremium({
    id: extensionUserId,
    premium: true,
    premiumSource: "promo"
  });

  return { ok: true };
}

export function ensurePromoSeed(envString) {
  if (!envString || !String(envString).trim()) return;
  const count = db.prepare("SELECT COUNT(*) AS c FROM promo_codes").get().c;
  if (count > 0) return;

  const entries = String(envString).split(",").map((s) => s.trim()).filter(Boolean);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO promo_codes (code, max_redemptions, active) VALUES (?, ?, 1)"
  );
  for (const entry of entries) {
    const [codePart, maxPart] = entry.split(":").map((x) => x.trim());
    if (!codePart) continue;
    const max = maxPart ? parseInt(maxPart, 10) : 100;
    insert.run(codePart.toUpperCase(), Number.isFinite(max) ? max : 100);
  }
}
