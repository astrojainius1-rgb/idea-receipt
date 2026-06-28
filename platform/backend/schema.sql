-- idea-receipt backend — D1 (SQLite) schema / migration.
-- System of record for users, ideas, lists, sessions metadata, and per-user state.
-- Apply with:  wrangler d1 execute idea_receipt --file=./schema.sql --remote
-- (sessions + push subscriptions live in KV, not here — see wrangler.toml / README.)
--
-- Conventions:
--   * ids are app-generated UUIDv4 strings (TEXT), not autoincrement ints, so the
--     client can mint ids offline and they survive sync/merge.
--   * all timestamps are ISO-8601 UTC strings ("2026-06-27T06:00:43Z").
--   * soft-delete via deleted_at (NULL = live) so offline clients can reconcile
--     deletions with last-write-wins instead of losing tombstones.

PRAGMA foreign_keys = ON;

-- ── users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- uuid
  email       TEXT NOT NULL UNIQUE,        -- lowercased, canonical identity
  name        TEXT,                        -- optional display name (from OAuth profile)
  created_at  TEXT NOT NULL
);

-- ── auth_identities ────────────────────────────────────────────────────────
-- One row per (provider, subject) so a single user can attach Google OAuth AND
-- magic-link, and so "which OAuth provider" is swappable without touching users.
CREATE TABLE IF NOT EXISTS auth_identities (
  id           TEXT PRIMARY KEY,           -- uuid
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- 'google' | 'magic' | (future: 'github'...)
  subject      TEXT NOT NULL,              -- provider's stable user id (OAuth 'sub'); for magic = email
  created_at   TEXT NOT NULL,
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON auth_identities(user_id);

-- ── sessions (audit copy) ──────────────────────────────────────────────────
-- The live session lookup is KV (fast, TTL-evicting). This table is an optional
-- durable audit/index so a user can list & revoke their devices. The Worker treats
-- KV as authoritative for auth; D1 here is best-effort bookkeeping.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,            -- opaque random (also the cookie value); store a hash in prod
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ── lists ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lists (
  id          TEXT PRIMARY KEY,            -- uuid
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,  -- manual ordering of lists
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                          -- NULL = live
);
CREATE INDEX IF NOT EXISTS idx_lists_user ON lists(user_id);

-- ── ideas ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ideas (
  id              TEXT PRIMARY KEY,         -- uuid (also the Vectorize key)
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id         TEXT REFERENCES lists(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '', -- free text / notes; the old `details` joined with \n
  tags            TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'done' | 'archived'
  priority        INTEGER NOT NULL DEFAULT 0,
  due_at          TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'notion'
  notion_block_id TEXT,                     -- set when source='notion'; used for idempotent import
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,            -- drives last-write-wins reconciliation
  deleted_at      TEXT,                     -- NULL = live (soft delete / tombstone)
  CHECK (status IN ('active','done','archived')),
  CHECK (source IN ('manual','notion'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_user        ON ideas(user_id);
CREATE INDEX IF NOT EXISTS idx_ideas_user_list   ON ideas(user_id, list_id);
CREATE INDEX IF NOT EXISTS idx_ideas_user_updated ON ideas(user_id, updated_at);
-- idempotent Notion re-import: a block maps to at most one idea per user
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ideas_notion
  ON ideas(user_id, notion_block_id) WHERE notion_block_id IS NOT NULL;

-- ── user_state ─────────────────────────────────────────────────────────────
-- Per-user device-synced settings + the "billed to" name + any UI state that used
-- to live in localStorage. Cross-off/done is modelled as ideas.status='done', but
-- ad-hoc client state (theme, sort, coupon flags, redeemed coupons, etc.) is a blob.
-- Single row per user; `data` is JSON; `updated_at` drives last-write-wins.
CREATE TABLE IF NOT EXISTS user_state (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL DEFAULT '{}',   -- JSON: { settings:{...}, billedTo:"...", coupons:{...}, ... }
  updated_at  TEXT NOT NULL
);
