// Velixar's own persistence — exactly how a real Aero does
// it: the platform gives you events + an API, and YOU keep your own data. Here
// that's a single SQLite file, so per-Nexus config, XP and open tickets survive
// restarts. One Aero, many Nexuses; every row is keyed by nexus_id.

import Database from 'better-sqlite3';

const db = new Database(process.env.VELIXAR_DB || 'velixar.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS nexus_config (
    nexus_id      TEXT PRIMARY KEY,
    welcome_space TEXT,
    ticket_title  TEXT,
    ticket_desc   TEXT,
    ticket_button TEXT,
    ticket_color  TEXT,
    ticket_staff_role TEXT,
    ticket_categories TEXT,           -- JSON array of strings
    self_roles    TEXT,               -- JSON array of { label, value }
    updated_at    INTEGER
  );
  CREATE TABLE IF NOT EXISTS xp (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    points   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (nexus_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tickets (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    space_id TEXT NOT NULL,
    PRIMARY KEY (nexus_id, user_id)
  );
`);

// Additive migration for older DBs (SQLite has no IF NOT EXISTS for columns).
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN ticket_category_id TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN suggestions_space TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN modlog_space TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN automod_banned TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN automod_flags TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN reaction_roles TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE nexus_config ADD COLUMN prefix TEXT`); } catch { /* already exists */ }

// Extra feature tables. Each is keyed by nexus_id so one Aero serves many.
db.exec(`
  CREATE TABLE IF NOT EXISTS level_roles (
    nexus_id TEXT NOT NULL,
    level    INTEGER NOT NULL,
    role_id  TEXT NOT NULL,
    PRIMARY KEY (nexus_id, level)
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nexus_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    text     TEXT NOT NULL,
    due_at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS giveaways (
    message_id TEXT PRIMARY KEY,
    nexus_id   TEXT NOT NULL,
    space_id   TEXT NOT NULL,
    prize      TEXT NOT NULL,
    winners    INTEGER NOT NULL DEFAULT 1,
    ends_at    INTEGER NOT NULL,
    ended      INTEGER NOT NULL DEFAULT 0,
    entrants   TEXT NOT NULL DEFAULT '[]'   -- JSON array of user ids
  );
  CREATE TABLE IF NOT EXISTS daily (
    nexus_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    last_claim INTEGER NOT NULL DEFAULT 0,   -- ms of last successful /daily
    streak     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (nexus_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS afk (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    reason   TEXT,
    since    INTEGER NOT NULL,
    PRIMARY KEY (nexus_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS counting (
    nexus_id  TEXT PRIMARY KEY,
    space_id  TEXT,                          -- the counting space (null = off)
    current   INTEGER NOT NULL DEFAULT 0,    -- last correct number
    last_user TEXT,                          -- who said it (no double-turns)
    best      INTEGER NOT NULL DEFAULT 0     -- all-time high
  );
  CREATE TABLE IF NOT EXISTS coins (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    balance  INTEGER NOT NULL DEFAULT 0,
    last_work INTEGER NOT NULL DEFAULT 0,    -- ms cooldown for /work
    PRIMARY KEY (nexus_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tags (
    nexus_id TEXT NOT NULL,
    name     TEXT NOT NULL,
    content  TEXT NOT NULL,
    PRIMARY KEY (nexus_id, name)
  );
  CREATE TABLE IF NOT EXISTS veli_counts (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (nexus_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS inventory (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    item     TEXT NOT NULL,
    qty      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (nexus_id, user_id, item)
  );
  CREATE TABLE IF NOT EXISTS mod_notes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    note     TEXT NOT NULL,
    author   TEXT,
    created  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS eco_cooldowns (
    nexus_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    action   TEXT NOT NULL,
    last     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (nexus_id, user_id, action)
  );
`);
// Bank balance lives alongside the wallet (added post-hoc like the config cols).
try { db.exec(`ALTER TABLE coins ADD COLUMN bank INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }

// ── Per-Nexus config ──
const DEFAULT_CONFIG = {
  welcome_space: null,
  ticket_title: 'Support tickets',
  ticket_desc: 'Need help? Open a private ticket and our staff will assist you.',
  ticket_button: 'Open a ticket',
  ticket_color: '#5865F2',
  ticket_staff_role: null,
  ticket_categories: ['General', 'Bug report', 'Billing', 'Report a member'],
  ticket_category_id: null,
  self_roles: [],
  suggestions_space: null,
  modlog_space: null,
  automod_banned: [],                                    // banned words
  automod_flags: { spam: false, caps: false, maxMentions: 0, action: 'warn', deleteMsg: true },
  reaction_roles: [],                                    // [{ label, emoji, role_id }]
  prefix: '!',                                           // the "!command" prefix, per-Nexus
};

const getRow = db.prepare('SELECT * FROM nexus_config WHERE nexus_id = ?');

export function getConfig(nexusId) {
  const row = getRow.get(nexusId);
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    welcome_space: row.welcome_space,
    ticket_title: row.ticket_title ?? DEFAULT_CONFIG.ticket_title,
    ticket_desc: row.ticket_desc ?? DEFAULT_CONFIG.ticket_desc,
    ticket_button: row.ticket_button ?? DEFAULT_CONFIG.ticket_button,
    ticket_color: row.ticket_color ?? DEFAULT_CONFIG.ticket_color,
    ticket_staff_role: row.ticket_staff_role,
    ticket_categories: safeParse(row.ticket_categories, DEFAULT_CONFIG.ticket_categories),
    ticket_category_id: row.ticket_category_id ?? null,
    self_roles: safeParse(row.self_roles, DEFAULT_CONFIG.self_roles),
    suggestions_space: row.suggestions_space ?? null,
    modlog_space: row.modlog_space ?? null,
    automod_banned: safeParse(row.automod_banned, DEFAULT_CONFIG.automod_banned),
    automod_flags: safeParse(row.automod_flags, DEFAULT_CONFIG.automod_flags),
    reaction_roles: safeParse(row.reaction_roles, DEFAULT_CONFIG.reaction_roles),
    prefix: row.prefix || DEFAULT_CONFIG.prefix,
  };
}

const upsert = db.prepare(`
  INSERT INTO nexus_config (nexus_id, welcome_space, ticket_title, ticket_desc, ticket_button, ticket_color, ticket_staff_role, ticket_categories, ticket_category_id, self_roles, suggestions_space, modlog_space, automod_banned, automod_flags, reaction_roles, prefix, updated_at)
  VALUES (@nexus_id, @welcome_space, @ticket_title, @ticket_desc, @ticket_button, @ticket_color, @ticket_staff_role, @ticket_categories, @ticket_category_id, @self_roles, @suggestions_space, @modlog_space, @automod_banned, @automod_flags, @reaction_roles, @prefix, @updated_at)
  ON CONFLICT(nexus_id) DO UPDATE SET
    welcome_space=excluded.welcome_space, ticket_title=excluded.ticket_title, ticket_desc=excluded.ticket_desc,
    ticket_button=excluded.ticket_button, ticket_color=excluded.ticket_color, ticket_staff_role=excluded.ticket_staff_role,
    ticket_categories=excluded.ticket_categories, ticket_category_id=excluded.ticket_category_id, self_roles=excluded.self_roles,
    suggestions_space=excluded.suggestions_space, modlog_space=excluded.modlog_space, automod_banned=excluded.automod_banned,
    automod_flags=excluded.automod_flags, reaction_roles=excluded.reaction_roles, prefix=excluded.prefix, updated_at=excluded.updated_at
`);

// Merge a patch into a Nexus's config and persist it.
export function setConfig(nexusId, patch) {
  const cur = getConfig(nexusId);
  const next = { ...cur, ...patch };
  upsert.run({
    nexus_id: nexusId,
    welcome_space: next.welcome_space ?? null,
    ticket_title: next.ticket_title,
    ticket_desc: next.ticket_desc,
    ticket_button: next.ticket_button,
    ticket_color: next.ticket_color,
    ticket_staff_role: next.ticket_staff_role ?? null,
    ticket_categories: JSON.stringify(next.ticket_categories || []),
    ticket_category_id: next.ticket_category_id ?? null,
    self_roles: JSON.stringify(next.self_roles || []),
    suggestions_space: next.suggestions_space ?? null,
    modlog_space: next.modlog_space ?? null,
    automod_banned: JSON.stringify(next.automod_banned || []),
    automod_flags: JSON.stringify(next.automod_flags || DEFAULT_CONFIG.automod_flags),
    reaction_roles: JSON.stringify(next.reaction_roles || []),
    prefix: next.prefix || DEFAULT_CONFIG.prefix,
    updated_at: Date.now(),
  });
  return next;
}

// ── XP ──
const getXpRow = db.prepare('SELECT points FROM xp WHERE nexus_id = ? AND user_id = ?');
const addXpStmt = db.prepare(`
  INSERT INTO xp (nexus_id, user_id, points) VALUES (?, ?, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET points = points + excluded.points
`);
const topXpStmt = db.prepare('SELECT user_id, points FROM xp WHERE nexus_id = ? ORDER BY points DESC LIMIT ?');

export function getXp(nexusId, userId) { return getXpRow.get(nexusId, userId)?.points || 0; }
export function addXp(nexusId, userId, amount) { addXpStmt.run(nexusId, userId, amount); }
export function topXp(nexusId, limit = 10) { return topXpStmt.all(nexusId, limit); }
const xpStatsStmt = db.prepare('SELECT COUNT(*) AS members, COALESCE(SUM(points),0) AS total FROM xp WHERE nexus_id = ?');
export function xpStats(nexusId) { return xpStatsStmt.get(nexusId) || { members: 0, total: 0 }; }
const openTicketCountStmt = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE nexus_id = ?');
export function openTicketCount(nexusId) { return openTicketCountStmt.get(nexusId)?.n || 0; }
const activeGiveawayCountStmt = db.prepare("SELECT COUNT(*) AS n FROM giveaways WHERE nexus_id = ? AND ended = 0");
export function activeGiveawayCount(nexusId) { return activeGiveawayCountStmt.get(nexusId)?.n || 0; }

// ── Tickets (one open per user) ──
const getTicket = db.prepare('SELECT space_id FROM tickets WHERE nexus_id = ? AND user_id = ?');
const setTicket = db.prepare('INSERT OR REPLACE INTO tickets (nexus_id, user_id, space_id) VALUES (?, ?, ?)');
const delTicket = db.prepare('DELETE FROM tickets WHERE nexus_id = ? AND user_id = ?');
const ownerBySpace = db.prepare('SELECT nexus_id, user_id FROM tickets WHERE space_id = ?');

export function openTicketOf(nexusId, userId) { return getTicket.get(nexusId, userId)?.space_id || null; }
export function recordTicket(nexusId, userId, spaceId) { setTicket.run(nexusId, userId, spaceId); }
export function clearTicket(nexusId, userId) { delTicket.run(nexusId, userId); }
export function ticketOwnerOf(spaceId) { return ownerBySpace.get(spaceId) || null; }

// ── XP absolute set (admin /setxp) ──
const setXpStmt = db.prepare(`
  INSERT INTO xp (nexus_id, user_id, points) VALUES (?, ?, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET points = excluded.points
`);
export function setXp(nexusId, userId, points) { setXpStmt.run(nexusId, userId, Math.max(0, points | 0)); }

// ── Level roles (level -> role granted at that level) ──
const setLevelRoleStmt = db.prepare('INSERT OR REPLACE INTO level_roles (nexus_id, level, role_id) VALUES (?, ?, ?)');
const delLevelRoleStmt = db.prepare('DELETE FROM level_roles WHERE nexus_id = ? AND level = ?');
const listLevelRolesStmt = db.prepare('SELECT level, role_id FROM level_roles WHERE nexus_id = ? ORDER BY level');
const rolesUpToStmt = db.prepare('SELECT role_id FROM level_roles WHERE nexus_id = ? AND level <= ? ORDER BY level');
export function setLevelRole(nexusId, level, roleId) { setLevelRoleStmt.run(nexusId, level | 0, roleId); }
export function removeLevelRole(nexusId, level) { delLevelRoleStmt.run(nexusId, level | 0); }
export function listLevelRoles(nexusId) { return listLevelRolesStmt.all(nexusId); }
export function levelRolesUpTo(nexusId, level) { return rolesUpToStmt.all(nexusId, level | 0).map((r) => r.role_id); }
export function levelRoleAt(nexusId, level) { return listLevelRolesStmt.all(nexusId).find((r) => r.level === (level | 0))?.role_id || null; }

// ── Reminders ──
const addReminderStmt = db.prepare('INSERT INTO reminders (nexus_id, space_id, user_id, text, due_at) VALUES (?, ?, ?, ?, ?)');
const dueRemindersStmt = db.prepare('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 50');
const delReminderStmt = db.prepare('DELETE FROM reminders WHERE id = ?');
const allRemindersStmt = db.prepare('SELECT * FROM reminders');
export function addReminder(nexusId, spaceId, userId, text, dueAt) { return addReminderStmt.run(nexusId, spaceId, userId, text, dueAt).lastInsertRowid; }
export function dueReminders(now = Date.now()) { return dueRemindersStmt.all(now); }
export function deleteReminder(id) { delReminderStmt.run(id); }
export function allReminders() { return allRemindersStmt.all(); }
const userRemindersStmt = db.prepare('SELECT * FROM reminders WHERE nexus_id = ? AND user_id = ? ORDER BY due_at LIMIT 25');
const delUserReminderStmt = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');
export function userReminders(nexusId, userId) { return userRemindersStmt.all(nexusId, userId); }
export function deleteUserReminder(id, userId) { return delUserReminderStmt.run(id, userId).changes > 0; }

// ── Giveaways ──
const addGiveawayStmt = db.prepare('INSERT OR REPLACE INTO giveaways (message_id, nexus_id, space_id, prize, winners, ends_at, ended, entrants) VALUES (@message_id, @nexus_id, @space_id, @prize, @winners, @ends_at, 0, @entrants)');
const getGiveawayStmt = db.prepare('SELECT * FROM giveaways WHERE message_id = ?');
const setGiveawayEntrantsStmt = db.prepare('UPDATE giveaways SET entrants = ? WHERE message_id = ?');
const endGiveawayStmt = db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?');
const activeGiveawaysStmt = db.prepare('SELECT * FROM giveaways WHERE ended = 0');
export function createGiveaway(g) { addGiveawayStmt.run({ ...g, entrants: JSON.stringify(g.entrants || []) }); }
export function getGiveaway(messageId) {
  const row = getGiveawayStmt.get(messageId);
  if (!row) return null;
  return { ...row, entrants: safeParse(row.entrants, []) };
}
export function setGiveawayEntrants(messageId, entrants) { setGiveawayEntrantsStmt.run(JSON.stringify(entrants || []), messageId); }
export function endGiveaway(messageId) { endGiveawayStmt.run(messageId); }
export function activeGiveaways() { return activeGiveawaysStmt.all().map((r) => ({ ...r, entrants: safeParse(r.entrants, []) })); }

// ── Daily streak ──
const getDailyStmt = db.prepare('SELECT last_claim, streak FROM daily WHERE nexus_id = ? AND user_id = ?');
const setDailyStmt = db.prepare(`
  INSERT INTO daily (nexus_id, user_id, last_claim, streak) VALUES (?, ?, ?, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET last_claim = excluded.last_claim, streak = excluded.streak
`);
export function getDaily(nexusId, userId) { return getDailyStmt.get(nexusId, userId) || { last_claim: 0, streak: 0 }; }
export function setDaily(nexusId, userId, lastClaim, streak) { setDailyStmt.run(nexusId, userId, lastClaim, streak); }

// ── AFK ──
const setAfkStmt = db.prepare('INSERT OR REPLACE INTO afk (nexus_id, user_id, reason, since) VALUES (?, ?, ?, ?)');
const getAfkStmt = db.prepare('SELECT reason, since FROM afk WHERE nexus_id = ? AND user_id = ?');
const delAfkStmt = db.prepare('DELETE FROM afk WHERE nexus_id = ? AND user_id = ?');
export function setAfk(nexusId, userId, reason) { setAfkStmt.run(nexusId, userId, reason || null, Date.now()); }
export function getAfk(nexusId, userId) { return getAfkStmt.get(nexusId, userId) || null; }
export function clearAfk(nexusId, userId) { delAfkStmt.run(nexusId, userId); }

// ── Counting game ──
const getCountStmt = db.prepare('SELECT * FROM counting WHERE nexus_id = ?');
const setCountSpaceStmt = db.prepare(`
  INSERT INTO counting (nexus_id, space_id, current, last_user, best) VALUES (?, ?, 0, NULL, COALESCE((SELECT best FROM counting WHERE nexus_id = ?), 0))
  ON CONFLICT(nexus_id) DO UPDATE SET space_id = excluded.space_id, current = 0, last_user = NULL
`);
const advanceCountStmt = db.prepare('UPDATE counting SET current = ?, last_user = ?, best = MAX(best, ?) WHERE nexus_id = ?');
const resetCountStmt = db.prepare('UPDATE counting SET current = 0, last_user = NULL WHERE nexus_id = ?');
export function getCounting(nexusId) { return getCountStmt.get(nexusId) || null; }
export function setCountingSpace(nexusId, spaceId) { setCountSpaceStmt.run(nexusId, spaceId, nexusId); }
export function advanceCounting(nexusId, next, userId) { advanceCountStmt.run(next, userId, next, nexusId); }
export function resetCounting(nexusId) { resetCountStmt.run(nexusId); }

// ── Economy (coins) ──
const getCoinsStmt = db.prepare('SELECT balance, last_work, bank FROM coins WHERE nexus_id = ? AND user_id = ?');
const addCoinsStmt = db.prepare(`
  INSERT INTO coins (nexus_id, user_id, balance) VALUES (?, ?, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET balance = MAX(0, balance + excluded.balance)
`);
const setWorkStmt = db.prepare(`
  INSERT INTO coins (nexus_id, user_id, balance, last_work) VALUES (?, ?, 0, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET last_work = excluded.last_work
`);
const topCoinsStmt = db.prepare('SELECT user_id, balance FROM coins WHERE nexus_id = ? ORDER BY balance DESC LIMIT ?');
export function getCoins(nexusId, userId) { return getCoinsStmt.get(nexusId, userId) || { balance: 0, last_work: 0, bank: 0 }; }
export function addCoins(nexusId, userId, amount) { addCoinsStmt.run(nexusId, userId, amount); }
export function markWork(nexusId, userId, ts) { setWorkStmt.run(nexusId, userId, ts); }
export function topCoins(nexusId, limit = 10) { return topCoinsStmt.all(nexusId, limit); }

// ── Bank (deposit/withdraw between wallet and bank) ──
const setBankStmt = db.prepare(`
  INSERT INTO coins (nexus_id, user_id, balance, bank) VALUES (?, ?, 0, ?)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET bank = MAX(0, bank + excluded.bank)
`);
// Move `amount` wallet->bank (deposit) or bank->wallet (withdraw, negative).
export const bankMove = db.transaction((nexusId, userId, amount) => {
  const row = getCoinsStmt.get(nexusId, userId) || { balance: 0, bank: 0 };
  if (amount > 0 && (row.balance || 0) < amount) return false;   // deposit needs wallet funds
  if (amount < 0 && (row.bank || 0) < -amount) return false;     // withdraw needs bank funds
  addCoinsStmt.run(nexusId, userId, -amount);
  setBankStmt.run(nexusId, userId, amount);
  return true;
});

// ── Generic economy cooldowns (fish/hunt/mine/…): last-use per action ──
const getCdStmt = db.prepare('SELECT last FROM eco_cooldowns WHERE nexus_id = ? AND user_id = ? AND action = ?');
const setCdStmt = db.prepare(`
  INSERT INTO eco_cooldowns (nexus_id, user_id, action, last) VALUES (?, ?, ?, ?)
  ON CONFLICT(nexus_id, user_id, action) DO UPDATE SET last = excluded.last
`);
export function ecoCooldown(nexusId, userId, action) { return getCdStmt.get(nexusId, userId, action)?.last || 0; }
export function markEco(nexusId, userId, action, ts) { setCdStmt.run(nexusId, userId, action, ts); }
// Move coins between two users atomically (for /pay and /rob).
export const transferCoins = db.transaction((nexusId, from, to, amount) => {
  const bal = getCoinsStmt.get(nexusId, from)?.balance || 0;
  if (bal < amount) return false;
  addCoinsStmt.run(nexusId, from, -amount);
  addCoinsStmt.run(nexusId, to, amount);
  return true;
});

// ── Tags (custom saved responses) ──
const setTagStmt = db.prepare('INSERT OR REPLACE INTO tags (nexus_id, name, content) VALUES (?, ?, ?)');
const getTagStmt = db.prepare('SELECT content FROM tags WHERE nexus_id = ? AND name = ?');
const delTagStmt = db.prepare('DELETE FROM tags WHERE nexus_id = ? AND name = ?');
const listTagsStmt = db.prepare('SELECT name FROM tags WHERE nexus_id = ? ORDER BY name LIMIT 50');
export function setTag(nexusId, name, content) { setTagStmt.run(nexusId, name, content); }
export function getTag(nexusId, name) { return getTagStmt.get(nexusId, name)?.content || null; }
export function deleteTag(nexusId, name) { return delTagStmt.run(nexusId, name).changes > 0; }
export function listTags(nexusId) { return listTagsStmt.all(nexusId).map((r) => r.name); }

// ── Veli counter (OwO-style) ──
const bumpVeliStmt = db.prepare(`
  INSERT INTO veli_counts (nexus_id, user_id, count) VALUES (?, ?, 1)
  ON CONFLICT(nexus_id, user_id) DO UPDATE SET count = count + 1
`);
const getVeliStmt = db.prepare('SELECT count FROM veli_counts WHERE nexus_id = ? AND user_id = ?');
const topVeliStmt = db.prepare('SELECT user_id, count FROM veli_counts WHERE nexus_id = ? ORDER BY count DESC LIMIT ?');
export function bumpVeli(nexusId, userId) { bumpVeliStmt.run(nexusId, userId); return getVeliStmt.get(nexusId, userId)?.count || 1; }
export function getVeli(nexusId, userId) { return getVeliStmt.get(nexusId, userId)?.count || 0; }
export function topVeli(nexusId, limit = 10) { return topVeliStmt.all(nexusId, limit); }

// ── Inventory (economy items) ──
const addItemStmt = db.prepare(`
  INSERT INTO inventory (nexus_id, user_id, item, qty) VALUES (?, ?, ?, ?)
  ON CONFLICT(nexus_id, user_id, item) DO UPDATE SET qty = MAX(0, qty + excluded.qty)
`);
const getItemStmt = db.prepare('SELECT qty FROM inventory WHERE nexus_id = ? AND user_id = ? AND item = ?');
const listInvStmt = db.prepare('SELECT item, qty FROM inventory WHERE nexus_id = ? AND user_id = ? AND qty > 0 ORDER BY item');
export function addItem(nexusId, userId, item, qty) { addItemStmt.run(nexusId, userId, item, qty); }
export function getItem(nexusId, userId, item) { return getItemStmt.get(nexusId, userId, item)?.qty || 0; }
export function listInventory(nexusId, userId) { return listInvStmt.all(nexusId, userId); }

// ── Mod notes (private staff notes on a member) ──
const addNoteStmt = db.prepare('INSERT INTO mod_notes (nexus_id, user_id, note, author, created) VALUES (?, ?, ?, ?, ?)');
const listNotesStmt = db.prepare('SELECT id, note, author, created FROM mod_notes WHERE nexus_id = ? AND user_id = ? ORDER BY created DESC');
const clearNotesStmt = db.prepare('DELETE FROM mod_notes WHERE nexus_id = ? AND user_id = ?');
export function addNote(nexusId, userId, note, author) { addNoteStmt.run(nexusId, userId, note, author || null, Date.now()); }
export function listNotes(nexusId, userId) { return listNotesStmt.all(nexusId, userId); }
export function clearNotes(nexusId, userId) { return clearNotesStmt.run(nexusId, userId).changes; }

function safeParse(s, fallback) {
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}
