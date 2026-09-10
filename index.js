// Velixar — the flagship all-in-one Aero for the SAITH Nexus.
//
// A single Aero that showcases every Ballastra capability, split into
// toggle-able MODULES the Nexus owner flips on/off in Nexus settings:
//
//   welcome     · greet new members with a rich card + role buttons
//   moderation  · /warn /timeout /purge with member pickers, ephemeral logs
//   levels      · earn XP from chatting, /rank, /leaderboard, /daily streak,
//                 level-up announcements + level-role rewards, admin /givexp
//   fun         · /roll /coinflip /eightball /choose /poll with buttons
//   roles       · self-assign roles (add + remove) from a menu
//   reactionroles· /rr-panel — a button panel that toggles roles on click
//   reminders   · /remind — a personal ping after N minutes (persisted)
//   suggestions · /suggest posts to a space with live up/down vote buttons
//   giveaways   · /giveaway — Enter button, timed draw, winner announce
//   automod     · banned words / spam / caps / mention filters (warns + logs)
//   logging     · mod actions + joins/leaves recorded to a mod-log space
//   afk         · /afk marks you away; a mention tells others, you clear it
//   counting    · members count up together in a space; a mistake resets it
//   economy     · coins: /work /daily-coins /balance /pay /rich /gamble /rob
//   tags        · /tag posts an admin-saved snippet
//   tickets     · /panel opens a private support Space per member
//   (always-on) · /userinfo, /nexusstats, over 30 fun + utility toys, and
//                 /announce + /embed to post rich messages to a space
//
// Over 100 commands total. Full list + per-command permissions in README.md
// and the aero.json manifest.
//
// It uses ONLY the public SDK an external developer has (@ballastra/aero).
// Nothing here is privileged. Declare the matching modules + commands in the
// Developer Portal, then install the Aero into SAITH and grant it the
// permissions each module needs.
//
// Config via env:
//   AERO_TOKEN     the Aero token (Developer Portal, shown once)
//   BALLASTRA_URL  gateway + REST origin, e.g. https://web.ballastra.app
//   WELCOME_SPACE  space id for welcomes + panels (optional; falls back to the
//                  interaction's own space)

import { createAero, loadManifest } from '@ballastra/aero';
import * as store from './store.js';

// .trim() guards against a trailing CRLF / space that Windows .env files and
// some --env-file parsers leave on the value — that would silently break the
// token hash and read as "invalid token".
const TOKEN = (process.env.AERO_TOKEN || '').trim();
const BASE  = (process.env.BALLASTRA_URL || 'https://web.ballastra.app').trim();

if (!TOKEN) { console.error('Set AERO_TOKEN.'); process.exit(1); }

const BRAND = '#5865F2';
const OK = '#22C55E';
const WARN_C = '#F59E0B';
const DANGER_C = '#EF4444';

// Every Velixar embed carries the same quiet footer, so 160+ replies read as one
// cohesive, on-brand voice instead of bare title+description cards. `say()` is
// the workhorse used across the whole file; keeping the polish here upgrades
// every command at once. Pass a 4th arg `false` to drop the footer for a reply
// that already has its own (e.g. paginated lists, game boards).
const BRAND_FOOTER = 'Velixar';
const say = (title, description, color = BRAND, footer = true) => ({
  embeds: [{ title, description, color, ...(footer ? { footer: { text: BRAND_FOOTER } } : {}) }],
});

// A consistent moderation confirmation card: the action, the member, the
// moderator, and an optional extra detail field (warning count, duration…).
// Keeps every mod reply auditable and on-brand in one place.
function modCard(i, { title, description, color = WARN_C, target, detail }) {
  const fields = [
    { name: 'Member', value: `<@${target}>`, inline: true },
    { name: 'Moderator', value: `<@${i.invoker.id}>`, inline: true },
  ];
  if (detail) fields.push({ name: detail.name, value: detail.value, inline: true });
  return rich({ title, description, color, fields, footer: 'Velixar · moderation' });
}

// Rich embed builder for a consistent, polished look: optional thumbnail,
// fields, footer and an ISO timestamp. Keeps every command's card on-brand.
function rich({ title, description, color = BRAND, thumbnail, image, fields, footer, timestamp = true }) {
  const e = { title, description, color };
  if (thumbnail) e.thumbnail = { url: thumbnail };
  if (image) e.image = { url: image };
  if (Array.isArray(fields) && fields.length) e.fields = fields;
  if (footer) e.footer = { text: footer };
  if (timestamp) e.timestamp = new Date().toISOString();
  return { embeds: [e] };
}

// Pagination: render page `p` of `items` (rendered by `renderPage`) with
// Prev/Next buttons. State is held per message id in `pageStore`.
const pageStore = new Map(); // messageId -> { items, perPage, title, color }
function pageView(state, p) {
  const total = Math.ceil(state.items.length / state.perPage) || 1;
  const page = Math.max(0, Math.min(p, total - 1));
  const slice = state.items.slice(page * state.perPage, page * state.perPage + state.perPage);
  const body = slice.map((line, n) => (state.numbered ? `**${page * state.perPage + n + 1}.** ${line}` : line)).join('\n');
  const comps = total > 1 ? [{ components: [
    { type: 'button', style: 'secondary', label: '◀ Prev', custom_id: 'page:prev' },
    { type: 'button', style: 'secondary', label: `${page + 1}/${total}`, custom_id: 'page:none' },
    { type: 'button', style: 'secondary', label: 'Next ▶', custom_id: 'page:next' },
  ] }] : [];
  return { embeds: [{ title: state.title, description: body || '(empty)', color: state.color, footer: state.footer ? { text: state.footer } : undefined }], components: comps };
}
async function replyPaged(i, { items, perPage = 10, title, color = BRAND, numbered = false, footer }) {
  const state = { items, perPage, title, color, numbered, footer, page: 0 };
  const res = await i.reply(pageView(state, 0));
  if (res?.message?.id && Math.ceil(items.length / perPage) > 1) pageStore.set(String(res.message.id), state);
  return undefined;
}
function handlePage(i, dir) {
  const s = pageStore.get(String(i.message_id));
  if (!s) return i.replyEphemeral('This list is no longer active.');
  s.page = dir === 'next' ? s.page + 1 : s.page - 1;
  return i.update(pageView(s, s.page));
}

// Post an audit entry to the Nexus's configured mod-log space (if the Logging
// module is on and a space is set). Best-effort — logging must never block or
// break the action it records.
async function modlog(nexusId, { title, lines, color = BRAND, actor }) {
  try {
    if (!aero.moduleEnabled(nexusId, 'logging')) return;
    const space = cfg(nexusId).modlog_space;
    if (!space) return;
    const desc = [...(Array.isArray(lines) ? lines : [lines]), actor ? `\n*by ${actor}*` : '']
      .filter(Boolean).join('\n');
    await aero.sendMessage(nexusId, space, {
      embeds: [{ title, description: desc, color, footer: { text: new Date().toLocaleString() } }],
    });
  } catch (e) { console.error('[velixar] modlog failed:', e.message); }
}

// Per-Nexus config lives in Velixar's own SQLite store (store.js), keyed by
// nexus_id — so ONE Aero serves many Nexuses, each configured by its own owner
// with the /setup commands below. Nothing is hard-coded to a single Nexus.
const cfg = (nexusId) => store.getConfig(nexusId);

// XP earn cooldown is fine in-memory (it only guards spam within a session).
const lastGain = new Map();    // `${nexus}:${user}` -> ts

// Load the manifest (aero.json) so unhandledCommands() can sanity-check that
// every command declared in the Portal has a handler here. Best-effort: a
// missing/invalid file must not stop the Aero.
const manifest = await loadManifest('./aero.json').catch(() => null);

const aero = await createAero({ token: TOKEN, baseUrl: BASE, manifest: manifest ?? undefined });
console.log(`[velixar] connected as "${aero.aero.name}" in ${aero.installations.length} Nexus(es).`);

// Helper: is a module on for the Nexus this event/interaction came from?
const on = (nexusId, key) => aero.moduleEnabled(nexusId, key);

// Inline-first helper: if the command was run with an inline `text` argument
// (inline-style, e.g. "/dice 20"), run `inline(value)` straight away; otherwise
// fall back to opening `modal` so the picker still works. Keeps every command
// that takes one free-text value inline without duplicating the fallback.
function inlineText(i, inline, modal) {
  const v = (i.options?.text ?? '').toString().trim();
  return v ? inline(v) : modal();
}

aero.onModuleToggled((m) => console.log(`[velixar] module ${m.module_key} -> ${m.enabled ? 'on' : 'off'}`));
aero.onLifecycle('error', (e) => console.error('[velixar] error:', e?.message || e));

// ─────────────────────────────────────────────────────────────
// WELCOME module
// ─────────────────────────────────────────────────────────────
aero.on('member.joined', async (ev) => {
  const member = ev.data?.member || {};
  const name = member.name || 'friend';
  const mention = member.id ? `<@${member.id}>` : `**${name}**`;

  // Logging module: record the join in the mod-log (independent of welcome).
  modlog(ev.nexus_id, { title: '📥 Member joined', color: OK, lines: [`${mention} joined the Nexus.`] });

  if (!on(ev.nexus_id, 'welcome')) return;
  const space = cfg(ev.nexus_id).welcome_space;
  if (!space) return; // owner hasn't run /welcome-setup yet
  const rolesReady = (cfg(ev.nexus_id).self_roles || []).length > 0;
  try {
    await aero.sendMessage(ev.nexus_id, space, {
      text: mention,
      embeds: [{
        title: `Welcome to the Nexus, ${name}! 🎉`,
        description: `Great to have you here, ${mention}. Take a moment to read the rules, then${rolesReady ? ' grab a role below and' : ''} jump in and say hi. 👋`,
        color: BRAND,
        thumbnail: member.avatar_url ? { url: member.avatar_url } : undefined,
      }],
      components: rolesReady ? [{ components: [
        { type: 'button', style: 'primary', label: 'Get roles', custom_id: 'roles:open' },
      ] }] : undefined,
    });
  } catch (e) { console.error('[velixar] welcome failed:', e.message); }
});

// Logging: a member left / was removed.
aero.on('member.left', (ev) => {
  const member = ev.data?.member || {};
  const who = member.name ? `**${member.name}**` : (member.id ? `<@${member.id}>` : 'A member');
  modlog(ev.nexus_id, { title: '📤 Member left', color: WARN_C, lines: [`${who} left the Nexus.`] });
});

// ─────────────────────────────────────────────────────────────
// LEVELS module — XP from chatting
// ─────────────────────────────────────────────────────────────
const levelFor = (points) => Math.floor(Math.sqrt(points / 50));

// Grant every level-role the member has now reached (idempotent — assignRole is
// a no-op if they already hold it). Used on level-up and on /setxp /givexp.
async function syncLevelRoles(nexusId, userId, level) {
  const roleIds = store.levelRolesUpTo(nexusId, level);
  for (const roleId of roleIds) {
    await aero.assignRole(nexusId, userId, roleId).catch(() => {});
  }
}

// Recent-message timestamps per user, for the automod spam check.
const recentMsgs = new Map(); // `${nexus}:${user}` -> [ts, ts, ...]

// Decide if a message violates this Nexus's automod rules. Returns a reason
// string, or null. Rules are all opt-in via /automod-* setup.
function automodViolation(nexusId, uid, content) {
  const c = cfg(nexusId);
  const text = String(content || '');
  // Banned words (whole-word, case-insensitive).
  const banned = c.automod_banned || [];
  if (banned.length) {
    const lower = text.toLowerCase();
    if (banned.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower))) {
      return 'a blocked word';
    }
  }
  const flags = c.automod_flags || {};
  // Excessive caps (only for longer messages).
  if (flags.caps && text.length >= 10) {
    const letters = text.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 8 && (text.replace(/[^A-Z]/g, '').length / letters.length) > 0.7) return 'excessive caps';
  }
  // Too many mentions in one message.
  if (flags.maxMentions > 0) {
    const mentions = (text.match(/<@[!&]?[a-zA-Z0-9_-]+>|@(everyone|here)\b/g) || []).length;
    if (mentions > flags.maxMentions) return `too many mentions (${mentions})`;
  }
  // Spam: 5+ messages inside 5 seconds.
  if (flags.spam) {
    const key = `${nexusId}:${uid}`;
    const now = Date.now();
    const arr = (recentMsgs.get(key) || []).filter((t) => now - t < 5000);
    arr.push(now);
    recentMsgs.set(key, arr);
    if (arr.length >= 5) return 'spam (too many messages)';
  }
  return null;
}

aero.on('message.created', async (ev) => {
  const uid = ev.data?.message?.sender_id;
  if (!uid || uid === aero.aero.user_id) return; // ignore the Aero's own messages
  const space = ev.data?.message?.space_id || ev.space_id;
  const content = ev.data?.message?.content ?? ev.data?.message?.text ?? '';

  // ── AFK: clear the sender's AFK, and flag any AFK member they mention ──
  if (on(ev.nexus_id, 'afk')) {
    if (store.getAfk(ev.nexus_id, uid)) {
      store.clearAfk(ev.nexus_id, uid);
      if (space) await aero.sendMessage(ev.nexus_id, space, `👋 Welcome back <@${uid}>, removed your AFK.`).catch(() => {});
    }
    const mentioned = [...String(content).matchAll(/<@([a-zA-Z0-9_-]+)>/g)].map((m) => m[1]);
    for (const mid of new Set(mentioned)) {
      if (mid === uid) continue;
      const afk = store.getAfk(ev.nexus_id, mid);
      if (afk && space) {
        const mins = Math.round((Date.now() - afk.since) / 60000);
        await aero.sendMessage(ev.nexus_id, space, say('💤 They are AFK', `<@${mid}> is away: *${afk.reason}* (${mins || 0}m ago).`, WARN_C)).catch(() => {});
      }
    }
  }

  // ── "veli" convenience trigger (Velixar's take on OwO's "owo") ──
  // A message that starts with "veli" gets a fun reply, no slash needed, and
  // bumps the sender's veli counter (see /velitop). Gated on the Fun module.
  if (on(ev.nexus_id, 'fun') && space) {
    const m = String(content).trim().match(/^veli\b(.*)$/i);
    if (m) {
      const extra = m[1].trim();
      const FACES = ['(◕ᴗ◕✿)', '(｡◕‿◕｡)', '(*^▽^*)', 'ヽ(・∀・)ﾉ', '(★^O^★)', '(≧◡≦)', '(ﾉ◕ヮ◕)ﾉ'];
      const face = FACES[Math.floor(Math.random() * FACES.length)];
      const count = store.bumpVeli(ev.nexus_id, uid);
      const milestone = count % 100 === 0 ? `  🎉 **${count} velis!**` : '';
      const reply = extra ? `**veli** ${extra} ${face}${milestone}` : `**veli!** ${face}${milestone}`;
      await aero.sendMessage(ev.nexus_id, space, reply).catch(() => {});
    }
  }

  // ── Auto-moderation (independent of levels) ──
  if (on(ev.nexus_id, 'automod')) {
    const reason = automodViolation(ev.nexus_id, uid, content);
    if (reason) {
      const flags = cfg(ev.nexus_id).automod_flags || {};
      const messageId = ev.data?.message?.id;
      const actions = [];
      try {
        // 1) Delete the offending message (if enabled + we have the id + the
        //    Aero holds Manage messages). Best-effort.
        if (flags.deleteMsg !== false && messageId && space) {
          await aero.deleteMessage(ev.nexus_id, space, messageId).catch(() => {});
          actions.push('message deleted');
        }
        // 2) Apply the configured punishment. warn auto-escalates via warnMember;
        //    mute/kick/ban act directly.
        const action = flags.action || 'warn';
        if (action === 'warn') {
          const { warnings } = await aero.warnMember(ev.nexus_id, uid, `AutoMod: ${reason}`);
          if (warnings >= 3) { await aero.timeoutMember(ev.nexus_id, uid, 10, `AutoMod: repeated ${reason}`).catch(() => {}); actions.push('auto-muted (3 warnings)'); }
          actions.push(`warned (${warnings})`);
        } else if (action === 'mute') {
          await aero.timeoutMember(ev.nexus_id, uid, 10, `AutoMod: ${reason}`); actions.push('timed out 10m');
        } else if (action === 'kick') {
          await aero.kickMember(ev.nexus_id, uid); actions.push('kicked');
        } else if (action === 'ban') {
          await aero.banMember(ev.nexus_id, uid, `AutoMod: ${reason}`); actions.push('banned');
        }
        // 3) Warn the member in-space (short, so they know why) + log it.
        if (space) await aero.sendMessage(ev.nexus_id, space, say('🤖 AutoMod', `<@${uid}>, that message broke a rule (**${reason}**).`, WARN_C)).catch(() => {});
        modlog(ev.nexus_id, { title: '🤖 AutoMod', color: WARN_C, lines: [`<@${uid}> triggered **${reason}**.`, actions.length ? `Action: ${actions.join(', ')}.` : ''] });
      } catch (e) { console.error('[velixar] automod action failed:', e.message); }
    }
  }

  // ── Counting game: members count up, one turn each, a mistake resets ──
  if (on(ev.nexus_id, 'counting')) {
    const game = store.getCounting(ev.nexus_id);
    if (game && game.space_id && space === game.space_id) {
      const num = parseInt(String(content).trim(), 10);
      // Only react to messages that are purely a number.
      if (String(content).trim() === String(num) && Number.isFinite(num)) {
        const expected = game.current + 1;
        if (uid === game.last_user) {
          store.resetCounting(ev.nexus_id);
          await aero.sendMessage(ev.nexus_id, space, say('💥 Reset', `<@${uid}>, you can't count twice in a row! Back to **1**.`, DANGER_C)).catch(() => {});
        } else if (num !== expected) {
          store.resetCounting(ev.nexus_id);
          await aero.sendMessage(ev.nexus_id, space, say('💥 Wrong number', `<@${uid}> broke the chain at **${game.current}** (expected ${expected}). Back to **1**.`, DANGER_C)).catch(() => {});
        } else {
          store.advanceCounting(ev.nexus_id, num, uid);
          const g = store.getCounting(ev.nexus_id);
          if (num > (game.best || 0) && num % 10 === 0) {
            await aero.sendMessage(ev.nexus_id, space, `🎉 New milestone: **${num}**! (best: ${g.best})`).catch(() => {});
          }
        }
      }
    }
  }

  // ── Levels: XP from chatting ──
  if (!on(ev.nexus_id, 'levels')) return;
  const key = `${ev.nexus_id}:${uid}`;
  const now = Date.now();
  if (now - (lastGain.get(key) || 0) < 30_000) return; // 30s cooldown
  lastGain.set(key, now);
  const before = levelFor(store.getXp(ev.nexus_id, uid));
  store.addXp(ev.nexus_id, uid, 10 + Math.floor(Math.random() * 6));
  const after = levelFor(store.getXp(ev.nexus_id, uid));
  if (after > before) {
    // Level up! Announce in the space they were chatting in, and hand out any
    // level-role they just unlocked.
    const roleId = store.levelRoleAt(ev.nexus_id, after);
    await syncLevelRoles(ev.nexus_id, uid, after);
    if (space) {
      const extra = roleId ? ` You unlocked the <@&${roleId}> role!` : '';
      await aero.sendMessage(ev.nexus_id, space, say('Level up! 🎉', `<@${uid}> reached **level ${after}**.${extra}`, OK)).catch(() => {});
    }
  }
});

// XP needed to reach a given level: level = floor(sqrt(pts/50)) ⇒ pts = 50·lvl².
const xpForLevel = (lvl) => 50 * lvl * lvl;
// A 10-cell progress bar toward the next level.
function progressBar(points) {
  const lvl = levelFor(points);
  const cur = xpForLevel(lvl);
  const next = xpForLevel(lvl + 1);
  const pct = Math.max(0, Math.min(1, (points - cur) / (next - cur)));
  const filled = Math.round(pct * 10);
  return { bar: '█'.repeat(filled) + '░'.repeat(10 - filled), have: points - cur, need: next - cur, next };
}

aero.command('rank', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  // "/rank @member" looks up someone else; bare "/rank" is your own.
  const target = i.options?.user || i.invoker.id;
  const self = target === i.invoker.id;
  const points = store.getXp(i.nexus_id, target);
  const lvl = levelFor(points);
  const p = progressBar(points);
  const body = rich({
    title: `📊 ${self ? i.invoker.name : 'Member'}`,
    description: `${self ? '' : `<@${target}>\n\n`}\`${p.bar}\`  **${p.have}/${p.need}** XP to level ${lvl + 1}`,
    color: OK,
    fields: [
      { name: 'Level', value: `**${lvl}**`, inline: true },
      { name: 'Total XP', value: `**${points.toLocaleString()}**`, inline: true },
      { name: 'To next', value: `${(p.need - p.have).toLocaleString()} XP`, inline: true },
    ],
    footer: 'Velixar · chat to earn XP',
  });
  // Your own rank stays private; someone else's is a normal reply.
  return self ? i.replyEphemeral(body) : i.reply(body);
});

const MEDALS = ['🥇', '🥈', '🥉'];
aero.command('leaderboard', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const rows = store.topXp(i.nexus_id, 50);
  if (!rows.length) return i.reply(say('🏆 Leaderboard', 'No XP earned yet. Start chatting to climb!'));
  const items = rows.map((r, idx) => {
    const rank = MEDALS[idx] || `**${idx + 1}.**`;
    return `${rank} <@${r.user_id}>. **${r.points}** XP · lvl ${levelFor(r.points)}`;
  });
  const you = store.getXp(i.nexus_id, i.invoker.id);
  return replyPaged(i, { items, perPage: 10, title: '🏆 Top members', footer: `You: ${you} XP (lvl ${levelFor(you)})` });
});

// ─────────────────────────────────────────────────────────────
// Finisher batch — a few more levels, community and text toys that round
// Velixar out to a full 200-command Aero.
// ─────────────────────────────────────────────────────────────

// /level — a friendly alias of /rank (bare = you; @member = them).
aero.command('level', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const target = i.options?.user || i.invoker.id;
  const pts = store.getXp(i.nexus_id, target);
  return i.replyEphemeral(say('📈 Level', `<@${target}> is level **${levelFor(pts)}** with **${pts}** XP.`, OK));
});
// /xp — show raw XP total.
aero.command('xp', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const target = i.options?.user || i.invoker.id;
  return i.replyEphemeral(say('✨ XP', `<@${target}> has **${store.getXp(i.nexus_id, target)}** XP.`, OK));
});
// /nextlevel — how much XP until the next level.
aero.command('nextlevel', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const pts = store.getXp(i.nexus_id, i.invoker.id);
  const lvl = levelFor(pts);
  const need = 50 * (lvl + 1) * (lvl + 1);
  return i.replyEphemeral(say('⏫ Next level', `You need **${need - pts}** more XP to reach level **${lvl + 1}**.`, BRAND));
});
// /progress — your progress bar toward the next level.
aero.command('progress', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const p = progressBar(store.getXp(i.nexus_id, i.invoker.id));
  return i.replyEphemeral(say('📊 Progress', `\`${p.bar}\`  ${p.have}/${p.need} XP to the next level.`, OK));
});
// /top — a short top-5 (alias of leaderboard, compact).
aero.command('top', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const rows = store.topXp(i.nexus_id, 5);
  if (!rows.length) return i.reply(say('🏆 Top 5', 'No XP yet · start chatting!'));
  const body = rows.map((r, n) => `${MEDALS[n] || `**${n + 1}.**`} <@${r.user_id}>. **${r.points}** XP`).join('\n');
  return i.reply(say('🏆 Top 5', body));
});

// /randomnumber — a random number in an inclusive range.
const doRandN = (i, raw) => {
  const m = String(raw).trim().match(/^(\-?\d+)\s+(\-?\d+)$/);
  const [lo, hi] = m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [1, 100];
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return i.reply(say('🎲 Random', `Your number between **${a}** and **${b}** is **${a + Math.floor(Math.random() * (b - a + 1))}**.`, OK));
};
aero.command('randomnumber', (i) => inlineText(i, (v) => doRandN(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Random number', custom_id: 'fun:randn', inputs: [{ id: 'text', label: 'Range (e.g. 1 100)', style: 'short', required: false, placeholder: '1 100' }],
}, { spaceId: i.space_id })));
aero.component('fun:randn', (i) => doRandN(i, i.fields?.text || ''));

// /pickone — pick one of comma-separated options (alias of /choose, friendlier).
const doPickOne = (i, raw) => {
  const opts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return i.replyEphemeral('Give at least two options, comma-separated.');
  return i.reply(say('🤔 I pick…', `**${opts[Math.floor(Math.random() * opts.length)]}**`, OK));
};
aero.command('pickone', (i) => inlineText(i, (v) => doPickOne(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Pick one', custom_id: 'fun:pickone', inputs: [{ id: 'text', label: 'Options (comma-separated)', style: 'short', required: true, placeholder: 'tea, coffee, water' }],
}, { spaceId: i.space_id })));
aero.component('fun:pickone', (i) => doPickOne(i, i.fields?.text || ''));

// /yesno — a definitive yes/no/maybe.
aero.command('yesno', (i) => i.reply(say('🎱 Answer', `**${pick(['Yes.', 'No.', 'Maybe.', 'Absolutely.', 'Definitely not.', 'Ask again later.'])}**`, BRAND)));

// /rolldice — roll N dice (2-10) and sum them.
const doRollDice = (i, raw) => {
  const n = Math.min(10, Math.max(1, parseInt(String(raw).trim(), 10) || 2));
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
  return i.reply(say('🎲 Dice roll', `${rolls.map((r) => `🎲${r}`).join(' ')}\n\nTotal: **${rolls.reduce((a, b) => a + b, 0)}** (${n}d6)`, OK));
};
aero.command('rolldice', (i) => inlineText(i, (v) => doRollDice(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Roll dice', custom_id: 'fun:rolldice', inputs: [{ id: 'text', label: 'How many dice (1-10)', style: 'short', required: false, placeholder: '2' }],
}, { spaceId: i.space_id })));
aero.component('fun:rolldice', (i) => doRollDice(i, i.fields?.text || ''));

// /flames — the classic FLAMES relationship game with a member.
aero.command('flames', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const target = i.options?.user;
  if (!target) return i.replyEphemeral('Use `/flames @member`.');
  const day = Math.floor(Date.now() / 86400000);
  const pair = [i.invoker.id, String(target)].sort().join(':');
  let h = 0; const s = `flames:${pair}:${day}`; for (let n = 0; n < s.length; n++) h = (h * 31 + s.charCodeAt(n)) >>> 0;
  const R = [['Friends', '🫂'], ['Lovers', '❤️'], ['Affection', '💕'], ['Marriage', '💍'], ['Enemies', '😈'], ['Siblings', '👫']];
  const [word, emoji] = R[h % R.length];
  return i.reply(say('🔥 FLAMES', `<@${i.invoker.id}> + <@${target}> = ${emoji} **${word}**`, OK));
});

// /magic8 — a fuller magic 8-ball (alias-style, more answers).
aero.command('magic8', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const A = ['It is certain.', 'Without a doubt.', 'Yes definitely.', 'You may rely on it.', 'Most likely.', 'Outlook good.', 'Signs point to yes.',
    'Reply hazy, try again.', 'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'My reply is no.', 'Very doubtful.'];
  return i.reply(say('🎱 Magic 8-ball', `*${pick(A)}*`, BRAND));
});

// /repeat — echo text (capped) — handy for reaction-role setup copy etc.
const doRepeat = (i, raw) => { const s = String(raw).slice(0, 500).trim(); return s ? i.reply(s) : i.replyEphemeral('Give me something to repeat.'); };
aero.command('repeat', (i) => inlineText(i, (v) => doRepeat(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Repeat', custom_id: 'fun:repeat', inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder: 'echo this' }],
}, { spaceId: i.space_id })));
aero.component('fun:repeat', (i) => doRepeat(i, i.fields?.text || ''));

// /owoify — the OwO text transform (a fun classic).
const owoify = (s) => s.replace(/[rl]/g, 'w').replace(/[RL]/g, 'W').replace(/n([aeiou])/g, 'ny$1').replace(/N([aeiou])/g, 'Ny$1').replace(/!+/g, ' owo!');
const doOwo = (i, raw) => { const s = String(raw).trim(); return s ? i.reply(say('🥺 OwO', owoify(s))) : i.replyEphemeral('Give me text to owoify.'); };
aero.command('owoify', (i) => inlineText(i, (v) => doOwo(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'OwOify', custom_id: 'fun:owo', inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder: 'hello there' }],
}, { spaceId: i.space_id })));
aero.component('fun:owo', (i) => doOwo(i, i.fields?.text || ''));

// /suggestions-list — recent suggestions summary (uses the configured space).
aero.command('suggestions-list', (i) => {
  if (!on(i.nexus_id, 'community')) return i.replyEphemeral('The Community module is off in this Nexus.');
  const space = cfg(i.nexus_id).suggestions_space;
  return i.replyEphemeral(say('💡 Suggestions', space ? `Suggestions post to <#${space}>. Use /suggest to add one.` : 'No suggestions space set yet. An admin can run /suggest-setup.'));
});

// /ticket-list — how many tickets are open (staff overview).
aero.command('ticket-list', (i) => {
  if (!on(i.nexus_id, 'community')) return i.replyEphemeral('The Community module is off in this Nexus.');
  return i.replyEphemeral(say('🎫 Tickets', `There ${store.openTicketCount(i.nexus_id) === 1 ? 'is' : 'are'} **${store.openTicketCount(i.nexus_id)}** open ticket(s) in this Nexus.`));
});

// /remindme — a quick alias of /remind for muscle memory (same modal).
aero.command('remindme', (i) => {
  if (!on(i.nexus_id, 'reminders')) return i.replyEphemeral('The Reminders module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Remind me', custom_id: 'remind:set',
    inputs: [
      { id: 'minutes', label: 'In how many minutes?', style: 'short', required: true, placeholder: 'e.g. 30' },
      { id: 'text', label: 'Remind me to…', style: 'paragraph', required: true, placeholder: 'take a break' },
    ],
  }, { spaceId: i.space_id });
});

// /daily — claim a daily XP bonus; a same-day repeat is blocked, a next-day
// claim grows the streak (bigger streak = bigger bonus), a gap resets it.
const DAY = 24 * 60 * 60 * 1000;
aero.command('daily', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const d = store.getDaily(i.nexus_id, i.invoker.id);
  const now = Date.now();
  const since = now - d.last_claim;
  if (since < DAY) {
    const hrs = Math.ceil((DAY - since) / (60 * 60 * 1000));
    return i.replyEphemeral(say('Already claimed', `Come back in **${hrs}h** for your next daily.`, WARN_C));
  }
  // Within 48h keeps the streak going; longer gap resets to 1.
  const streak = since < 2 * DAY ? d.streak + 1 : 1;
  const bonus = 50 + Math.min(streak, 30) * 10; // caps the streak bonus at +300
  store.setDaily(i.nexus_id, i.invoker.id, now, streak);
  store.addXp(i.nexus_id, i.invoker.id, bonus);
  const lvl = levelFor(store.getXp(i.nexus_id, i.invoker.id));
  return i.replyEphemeral(say('Daily claimed! 🎁', `+**${bonus} XP** · 🔥 **${streak}-day** streak\nYou're at level **${lvl}** now.`, OK));
});

// ─────────────────────────────────────────────────────────────
// AFK module — /afk marks you away; your next message clears it, and
// anyone who mentions you is told you're AFK (handled in message.created).
// ─────────────────────────────────────────────────────────────
const doAfk = (i, raw) => {
  const reason = (raw || '').trim().slice(0, 200) || 'AFK';
  store.setAfk(i.nexus_id, i.invoker.id, reason);
  return i.reply(say('💤 You are now AFK', `I'll let people know: *${reason}*`, WARN_C));
};
aero.command('afk', (i) => {
  if (!on(i.nexus_id, 'afk')) return i.replyEphemeral('The AFK module is off in this Nexus.');
  // "/afk lunch" sets it inline; bare "/afk" opens the reason modal.
  const reason = (i.options?.text ?? '').toString().trim();
  return reason ? doAfk(i, reason) : aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Set AFK', custom_id: 'afk:set',
    inputs: [{ id: 'reason', label: 'Reason (optional)', style: 'short', required: false, placeholder: 'Be right back' }],
  }, { spaceId: i.space_id });
});
aero.component('afk:set', (i) => doAfk(i, i.fields?.reason || ''));

// /givexp — add XP to a member (admin). Two steps: pick the member, then a modal
// asks how much. The pending target is keyed by the admin's id.
const pendingXpTarget = new Map(); // `${nexus}:${admin}` -> targetUserId
async function doGiveXp(i, target, amountRaw) {
  const amount = parseInt(String(amountRaw).trim(), 10);
  if (!Number.isFinite(amount) || amount === 0) return i.replyEphemeral('Enter a non-zero number, e.g. `/givexp @name 250`.');
  store.addXp(i.nexus_id, target, amount);
  const lvl = levelFor(store.getXp(i.nexus_id, target));
  await syncLevelRoles(i.nexus_id, target, lvl);
  return i.replyEphemeral(say('XP updated', `<@${target}> is now at **${store.getXp(i.nexus_id, target)}** XP (level ${lvl}).`, OK));
}
aero.command('givexp', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  // "/givexp @member 250" runs inline; a member with no amount, or nothing,
  // falls back to the picker + amount modal.
  const target = i.options?.user;
  const amount = (i.options?.text ?? '').toString().trim();
  if (target && amount) return doGiveXp(i, target, amount);
  return i.reply({
    embeds: [{ title: 'Give XP', description: 'Pick the member to award XP to. (tip: `/givexp @name 250`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'xp:give', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('xp:give', (i) => {
  pendingXpTarget.set(`${i.nexus_id}:${i.invoker.id}`, i.values?.[0]);
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Give XP', custom_id: 'xp:give-amount',
    inputs: [{ id: 'amount', label: 'Amount (use a minus to remove)', style: 'short', required: true, placeholder: 'e.g. 250' }],
  }, { spaceId: i.space_id });
});
aero.component('xp:give-amount', (i) => {
  const target = pendingXpTarget.get(`${i.nexus_id}:${i.invoker.id}`);
  pendingXpTarget.delete(`${i.nexus_id}:${i.invoker.id}`);
  if (!target) return i.replyEphemeral('That pick expired. Run /givexp again.');
  return doGiveXp(i, target, i.fields?.amount || '');
});

// /level-roles — list the level→role rewards; /level-role-add wires a new one.
aero.command('level-roles', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  const rows = store.listLevelRoles(i.nexus_id);
  const body = rows.length ? rows.map((r) => `Level **${r.level}** → <@&${r.role_id}>`).join('\n') : 'No level rewards yet. Add one with /level-role-add.';
  return i.replyEphemeral(say('Level rewards', body));
});
const pendingLevelNum = new Map(); // `${nexus}:${admin}` -> level
aero.command('level-role-add', (i) => {
  if (!on(i.nexus_id, 'levels')) return i.replyEphemeral('The Levels module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Level reward', custom_id: 'xp:levelrole-num',
    inputs: [{ id: 'level', label: 'Level that unlocks the role', style: 'short', required: true, placeholder: 'e.g. 5' }],
  }, { spaceId: i.space_id });
});
aero.component('xp:levelrole-num', (i) => {
  const level = parseInt((i.fields?.level || '').trim(), 10);
  if (!Number.isFinite(level) || level < 1) return i.replyEphemeral('Enter a level of 1 or higher.');
  pendingLevelNum.set(`${i.nexus_id}:${i.invoker.id}`, level);
  return i.reply({
    embeds: [{ title: `Reward for level ${level}`, description: 'Pick the role members get at this level.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'role', custom_id: 'xp:levelrole-pick', placeholder: 'Pick a role', min: 1, max: 1 }] }],
  });
});
aero.component('xp:levelrole-pick', (i) => {
  const level = pendingLevelNum.get(`${i.nexus_id}:${i.invoker.id}`);
  pendingLevelNum.delete(`${i.nexus_id}:${i.invoker.id}`);
  if (level == null) return i.replyEphemeral('That setup expired. Run /level-role-add again.');
  store.setLevelRole(i.nexus_id, level, i.values?.[0]);
  return i.update(say('Reward set', `Members reaching **level ${level}** now get <@&${i.values?.[0]}>.`, OK));
});

// ─────────────────────────────────────────────────────────────
// FUN module
// ─────────────────────────────────────────────────────────────
aero.command('roll', (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return i.reply(`🎲 ${i.invoker.name} rolled a **${1 + Math.floor(Math.random() * 6)}**.`);
});

const EIGHTBALL = ['Yes.', 'No.', 'Definitely.', 'Ask again later.', 'Doubtful.', 'Without a doubt.', 'Not looking good.'];
// Command names must start with a letter, so the 8-ball command is `eightball`.
aero.command('eightball', (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return i.reply(say('🎱 The 8-ball says', EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]));
});

aero.command('poll', (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  // "/poll Should we do X?" uses the text as the question; bare "/poll" is generic.
  const q = (i.options?.text ?? '').toString().trim();
  return i.reply({
    embeds: [{ title: `📊 ${q || 'Quick poll'}`, description: 'Cast your vote below.', color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'success', label: 'Yes', custom_id: 'poll:yes' },
      { type: 'button', style: 'danger', label: 'No', custom_id: 'poll:no' },
    ] }],
  });
});
const pollVotes = new Map(); // messageId -> { yes:Set, no:Set }
// A 12-cell bar with the percentage, so the tally reads at a glance.
function pollBar(part, total) {
  const pct = total ? Math.round((part / total) * 100) : 0;
  const filled = total ? Math.round((part / total) * 12) : 0;
  return `\`${'█'.repeat(filled)}${'░'.repeat(12 - filled)}\` ${pct}%`;
}
const vote = (i, choice) => {
  const box = pollVotes.get(i.message_id) || { yes: new Set(), no: new Set() };
  box.yes.delete(i.invoker.id); box.no.delete(i.invoker.id);
  box[choice].add(i.invoker.id);
  pollVotes.set(i.message_id, box);
  const total = box.yes.size + box.no.size;
  return i.update({
    embeds: [{
      title: '📊 Quick poll',
      description: `**Yes** ${pollBar(box.yes.size, total)} · ${box.yes.size}\n**No**  ${pollBar(box.no.size, total)} · ${box.no.size}\n\n${total} vote${total === 1 ? '' : 's'}`,
      color: BRAND,
    }],
    components: [{ components: [
      { type: 'button', style: 'success', label: `Yes (${box.yes.size})`, custom_id: 'poll:yes' },
      { type: 'button', style: 'danger', label: `No (${box.no.size})`, custom_id: 'poll:no' },
    ] }],
  });
};
aero.component('poll:yes', (i) => vote(i, 'yes'));
aero.component('poll:no', (i) => vote(i, 'no'));

// Animate a coin flip: edit the message a few times so the coin visibly spins
// (alternating faces) before landing. Returns the landed side. `onLand` builds
// the final embed. Best-effort — if an edit fails the result still shows.
async function animateFlip(i, title, onLand) {
  const heads = Math.random() < 0.5;
  const side = heads ? 'Heads' : 'Tails';
  const res = await i.reply(say(title, '🪙 Flipping…', BRAND));
  const mid = res?.message?.id;
  if (!mid) return side;
  const faces = ['🪙', '🌕', '🪙', '🌑', '🪙', '🌕'];
  for (let n = 0; n < faces.length; n++) {
    await new Promise((r) => setTimeout(r, 220));
    await aero.editMessage(i.nexus_id, i.space_id, mid, say(title, `${faces[n]} Flipping…`, BRAND)).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 260));
  await aero.editMessage(i.nexus_id, i.space_id, mid, onLand(heads, side)).catch(() => {});
  return side;
}

aero.command('coinflip', async (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  await animateFlip(i, '🪙 Coin flip', (heads, side) =>
    say('🪙 Coin flip', `${heads ? '🌕' : '🌑'} ${i.invoker.name} flipped **${side}**!`, OK));
  return undefined;
});

// /choose a, b, c — pick one of a comma-separated list. Uses a modal so the
// options aren't limited by a single command argument.
const doChoose = (i, raw) => {
  const opts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return i.replyEphemeral('Give me at least two options, comma-separated.');
  return i.reply(say('🤔 I choose', `**${opts[Math.floor(Math.random() * opts.length)]}**`, OK));
};
aero.command('choose', (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return inlineText(i, (v) => doChoose(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Let me choose', custom_id: 'fun:choose',
    inputs: [{ id: 'options', label: 'Options (comma-separated)', style: 'short', required: true, placeholder: 'pizza, sushi, tacos' }],
  }, { spaceId: i.space_id }));
});
aero.component('fun:choose', (i) => doChoose(i, i.fields?.options || ''));

// Anime action GIFs (Tenor CDN direct .gif links, a few per action so it feels
// varied). Embedded as the embed image, so the reply plays a GIF the way a
// an action command does, instead of a plain text row.
const gg = (id) => `https://media.giphy.com/media/${id}/giphy.gif`;
const ACTION_GIFS = {
  hug: [gg('od5H3PmEG5EVq'), gg('l2QDM9Jnim1YVILXa')],
  pat: [gg('wnsgren68VmqI'), gg('ARSp9K7ncf5rW')],
  highfive: [gg('3o6Zt6ML6BklcajjsA'), gg('3ohzdIuqJoo8QdKlnW')],
  slap: [gg('jXf3JYGF7cUFy'), gg('Gf3AUz3eBNbTW')],
  poke: [gg('l0MYNsHY6BbzC2Y7C'), gg('3oz8xLd9DJq2l2VFtu')],
  kiss: [gg('bGm9FuBCGg4SY'), gg('flmwRQdChp8FC')],
  cuddle: [gg('143v0Z4767T15e'), gg('PHZ7v9tfQu0o0')],
  bonk: [gg('WT9Gp8Y0j0YAoQd0Kp'), gg('l1KVaj5UcbHwrBMqI')],
  wave: [gg('ASd0Ukj0y3qMM'), gg('W1lIA1PVn3w4M')],
  dance: [gg('l0MYt5jPR6QX5pnqM'), gg('3oz8xRF0v9WMAUVLNK')],
  cry: [gg('d2lcHJTG5Tscg'), gg('ROF8OQvDmxytW')],
  bite: [gg('MvUV1sRnBBw6c'), gg('l4pTsRr34sr0AmyEo')],
  yeet: [gg('dXjhbfM8nfvW7VqEfy'), gg('l0IykOKm9c92BLPKw')],
  tickle: [gg('3XFDrjPa9pMY8'), gg('yr7n0u3qzO9nG')],
  boop: [gg('nBVsQaBj0Tzja'), gg('bgraT33xM40vu')],
  handshake: [gg('l0MYzMPvbY6DAAghy'), gg('3oEjHBw0jRoGT4d3XW')],
  salute: [gg('3o7btNUXY4hMdqI0hy'), gg('l0MYt5jPR6QX5pnqM')],
};
const gifFor = (name) => { const g = ACTION_GIFS[name]; return g ? g[Math.floor(Math.random() * g.length)] : null; };

// A helper for the social "action" commands (hug, pat, …): pick a member, then
// post an embed with a random action GIF playing above the line.
const funGate = (i) => on(i.nexus_id, 'fun');
function socialCommand(name, emoji, verb) {
  const render = (invokerId, target) => {
    const gif = gifFor(name);
    if (target === invokerId) return { embeds: [{ description: `${emoji} <@${invokerId}> ${verb}s themselves. Self care! 💖`, color: OK, ...(gif ? { image: { url: gif } } : {}) }] };
    return { embeds: [{ description: `${emoji} <@${invokerId}> ${verb}s <@${target}>!`, color: BRAND, ...(gif ? { image: { url: gif } } : {}) }] };
  };
  aero.command(name, (i) => {
    if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
    // Inline: `/hug @member` runs straight away. No mention → show a picker.
    const target = i.options?.user;
    if (target) return i.reply(render(i.invoker.id, target));
    return i.reply({
      embeds: [{ description: `${emoji} Who do you want to ${verb}? (tip: type \`/${name} @name\` next time)`, color: BRAND }],
      components: [{ components: [{ type: 'select', kind: 'member', custom_id: `social:${name}`, placeholder: 'Pick a member', min: 1, max: 1 }] }],
    });
  });
  aero.component(`social:${name}`, (i) => i.update(render(i.invoker.id, i.values?.[0])));
}
socialCommand('hug', '🤗', 'hug');
socialCommand('pat', '👋', 'pat');
socialCommand('highfive', '🙌', 'high-five');
socialCommand('slap', '🖐️', 'slap');
socialCommand('poke', '👉', 'poke');
// Social batch — more action commands via the same factory + GIFs.
socialCommand('kiss', '😘', 'kiss');
socialCommand('cuddle', '🫂', 'cuddle');
socialCommand('bonk', '🔨', 'bonk');
socialCommand('wave', '👋', 'wave at');
socialCommand('dance', '💃', 'dance with');
socialCommand('cry', '😭', 'cry on');
socialCommand('bite', '🫦', 'bite');
socialCommand('yeet', '🚀', 'yeet');
socialCommand('tickle', '🤭', 'tickle');
socialCommand('boop', '👉', 'boop');
socialCommand('handshake', '🤝', 'shake hands with');
socialCommand('salute', '🫡', 'salute');

// ── Fun "meter" toys — deterministic-per-user-per-day so they don't reroll on
// spam, but feel personal. Gated on the Fun module. ──
function seededPct(i, salt, target) {
  const day = Math.floor(Date.now() / 86400000);
  const s = `${salt}:${target ?? i.invoker.id}:${day}`;
  let h = 0; for (let n = 0; n < s.length; n++) h = (h * 31 + s.charCodeAt(n)) >>> 0;
  return h % 101;
}
function meterCmd(name, emoji, title, phrase, self = true) {
  aero.command(name, (i) => {
    if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
    const target = i.options?.user || (self ? i.invoker.id : null);
    if (!target) return i.replyEphemeral(`Use \`/${name} @member\`.`);
    const pct = seededPct(i, name, target);
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return i.reply(say(`${emoji} ${title}`, `${phrase.replace('{u}', `<@${target}>`)}\n\n\`${bar}\` **${pct}%**`, pct >= 50 ? OK : BRAND));
  });
}
meterCmd('iq', '🧠', 'IQ meter', "{u}'s IQ today measures…");
meterCmd('simp', '😍', 'Simp meter', '{u} is simping at…');
meterCmd('vibecheck', '🌈', 'Vibe check', "{u}'s vibe today is…");
meterCmd('pp', '🍆', 'PP meter', "{u}'s confidence meter reads…");
meterCmd('howfunny', '😂', 'Funny meter', '{u} is this funny today:');
meterCmd('coolness', '😎', 'Coolness', '{u} is this cool:');
meterCmd('braincells', '🧠', 'Brain cells', '{u} has this many brain cells firing:');

// /love and /ship-2 — compatibility between the invoker and a member.
aero.command('love', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const target = i.options?.user;
  if (!target) return i.replyEphemeral('Use `/love @member` to check compatibility.');
  const day = Math.floor(Date.now() / 86400000);
  const pair = [i.invoker.id, String(target)].sort().join(':');
  let h = 0; const s = `love:${pair}:${day}`; for (let n = 0; n < s.length; n++) h = (h * 31 + s.charCodeAt(n)) >>> 0;
  const pct = h % 101;
  const heart = pct >= 80 ? '💖' : pct >= 50 ? '❤️' : pct >= 25 ? '💛' : '💔';
  return i.reply(say(`${heart} Love meter`, `<@${i.invoker.id}> + <@${target}> = **${pct}%** ${heart}`, pct >= 50 ? OK : BRAND));
});

// /coinflip already exists. A few more quick fun toys:
const doDice = (i, raw) => {
  const sides = Math.min(1000, Math.max(2, parseInt(String(raw).trim(), 10) || 6));
  return i.reply(say('🎲 Dice', `${i.invoker.name} rolled a **${1 + Math.floor(Math.random() * sides)}** (d${sides}).`, OK));
};
aero.command('dice', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  // "/dice 20" rolls inline; bare "/dice" rolls a d6 straight away (no modal
  // needed for an optional single number).
  return doDice(i, i.options?.text ?? '6');
});
aero.command('rps', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return i.reply({
    embeds: [{ title: '✊ Rock, Paper, Scissors', description: 'Make your move!', color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'secondary', label: '✊ Rock', custom_id: 'rps:rock' },
      { type: 'button', style: 'secondary', label: '📄 Paper', custom_id: 'rps:paper' },
      { type: 'button', style: 'secondary', label: '✂️ Scissors', custom_id: 'rps:scissors' },
    ] }],
  });
});
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const RPS_EMOJI = { rock: '✊', paper: '📄', scissors: '✂️' };
function playRps(i, pick) {
  const me = ['rock', 'paper', 'scissors'][Math.floor(Math.random() * 3)];
  const result = pick === me ? "It's a tie!" : RPS_BEATS[pick] === me ? 'You win! 🎉' : 'I win! 😎';
  return i.update(say('✊ Rock, Paper, Scissors', `You: ${RPS_EMOJI[pick]}  ·  Me: ${RPS_EMOJI[me]}\n\n**${result}**`, OK));
}
aero.component('rps:rock', (i) => playRps(i, 'rock'));
aero.component('rps:paper', (i) => playRps(i, 'paper'));
aero.component('rps:scissors', (i) => playRps(i, 'scissors'));

// /ship two members for a fun compatibility percentage (deterministic per pair).
aero.command('ship', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return i.reply({
    embeds: [{ title: '💘 Ship', description: 'Pick two members to ship.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'fun:ship', placeholder: 'Pick two members', min: 2, max: 2 }] }],
  });
});
aero.component('fun:ship', (i) => {
  const [a, b] = i.values || [];
  if (!a || !b) return i.replyEphemeral('Pick exactly two members.');
  // Deterministic score from the pair so the same couple always matches the same.
  let h = 0; for (const ch of [a, b].sort().join('')) h = (h * 31 + ch.charCodeAt(0)) % 101;
  const hearts = '█'.repeat(Math.round(h / 10)) + '░'.repeat(10 - Math.round(h / 10));
  return i.update(say('💘 Compatibility', `<@${a}> + <@${b}>\n\n\`${hearts}\` **${h}%**`, h >= 60 ? OK : BRAND));
});

// /mock turns text into mocking SpOnGeBoB case; /reverse flips it. Both work
// inline ("/mock hello") or open a modal when no text is given.
const doMock = (i, t) => { const out = [...t.slice(0, 300)].map((c, n) => (n % 2 ? c.toUpperCase() : c.toLowerCase())).join(''); return i.reply(out || '...'); };
aero.command('mock', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return inlineText(i, (v) => doMock(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Mocking text', custom_id: 'fun:mock', inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder: 'type something' }] }, { spaceId: i.space_id }));
});
aero.component('fun:mock', (i) => doMock(i, i.fields?.text || ''));
aero.command('reverse', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return inlineText(i, (v) => i.reply([...v].reverse().join('') || '...'), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Reverse text', custom_id: 'fun:reverse', inputs: [{ id: 'text', label: 'Text', style: 'short', required: true, placeholder: 'hello' }] }, { spaceId: i.space_id }));
});
aero.component('fun:reverse', (i) => i.reply([...(i.fields?.text || '')].reverse().join('') || '...'));

// A batch of self-contained fun toys. Each is a one-liner reply, gated on Fun.
const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'I told my computer I needed a break, and it said "no problem, I will go to sleep."',
  'Why was the JavaScript developer sad? Because they did not know how to null their feelings.',
  'There are 10 kinds of people: those who understand binary and those who do not.',
  'A SQL query walks into a bar, walks up to two tables and asks: may I join you?',
];
const FACTS = [
  'Honey never spoils. Archaeologists have eaten 3000-year-old honey.',
  'Octopuses have three hearts and blue blood.',
  'Bananas are berries, but strawberries are not.',
  'A day on Venus is longer than its year.',
  'The Eiffel Tower can grow taller in summer as the metal expands.',
];
const ADVICE = [
  'Ship small, ship often.',
  'Take the break. You will think more clearly after.',
  'Name things for what they do, not how they work.',
  'When stuck, explain the problem out loud.',
  'Done is better than perfect, but tested is better than done.',
];
const QUOTES = [
  '"The best way out is always through." (Robert Frost)',
  '"Simplicity is the soul of efficiency." (Austin Freeman)',
  '"Make it work, make it right, make it fast." (Kent Beck)',
  '"Programs must be written for people to read." (Harold Abelson)',
  '"The only way to go fast is to go well." (Robert C. Martin)',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
aero.command('joke', (i) => funGate(i) ? i.reply(say('😂 Joke', pick(JOKES))) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('fact', (i) => funGate(i) ? i.reply(say('🧠 Fact', pick(FACTS))) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('advice', (i) => funGate(i) ? i.reply(say('💡 Advice', pick(ADVICE))) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('quote', (i) => funGate(i) ? i.reply(say('📜 Quote', pick(QUOTES))) : i.replyEphemeral('The Fun module is off in this Nexus.'));

// Text transformers.
function textCmd(name, title, transform) {
  const run = (i, raw) => i.reply(transform((raw || '').slice(0, 400)) || '...');
  aero.command(name, (i) => {
    if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
    return inlineText(i, (v) => run(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title, custom_id: `txt:${name}`, inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder: 'type something' }] }, { spaceId: i.space_id }));
  });
  aero.component(`txt:${name}`, (i) => run(i, i.fields?.text || ''));
}
textCmd('clap', 'Clap text', (t) => t.split(/\s+/).filter(Boolean).join(' 👏 '));
textCmd('spaceout', 'Space out text', (t) => [...t].join(' '));
// Real regional-indicator emoji (🇦 is U+1F1E6, offset by the letter), plus
// keycap digits, so the output is actual emoji rather than :shortcode: text.
textCmd('emojify', 'Emojify', (t) => [...t.toLowerCase()].map((c) => {
  if (c >= 'a' && c <= 'z') return String.fromCodePoint(0x1F1E6 + (c.charCodeAt(0) - 97));
  if (c >= '0' && c <= '9') return `${c}️⃣`; // keycap digit
  return c;
}).join(' '));

// /rate gives a playful out-of-10 rating for anything.
const doRate = (i, raw) => {
  const thing = (raw || 'that').slice(0, 100);
  let h = 0; for (const c of thing.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 11;
  return i.reply(say('⭐ Rating', `I rate **${thing}** a **${h}/10**.`, OK));
};
aero.command('rate', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return inlineText(i, (v) => doRate(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Rate it', custom_id: 'fun:rate', inputs: [{ id: 'thing', label: 'What should I rate?', style: 'short', required: true, placeholder: 'my code' }] }, { spaceId: i.space_id }));
});
aero.component('fun:rate', (i) => doRate(i, i.fields?.thing || ''));

// /number: guess a number 1 to 10 with buttons.
aero.command('number', (i) => funGate(i)
  ? i.reply({ embeds: [{ title: '🔢 Guess 1 to 10', description: 'I picked a number. Can you guess it?', color: BRAND }], components: [
      { components: [1, 2, 3, 4, 5].map((n) => ({ type: 'button', style: 'secondary', label: `${n}`, custom_id: `guess:${n}` })) },
      { components: [6, 7, 8, 9, 10].map((n) => ({ type: 'button', style: 'secondary', label: `${n}`, custom_id: `guess:${n}` })) },
    ] })
  : i.replyEphemeral('The Fun module is off in this Nexus.'));
function handleGuess(i) {
  const guess = parseInt(i.custom_id.split(':')[1], 10);
  const answer = 1 + Math.floor(Math.random() * 10);
  return i.update(guess === answer
    ? say('🎉 Correct!', `It was **${answer}**. Well guessed!`, OK)
    : say('❌ Not quite', `You guessed ${guess}, it was **${answer}**. Try /number again!`, WARN_C));
}

const WYR = [
  'be able to fly or be invisible?',
  'have unlimited coffee or unlimited pizza?',
  'always be 10 minutes late or 20 minutes early?',
  'live without music or without movies?',
  'fight one horse-sized duck or a hundred duck-sized horses?',
];
const TOD = ['Truth: what is your most-used app?', 'Dare: send the last emoji you used, ten times.', 'Truth: what is a hobby you want to start?', 'Dare: type your message backwards for the next minute.'];
aero.command('wouldyourather', (i) => funGate(i) ? i.reply(say('🤔 Would you rather', `Would you rather ${pick(WYR)}`, BRAND)) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('truthordare', (i) => funGate(i) ? i.reply(say('🎭 Truth or Dare', pick(TOD))) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('flip', async (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  await animateFlip(i, '🪙 Flip', (heads, side) => say('🪙 Flip', `${heads ? '🌕' : '🌑'} **${side}**`, OK));
  return undefined;
});
aero.command('randomcolor', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const hex = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return i.reply({ embeds: [{ title: '🎨 Random colour', description: `**${hex.toUpperCase()}**`, color: hex }] });
});
aero.command('password', (i) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pw = ''; for (let n = 0; n < 16; n++) pw += chars[Math.floor(Math.random() * chars.length)];
  return i.replyEphemeral(say('🔐 Password', `Here is a strong password (only you can see this):\n\`${pw}\``, OK));
});
const SLOT_S = ['🍒', '🍋', '🔔', '⭐', '7️⃣'];
const spin = () => SLOT_S[Math.floor(Math.random() * SLOT_S.length)];
aero.command('slots', async (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const r = [spin(), spin(), spin()];
  const won = r[0] === r[1] && r[1] === r[2];
  await animateSlots(i, '🎰 Slots', r, won ? 'Jackpot! 🎉🎉🎉' : 'No match, try again!', won ? OK : BRAND);
  return undefined;
});
const INSPIRE = [
  'You are capable of more than you know.',
  'Small steps every day add up to big results.',
  'Progress, not perfection.',
  'The expert in anything was once a beginner.',
  'Your only limit is the one you set yourself.',
];
aero.command('inspire', (i) => funGate(i) ? i.reply(say('✨ Inspiration', pick(INSPIRE), OK)) : i.replyEphemeral('The Fun module is off in this Nexus.'));
async function doCountdown(i, raw) {
  const secs = Math.min(30, Math.max(1, parseInt(String(raw).trim(), 10) || 3));
  const res = await i.reply(say('⏳ Countdown', `**${secs}**`));
  const mid = res?.message?.id;
  if (!mid) return undefined;
  for (let n = secs - 1; n >= 0; n--) {
    await new Promise((r) => setTimeout(r, 1000));
    await aero.editMessage(i.nexus_id, i.space_id, mid, say('⏳ Countdown', n === 0 ? '🎉 **Go!**' : `**${n}**`, n === 0 ? OK : BRAND)).catch(() => {});
  }
  return undefined;
}
aero.command('countdown', (i) => inlineText(i, (v) => doCountdown(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Countdown', custom_id: 'fun:countdown', inputs: [{ id: 'secs', label: 'Seconds (max 30)', style: 'short', required: true, placeholder: '5' }] }, { spaceId: i.space_id })));
aero.component('fun:countdown', (i) => doCountdown(i, i.fields?.secs || '3'));

// /vote: a 3-way yes / no / abstain vote with live tally.
const voteBoxes = new Map();
async function doVote(i, raw) {
  const q = (raw || '').trim();
  if (!q) return i.replyEphemeral('Give a question, e.g. `/vote Movie night?`');
  const box = { q, yes: new Set(), no: new Set(), abstain: new Set() };
  const res = await i.reply(voteView(box));
  if (res?.message?.id) voteBoxes.set(String(res.message.id), box);
  return undefined;
}
aero.command('vote', (i) => inlineText(i, (v) => doVote(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Start a vote', custom_id: 'vote:new', inputs: [{ id: 'q', label: 'Question', style: 'short', required: true, placeholder: 'Add movie night?' }] }, { spaceId: i.space_id })));
aero.component('vote:new', (i) => doVote(i, i.fields?.q || ''));
function voteView(b) {
  return {
    embeds: [{ title: `🗳️ ${b.q}`, description: `✅ ${b.yes.size}  ·  ❌ ${b.no.size}  ·  🤷 ${b.abstain.size}`, color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'success', label: `Yes (${b.yes.size})`, custom_id: 'vote:yes' },
      { type: 'button', style: 'danger', label: `No (${b.no.size})`, custom_id: 'vote:no' },
      { type: 'button', style: 'secondary', label: `Abstain (${b.abstain.size})`, custom_id: 'vote:abstain' },
    ] }],
  };
}
function handleVote(i, choice) {
  const b = voteBoxes.get(String(i.message_id));
  if (!b) return i.replyEphemeral('This vote is closed.');
  b.yes.delete(i.invoker.id); b.no.delete(i.invoker.id); b.abstain.delete(i.invoker.id);
  b[choice].add(i.invoker.id);
  return i.update(voteView(b));
}
aero.component('vote:yes', (i) => handleVote(i, 'yes'));
aero.component('vote:no', (i) => handleVote(i, 'no'));
aero.component('vote:abstain', (i) => handleVote(i, 'abstain'));

// /roll-team splits picked members into two random teams.
aero.command('roll-team', (i) => funGate(i) ? i.reply({
  embeds: [{ title: '🎽 Team roller', description: 'Pick the members to split into two teams.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'fun:teams', placeholder: 'Pick members', min: 2, max: 10 }] }],
}) : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.component('fun:teams', (i) => {
  const ids = [...(i.values || [])].sort(() => Math.random() - 0.5);
  const half = Math.ceil(ids.length / 2);
  const a = ids.slice(0, half).map((u) => `<@${u}>`).join(', ');
  const b = ids.slice(half).map((u) => `<@${u}>`).join(', ');
  return i.update(say('🎽 Teams', `**Team A:** ${a || 'nobody'}\n**Team B:** ${b || 'nobody'}`, OK));
});

// /veli — your veli count; /velitop — the Nexus leaderboard.
aero.command('veli', (i) => funGate(i)
  ? i.replyEphemeral(say('veli', `You have said **veli** ${store.getVeli(i.nexus_id, i.invoker.id)} time(s). (◕ᴗ◕✿)`, OK))
  : i.replyEphemeral('The Fun module is off in this Nexus.'));
aero.command('velitop', (i) => {
  if (!funGate(i)) return i.replyEphemeral('The Fun module is off in this Nexus.');
  const rows = store.topVeli(i.nexus_id, 50);
  if (!rows.length) return i.reply(say('veli leaderboard', 'No one has said veli yet. Try it!'));
  const items = rows.map((r, n) => `${MEDALS[n] || `**${n + 1}.**`} <@${r.user_id}>. **${r.count}** velis`);
  return replyPaged(i, { items, perPage: 10, title: '✨ Top veli-sayers' });
});

// ─────────────────────────────────────────────────────────────
// GAMES module — button-based mini-games. Each is gated on `games`.
// ─────────────────────────────────────────────────────────────
const gameGate = (i) => on(i.nexus_id, 'games');

// /trivia — a question with 4 answer buttons; correct answer awards XP if the
// Levels module is on.
const TRIVIA = [
  { q: 'What is the largest planet in our solar system?', a: ['Jupiter', 'Saturn', 'Earth', 'Neptune'], correct: 0 },
  { q: 'How many continents are there?', a: ['5', '6', '7', '8'], correct: 2 },
  { q: 'What is the chemical symbol for gold?', a: ['Gd', 'Au', 'Ag', 'Go'], correct: 1 },
  { q: 'Which language runs in a web browser?', a: ['Python', 'C++', 'JavaScript', 'Java'], correct: 2 },
  { q: 'What year did the first iPhone release?', a: ['2005', '2007', '2009', '2010'], correct: 1 },
  { q: 'What is the capital of Japan?', a: ['Seoul', 'Beijing', 'Bangkok', 'Tokyo'], correct: 3 },
  { q: 'How many sides does a hexagon have?', a: ['5', '6', '7', '8'], correct: 1 },
  { q: 'What is the smallest prime number?', a: ['0', '1', '2', '3'], correct: 2 },
];
const triviaState = new Map(); // messageId -> { correct, answered:Set }
aero.command('trivia', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const t = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
  const res = await i.reply({
    embeds: [{ title: '❓ Trivia', description: t.q, color: BRAND, footer: { text: 'First correct answer wins!' } }],
    components: [{ components: t.a.map((opt, n) => ({ type: 'button', style: 'secondary', label: opt, custom_id: `trivia:${n}` })) }],
  });
  if (res?.message?.id) triviaState.set(String(res.message.id), { correct: t.correct, q: t.q, options: t.a, answered: new Set() });
  return undefined;
});
function handleTrivia(i) {
  const st = triviaState.get(String(i.message_id));
  if (!st) return i.replyEphemeral('This trivia round has ended.');
  if (st.answered.has(i.invoker.id)) return i.replyEphemeral('You already answered this one.');
  st.answered.add(i.invoker.id);
  const chose = parseInt(i.custom_id.split(':')[1], 10);
  if (chose === st.correct) {
    triviaState.delete(String(i.message_id));
    if (on(i.nexus_id, 'levels')) store.addXp(i.nexus_id, i.invoker.id, 25);
    return i.update({ embeds: [{ title: '✅ Correct!', description: `${st.q}\n\n<@${i.invoker.id}> got it: **${st.options[st.correct]}**${on(i.nexus_id, 'levels') ? ' (+25 XP)' : ''}`, color: OK }] });
  }
  return i.replyEphemeral(`❌ Not **${st.options[chose]}**. Try again!`);
}

// /tictactoe — challenge a member; take turns tapping the 3x3 grid.
const tttState = new Map(); // messageId -> { board:[9], turn, players:[x,o], done }
aero.command('tictactoe', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const opponent = i.options?.user;
  if (!opponent) return i.reply({
    embeds: [{ title: '⭕ Tic-tac-toe', description: 'Pick who to challenge.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'ttt:challenge', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
  return startTtt(i, opponent);
});
aero.component('ttt:challenge', (i) => startTtt(i, i.values?.[0], (m) => i.update(m)));
async function startTtt(i, opponent, respond) {
  if (opponent === i.invoker.id) return i.replyEphemeral("You can't challenge yourself.");
  const reply = respond || ((m) => i.reply(m));
  const state = { board: Array(9).fill(null), turn: 0, players: [i.invoker.id, opponent], done: false };
  const res = await reply(tttView(state));
  const mid = res?.message?.id;
  if (mid) tttState.set(String(mid), state);
  return undefined;
}
const TTT_MARK = ['❌', '⭕'];
function tttView(s) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    rows.push({ components: [0, 1, 2].map((c) => {
      const idx = r * 3 + c;
      const mark = s.board[idx];
      return { type: 'button', style: mark === null ? 'secondary' : (mark === 0 ? 'danger' : 'primary'), label: mark === null ? '·' : TTT_MARK[mark], custom_id: `ttt:${idx}` };
    }) });
  }
  const desc = s.done
    ? (s.done === 'draw' ? "It's a draw!" : `${TTT_MARK[s.done.mark]} <@${s.done.winner}> wins!`)
    : `${TTT_MARK[s.turn]} <@${s.players[s.turn]}>'s turn`;
  return { embeds: [{ title: '⭕ Tic-tac-toe', description: `<@${s.players[0]}> ${TTT_MARK[0]}  vs  ${TTT_MARK[1]} <@${s.players[1]}>\n\n${desc}`, color: s.done ? OK : BRAND }], components: rows };
}
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
function handleTtt(i) {
  const s = tttState.get(String(i.message_id));
  if (!s || s.done) return i.replyEphemeral('This game is over.');
  if (i.invoker.id !== s.players[s.turn]) return i.replyEphemeral("It's not your turn.");
  const idx = parseInt(i.custom_id.split(':')[1], 10);
  if (s.board[idx] !== null) return i.replyEphemeral('That cell is taken.');
  s.board[idx] = s.turn;
  const win = TTT_WINS.find((line) => line.every((c) => s.board[c] === s.turn));
  if (win) s.done = { winner: s.players[s.turn], mark: s.turn };
  else if (s.board.every((c) => c !== null)) s.done = 'draw';
  else s.turn = s.turn === 0 ? 1 : 0;
  return i.update(tttView(s));
}

// /hangman — guess the word letter by letter with buttons (2 rows of letters,
// paginated a..m / n..z). Anyone in the space can guess.
const HANGMAN_WORDS = ['ballastra', 'nexus', 'velixar', 'gaming', 'community', 'moderator', 'javascript', 'keyboard', 'pineapple', 'adventure'];
const HANG_STAGES = ['😀', '🙂', '😐', '😟', '😧', '😵', '💀'];
const hangState = new Map(); // messageId -> { word, guessed:Set, wrong, page }
aero.command('hangman', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const word = HANGMAN_WORDS[Math.floor(Math.random() * HANGMAN_WORDS.length)];
  const st = { word, guessed: new Set(), wrong: 0, page: 0 };
  const res = await i.reply(hangView(st));
  if (res?.message?.id) hangState.set(String(res.message.id), st);
  return undefined;
});
function hangView(s) {
  const shown = [...s.word].map((c) => (s.guessed.has(c) ? c.toUpperCase() : '＿')).join(' ');
  const won = [...s.word].every((c) => s.guessed.has(c));
  const lost = s.wrong >= HANG_STAGES.length - 1;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const slice = s.page === 0 ? letters.slice(0, 13) : letters.slice(13);
  const rows = [];
  for (let n = 0; n < slice.length; n += 7) {
    rows.push({ components: [...slice.slice(n, n + 7)].map((c) => ({
      type: 'button', style: s.guessed.has(c) ? 'secondary' : 'primary', label: c.toUpperCase(), custom_id: `hang:${c}`,
    })) });
  }
  if (!won && !lost) rows.push({ components: [{ type: 'button', style: 'secondary', label: s.page === 0 ? 'N–Z →' : '← A–M', custom_id: 'hang:page' }] });
  const desc = won ? `🎉 Solved: **${s.word.toUpperCase()}**` : lost ? `💀 Out of guesses. It was **${s.word.toUpperCase()}**` : `\`${shown}\``;
  return { embeds: [{ title: `🪢 Hangman  ${HANG_STAGES[s.wrong]}`, description: desc, color: won ? OK : lost ? DANGER_C : BRAND }], components: (won || lost) ? [] : rows };
}
function handleHangman(i) {
  const s = hangState.get(String(i.message_id));
  if (!s) return i.replyEphemeral('This game has ended.');
  const key = i.custom_id.split(':')[1];
  if (key === 'page') { s.page = s.page === 0 ? 1 : 0; return i.update(hangView(s)); }
  if (s.guessed.has(key)) return i.replyEphemeral('Already guessed that letter.');
  s.guessed.add(key);
  if (!s.word.includes(key)) s.wrong++;
  const won = [...s.word].every((c) => s.guessed.has(c));
  const lost = s.wrong >= HANG_STAGES.length - 1;
  if ((won || lost)) { if (won && on(i.nexus_id, 'levels')) store.addXp(i.nexus_id, i.invoker.id, 20); hangState.delete(String(i.message_id)); }
  return i.update(hangView(s));
}

// /connect4 — challenge a member; drop discs into 7 columns.
const c4State = new Map(); // messageId -> { board:6x7, turn, players, done }
aero.command('connect4', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const opp = i.options?.user;
  if (!opp) return i.reply({
    embeds: [{ title: '🔴 Connect 4', description: 'Pick who to challenge.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'c4:challenge', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
  return startC4(i, opp);
});
aero.component('c4:challenge', (i) => startC4(i, i.values?.[0], (m) => i.update(m)));
async function startC4(i, opp, respond) {
  if (opp === i.invoker.id) return i.replyEphemeral("You can't challenge yourself.");
  const reply = respond || ((m) => i.reply(m));
  const s = { board: Array.from({ length: 6 }, () => Array(7).fill(null)), turn: 0, players: [i.invoker.id, opp], done: false };
  const res = await reply(c4View(s));
  if (res?.message?.id) c4State.set(String(res.message.id), s);
  return undefined;
}
const C4_DISC = ['🔴', '🟡'];
function c4View(s) {
  const grid = s.board.map((row) => row.map((c) => (c === null ? '⚪' : C4_DISC[c])).join('')).join('\n');
  const desc = s.done
    ? (s.done === 'draw' ? "It's a draw!" : `${C4_DISC[s.done.mark]} <@${s.done.winner}> wins!`)
    : `${C4_DISC[s.turn]} <@${s.players[s.turn]}>'s turn`;
  const btns = [0, 1, 2, 3, 4, 5, 6].map((c) => ({ type: 'button', style: 'secondary', label: `${c + 1}`, custom_id: `c4:${c}` }));
  return { embeds: [{ title: '🔴 Connect 4', description: `<@${s.players[0]}> ${C4_DISC[0]} vs ${C4_DISC[1]} <@${s.players[1]}>\n\n${grid}\n\n${desc}`, color: s.done ? OK : BRAND }], components: s.done ? [] : [{ components: btns.slice(0, 4) }, { components: btns.slice(4) }] };
}
function c4Win(b, mark) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    if (b[r][c] !== mark) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let k = 1;
      while (k < 4) { const nr = r + dr * k, nc = c + dc * k; if (nr < 0 || nr >= 6 || nc < 0 || nc >= 7 || b[nr][nc] !== mark) break; k++; }
      if (k === 4) return true;
    }
  }
  return false;
}
function handleC4(i) {
  const s = c4State.get(String(i.message_id));
  if (!s || s.done) return i.replyEphemeral('This game is over.');
  if (i.invoker.id !== s.players[s.turn]) return i.replyEphemeral("It's not your turn.");
  const col = parseInt(i.custom_id.split(':')[1], 10);
  let placed = -1;
  for (let r = 5; r >= 0; r--) { if (s.board[r][col] === null) { s.board[r][col] = s.turn; placed = r; break; } }
  if (placed === -1) return i.replyEphemeral('That column is full.');
  if (c4Win(s.board, s.turn)) s.done = { winner: s.players[s.turn], mark: s.turn };
  else if (s.board.every((row) => row.every((c) => c !== null))) s.done = 'draw';
  else s.turn = s.turn === 0 ? 1 : 0;
  return i.update(c4View(s));
}

// /guess-flag style: /guessword shows a scrambled word to unscramble via a modal.
const scrambleWords = ['galaxy', 'wizard', 'planet', 'rocket', 'castle', 'dragon', 'jungle', 'python'];
const scrambleState = new Map(); // messageId -> answer
aero.command('unscramble', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const w = scrambleWords[Math.floor(Math.random() * scrambleWords.length)];
  const scrambled = [...w].sort(() => Math.random() - 0.5).join('');
  const res = await i.reply({
    embeds: [{ title: '🔤 Unscramble', description: `Unscramble this word:\n\n# ${scrambled.toUpperCase()}`, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Answer', custom_id: 'scramble:answer' }] }],
  });
  if (res?.message?.id) scrambleState.set(String(res.message.id), w);
  return undefined;
});
aero.component('scramble:answer', (i) => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Your answer', custom_id: `scramble:submit:${i.message_id}`, inputs: [{ id: 'guess', label: 'The word', style: 'short', required: true }] }, { spaceId: i.space_id }));
function handleScrambleSubmit(i) {
  const mid = i.custom_id.split(':')[2];
  const answer = scrambleState.get(String(mid));
  if (!answer) return i.replyEphemeral('That round has ended.');
  if ((i.fields?.guess || '').trim().toLowerCase() === answer) {
    scrambleState.delete(String(mid));
    if (on(i.nexus_id, 'levels')) store.addXp(i.nexus_id, i.invoker.id, 15);
    return i.reply(say('✅ Correct!', `<@${i.invoker.id}> unscrambled **${answer.toUpperCase()}**${on(i.nexus_id, 'levels') ? ' (+15 XP)' : ''}`, OK));
  }
  return i.replyEphemeral('❌ Not quite, try again!');
}

// /dice-duel — you vs the Aero, higher roll wins a coin wager (needs Economy).
aero.command('dice-duel', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const you = 1 + Math.floor(Math.random() * 6);
  const me = 1 + Math.floor(Math.random() * 6);
  const result = you > me ? 'You win! 🎉' : you < me ? 'I win! 😎' : "It's a tie!";
  return i.reply(say('🎲 Dice duel', `You rolled **${you}** 🎲  ·  I rolled **${me}** 🎲\n\n**${result}**`, you > me ? OK : BRAND));
});

// ─────────────────────────────────────────────────────────────
// Games batch — more single-player + interactive mini-games. Gated on the
// Games module; guessing games award a little XP if the Levels module is on.
// ─────────────────────────────────────────────────────────────
function awardXp(i, amount) {
  if (on(i.nexus_id, 'levels')) store.addXp(i.nexus_id, i.invoker.id, amount);
}

// /guessnumber — I pick 1-100, you guess via a modal; feedback higher/lower.
const guessState = new Map(); // `${nexus}:${user}` -> { target, tries }
aero.command('guessnumber', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  guessState.set(`${i.nexus_id}:${i.invoker.id}`, { target: 1 + Math.floor(Math.random() * 100), tries: 0 });
  return i.reply({
    embeds: [{ title: '🔢 Guess the number', description: "I'm thinking of a number **1-100**. Press Guess to try.", color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Guess', custom_id: 'gn:guess' }] }],
  });
});
aero.component('gn:guess', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Your guess', custom_id: 'gn:submit', inputs: [{ id: 'n', label: 'A number 1-100', style: 'short', required: true, placeholder: '50' }],
}, { spaceId: i.space_id }));
aero.component('gn:submit', (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const s = guessState.get(key);
  if (!s) return i.replyEphemeral('Start a new game with /guessnumber.');
  const g = parseInt(i.fields?.n, 10);
  if (!Number.isFinite(g)) return i.replyEphemeral('Enter a number 1-100.');
  s.tries++;
  if (g === s.target) {
    guessState.delete(key);
    awardXp(i, 15);
    return i.reply(say('🎉 Correct!', `**${s.target}** it was · you got it in **${s.tries}** tries.${on(i.nexus_id, 'levels') ? ' (+15 XP)' : ''}`, OK));
  }
  return i.replyEphemeral(say('🔢 Keep going', `**${g}** is too ${g < s.target ? 'low ⬆️' : 'high ⬇️'}. (try ${s.tries})`, WARN_C));
});

// /higherlower — is the next number higher or lower? Streak-based.
const hlState = new Map(); // messageId -> { current, streak }
aero.command('higherlower', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const current = 1 + Math.floor(Math.random() * 100);
  const res = await i.reply(hlView(current, 0));
  if (res?.message?.id) hlState.set(String(res.message.id), { current, streak: 0 });
  return undefined;
});
function hlView(current, streak) {
  return {
    embeds: [{ title: '🔼🔽 Higher or Lower', description: `Current number: **${current}** (1-100)\nStreak: **${streak}**\nWill the next be higher or lower?`, color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'success', label: '⬆️ Higher', custom_id: 'hl:high' },
      { type: 'button', style: 'danger', label: '⬇️ Lower', custom_id: 'hl:low' },
    ] }],
  };
}
function handleHL(i) {
  const s = hlState.get(String(i.message_id));
  if (!s) return i.replyEphemeral('This game has ended · start a new /higherlower.');
  const next = 1 + Math.floor(Math.random() * 100);
  const pick = i.custom_id.split(':')[1];
  const correct = (pick === 'high' && next >= s.current) || (pick === 'low' && next <= s.current);
  if (!correct) {
    hlState.delete(String(i.message_id));
    return i.update(say('💥 Wrong', `It was **${next}**. Final streak: **${s.streak}**.`, DANGER_C));
  }
  s.current = next; s.streak++;
  if (s.streak % 5 === 0) awardXp(i, 10);
  return i.update(hlView(next, s.streak));
}

// /wordle-lite — guess a 5-letter word in 6 tries (feedback via 🟩🟨⬛).
const WORDLE_WORDS = ['crane', 'plumb', 'ghost', 'vivid', 'quilt', 'nymph', 'fjord', 'waltz', 'blitz', 'proxy', 'mango', 'zebra', 'ninja', 'pixel', 'robot'];
const wordleState = new Map(); // `${nexus}:${user}` -> { word, tries }
aero.command('wordle-lite', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  wordleState.set(`${i.nexus_id}:${i.invoker.id}`, { word: pick(WORDLE_WORDS), tries: 0 });
  return i.reply({
    embeds: [{ title: '🟩 Wordle-lite', description: 'Guess the hidden **5-letter** word in **6** tries. Press Guess.', color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Guess', custom_id: 'wl:guess' }] }],
  });
});
aero.component('wl:guess', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Your guess', custom_id: 'wl:submit', inputs: [{ id: 'w', label: '5-letter word', style: 'short', required: true, placeholder: 'crane' }],
}, { spaceId: i.space_id }));
aero.component('wl:submit', (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const s = wordleState.get(key);
  if (!s) return i.replyEphemeral('Start a new game with /wordle-lite.');
  const g = String(i.fields?.w || '').trim().toLowerCase();
  if (!/^[a-z]{5}$/.test(g)) return i.replyEphemeral('Enter exactly 5 letters.');
  s.tries++;
  const marks = [...g].map((c, n) => s.word[n] === c ? '🟩' : s.word.includes(c) ? '🟨' : '⬛').join('');
  if (g === s.word) { wordleState.delete(key); awardXp(i, 20); return i.reply(say('🎉 Solved!', `${marks}\n**${s.word.toUpperCase()}** in ${s.tries} tries!${on(i.nexus_id, 'levels') ? ' (+20 XP)' : ''}`, OK)); }
  if (s.tries >= 6) { wordleState.delete(key); return i.reply(say('💥 Out of tries', `${marks}\nThe word was **${s.word.toUpperCase()}**.`, DANGER_C)); }
  return i.replyEphemeral(say(`Try ${s.tries}/6`, `${marks}  \`${g.toUpperCase()}\``, BRAND));
});

// /anagram — unscramble a word within the message (single guess via modal).
const anagramState = new Map(); // `${nexus}:${user}` -> word
aero.command('anagram', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const word = pick(['galaxy', 'puzzle', 'rocket', 'wizard', 'jungle', 'castle', 'dragon', 'planet']);
  anagramState.set(`${i.nexus_id}:${i.invoker.id}`, word);
  const scrambled = [...word].sort(() => Math.random() - 0.5).join('');
  return i.reply({
    embeds: [{ title: '🔤 Anagram', description: `Unscramble: **${scrambled.toUpperCase()}**`, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Answer', custom_id: 'ana:guess' }] }],
  });
});
aero.component('ana:guess', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Your answer', custom_id: 'ana:submit', inputs: [{ id: 'w', label: 'The word', style: 'short', required: true, placeholder: 'answer' }],
}, { spaceId: i.space_id }));
aero.component('ana:submit', (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const word = anagramState.get(key);
  if (!word) return i.replyEphemeral('Start a new /anagram.');
  const g = String(i.fields?.w || '').trim().toLowerCase();
  if (g === word) { anagramState.delete(key); awardXp(i, 12); return i.reply(say('✅ Correct', `It was **${word}**!${on(i.nexus_id, 'levels') ? ' (+12 XP)' : ''}`, OK)); }
  return i.replyEphemeral(say('❌ Not quite', 'Try again · press Answer.', WARN_C));
});

// /mathrace — solve a quick sum against the clock (single question).
const mathRace = new Map(); // `${nexus}:${user}` -> { answer, at }
aero.command('mathrace', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const a = 2 + Math.floor(Math.random() * 30), b = 2 + Math.floor(Math.random() * 30);
  const op = pick(['+', '-', '×']);
  const answer = op === '+' ? a + b : op === '-' ? a - b : a * b;
  mathRace.set(`${i.nexus_id}:${i.invoker.id}`, { answer, at: Date.now() });
  return i.reply({
    embeds: [{ title: '➗ Math race', description: `Solve fast: **${a} ${op} ${b} = ?**`, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Answer', custom_id: 'mr:guess' }] }],
  });
});
aero.component('mr:guess', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Your answer', custom_id: 'mr:submit', inputs: [{ id: 'n', label: 'Result', style: 'short', required: true, placeholder: '42' }],
}, { spaceId: i.space_id }));
aero.component('mr:submit', (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const s = mathRace.get(key);
  if (!s) return i.replyEphemeral('Start a new /mathrace.');
  const g = parseInt(i.fields?.n, 10);
  if (g === s.answer) { mathRace.delete(key); const secs = ((Date.now() - s.at) / 1000).toFixed(1); awardXp(i, 10); return i.reply(say('⚡ Correct', `Solved in **${secs}s**!${on(i.nexus_id, 'levels') ? ' (+10 XP)' : ''}`, OK)); }
  return i.replyEphemeral(say('❌ Wrong', 'Not the right number · press Answer to retry.', WARN_C));
});

// /slotmachine — a free (non-coin) 3-reel spin for fun.
// Animate a 3-reel slot spin: reels blur while spinning, then stop left-to-right.
// `r` is the pre-decided result; `finalLine` is the result text under the reels.
async function animateSlots(i, title, r, finalLine, color) {
  const REELS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
  const blur = () => pick(REELS);
  const res = await i.reply(say(title, `[ ${blur()} | ${blur()} | ${blur()} ]\n\nSpinning…`, BRAND));
  const mid = res?.message?.id;
  if (!mid) return;
  // A few all-blur frames so the reels visibly spin.
  for (let f = 0; f < 3; f++) {
    await new Promise((res2) => setTimeout(res2, 260));
    await aero.editMessage(i.nexus_id, i.space_id, mid, say(title, `[ ${blur()} | ${blur()} | ${blur()} ]\n\nSpinning…`, BRAND)).catch(() => {});
  }
  // Stop each reel in turn.
  const stops = [
    `[ ${r[0]} | ${blur()} | ${blur()} ]\n\nSpinning…`,
    `[ ${r[0]} | ${r[1]} | ${blur()} ]\n\nSpinning…`,
    `[ ${r[0]} | ${r[1]} | ${r[2]} ]\n\n${finalLine}`,
  ];
  for (let n = 0; n < stops.length; n++) {
    await new Promise((res2) => setTimeout(res2, 600));
    await aero.editMessage(i.nexus_id, i.space_id, mid, say(title, stops[n], n === 2 ? color : BRAND)).catch(() => {});
  }
}

aero.command('slotmachine', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const REELS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣'];
  const r = [0, 0, 0].map(() => pick(REELS));
  const win = r[0] === r[1] && r[1] === r[2];
  if (win) awardXp(i, 8);
  await animateSlots(i, '🎰 Slots', r,
    win ? `**JACKPOT!** 🎉${on(i.nexus_id, 'levels') ? ' (+8 XP)' : ''}` : 'No match · spin again!',
    win ? OK : BRAND);
  return undefined;
});

// /rps-lizard — extended rock-paper-scissors-lizard-spock vs Velixar.
aero.command('rps-lizard', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  return i.reply({
    embeds: [{ title: '🖖 RPS-Lizard-Spock', description: 'Pick your move against Velixar.', color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'secondary', label: '🪨', custom_id: 'rpsl:rock' },
      { type: 'button', style: 'secondary', label: '📄', custom_id: 'rpsl:paper' },
      { type: 'button', style: 'secondary', label: '✂️', custom_id: 'rpsl:scissors' },
      { type: 'button', style: 'secondary', label: '🦎', custom_id: 'rpsl:lizard' },
      { type: 'button', style: 'secondary', label: '🖖', custom_id: 'rpsl:spock' },
    ] }],
  });
});
function handleRpsl(i) {
  const beats = { rock: ['scissors', 'lizard'], paper: ['rock', 'spock'], scissors: ['paper', 'lizard'], lizard: ['paper', 'spock'], spock: ['rock', 'scissors'] };
  const icon = { rock: '🪨', paper: '📄', scissors: '✂️', lizard: '🦎', spock: '🖖' };
  const you = i.custom_id.split(':')[1];
  const me = pick(Object.keys(beats));
  const res = you === me ? 'Tie!' : beats[you].includes(me) ? 'You win! 🎉' : 'I win! 😎';
  if (res.startsWith('You')) awardXp(i, 6);
  return i.update(say('🖖 Result', `You ${icon[you]} vs ${icon[me]} me\n\n**${res}**`, res.startsWith('You') ? OK : BRAND));
}

// /emojiquiz — guess the phrase from emojis (single guess).
const EMOJI_QUIZ = [
  { e: '🕷️🕸️👨', a: 'spiderman' }, { e: '❄️👑👸', a: 'frozen' }, { e: '🦁👑', a: 'lion king' },
  { e: '🏴‍☠️⚓🌊', a: 'pirates' }, { e: '🔴⭕🎮', a: 'squid game' }, { e: '🧙⚡🤓', a: 'harry potter' },
];
const emojiQuizState = new Map();
aero.command('emojiquiz', (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const q = pick(EMOJI_QUIZ);
  emojiQuizState.set(`${i.nexus_id}:${i.invoker.id}`, q.a);
  return i.reply({
    embeds: [{ title: '🧩 Emoji quiz', description: `What is this?\n\n# ${q.e}`, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Answer', custom_id: 'eq:guess' }] }],
  });
});
aero.component('eq:guess', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Your answer', custom_id: 'eq:submit', inputs: [{ id: 'a', label: 'Guess', style: 'short', required: true, placeholder: 'movie / show' }],
}, { spaceId: i.space_id }));
aero.component('eq:submit', (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const answer = emojiQuizState.get(key);
  if (!answer) return i.replyEphemeral('Start a new /emojiquiz.');
  const g = String(i.fields?.a || '').trim().toLowerCase();
  if (g.includes(answer) || answer.includes(g)) { emojiQuizState.delete(key); awardXp(i, 10); return i.reply(say('✅ Correct', `It was **${answer}**!${on(i.nexus_id, 'levels') ? ' (+10 XP)' : ''}`, OK)); }
  return i.replyEphemeral(say('❌ Nope', 'Try again · press Answer.', WARN_C));
});

// /reactiontest — click the button as fast as you can.
aero.command('reactiontest', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const delay = 1500 + Math.floor(Math.random() * 3000);
  await i.reply(say('⏳ Reaction test', 'Wait for it… a **Click!** button appears soon. Be ready!'));
  setTimeout(async () => {
    try {
      await aero.sendMessage(i.nexus_id, i.space_id, {
        embeds: [{ title: '🟢 CLICK NOW!', color: OK }],
        components: [{ components: [{ type: 'button', style: 'success', label: 'Click!', custom_id: `rt:${Date.now()}` }] }],
      });
    } catch { /* space may be gone */ }
  }, delay);
  return undefined;
});
function handleReactionTest(i) {
  const started = parseInt(i.custom_id.split(':')[1], 10);
  const ms = Date.now() - started;
  awardXp(i, 5);
  return i.update(say('⚡ Reaction', `You clicked in **${ms} ms**!${on(i.nexus_id, 'levels') ? ' (+5 XP)' : ''}`, OK));
}

// /coinstreak — flip until you miss; how long a heads streak can you get?
const streakState = new Map();
aero.command('coinstreak', async (i) => {
  if (!gameGate(i)) return i.replyEphemeral('The Games module is off in this Nexus.');
  const res = await i.reply(streakView(0));
  if (res?.message?.id) streakState.set(String(res.message.id), 0);
  return undefined;
});
function streakView(streak) {
  return { embeds: [{ title: '🪙 Coin streak', description: `Heads streak: **${streak}**\nFlip again and pray for heads!`, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'primary', label: 'Flip', custom_id: 'cs:flip' }] }] };
}
function handleCoinStreak(i) {
  const cur = streakState.get(String(i.message_id));
  if (cur == null) return i.replyEphemeral('Start a new /coinstreak.');
  if (Math.random() < 0.5) { streakState.set(String(i.message_id), cur + 1); if ((cur + 1) % 5 === 0) awardXp(i, 8); return i.update(streakView(cur + 1)); }
  streakState.delete(String(i.message_id));
  return i.update(say('💥 Tails!', `Your streak ended at **${cur}** heads.`, DANGER_C));
}

// ─────────────────────────────────────────────────────────────
// TAGS module — /tag posts a saved snippet; admins manage them.
// ─────────────────────────────────────────────────────────────
const doTag = (i, raw) => {
  const content = store.getTag(i.nexus_id, (raw || '').trim().toLowerCase());
  return content ? i.reply(content) : i.replyEphemeral('No tag by that name. See /tag-list.');
};
aero.command('tag', (i) => inlineText(i, (v) => doTag(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Tag', custom_id: 'tag:get', inputs: [{ id: 'name', label: 'Tag name', style: 'short', required: true, placeholder: 'rules' }] }, { spaceId: i.space_id })));
aero.component('tag:get', (i) => doTag(i, i.fields?.name || ''));
aero.command('tag-list', (i) => {
  const tags = store.listTags(i.nexus_id);
  return i.replyEphemeral(say('🏷️ Tags', tags.length ? tags.map((t) => `\`${t}\``).join(', ') : 'No tags yet. An admin can add one with /tag-add.'));
});
aero.command('tag-add', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Add a tag', custom_id: 'tag:add',
  inputs: [
    { id: 'name', label: 'Name', style: 'short', required: true, placeholder: 'rules' },
    { id: 'content', label: 'Response', style: 'paragraph', required: true, placeholder: 'Be kind. No spam.' },
  ],
}, { spaceId: i.space_id }));
aero.component('tag:add', (i) => {
  const name = (i.fields?.name || '').trim().toLowerCase().slice(0, 40);
  const content = (i.fields?.content || '').trim().slice(0, 1500);
  if (!name || !content) return i.replyEphemeral('A tag needs a name and a response.');
  store.setTag(i.nexus_id, name, content);
  return i.replyEphemeral(say('Saved', `Tag \`${name}\` saved. Post it with /tag.`, OK));
});
aero.command('tag-delete', (i) => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Delete a tag', custom_id: 'tag:del', inputs: [{ id: 'name', label: 'Name', style: 'short', required: true, placeholder: 'rules' }] }, { spaceId: i.space_id }));
aero.component('tag:del', (i) => {
  const ok = store.deleteTag(i.nexus_id, (i.fields?.name || '').trim().toLowerCase());
  return i.replyEphemeral(ok ? '🗑️ Tag deleted.' : 'No tag by that name.');
});


// ─────────────────────────────────────────────────────────────
// COUNTING module — /count-setup makes a space the counting game space;
// members count 1, 2, 3… one turn each, and any mistake resets to 1.
// The counting itself is handled in message.created above.
// ─────────────────────────────────────────────────────────────
aero.command('count-setup', (i) => i.reply({
  embeds: [{ title: '🔢 Counting game', description: 'Pick the space where members count up together.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'space', custom_id: 'count:space', placeholder: 'Pick a space', min: 1, max: 1 }] }],
}));
aero.component('count:space', async (i) => {
  const spaceId = i.values?.[0];
  store.setCountingSpace(i.nexus_id, spaceId);
  try { await aero.sendMessage(i.nexus_id, spaceId, say('🔢 Counting starts now', 'Count up together, starting at **1**. One turn each. A wrong number or a double-turn resets it!', OK)); } catch { /* ignore */ }
  return i.update(say('Saved', 'Counting game is set up. Turn on the Counting module to activate.', OK));
});
aero.command('count-status', (i) => {
  if (!on(i.nexus_id, 'counting')) return i.replyEphemeral('The Counting module is off in this Nexus.');
  const g = store.getCounting(i.nexus_id);
  if (!g || !g.space_id) return i.replyEphemeral('No counting space set. An admin can set one with /count-setup.');
  return i.replyEphemeral(say('🔢 Counting', `Current: **${g.current}** · next is **${g.current + 1}**\nAll-time best: **${g.best}**`));
});

// ─────────────────────────────────────────────────────────────
// ECONOMY module — a light coin economy: /work earns, /daily-coins,
// /balance, /pay, /rich leaderboard, /gamble and /rob for risk-takers.
// ─────────────────────────────────────────────────────────────
const COIN = '🪙';
const ecoGate = (i) => on(i.nexus_id, 'economy');
const fmtCoins = (n) => `${COIN} **${n.toLocaleString()}**`;

aero.command('balance', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const c = store.getCoins(i.nexus_id, i.invoker.id);
  const net = (c.balance || 0) + (c.bank || 0);
  return i.replyEphemeral(rich({
    title: '💰 Your wallet',
    description: `You're carrying ${fmtCoins(c.balance || 0)}.`,
    color: OK,
    fields: [
      { name: 'Wallet', value: fmtCoins(c.balance || 0), inline: true },
      { name: 'Bank', value: fmtCoins(c.bank || 0), inline: true },
      { name: 'Net worth', value: fmtCoins(net), inline: true },
    ],
    footer: 'Velixar · use /deposit and /withdraw',
  }));
});

const WORK_COOLDOWN = 60 * 60 * 1000; // 1 hour
const WORK_LINES = ['You fixed a bug', 'You mopped the tavern', 'You walked some dogs', 'You sold fan art', 'You streamed for tips'];
aero.command('work', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const c = store.getCoins(i.nexus_id, i.invoker.id);
  const since = Date.now() - c.last_work;
  if (since < WORK_COOLDOWN) {
    const mins = Math.ceil((WORK_COOLDOWN - since) / 60000);
    return i.replyEphemeral(say('Tired!', `You need a break. Come back in **${mins} min**.`, WARN_C));
  }
  const earned = 50 + Math.floor(Math.random() * 150);
  store.addCoins(i.nexus_id, i.invoker.id, earned);
  store.markWork(i.nexus_id, i.invoker.id, Date.now());
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  return i.reply(rich({
    title: '💼 Work',
    description: `${WORK_LINES[Math.floor(Math.random() * WORK_LINES.length)]} and earned ${fmtCoins(earned)}.`,
    color: OK,
    fields: [{ name: 'New balance', value: fmtCoins(bal), inline: true }],
    footer: 'Velixar',
  }));
});

aero.command('daily-coins', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  // Reuse the /daily streak store so coins + XP dailies stay in sync per user.
  const d = store.getDaily(i.nexus_id, i.invoker.id);
  const now = Date.now();
  if (now - d.last_claim < DAY) {
    const hrs = Math.ceil((DAY - (now - d.last_claim)) / (60 * 60 * 1000));
    return i.replyEphemeral(say('Already claimed', `Your next daily is in **${hrs}h**.`, WARN_C));
  }
  const streak = now - d.last_claim < 2 * DAY ? d.streak + 1 : 1;
  const reward = 100 + Math.min(streak, 30) * 20;
  store.setDaily(i.nexus_id, i.invoker.id, now, streak);
  store.addCoins(i.nexus_id, i.invoker.id, reward);
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  return i.reply(rich({
    title: '🎁 Daily coins',
    description: `You claimed today's reward.`,
    color: OK,
    fields: [
      { name: 'Earned', value: fmtCoins(reward), inline: true },
      { name: 'Streak', value: `🔥 ${streak}-day`, inline: true },
      { name: 'Balance', value: fmtCoins(bal), inline: true },
    ],
    footer: 'Velixar · come back tomorrow',
  }));
});

aero.command('rich', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const rows = store.topCoins(i.nexus_id, 50);
  if (!rows.length) return i.reply(say('💰 Richest', 'No one has coins yet. Try /work!'));
  const items = rows.map((r, n) => `${MEDALS[n] || `**${n + 1}.**`} <@${r.user_id}> · ${fmtCoins(r.balance)}`);
  return replyPaged(i, { items, perPage: 10, title: '💰 Richest members' });
});

// /pay a member some of your coins.
const pendingPay = new Map();
const doPay = (i, to, amountRaw) => {
  if (to === i.invoker.id) return i.replyEphemeral("You can't pay yourself.");
  const amount = parseInt(String(amountRaw).trim(), 10);
  if (!Number.isFinite(amount) || amount < 1) return i.replyEphemeral('Enter a positive amount, e.g. `/pay @name 100`.');
  const ok = store.transferCoins(i.nexus_id, i.invoker.id, to, amount);
  if (!ok) return i.replyEphemeral("You don't have that many coins.");
  return i.reply(say('💸 Paid', `<@${i.invoker.id}> paid ${fmtCoins(amount)} to <@${to}>.`, OK));
};
aero.command('pay', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const to = i.options?.user;
  const amount = (i.options?.text ?? '').toString().trim();
  if (to && amount) return doPay(i, to, amount);
  return i.reply({
    embeds: [{ title: '💸 Pay', description: 'Pick who to pay. (tip: `/pay @name 100`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'eco:pay', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('eco:pay', (i) => {
  if (i.values?.[0] === i.invoker.id) return i.replyEphemeral("You can't pay yourself.");
  pendingPay.set(`${i.nexus_id}:${i.invoker.id}`, i.values?.[0]);
  return aero.openModal(i.nexus_id, i.invoker.id, { title: 'Amount', custom_id: 'eco:pay-amt', inputs: [{ id: 'amount', label: 'How many coins?', style: 'short', required: true, placeholder: '100' }] }, { spaceId: i.space_id });
});
aero.component('eco:pay-amt', (i) => {
  const to = pendingPay.get(`${i.nexus_id}:${i.invoker.id}`);
  pendingPay.delete(`${i.nexus_id}:${i.invoker.id}`);
  if (!to) return i.replyEphemeral('That expired. Run /pay again.');
  return doPay(i, to, i.fields?.amount || '');
});

// /gamble half-or-double a bet.
const WIN_GIF = gg('26u4b45b8KlgAB7iM');
const LOSE_GIF = gg('OPU6wzx8JrHna');
async function doGamble(i, betRaw) {
  const bet = parseInt(String(betRaw).trim(), 10);
  if (!Number.isFinite(bet) || bet < 1) return i.replyEphemeral('Enter a positive bet, e.g. `/gamble 100`.');
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  if (bet > bal) return i.replyEphemeral("You can't bet more than you have.");
  const win = Math.random() < 0.45; // slight house edge
  store.addCoins(i.nexus_id, i.invoker.id, win ? bet : -bet);
  // Animate: post a spinning message, then edit to the result a beat later.
  const res = await i.reply(say('🎰 Rolling...', '🎲 🎲 🎲', BRAND));
  const mid = res?.message?.id;
  const final = win
    ? { embeds: [{ title: '🎉 You won!', description: `You doubled your bet and won ${fmtCoins(bet)}.\nNew balance: ${fmtCoins(bal + bet)}.`, color: OK, image: { url: WIN_GIF } }] }
    : { embeds: [{ title: '💸 You lost', description: `You lost ${fmtCoins(bet)}.\nNew balance: ${fmtCoins(bal - bet)}.`, color: DANGER_C, image: { url: LOSE_GIF } }] };
  if (mid) setTimeout(() => aero.editMessage(i.nexus_id, i.space_id, mid, final).catch(() => {}), 1200);
  return undefined;
}
aero.command('gamble', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  // "/gamble 100" bets inline; bare "/gamble" opens the amount modal.
  return inlineText(i, (v) => doGamble(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Gamble', custom_id: 'eco:gamble', inputs: [{ id: 'bet', label: 'Bet amount', style: 'short', required: true, placeholder: '100' }] }, { spaceId: i.space_id }));
});
aero.component('eco:gamble', (i) => doGamble(i, i.fields?.bet || ''));

// /rob attempt to steal from a member (risky: can backfire).
const doRob = (i, target, respond) => {
  if (target === i.invoker.id) return i.replyEphemeral("You can't rob yourself.");
  const theirBal = store.getCoins(i.nexus_id, target).balance;
  if (theirBal < 50) return respond(say('🕵️ Not worth it', "They don't have enough to rob.", WARN_C));
  if (Math.random() < 0.5) {
    const stolen = Math.floor(theirBal * (0.1 + Math.random() * 0.2));
    store.transferCoins(i.nexus_id, target, i.invoker.id, stolen);
    return respond(say('🕵️ Success', `You robbed ${fmtCoins(stolen)} from <@${target}>!`, OK));
  }
  const fine = 50 + Math.floor(Math.random() * 100);
  store.addCoins(i.nexus_id, i.invoker.id, -fine);
  return respond(say('🚔 Caught!', `You got caught and paid a ${fmtCoins(fine)} fine.`, DANGER_C));
};
aero.command('rob', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const target = i.options?.user;
  if (target) return doRob(i, target, (m) => i.reply(m));
  return i.reply({
    embeds: [{ title: '🕵️ Rob', description: 'Pick who to rob. It might backfire! (tip: `/rob @name`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'eco:rob', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('eco:rob', (i) => doRob(i, i.values?.[0], (m) => i.update(m)));

// ── Shop + inventory ──
const SHOP = [
  { id: 'coffee', emoji: '☕', name: 'Coffee', price: 50, desc: 'A warm cup. Cosmetic.' },
  { id: 'fish', emoji: '🐟', name: 'Fish', price: 100, desc: 'Fresh catch.' },
  { id: 'gem', emoji: '💎', name: 'Gem', price: 500, desc: 'Shiny and valuable.' },
  { id: 'crown', emoji: '👑', name: 'Crown', price: 2000, desc: 'For the wealthy.' },
  { id: 'rocket', emoji: '🚀', name: 'Rocket', price: 5000, desc: 'To the moon!' },
];
aero.command('shop', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const body = SHOP.map((s) => `${s.emoji} **${s.name}**  ·  ${fmtCoins(s.price)}\n${s.desc}`).join('\n\n');
  return i.reply({ embeds: [{ title: '🛒 Shop', description: `${body}\n\nBuy with \`/buy\` and the item name.`, color: BRAND, footer: { text: `Your balance: ${store.getCoins(i.nexus_id, i.invoker.id).balance} coins` } }] });
});
const doBuy = (i, raw) => {
  const key = (raw || '').trim().toLowerCase();
  const item = SHOP.find((s) => s.id === key || s.name.toLowerCase() === key);
  if (!item) return i.replyEphemeral(`No such item. See /shop. (try: ${SHOP.map((s) => s.id).join(', ')})`);
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  if (bal < item.price) return i.replyEphemeral(`You need ${fmtCoins(item.price)} but only have ${fmtCoins(bal)}.`);
  store.addCoins(i.nexus_id, i.invoker.id, -item.price);
  store.addItem(i.nexus_id, i.invoker.id, item.id, 1);
  return i.reply(say('🛍️ Purchased', `<@${i.invoker.id}> bought ${item.emoji} **${item.name}** for ${fmtCoins(item.price)}.`, OK));
};
aero.command('buy', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => doBuy(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Buy an item', custom_id: 'eco:buy', inputs: [{ id: 'item', label: 'Item name', style: 'short', required: true, placeholder: 'gem' }] }, { spaceId: i.space_id }));
});
aero.component('eco:buy', (i) => doBuy(i, i.fields?.item || ''));
aero.command('inventory', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const inv = store.listInventory(i.nexus_id, i.invoker.id);
  if (!inv.length) return i.replyEphemeral(say('🎒 Inventory', 'Empty. Buy something with /shop and /buy.'));
  const body = inv.map((r) => { const s = SHOP.find((x) => x.id === r.item); return `${s ? s.emoji : '📦'} **${s ? s.name : r.item}** ×${r.qty}`; }).join('\n');
  return i.replyEphemeral(say('🎒 Your inventory', body));
});

// ── Gambling games ──
aero.command('coinflip-bet', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => doCoinBet(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Coinflip bet', custom_id: 'eco:coinbet', inputs: [{ id: 'bet', label: 'Bet amount', style: 'short', required: true, placeholder: '100' }] }, { spaceId: i.space_id }));
});
aero.component('eco:coinbet', (i) => doCoinBet(i, i.fields?.bet || ''));
async function doCoinBet(i, raw) {
  const bet = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(bet) || bet < 1) return i.replyEphemeral('Enter a positive bet, e.g. `/coinflip-bet 100`.');
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  if (bet > bal) return i.replyEphemeral("You can't bet more than you have.");
  // Heads wins. animateFlip spins the coin, then we settle on the landed side.
  await animateFlip(i, '🪙 Coinflip bet', (heads) => {
    store.addCoins(i.nexus_id, i.invoker.id, heads ? bet : -bet);
    return say(
      heads ? '🪙 Heads · you win!' : '🪙 Tails · you lose',
      heads ? `You won ${fmtCoins(bet)}.` : `You lost ${fmtCoins(bet)}.`,
      heads ? OK : DANGER_C,
    );
  });
  return undefined;
}

// /lottery — buy a ticket (50 coins) for a chance at a jackpot.
aero.command('lottery', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  if (bal < 50) return i.replyEphemeral('A ticket costs 50 coins.');
  store.addCoins(i.nexus_id, i.invoker.id, -50);
  const roll = Math.random();
  let prize = 0;
  if (roll < 0.01) prize = 5000; else if (roll < 0.08) prize = 500; else if (roll < 0.3) prize = 100;
  if (prize) store.addCoins(i.nexus_id, i.invoker.id, prize);
  return i.reply(prize
    ? say('🎟️ Lottery win!', `<@${i.invoker.id}> won ${fmtCoins(prize)}! 🎉`, OK)
    : say('🎟️ Lottery', 'No luck this time. Better luck next ticket!', BRAND));
});

// /blackjack — a simplified hit/stand game vs the dealer, wagering coins.
const bjState = new Map(); // messageId -> { bet, player:[], dealer:[], done }
const bjDraw = () => 1 + Math.floor(Math.random() * 13);
const bjVal = (cards) => { let sum = cards.reduce((a, c) => a + Math.min(c, 10), 0); let aces = cards.filter((c) => c === 1).length; while (aces > 0 && sum + 10 <= 21) { sum += 10; aces--; } return sum; };
// Numeric 1..13 -> a card face on a suit picked by position, so a hand reads
// like real cards AND a card's suit stays stable across re-renders (index-based,
// not random each frame). The value math above stays numeric and untouched.
const BJ_RANK = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const bjCard = (c, idx = 0) => `${BJ_RANK[c] || c}${['♠', '♥', '♦', '♣'][idx % 4]}`;
aero.command('blackjack', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => startBj(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, { title: 'Blackjack', custom_id: 'eco:bj', inputs: [{ id: 'bet', label: 'Bet amount', style: 'short', required: true, placeholder: '100' }] }, { spaceId: i.space_id }));
});
aero.component('eco:bj', (i) => startBj(i, i.fields?.bet || ''));
async function startBj(i, raw) {
  const bet = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(bet) || bet < 1) return i.replyEphemeral('Enter a positive bet, e.g. `/blackjack 100`.');
  const bal = store.getCoins(i.nexus_id, i.invoker.id).balance;
  if (bet > bal) return i.replyEphemeral("You can't bet more than you have.");
  const s = { bet, player: [bjDraw(), bjDraw()], dealer: [bjDraw()], done: false, owner: i.invoker.id };
  const res = await i.reply(bjView(s));
  if (res?.message?.id) bjState.set(String(res.message.id), s);
  return undefined;
}
function bjView(s) {
  const pv = bjVal(s.player), dv = bjVal(s.dealer);
  // Colour the finished board by outcome: green win, red loss, amber push.
  const won = s.done && /win/i.test(s.done);
  const lost = s.done && /(lost|Bust|Dealer wins)/i.test(s.done);
  const color = !s.done ? BRAND : won ? OK : lost ? DANGER_C : WARN_C;
  return {
    embeds: [{
      title: '🃏 Blackjack',
      description: s.done ? `**${s.done}**` : 'Hit to draw, or stand to hold.',
      color,
      fields: [
        { name: 'Your hand', value: `${s.player.map(bjCard).join('  ')}\n**${pv}**`, inline: true },
        { name: 'Dealer', value: `${s.dealer.map(bjCard).join('  ')}\n**${dv}**`, inline: true },
        { name: 'Bet', value: fmtCoins(s.bet), inline: true },
      ],
      footer: { text: 'Velixar · Blackjack' },
    }],
    components: s.done ? [] : [{ components: [
      { type: 'button', style: 'success', label: 'Hit', custom_id: 'bj:hit' },
      { type: 'button', style: 'danger', label: 'Stand', custom_id: 'bj:stand' },
    ] }],
  };
}
function handleBj(i, action) {
  const s = bjState.get(String(i.message_id));
  if (!s || s.done) return i.replyEphemeral('This game is over.');
  if (i.invoker.id !== s.owner) return i.replyEphemeral("This isn't your game.");
  if (action === 'hit') {
    s.player.push(bjDraw());
    if (bjVal(s.player) > 21) { s.done = `Bust! You lost ${fmtCoins(s.bet)}.`; store.addCoins(i.nexus_id, i.invoker.id, -s.bet); }
  } else {
    while (bjVal(s.dealer) < 17) s.dealer.push(bjDraw());
    const pv = bjVal(s.player), dv = bjVal(s.dealer);
    if (dv > 21 || pv > dv) { s.done = `You win ${fmtCoins(s.bet)}! 🎉`; store.addCoins(i.nexus_id, i.invoker.id, s.bet); }
    else if (pv < dv) { s.done = `Dealer wins. You lost ${fmtCoins(s.bet)}.`; store.addCoins(i.nexus_id, i.invoker.id, -s.bet); }
    else s.done = 'Push (tie). Your bet is returned.';
  }
  if (s.done) bjState.delete(String(i.message_id));
  return i.update(bjView(s));
}

// /beg and /crime — small no-cost coin sources with cooldownless flavour.
aero.command('beg', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const got = Math.random() < 0.7 ? 5 + Math.floor(Math.random() * 45) : 0;
  if (got) store.addCoins(i.nexus_id, i.invoker.id, got);
  return i.reply(got ? say('🙏 Begging', `Someone gave you ${fmtCoins(got)}.`, OK) : say('🙏 Begging', 'No one spared a coin. 😔', BRAND));
});
aero.command('crime', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  if (Math.random() < 0.55) { const loot = 50 + Math.floor(Math.random() * 150); store.addCoins(i.nexus_id, i.invoker.id, loot); return i.reply(say('🦹 Crime', `You pulled it off and got ${fmtCoins(loot)}!`, OK)); }
  const fine = 30 + Math.floor(Math.random() * 100); store.addCoins(i.nexus_id, i.invoker.id, -fine);
  return i.reply(say('🚔 Busted', `You got caught and paid a ${fmtCoins(fine)} fine.`, DANGER_C));
});
aero.component('bj:hit', (i) => handleBj(i, 'hit'));
aero.component('bj:stand', (i) => handleBj(i, 'stand'));

// ─────────────────────────────────────────────────────────────
// Economy items batch — bank, gather commands (fish/hunt/mine), more
// gambling and wealth tools. All gated on the Economy module.
// ─────────────────────────────────────────────────────────────

// /bank — see wallet + bank + net worth.
aero.command('bank', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const c = store.getCoins(i.nexus_id, i.invoker.id);
  return i.replyEphemeral(rich({
    title: '🏦 Your bank',
    fields: [
      { name: 'Wallet', value: `${COIN} ${(c.balance || 0).toLocaleString()}`, inline: true },
      { name: 'Bank', value: `${COIN} ${(c.bank || 0).toLocaleString()}`, inline: true },
      { name: 'Net worth', value: `${COIN} ${((c.balance || 0) + (c.bank || 0)).toLocaleString()}`, inline: true },
    ],
    footer: 'Use /deposit and /withdraw to move coins',
  }));
});
aero.command('networth', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const c = store.getCoins(i.nexus_id, i.invoker.id);
  return i.replyEphemeral(say('💎 Net worth', `Your total is ${fmtCoins((c.balance || 0) + (c.bank || 0))}.`, OK));
});

// /deposit and /withdraw — move coins wallet <-> bank. Accept "all".
function bankCmd(name, dir, title) {
  const run = (i, raw) => {
    if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
    const c = store.getCoins(i.nexus_id, i.invoker.id);
    const cap = dir > 0 ? (c.balance || 0) : (c.bank || 0);
    const word = String(raw).trim().toLowerCase();
    const amount = word === 'all' ? cap : parseInt(word, 10);
    if (!Number.isFinite(amount) || amount <= 0) return i.replyEphemeral(`Enter an amount or \`all\`, e.g. \`/${name} 500\`.`);
    const ok = store.bankMove(i.nexus_id, i.invoker.id, dir * amount);
    if (!ok) return i.replyEphemeral(`You don't have ${fmtCoins(amount)} to ${name}.`);
    return i.reply(say(title, `${dir > 0 ? 'Deposited' : 'Withdrew'} ${fmtCoins(amount)}.`, OK));
  };
  aero.command(name, (i) => inlineText(i, (v) => run(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title, custom_id: `eco:${name}`, inputs: [{ id: 'text', label: 'Amount (or "all")', style: 'short', required: true, placeholder: '500' }],
  }, { spaceId: i.space_id })));
  aero.component(`eco:${name}`, (i) => run(i, i.fields?.text || ''));
}
bankCmd('deposit', +1, '🏦 Deposit');
bankCmd('withdraw', -1, '🏦 Withdraw');

// Gather commands: a shared cooldown + weighted reward table.
function gatherCmd(name, { title, cooldownMs, table, emoji }) {
  aero.command(name, (i) => {
    if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
    const now = Date.now();
    const last = store.ecoCooldown(i.nexus_id, i.invoker.id, name);
    if (now - last < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (now - last)) / 1000);
      return i.replyEphemeral(say(title, `Rest a moment · try again in **${wait}s**.`, WARN_C));
    }
    store.markEco(i.nexus_id, i.invoker.id, name, now);
    const roll = table[Math.floor(Math.random() * table.length)];
    store.addCoins(i.nexus_id, i.invoker.id, roll.coins);
    return i.reply(say(`${emoji} ${title}`, `${roll.text} You earned ${fmtCoins(roll.coins)}.`, roll.coins > 0 ? OK : BRAND));
  });
}
gatherCmd('fish', { title: 'Fishing', emoji: '🎣', cooldownMs: 30000, table: [
  { text: 'You caught a tiny minnow.', coins: 15 }, { text: 'A shimmering bass!', coins: 45 },
  { text: 'A rare golden koi! ✨', coins: 120 }, { text: 'Just an old boot. 🥾', coins: 0 },
  { text: 'A bucket of shrimp.', coins: 30 },
] });
gatherCmd('hunt', { title: 'Hunting', emoji: '🏹', cooldownMs: 30000, table: [
  { text: 'You bagged a rabbit.', coins: 25 }, { text: 'A wild boar · nice!', coins: 80 },
  { text: 'A legendary stag! 🦌', coins: 150 }, { text: 'You came back empty-handed.', coins: 0 },
  { text: 'A brace of pheasants.', coins: 40 },
] });
gatherCmd('mine', { title: 'Mining', emoji: '⛏️', cooldownMs: 30000, table: [
  { text: 'A vein of copper.', coins: 20 }, { text: 'A chunk of silver.', coins: 60 },
  { text: 'A diamond! 💎', coins: 200 }, { text: 'Only rubble this time.', coins: 0 },
  { text: 'A pocket of gold dust.', coins: 90 },
] });

// /weekly — a bigger, once-a-week bonus (separate cooldown from /daily-coins).
aero.command('weekly', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const now = Date.now(), WEEK = 7 * 86400000;
  const last = store.ecoCooldown(i.nexus_id, i.invoker.id, 'weekly');
  if (now - last < WEEK) {
    const days = Math.ceil((WEEK - (now - last)) / 86400000);
    return i.replyEphemeral(say('📅 Weekly', `Already claimed · come back in **${days} day(s)**.`, WARN_C));
  }
  store.markEco(i.nexus_id, i.invoker.id, 'weekly', now);
  const reward = 500 + Math.floor(Math.random() * 500);
  store.addCoins(i.nexus_id, i.invoker.id, reward);
  return i.reply(say('📅 Weekly bonus', `+${fmtCoins(reward)} · see you next week!`, OK));
});

// /richest — the coin leaderboard (wallet + bank).
aero.command('richest', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const rows = store.topCoins(i.nexus_id, 50);
  if (!rows.length) return i.reply(say('🏆 Richest', 'No one has any coins yet. Try /work!'));
  const MED = ['🥇', '🥈', '🥉'];
  const items = rows.map((r, n) => `${MED[n] || `**${n + 1}.**`} <@${r.user_id}> · ${fmtCoins(r.balance)}`);
  return replyPaged(i, { items, perPage: 10, title: '🏆 Richest members' });
});

// /give-coins — a friendly alias of /pay with an inline amount.
aero.command('give-coins', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  const to = i.options?.user;
  if (!to) return i.replyEphemeral('Use `/give-coins @member 100` to send coins.');
  const amount = parseInt(String(i.options?.text || '').trim(), 10);
  if (!Number.isFinite(amount) || amount <= 0) return i.replyEphemeral('Add an amount, e.g. `/give-coins @member 100`.');
  if (String(to) === String(i.invoker.id)) return i.replyEphemeral("You can't pay yourself.");
  const ok = store.transferCoins(i.nexus_id, i.invoker.id, to, amount);
  if (!ok) return i.replyEphemeral(`You don't have ${fmtCoins(amount)}.`);
  return i.reply(say('💸 Sent', `<@${i.invoker.id}> gave ${fmtCoins(amount)} to <@${to}>.`, OK));
});

// /roulette — bet on red/black/green via buttons, house-fair odds.
aero.command('roulette', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => openRoulette(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Roulette', custom_id: 'eco:roulette', inputs: [{ id: 'text', label: 'Bet amount', style: 'short', required: true, placeholder: '100' }],
  }, { spaceId: i.space_id }));
});
aero.component('eco:roulette', (i) => openRoulette(i, i.fields?.text || ''));
function openRoulette(i, raw) {
  const bet = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(bet) || bet <= 0) return i.replyEphemeral('Enter a positive bet, e.g. `/roulette 100`.');
  if ((store.getCoins(i.nexus_id, i.invoker.id).balance || 0) < bet) return i.replyEphemeral(`You don't have ${fmtCoins(bet)}.`);
  return i.reply({
    embeds: [{ title: '🎡 Roulette', description: `Bet: ${fmtCoins(bet)}\nPick a colour · red/black pay 2×, green pays 14×.`, color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'danger', label: 'Red', custom_id: `roul:red:${bet}` },
      { type: 'button', style: 'secondary', label: 'Black', custom_id: `roul:black:${bet}` },
      { type: 'button', style: 'success', label: 'Green', custom_id: `roul:green:${bet}` },
    ] }],
  });
}
async function handleRoulette(i) {
  const [, colour, betStr] = i.custom_id.split(':');
  const bet = parseInt(betStr, 10);
  if ((store.getCoins(i.nexus_id, i.invoker.id).balance || 0) < bet) return i.replyEphemeral(`You no longer have ${fmtCoins(bet)}.`);
  const r = Math.random();
  const landed = r < 1 / 37 ? 'green' : r < 0.5 + 0.5 / 37 ? 'red' : 'black';
  const EMO = { red: '🔴', black: '⚫', green: '🟢' };
  // Spin the wheel: cycle the ball through colours before it settles. First edit
  // via update() (removes the buttons), the rest via editMessage on the same id.
  await i.update(say('🎡 Roulette', `The wheel is spinning…\n\n🔴 ⚫ 🔴 ⚫ 🟢`, BRAND));
  const seq = ['red', 'black', 'red', 'black', 'green', 'red', 'black'];
  for (let n = 0; n < seq.length; n++) {
    await new Promise((res) => setTimeout(res, 240));
    await aero.editMessage(i.nexus_id, i.space_id, i.message_id, say('🎡 Roulette', `Spinning…  ${EMO[seq[n]]}`, BRAND)).catch(() => {});
  }
  const mult = landed === colour ? (landed === 'green' ? 14 : 2) : 0;
  const delta = mult ? bet * (mult - 1) : -bet;
  store.addCoins(i.nexus_id, i.invoker.id, delta);
  await new Promise((res) => setTimeout(res, 300));
  await aero.editMessage(i.nexus_id, i.space_id, i.message_id, say('🎡 Roulette',
    `The ball landed on ${EMO[landed]} **${landed}**.\n${mult ? `You won ${fmtCoins(bet * mult)}! (${mult}×)` : `You lost ${fmtCoins(bet)}.`}`,
    mult ? OK : DANGER_C)).catch(() => {});
  return undefined;
}

// /dice-bet — bet on high/low of a single d6.
aero.command('dice-bet', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => openDiceBet(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Dice bet', custom_id: 'eco:dicebet', inputs: [{ id: 'text', label: 'Bet amount', style: 'short', required: true, placeholder: '100' }],
  }, { spaceId: i.space_id }));
});
aero.component('eco:dicebet', (i) => openDiceBet(i, i.fields?.text || ''));
function openDiceBet(i, raw) {
  const bet = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(bet) || bet <= 0) return i.replyEphemeral('Enter a positive bet, e.g. `/dice-bet 100`.');
  if ((store.getCoins(i.nexus_id, i.invoker.id).balance || 0) < bet) return i.replyEphemeral(`You don't have ${fmtCoins(bet)}.`);
  return i.reply({
    embeds: [{ title: '🎲 Dice bet', description: `Bet: ${fmtCoins(bet)}\nWill the die roll **low** (1-3) or **high** (4-6)? Pays 2×.`, color: BRAND }],
    components: [{ components: [
      { type: 'button', style: 'secondary', label: 'Low (1-3)', custom_id: `dbet:low:${bet}` },
      { type: 'button', style: 'secondary', label: 'High (4-6)', custom_id: `dbet:high:${bet}` },
    ] }],
  });
}
async function handleDiceBet(i) {
  const [, pick, betStr] = i.custom_id.split(':');
  const bet = parseInt(betStr, 10);
  if ((store.getCoins(i.nexus_id, i.invoker.id).balance || 0) < bet) return i.replyEphemeral(`You no longer have ${fmtCoins(bet)}.`);
  const roll = 1 + Math.floor(Math.random() * 6);
  const DIE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  // Tumble the die a few times before it settles.
  await i.update(say('🎲 Dice bet', 'Rolling…  🎲', BRAND));
  for (let n = 0; n < 5; n++) {
    await new Promise((res) => setTimeout(res, 200));
    await aero.editMessage(i.nexus_id, i.space_id, i.message_id, say('🎲 Dice bet', `Rolling…  ${DIE[Math.floor(Math.random() * 6)]}`, BRAND)).catch(() => {});
  }
  const win = (pick === 'low' && roll <= 3) || (pick === 'high' && roll >= 4);
  store.addCoins(i.nexus_id, i.invoker.id, win ? bet : -bet);
  await new Promise((res) => setTimeout(res, 280));
  await aero.editMessage(i.nexus_id, i.space_id, i.message_id, say('🎲 Dice bet',
    `The die shows ${DIE[roll - 1]} **${roll}**.\n${win ? `You won ${fmtCoins(bet * 2)}!` : `You lost ${fmtCoins(bet)}.`}`,
    win ? OK : DANGER_C)).catch(() => {});
  return undefined;
}

// /sell — sell a shop item back for half its price.
aero.command('sell', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => doSell(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Sell an item', custom_id: 'eco:sell', inputs: [{ id: 'text', label: 'Item name', style: 'short', required: true, placeholder: 'gem' }],
  }, { spaceId: i.space_id }));
});
aero.component('eco:sell', (i) => doSell(i, i.fields?.text || ''));
function doSell(i, raw) {
  const name = String(raw).trim().toLowerCase();
  const item = SHOP.find((s) => s.name.toLowerCase() === name || s.emoji === name);
  if (!item) return i.replyEphemeral(`No such item. Shop items: ${SHOP.map((s) => s.name).join(', ')}.`);
  if (store.getItem(i.nexus_id, i.invoker.id, item.name) < 1) return i.replyEphemeral(`You don't own a ${item.name}.`);
  const refund = Math.floor(item.price / 2);
  store.addItem(i.nexus_id, i.invoker.id, item.name, -1);
  store.addCoins(i.nexus_id, i.invoker.id, refund);
  return i.reply(say('💰 Sold', `Sold one ${item.emoji} **${item.name}** for ${fmtCoins(refund)}.`, OK));
}

// /use — playfully "use" an owned item (flavourful, consumes nothing risky).
aero.command('use', (i) => {
  if (!ecoGate(i)) return i.replyEphemeral('The Economy module is off in this Nexus.');
  return inlineText(i, (v) => doUse(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Use an item', custom_id: 'eco:use', inputs: [{ id: 'text', label: 'Item name', style: 'short', required: true, placeholder: 'coffee' }],
  }, { spaceId: i.space_id }));
});
aero.component('eco:use', (i) => doUse(i, i.fields?.text || ''));
function doUse(i, raw) {
  const name = String(raw).trim().toLowerCase();
  const item = SHOP.find((s) => s.name.toLowerCase() === name || s.emoji === name);
  if (!item) return i.replyEphemeral(`No such item. Shop items: ${SHOP.map((s) => s.name).join(', ')}.`);
  if (store.getItem(i.nexus_id, i.invoker.id, item.name) < 1) return i.replyEphemeral(`You don't own a ${item.name}.`);
  return i.reply(say(`${item.emoji} Used ${item.name}`, `You show off your ${item.emoji} **${item.name}**. Style points +100.`, OK));
}

// ─────────────────────────────────────────────────────────────
// ROLES module — self-assign from a dropdown (per-Nexus config)
// ─────────────────────────────────────────────────────────────
function rolesPanel(nexusId) {
  const roles = cfg(nexusId).self_roles;
  if (!roles.length) return null;
  return {
    embeds: [{ title: 'Pick your roles', description: 'Choose from the menu to assign yourself a role.', color: BRAND }],
    components: [{ components: [{
      type: 'select', kind: 'string', custom_id: 'roles:pick', placeholder: 'Select a role', min: 1, max: 1,
      options: roles.map((r) => ({ label: r.label, value: r.value })),
    }] }],
  };
}
aero.command('roles', (i) => {
  if (!on(i.nexus_id, 'roles')) return i.replyEphemeral('The Roles module is off in this Nexus.');
  const panel = rolesPanel(i.nexus_id);
  return panel ? i.reply(panel) : i.replyEphemeral('No self-assign roles set up. An admin can add them with /roles-add.');
});
aero.component('roles:open', (i) => {
  if (!on(i.nexus_id, 'roles')) return i.replyEphemeral('Roles are off right now.');
  const panel = rolesPanel(i.nexus_id);
  return panel ? i.replyEphemeral(panel) : i.replyEphemeral('No self-assign roles have been set up yet.');
});
aero.component('roles:pick', async (i) => {
  if (!on(i.nexus_id, 'roles')) return i.replyEphemeral('The Roles module is off in this Nexus.');
  const roleId = i.values?.[0];
  try {
    await aero.assignRole(i.nexus_id, i.invoker.id, roleId);
    return i.replyEphemeral(`✅ Role assigned.`);
  } catch (e) {
    return i.replyEphemeral(`❌ ${e.message}`);
  }
});

// ─────────────────────────────────────────────────────────────
// MODERATION module — pickers + ephemeral confirmations
// ─────────────────────────────────────────────────────────────
const modState = new Map(); // `${user}` -> pending action target

// Picks a member inline (`/warn @name`) or via a picker. `pick` is the reply UI.
const memberPickReply = (i, title, prompt, customId) => i.reply({
  embeds: [{ title, description: `${prompt} (tip: \`/${customId.split(':')[1]} @name\`)`, color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'member', custom_id: customId, placeholder: 'Pick a member', min: 1, max: 1 }] }],
});

// Threshold auto-action: the SDK returns the running warning count, so Velixar
// decides the escalation itself (3 -> timeout, 5 -> ban). No backend change.
async function doWarn(i, target, respond) {
  try {
    const { warnings } = await aero.warnMember(i.nexus_id, target, 'Warned via Velixar');
    if (warnings >= 5) {
      await aero.banMember(i.nexus_id, target, 'Reached 5 warnings').catch(() => {});
      modlog(i.nexus_id, { title: '🔨 Member banned', color: DANGER_C, actor: i.invoker.name, lines: [`<@${target}> banned after **5** warnings.`] });
      return respond(modCard(i, { title: '🔨 Member banned', description: `Reached **5** warnings and was auto-banned.`, color: DANGER_C, target, detail: { name: 'Warnings', value: '5' } }));
    }
    if (warnings >= 3) {
      await aero.timeoutMember(i.nexus_id, target, 60, 'Reached 3 warnings').catch(() => {});
      modlog(i.nexus_id, { title: '🔇 Auto timeout', color: WARN_C, actor: i.invoker.name, lines: [`<@${target}> timed out 1h after **3** warnings.`] });
      return respond(modCard(i, { title: '🔇 Auto timeout', description: `Reached **3** warnings and was timed out for **1 hour**.`, color: WARN_C, target, detail: { name: 'Warnings', value: String(warnings) } }));
    }
    modlog(i.nexus_id, { title: '⚠️ Member warned', color: WARN_C, actor: i.invoker.name, lines: [`<@${target}> now has **${warnings}** warning(s).`] });
    return respond(modCard(i, { title: '⚠️ Member warned', description: `3 warnings triggers a timeout, 5 a ban.`, color: WARN_C, target, detail: { name: 'Warnings', value: String(warnings) } }));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('warn', (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const t = i.options?.user;
  return t ? doWarn(i, t, (m) => i.reply(m)) : memberPickReply(i, 'Warn a member', 'Choose who to warn.', 'mod:warn');
});
aero.component('mod:warn', (i) => doWarn(i, i.values?.[0], (m) => i.update(m)));

// See a member's warnings.
async function doWarnings(i, target, respond) {
  try {
    const { warnings, count } = await aero.getWarnings(i.nexus_id, target);
    if (!count) return respond(say('No warnings', `<@${target}> has a clean record.`, OK));
    const list = warnings.slice(0, 10).map((w, n) => `**${n + 1}.** ${w.reason || 'No reason'} · ${new Date(w.created_at).toLocaleDateString()}`).join('\n');
    return respond(say(`Warnings for a member (${count})`, list));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('warnings', (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const t = i.options?.user;
  return t ? doWarnings(i, t, (m) => i.reply(m)) : memberPickReply(i, 'Check warnings', 'Pick a member to view their warnings.', 'mod:warnings');
});
aero.component('mod:warnings', (i) => doWarnings(i, i.values?.[0], (m) => i.update(m)));

async function doTimeout(i, target, respond) {
  try {
    await aero.timeoutMember(i.nexus_id, target, 10, 'Timed out via Velixar');
    modlog(i.nexus_id, { title: '🔇 Member timed out', color: WARN_C, actor: i.invoker.name, lines: [`<@${target}> timed out for 10 minutes.`] });
    return respond(modCard(i, { title: '🔇 Member timed out', description: 'The platform lifts the timeout automatically.', color: WARN_C, target, detail: { name: 'Duration', value: '10 min' } }));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('timeout', (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const t = i.options?.user;
  return t ? doTimeout(i, t, (m) => i.reply(m)) : memberPickReply(i, 'Time out a member', 'Pick a member to time out for 10 minutes.', 'mod:timeout');
});
aero.component('mod:timeout', (i) => doTimeout(i, i.values?.[0], (m) => i.update(m)));

// /tempmute — timeout a member for a CHOSEN duration. The platform auto-expires
// the timeout, so no un-mute bookkeeping is needed on our side.
const pendingMute = new Map(); // `${nexus}:${mod}` -> targetUserId
async function doTempmute(i, target, minsRaw) {
  const mins = parseInt(String(minsRaw).trim(), 10);
  if (!Number.isFinite(mins) || mins < 1 || mins > 60 * 24 * 28) return i.replyEphemeral('Enter 1 to 40320 minutes (28 days), e.g. `/tempmute @name 30`.');
  try {
    await aero.timeoutMember(i.nexus_id, target, mins, `Timed out ${mins}m via Velixar`);
    modlog(i.nexus_id, { title: '🔇 Member timed out', color: WARN_C, actor: i.invoker.name, lines: [`<@${target}> timed out for **${mins} min**.`] });
    return i.replyEphemeral(modCard(i, { title: '🔇 Member timed out', description: 'The platform lifts the timeout automatically.', color: WARN_C, target, detail: { name: 'Duration', value: `${mins} min` } }));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('tempmute', (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const target = i.options?.user;
  const mins = (i.options?.text ?? '').toString().trim();
  if (target && mins) return doTempmute(i, target, mins);
  return i.reply({
    embeds: [{ title: 'Temp timeout', description: 'Pick the member to time out. (tip: `/tempmute @name 30`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'mod:tempmute', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('mod:tempmute', (i) => {
  pendingMute.set(`${i.nexus_id}:${i.invoker.id}`, i.values?.[0]);
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Timeout duration', custom_id: 'mod:tempmute-mins',
    inputs: [{ id: 'minutes', label: 'Minutes to time out', style: 'short', required: true, placeholder: 'e.g. 30' }],
  }, { spaceId: i.space_id });
});
aero.component('mod:tempmute-mins', (i) => {
  const target = pendingMute.get(`${i.nexus_id}:${i.invoker.id}`);
  pendingMute.delete(`${i.nexus_id}:${i.invoker.id}`);
  if (!target) return i.replyEphemeral('That pick expired. Run /tempmute again.');
  return doTempmute(i, target, i.fields?.minutes || '');
});

aero.command('purge', async (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  try {
    const { removed } = await aero.purgeMessages(i.nexus_id, i.space_id, 20);
    modlog(i.nexus_id, { title: '🧹 Messages purged', actor: i.invoker.name, lines: [`Removed **${removed}** message(s).`] });
    return i.replyEphemeral(`🧹 Removed ${removed} recent message(s).`);
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// A small factory for "pick a member, then run a mod action" commands. Keeps
// kick / ban consistent and logged.
function memberActionCommand(name, { title, prompt, run, logTitle, logColor }) {
  const act = async (i, target, respond) => {
    try {
      const msg = await run(i, target);
      modlog(i.nexus_id, { title: logTitle, color: logColor, actor: i.invoker.name, lines: [`<@${target}>`] });
      // A consistent moderation card: what happened + who did it, so every
      // action reads as a proper, auditable confirmation.
      return respond(rich({
        title: logTitle,
        description: msg,
        color: logColor,
        fields: [
          { name: 'Member', value: `<@${target}>`, inline: true },
          { name: 'Moderator', value: `<@${i.invoker.id}>`, inline: true },
        ],
        footer: 'Velixar · moderation',
      }));
    } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
  };
  aero.command(name, (i) => {
    if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
    // Inline: `/kick @member` runs straight away. No mention → show a picker.
    const target = i.options?.user;
    if (target) return act(i, target, (m) => i.reply(m));
    return i.reply({
      embeds: [{ title, description: `${prompt} (tip: type \`/${name} @name\`)`, color: BRAND }],
      components: [{ components: [{ type: 'select', kind: 'member', custom_id: `mod:${name}`, placeholder: 'Pick a member', min: 1, max: 1 }] }],
    });
  });
  aero.component(`mod:${name}`, (i) => act(i, i.values?.[0], (m) => i.update(m)));
}
memberActionCommand('kick', {
  title: 'Kick a member', prompt: 'Pick the member to remove from the Nexus.',
  run: async (i, t) => { await aero.kickMember(i.nexus_id, t); return `<@${t}> was kicked.`; },
  logTitle: '👢 Member kicked', logColor: WARN_C,
});
memberActionCommand('ban', {
  title: 'Ban a member', prompt: 'Pick the member to ban.',
  run: async (i, t) => { await aero.banMember(i.nexus_id, t, `Banned by ${i.invoker.name}`); return `<@${t}> was banned.`; },
  logTitle: '🔨 Member banned', logColor: DANGER_C,
});
memberActionCommand('unwarn', {
  title: 'Clear warnings', prompt: 'Pick the member whose warnings to clear.',
  run: async (i, t) => { await aero.clearWarnings(i.nexus_id, t); return `Cleared all warnings for <@${t}>.`; },
  logTitle: '🧾 Warnings cleared', logColor: OK,
});

// ─────────────────────────────────────────────────────────────
// Moderation++ batch — staff notes, warn lists, mod stats and a few more
// member actions. All gated on the Moderation module + require the mod
// permission at the backend (declared in aero.json).
// ─────────────────────────────────────────────────────────────
const modGate = (i) => on(i.nexus_id, 'moderation');

// /warnlist — show a member's warning count (SDK exposes count + rows).
async function doWarnlist(i, target, respond) {
  try {
    const { warnings = [], count = 0 } = await aero.getWarnings(i.nexus_id, target);
    const lines = warnings.slice(0, 10).map((w, n) => `**${n + 1}.** ${w.reason || 'No reason'} ${w.created_at ? `· ${new Date(w.created_at).toLocaleDateString()}` : ''}`);
    return respond(say('🧾 Warnings', `<@${target}> has **${count}** warning(s).${lines.length ? `\n\n${lines.join('\n')}` : ''}`, count ? WARN_C : OK));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('warnlist', (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const target = i.options?.user;
  if (target) return doWarnlist(i, target, (m) => i.reply(m));
  return i.reply({
    embeds: [{ title: '🧾 Warnings', description: 'Pick a member to view their warnings. (tip: `/warnlist @name`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'mod:warnlist', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('mod:warnlist', (i) => doWarnlist(i, i.values?.[0], (m) => i.update(m)));

// /softban — ban then immediately unban is not available via the SDK; here
// "softban" = ban + a note that it was a message-purge ban, the common intent.
memberActionCommand('softban', {
  title: 'Soft-ban a member', prompt: 'Pick the member to soft-ban (ban to clear their recent messages).',
  run: async (i, t) => {
    await aero.banMember(i.nexus_id, t, `Soft-ban by ${i.invoker.name}`);
    store.addNote(i.nexus_id, t, `Soft-banned by ${i.invoker.name}`, i.invoker.name);
    return `<@${t}> was soft-banned (banned to clear recent messages). Lift it from Nexus settings.`;
  },
  logTitle: '🧹 Member soft-banned', logColor: DANGER_C,
});

// /note — add a private staff note to a member. /notes — read them.
aero.command('note', (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const target = i.options?.user;
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Add a note', custom_id: target ? `mod:note:${target}` : 'mod:note',
    inputs: [
      ...(target ? [] : [{ id: 'user', label: 'Member id (or use /note @name)', style: 'short', required: true, placeholder: 'paste an id' }]),
      { id: 'note', label: 'Note', style: 'paragraph', required: true, placeholder: 'context for the next mod' },
    ],
  }, { spaceId: i.space_id });
});
function saveNote(i, target, text) {
  if (!target || !text) return i.replyEphemeral('A member and a note are required.');
  store.addNote(i.nexus_id, target, text, i.invoker.name);
  modlog(i.nexus_id, { title: '📝 Note added', actor: i.invoker.name, lines: [`<@${target}>`, `> ${text}`] });
  return i.replyEphemeral(say('📝 Note added', `Saved a note on <@${target}>.`, OK));
}
aero.component('mod:note', (i) => saveNote(i, (i.fields?.user || '').trim(), (i.fields?.note || '').trim()));
// A member-scoped custom_id carries the target after the prefix; routed via '*'.

// /notes — list the staff notes on a member.
async function doNotes(i, target, respond) {
  const notes = store.listNotes(i.nexus_id, target);
  if (!notes.length) return respond(say('📝 Notes', `No notes on <@${target}> yet. Add one with /note.`));
  const lines = notes.slice(0, 10).map((n) => `• ${n.note}${n.author ? ` *(by ${n.author})*` : ''}`);
  return respond(say('📝 Notes', `<@${target}>\n\n${lines.join('\n')}`));
}
aero.command('notes', (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const target = i.options?.user;
  if (target) return doNotes(i, target, (m) => i.replyEphemeral(m));
  return i.reply({
    embeds: [{ title: '📝 Notes', description: 'Pick a member to read their staff notes. (tip: `/notes @name`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'mod:notes', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('mod:notes', (i) => doNotes(i, i.values?.[0], (m) => i.update(m)));

// /notes-clear — wipe a member's notes.
memberActionCommand('notes-clear', {
  title: 'Clear notes', prompt: 'Pick the member whose staff notes to clear.',
  run: async (i, t) => { const n = store.clearNotes(i.nexus_id, t); return `Cleared **${n}** note(s) on <@${t}>.`; },
  logTitle: '🗑️ Notes cleared', logColor: OK,
});

// /modstats — a quick moderation summary for this Nexus.
aero.command('modstats', (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  const flags = cfg(i.nexus_id).automod_flags || {};
  const banned = (cfg(i.nexus_id).automod_banned || []).length;
  return i.replyEphemeral(rich({
    title: '🛡️ Moderation status',
    fields: [
      { name: 'AutoMod action', value: String(flags.action || 'warn'), inline: true },
      { name: 'Delete on hit', value: flags.deleteMsg ? 'Yes' : 'No', inline: true },
      { name: 'Banned words', value: String(banned), inline: true },
      { name: 'Spam guard', value: flags.spam ? 'On' : 'Off', inline: true },
      { name: 'Caps guard', value: flags.caps ? 'On' : 'Off', inline: true },
      { name: 'Max mentions', value: String(flags.maxMentions || 0), inline: true },
    ],
    footer: 'Configure with /automod',
  }));
});

// /slowmode-off — clear slowmode on the current space (convenience).
aero.command('slowmode-off', async (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  try { await aero.setSlowmode(i.nexus_id, i.space_id, 0); return i.reply(say('🐢 Slowmode off', 'Slowmode is now disabled in this space.', OK)); }
  catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// /timeout-clear — remove a member's timeout (set to 0 minutes).
memberActionCommand('timeout-clear', {
  title: 'Clear timeout', prompt: 'Pick the member to un-timeout.',
  run: async (i, t) => { await aero.timeoutMember(i.nexus_id, t, 0, `Timeout cleared by ${i.invoker.name}`); return `Removed the timeout on <@${t}>.`; },
  logTitle: '⏰ Timeout cleared', logColor: OK,
});

// /purge-user — bulk-delete this space's recent messages (SDK purge is count
// based; this is a thin, discoverable alias with a clear default).
aero.command('purge-user', (i) => {
  if (!modGate(i)) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  return inlineText(i, async (v) => {
    const n = Math.max(1, Math.min(parseInt(v, 10) || 0, 100));
    try { const r = await aero.purgeMessages(i.nexus_id, i.space_id, n); return i.reply(say('🧹 Purged', `Removed **${r.removed ?? n}** recent message(s).`, WARN_C)); }
    catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
  }, () => aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Purge messages', custom_id: 'mod:purgeuser',
    inputs: [{ id: 'text', label: 'How many (1-100)', style: 'short', required: true, placeholder: '10' }],
  }, { spaceId: i.space_id }));
});
aero.component('mod:purgeuser', async (i) => {
  const n = Math.max(1, Math.min(parseInt(i.fields?.text, 10) || 0, 100));
  try { const r = await aero.purgeMessages(i.nexus_id, i.space_id, n); return i.reply(say('🧹 Purged', `Removed **${r.removed ?? n}** recent message(s).`, WARN_C)); }
  catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// /modhelp — a focused moderator cheat-sheet.
aero.command('modhelp', (i) => i.replyEphemeral(say('🛡️ Moderator commands',
  ['`/warn` `/warnings` `/warnlist` `/unwarn`. warnings',
   '`/timeout` `/tempmute` `/timeout-clear`. timeouts',
   '`/kick` `/ban` `/softban`. removals',
   '`/note` `/notes` `/notes-clear`. staff notes',
   '`/lock` `/unlock` `/slowmode` `/slowmode-off`. spaces',
   '`/purge` `/purge-user`. message cleanup',
   '`/automod` `/automod-words` `/modlog-setup` `/modstats`. automation',
  ].join('\n'))));

// /lock and /unlock the current space.
aero.command('lock', async (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  try {
    await aero.setLockdown(i.nexus_id, i.space_id, true);
    modlog(i.nexus_id, { title: '🔒 Space locked', actor: i.invoker.name, lines: ['This space was locked.'] });
    return i.reply(say('🔒 Locked', 'This space is now locked. Run /unlock to reopen it.', WARN_C));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});
aero.command('unlock', async (i) => {
  if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
  try {
    await aero.setLockdown(i.nexus_id, i.space_id, false);
    modlog(i.nexus_id, { title: '🔓 Space unlocked', actor: i.invoker.name, lines: ['This space was unlocked.'] });
    return i.reply(say('🔓 Unlocked', 'This space is open again.', OK));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// /role-give and /role-take: assign or remove a role, two-step (member, role).
const pendingRoleOp = new Map(); // `${nexus}:${mod}:${op}` -> targetUserId
function roleOpCommand(name, op, verb, logTitle) {
  aero.command(name, (i) => {
    if (!on(i.nexus_id, 'moderation')) return i.replyEphemeral('The Moderation module is off in this Nexus.');
    // Inline: "/role-give @member" jumps straight to the role picker; otherwise
    // pick the member first.
    const target = i.options?.user;
    if (target) {
      pendingRoleOp.set(`${i.nexus_id}:${i.invoker.id}:${op}`, target);
      return roleOpPickRole(i, op, (m) => i.reply(m));
    }
    return i.reply({
      embeds: [{ title: verb, description: `Pick the member to ${op === 'give' ? 'give a role to' : 'take a role from'}. (tip: \`/${name} @name\`)`, color: BRAND }],
      components: [{ components: [{ type: 'select', kind: 'member', custom_id: `roleop:${op}:member`, placeholder: 'Pick a member', min: 1, max: 1 }] }],
    });
  });
}
roleOpCommand('role-give', 'give', 'Give a role', '➕ Role given');
roleOpCommand('role-take', 'take', 'Take a role', '➖ Role taken');
aero.component('roleop:give:member', (i) => { pendingRoleOp.set(`${i.nexus_id}:${i.invoker.id}:give`, i.values?.[0]); return roleOpPickRole(i, 'give', (m) => i.update(m)); });
aero.component('roleop:take:member', (i) => { pendingRoleOp.set(`${i.nexus_id}:${i.invoker.id}:take`, i.values?.[0]); return roleOpPickRole(i, 'take', (m) => i.update(m)); });
function roleOpPickRole(i, op, respond) {
  return respond({
    embeds: [{ title: op === 'give' ? 'Give a role' : 'Take a role', description: 'Now pick the role.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'role', custom_id: `roleop:${op}:role`, placeholder: 'Pick a role', min: 1, max: 1 }] }],
  });
}
aero.component('roleop:give:role', (i) => finishRoleOp(i, 'give'));
aero.component('roleop:take:role', (i) => finishRoleOp(i, 'take'));
async function finishRoleOp(i, op) {
  const target = pendingRoleOp.get(`${i.nexus_id}:${i.invoker.id}:${op}`);
  pendingRoleOp.delete(`${i.nexus_id}:${i.invoker.id}:${op}`);
  if (!target) return i.update(say('Expired', 'That action expired. Run the command again.', WARN_C));
  const roleId = i.values?.[0];
  try {
    if (op === 'give') await aero.assignRole(i.nexus_id, target, roleId);
    else await aero.removeRole(i.nexus_id, target, roleId);
    modlog(i.nexus_id, { title: op === 'give' ? '➕ Role given' : '➖ Role taken', actor: i.invoker.name, lines: [`<@&${roleId}> ${op === 'give' ? 'to' : 'from'} <@${target}>`] });
    return i.update(say(op === 'give' ? '➕ Role given' : '➖ Role taken', `<@&${roleId}> ${op === 'give' ? 'given to' : 'taken from'} <@${target}>.`, OK));
  } catch (e) { return i.update(say('Failed', `❌ ${e.message}`, DANGER_C)); }
}

// ─────────────────────────────────────────────────────────────
// REMINDERS module — /remind sets a personal ping after N minutes.
// Persisted in the store so a restart doesn't lose them; a single sweep
// timer fires the due ones. Works in whatever space the command ran in.
// ─────────────────────────────────────────────────────────────
aero.command('remind', (i) => {
  if (!on(i.nexus_id, 'reminders')) return i.replyEphemeral('The Reminders module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Set a reminder', custom_id: 'remind:set',
    inputs: [
      { id: 'minutes', label: 'In how many minutes?', style: 'short', required: true, placeholder: 'e.g. 30' },
      { id: 'text', label: 'Remind me to…', style: 'paragraph', required: true, placeholder: 'take a break' },
    ],
  }, { spaceId: i.space_id });
});
aero.component('remind:set', (i) => {
  const minutes = parseInt((i.fields?.minutes || '').trim(), 10);
  const text = (i.fields?.text || '').trim();
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 14) return i.replyEphemeral('Give a number of minutes between 1 and 20160 (14 days).');
  if (!text) return i.replyEphemeral('Tell me what to remind you about.');
  const dueAt = Date.now() + minutes * 60_000;
  store.addReminder(i.nexus_id, i.space_id, i.invoker.id, text.slice(0, 500), dueAt);
  return i.replyEphemeral(say('Reminder set ⏰', `I'll ping you in **${minutes} min**: ${text}`, OK));
});

// One sweep for every Nexus — fire due reminders, then delete them.
setInterval(async () => {
  for (const r of store.dueReminders()) {
    try {
      await aero.sendMessage(r.nexus_id, r.space_id, {
        text: `⏰ <@${r.user_id}> reminder:`,
        embeds: [{ description: r.text, color: BRAND }],
      });
    } catch (e) { console.error('[velixar] reminder send failed:', e.message); }
    store.deleteReminder(r.id);
  }
}, 20_000);

// /remindlist — see your pending reminders, with a button to cancel each.
aero.command('remindlist', (i) => {
  if (!on(i.nexus_id, 'reminders')) return i.replyEphemeral('The Reminders module is off in this Nexus.');
  const list = store.userReminders(i.nexus_id, i.invoker.id);
  if (!list.length) return i.replyEphemeral(say('No reminders', 'You have no pending reminders. Set one with /remind.'));
  const body = list.map((r) => {
    const mins = Math.max(0, Math.round((r.due_at - Date.now()) / 60000));
    return `• *${r.text}* · in **${mins}m**`;
  }).join('\n');
  return i.replyEphemeral({
    embeds: [{ title: '⏰ Your reminders', description: body, color: BRAND }],
    components: [{ components: [{ type: 'button', style: 'danger', label: 'Cancel the next one', custom_id: `remind:cancel:${list[0].id}` }] }],
  });
});
function handleRemindCancel(i) {
  const id = i.custom_id.split(':')[2];
  const ok = store.deleteUserReminder(id, i.invoker.id);
  return i.update(say(ok ? 'Cancelled' : 'Not found', ok ? 'That reminder was cancelled.' : "That reminder is already gone.", ok ? OK : WARN_C));
}

// ─────────────────────────────────────────────────────────────
// SUGGESTIONS module — /suggest posts to a configured space with
// up/down vote buttons and a live tally. /suggest-setup picks the space.
// ─────────────────────────────────────────────────────────────
const suggestVotes = new Map(); // messageId -> { up:Set, down:Set }
aero.command('suggest', (i) => {
  if (!on(i.nexus_id, 'suggestions')) return i.replyEphemeral('The Suggestions module is off in this Nexus.');
  if (!cfg(i.nexus_id).suggestions_space) return i.replyEphemeral('No suggestions space set. An admin can set one with /suggest-setup.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Submit a suggestion', custom_id: 'suggest:submit',
    inputs: [{ id: 'idea', label: 'Your suggestion', style: 'paragraph', required: true, placeholder: 'Add a music space…' }],
  }, { spaceId: i.space_id });
});
aero.component('suggest:submit', async (i) => {
  const idea = (i.fields?.idea || '').trim();
  if (!idea) return i.replyEphemeral('Write your suggestion first.');
  const space = cfg(i.nexus_id).suggestions_space;
  if (!space) return i.replyEphemeral('No suggestions space is set up.');
  try {
    await aero.sendMessage(i.nexus_id, space, {
      embeds: [{ title: '💡 New suggestion', description: idea, color: BRAND, footer: { text: `Suggested by ${i.invoker.name}` } }],
      components: [{ components: [
        { type: 'button', style: 'success', label: '👍 0', custom_id: 'suggest:up' },
        { type: 'button', style: 'danger', label: '👎 0', custom_id: 'suggest:down' },
      ] }],
    });
    return i.replyEphemeral('✅ Suggestion posted. Thanks!');
  } catch (e) { return i.replyEphemeral(`❌ Could not post it: ${e.message}`); }
});
const suggestVote = (i, dir) => {
  const box = suggestVotes.get(i.message_id) || { up: new Set(), down: new Set() };
  box.up.delete(i.invoker.id); box.down.delete(i.invoker.id);
  box[dir].add(i.invoker.id);
  suggestVotes.set(i.message_id, box);
  return i.update({
    // Keep the original embed by re-sending a compact version with the tally.
    components: [{ components: [
      { type: 'button', style: 'success', label: `👍 ${box.up.size}`, custom_id: 'suggest:up' },
      { type: 'button', style: 'danger', label: `👎 ${box.down.size}`, custom_id: 'suggest:down' },
    ] }],
  });
};
aero.component('suggest:up', (i) => suggestVote(i, 'up'));
aero.component('suggest:down', (i) => suggestVote(i, 'down'));

// ─────────────────────────────────────────────────────────────
// GIVEAWAYS module — /giveaway posts an embed with an Enter button;
// after N minutes a timer picks winners, announces them, and locks the
// button. Entrants + timing are persisted so a restart still resolves.
// ─────────────────────────────────────────────────────────────
aero.command('giveaway', (i) => {
  if (!on(i.nexus_id, 'giveaways')) return i.replyEphemeral('The Giveaways module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Start a giveaway', custom_id: 'giveaway:create',
    inputs: [
      { id: 'prize', label: 'Prize', style: 'short', required: true, placeholder: 'Aether, a role, bragging rights…' },
      { id: 'minutes', label: 'Runs for (minutes)', style: 'short', required: true, placeholder: '10' },
      { id: 'winners', label: 'Number of winners', style: 'short', required: false, placeholder: '1' },
    ],
  }, { spaceId: i.space_id });
});
aero.component('giveaway:create', async (i) => {
  const prize = (i.fields?.prize || '').trim();
  const minutes = parseInt((i.fields?.minutes || '').trim(), 10);
  const winners = Math.max(1, parseInt((i.fields?.winners || '1').trim(), 10) || 1);
  if (!prize) return i.replyEphemeral('Give the giveaway a prize.');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60 * 24 * 7) return i.replyEphemeral('Duration must be 1 to 10080 minutes (7 days).');
  const endsAt = Date.now() + minutes * 60_000;
  try {
    const { message } = await aero.sendMessage(i.nexus_id, i.space_id, giveawayEmbed(prize, winners, endsAt, 0));
    const messageId = message?.id;
    if (!messageId) return i.replyEphemeral('Posted, but could not track entries (no message id).');
    store.createGiveaway({ message_id: String(messageId), nexus_id: i.nexus_id, space_id: i.space_id, prize, winners, ends_at: endsAt, entrants: [] });
    scheduleGiveaway(String(messageId), endsAt - Date.now());
    return i.replyEphemeral(`🎉 Giveaway for **${prize}** started for ${minutes} min.`);
  } catch (e) { return i.replyEphemeral(`❌ Could not start it: ${e.message}`); }
});
function giveawayEmbed(prize, winners, endsAt, count, endedText) {
  return {
    embeds: [{
      title: '🎉 Giveaway',
      description: endedText || `**Prize:** ${prize}\n**Winners:** ${winners}\n**Entries:** ${count}\n\nPress **Enter** below to join!`,
      color: endedText ? '#6B7280' : BRAND,
      footer: { text: endedText ? 'Giveaway ended' : `Ends at ${new Date(endsAt).toLocaleTimeString()}` },
    }],
    components: endedText ? [] : [{ components: [{ type: 'button', style: 'primary', label: `Enter (${count})`, custom_id: 'giveaway:enter' }] }],
  };
}
aero.component('giveaway:enter', (i) => {
  const g = store.getGiveaway(i.message_id);
  if (!g || g.ended) return i.replyEphemeral('This giveaway has ended.');
  // Entrants are { id, name } so the winner line always reads well, even if the
  // roster can't resolve the mention for some reason.
  if (g.entrants.some((e) => e.id === i.invoker.id)) return i.replyEphemeral('You are already entered. Good luck! 🍀');
  const entrants = [...g.entrants, { id: i.invoker.id, name: i.invoker.name }];
  store.setGiveawayEntrants(i.message_id, entrants);
  return i.update(giveawayEmbed(g.prize, g.winners, g.ends_at, entrants.length));
});
function scheduleGiveaway(messageId, ms) {
  setTimeout(() => resolveGiveaway(messageId).catch((e) => console.error('[velixar] giveaway resolve failed:', e.message)), Math.max(0, ms));
}
// `<@id>` renders as a real mention pill AND pings; the bold name is a
// belt-and-suspenders fallback so the winner is always legible.
const winnerTag = (e) => `<@${e.id}> (**${e.name}**)`;
async function resolveGiveaway(messageId) {
  const g = store.getGiveaway(messageId);
  if (!g || g.ended) return;
  store.endGiveaway(messageId);
  const pool = [...g.entrants];
  const picked = [];
  while (picked.length < g.winners && pool.length) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const result = picked.length
    ? `**Prize:** ${g.prize}\n**Winner${picked.length > 1 ? 's' : ''}:** ${picked.map(winnerTag).join(', ')}\n**Entries:** ${g.entrants.length}\n\nCongratulations! 🎉`
    : `**Prize:** ${g.prize}\n\nNo one entered. 😔`;
  // Edit the original message to its ended state, then ping the winners with a
  // clear, name-first announcement.
  await aero.editMessage(g.nexus_id, g.space_id, messageId, giveawayEmbed(g.prize, g.winners, g.ends_at, g.entrants.length, result)).catch(() => {});
  if (picked.length) {
    await aero.sendMessage(g.nexus_id, g.space_id, {
      text: picked.map((e) => `<@${e.id}>`).join(' '),
      embeds: [{
        title: '🎉 We have a winner!',
        description: `${picked.map((e) => `🏆 **${e.name}** · ${`<@${e.id}>`}`).join('\n')}\n\nYou won **${g.prize}**! 🥳`,
        color: OK,
      }],
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// TICKETS module — a full ticket tool: a customisable panel, a
// category picker, a private Space per ticket with a staff ping,
// a close button, and one-open-ticket-per-user.
// ─────────────────────────────────────────────────────────────
const catValue = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'general';

// The panel: an embed the OWNER customised via /ticket-setup for THIS Nexus,
// with either a single "Open a ticket" button or a reason dropdown.
function ticketPanel(nexusId) {
  const t = cfg(nexusId);
  const embed = { title: `🎫 ${t.ticket_title}`, description: t.ticket_desc, color: t.ticket_color };
  const cats = t.ticket_categories || [];
  const row = cats.length > 1
    ? { components: [{
        type: 'select', kind: 'string', custom_id: 'ticket:pick', placeholder: 'Choose a topic to open a ticket',
        options: cats.map((c) => ({ label: c, value: catValue(c), description: `Open a ${c} ticket` })),
      }] }
    : { components: [{ type: 'button', style: 'primary', label: t.ticket_button, custom_id: 'ticket:open' }] };
  return { embeds: [embed], components: [row] };
}

aero.command('panel', (i) => {
  if (!on(i.nexus_id, 'tickets')) return i.replyEphemeral('The Tickets module is off in this Nexus.');
  return i.reply(ticketPanel(i.nexus_id));
});

// Open a ticket. `topic` is the human label shown inside the ticket. Config +
// the open-ticket guard both come from Velixar's store, per Nexus.
async function openTicket(i, topic) {
  if (!on(i.nexus_id, 'tickets')) return i.replyEphemeral('Tickets are off right now.');
  if (store.openTicketOf(i.nexus_id, i.invoker.id)) {
    return i.replyEphemeral('You already have an open ticket. Please use it, or close it first.');
  }
  const t = cfg(i.nexus_id);
  try {
    // Keep all tickets tidy under one "Tickets" category (created once per
    // Nexus, then reused) instead of scattering them in the default group.
    let categoryId = t.ticket_category_id;
    if (!categoryId) {
      try {
        const { category } = await aero.createCategory(i.nexus_id, 'Tickets');
        categoryId = category?.id ?? null;
        if (categoryId) store.setConfig(i.nexus_id, { ticket_category_id: categoryId });
      } catch { /* no manage_categories grant — fall back to no category */ }
    }
    const stamp = Date.now().toString(36).slice(-4);
    const { space } = await aero.createSpace(i.nexus_id, {
      name: `ticket-${i.invoker.name}-${stamp}`.toLowerCase().slice(0, 30),
      private: true,
      description: topic ? `Ticket: ${topic}` : 'Support ticket',
      categoryId: categoryId ?? undefined,
    });
    await aero.addSpaceMember(i.nexus_id, space.id, i.invoker.id);
    store.recordTicket(i.nexus_id, i.invoker.id, space.id);

    const ping = t.ticket_staff_role ? `<@&${t.ticket_staff_role}> ` : '';
    await aero.sendMessage(i.nexus_id, space.id, {
      text: `${ping}New ticket from <@${i.invoker.id}>`,
      embeds: [{
        title: topic ? `🎫 ${topic}` : '🎫 Support ticket',
        description: `Hi ${i.invoker.name}, describe your issue in detail and staff will help. Use the button below to close this ticket when you are done.`,
        color: t.ticket_color,
      }],
      components: [{ components: [{ type: 'button', style: 'danger', label: 'Close ticket', custom_id: 'ticket:close' }] }],
    });
    return i.replyEphemeral(`✅ Your ticket is open: **${space.name}**.`);
  } catch (e) { return i.replyEphemeral(`❌ Could not open a ticket: ${e.message}`); }
}

aero.component('ticket:open', (i) => openTicket(i, null));
aero.component('ticket:pick', (i) => {
  const val = i.values?.[0];
  const label = (cfg(i.nexus_id).ticket_categories || []).find((c) => catValue(c) === val) || val;
  return openTicket(i, label);
});

// Close: lock the space, drop the opener, clear the guard (all persisted).
aero.component('ticket:close', async (i) => {
  const spaceId = i.space_id;
  const owner = store.ticketOwnerOf(spaceId);
  try {
    await aero.sendMessage(i.nexus_id, spaceId, say('Ticket closed', `Closed by ${i.invoker.name}. This space is now locked.`, '#EF4444')).catch(() => {});
    await aero.setLockdown(i.nexus_id, spaceId, true).catch(() => {});
    if (owner) {
      store.clearTicket(owner.nexus_id, owner.user_id);
      await aero.removeSpaceMember(i.nexus_id, spaceId, owner.user_id).catch(() => {});
    }
    return i.replyEphemeral('✅ Ticket closed.');
  } catch (e) { return i.replyEphemeral(`❌ Could not close: ${e.message}`); }
});

// ─────────────────────────────────────────────────────────────
// SETUP — per-Nexus configuration. Each Nexus owner runs these to
// configure Velixar for THEIR Nexus; nothing is hard-coded or global.
// (Grant "Manage nexus" or run as owner — the runtime API still enforces
//  every action, so a non-privileged member can't actually apply harmful
//  config through these.)
// ─────────────────────────────────────────────────────────────

// /ticket-setup — a form to customise this Nexus's ticket panel.
aero.command('ticket-setup', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Ticket setup',
  custom_id: 'setup:ticket',
  inputs: [
    { id: 'title', label: 'Panel title', style: 'short', required: false, placeholder: cfg(i.nexus_id).ticket_title },
    { id: 'desc', label: 'Panel description', style: 'paragraph', required: false, placeholder: cfg(i.nexus_id).ticket_desc },
    { id: 'button', label: 'Button label', style: 'short', required: false, placeholder: cfg(i.nexus_id).ticket_button },
    { id: 'color', label: 'Accent color (hex, e.g. #5865F2)', style: 'short', required: false, placeholder: cfg(i.nexus_id).ticket_color },
    { id: 'categories', label: 'Topics (comma-separated, blank = one button)', style: 'short', required: false, placeholder: (cfg(i.nexus_id).ticket_categories || []).join(', ') },
  ],
}, { spaceId: i.space_id }));
aero.component('setup:ticket', (i) => {
  const f = i.fields || {};
  const patch = {};
  if (f.title?.trim()) patch.ticket_title = f.title.trim();
  if (f.desc?.trim()) patch.ticket_desc = f.desc.trim();
  if (f.button?.trim()) patch.ticket_button = f.button.trim();
  if (f.color?.trim() && /^#?[0-9a-fA-F]{6}$/.test(f.color.trim())) patch.ticket_color = f.color.trim().startsWith('#') ? f.color.trim() : `#${f.color.trim()}`;
  if (f.categories !== undefined) patch.ticket_categories = f.categories.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  store.setConfig(i.nexus_id, patch);
  return i.replyEphemeral('✅ Ticket panel saved. Run /panel to post it.');
});

// /ticket-staff — pick the staff role added + pinged in each ticket.
aero.command('ticket-staff', (i) => i.reply({
  embeds: [{ title: 'Ticket staff role', description: 'Pick the role to ping in new tickets.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'role', custom_id: 'setup:ticketstaff', placeholder: 'Pick a role', min: 1, max: 1 }] }],
}));
aero.component('setup:ticketstaff', (i) => {
  store.setConfig(i.nexus_id, { ticket_staff_role: i.values?.[0] || null });
  return i.update(say('Saved', 'Staff role set for tickets.', OK));
});

// /welcome-setup — pick the space to greet new members in.
aero.command('welcome-setup', (i) => i.reply({
  embeds: [{ title: 'Welcome space', description: 'Pick the space where new members are greeted.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'space', custom_id: 'setup:welcome', placeholder: 'Pick a space', min: 1, max: 1 }] }],
}));
aero.component('setup:welcome', (i) => {
  store.setConfig(i.nexus_id, { welcome_space: i.values?.[0] || null });
  return i.update(say('Saved', 'New members will be greeted there.', OK));
});

// /suggest-setup — pick the space where /suggest posts land.
aero.command('suggest-setup', (i) => i.reply({
  embeds: [{ title: 'Suggestions space', description: 'Pick the space where suggestions are posted.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'space', custom_id: 'setup:suggest', placeholder: 'Pick a space', min: 1, max: 1 }] }],
}));
aero.component('setup:suggest', (i) => {
  store.setConfig(i.nexus_id, { suggestions_space: i.values?.[0] || null });
  return i.update(say('Saved', 'Suggestions will be posted there.', OK));
});

// ─────────────────────────────────────────────────────────────
// LOGGING module — /modlog-setup picks the audit space. Mod actions,
// joins and leaves are then recorded there via modlog() above.
// ─────────────────────────────────────────────────────────────
aero.command('modlog-setup', (i) => i.reply({
  embeds: [{ title: 'Mod-log space', description: 'Pick the space where moderation + join/leave logs are posted.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'space', custom_id: 'setup:modlog', placeholder: 'Pick a space', min: 1, max: 1 }] }],
}));
aero.component('setup:modlog', (i) => {
  store.setConfig(i.nexus_id, { modlog_space: i.values?.[0] || null });
  return i.update(say('Saved', 'Logs will be posted there. Turn on the Logging module to activate.', OK));
});

// ─────────────────────────────────────────────────────────────
// AUTOMOD module — configurable filters. /automod shows + toggles the
// switches; /automod-words manages the banned-word list.
// ─────────────────────────────────────────────────────────────
const ACTION_LABELS = { warn: 'Warn (auto-escalate)', mute: 'Timeout 10m', kick: 'Kick', ban: 'Ban' };
const ACTION_CYCLE = ['warn', 'mute', 'kick', 'ban'];
function automodPanel(nexusId) {
  const f = cfg(nexusId).automod_flags || {};
  const words = cfg(nexusId).automod_banned || [];
  const action = f.action || 'warn';
  return {
    embeds: [{
      title: '🤖 AutoMod',
      description: [
        `**Spam guard:** ${f.spam ? '✅ on' : '❌ off'}`,
        `**Caps guard:** ${f.caps ? '✅ on' : '❌ off'}`,
        `**Max mentions:** ${f.maxMentions > 0 ? f.maxMentions : 'off'}`,
        `**Banned words:** ${words.length} (set with /automod-words)`,
        '',
        `**On a violation:** ${f.deleteMsg !== false ? 'delete message + ' : ''}**${ACTION_LABELS[action]}**`,
        '',
        'Tap a guard to toggle it. Cycle the punishment and the delete toggle below. Every action is posted to the mod-log.',
      ].join('\n'),
      color: BRAND,
    }],
    components: [
      { components: [
        { type: 'button', style: f.spam ? 'success' : 'secondary', label: 'Spam guard', custom_id: 'am:spam' },
        { type: 'button', style: f.caps ? 'success' : 'secondary', label: 'Caps guard', custom_id: 'am:caps' },
        { type: 'button', style: 'secondary', label: 'Mentions +', custom_id: 'am:mentions' },
      ] },
      { components: [
        { type: 'button', style: 'primary', label: `Punish: ${ACTION_LABELS[action]}`, custom_id: 'am:action' },
        { type: 'button', style: f.deleteMsg !== false ? 'success' : 'secondary', label: `Delete msg: ${f.deleteMsg !== false ? 'on' : 'off'}`, custom_id: 'am:delete' },
      ] },
    ],
  };
}
aero.command('automod', (i) => {
  if (!on(i.nexus_id, 'automod')) return i.replyEphemeral('The AutoMod module is off in this Nexus. Turn it on in settings, then run this again.');
  return i.reply(automodPanel(i.nexus_id));
});
const setFlags = (i, patch) => {
  const f = { ...(cfg(i.nexus_id).automod_flags || {}), ...patch };
  store.setConfig(i.nexus_id, { automod_flags: f });
  return i.update(automodPanel(i.nexus_id));
};
aero.component('am:spam', (i) => setFlags(i, { spam: !(cfg(i.nexus_id).automod_flags || {}).spam }));
aero.component('am:caps', (i) => setFlags(i, { caps: !(cfg(i.nexus_id).automod_flags || {}).caps }));
aero.component('am:mentions', (i) => setFlags(i, { maxMentions: (((cfg(i.nexus_id).automod_flags || {}).maxMentions || 0) + 1) % 7 }));
aero.component('am:delete', (i) => setFlags(i, { deleteMsg: !((cfg(i.nexus_id).automod_flags || {}).deleteMsg !== false) }));
aero.component('am:action', (i) => {
  const cur = (cfg(i.nexus_id).automod_flags || {}).action || 'warn';
  const next = ACTION_CYCLE[(ACTION_CYCLE.indexOf(cur) + 1) % ACTION_CYCLE.length];
  return setFlags(i, { action: next });
});
aero.command('automod-words', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Banned words', custom_id: 'am:words',
  inputs: [{ id: 'words', label: 'Comma-separated (replaces the list)', style: 'paragraph', required: false, placeholder: (cfg(i.nexus_id).automod_banned || []).join(', ') }],
}, { spaceId: i.space_id }));
aero.component('am:words', (i) => {
  const words = (i.fields?.words || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  store.setConfig(i.nexus_id, { automod_banned: words });
  return i.replyEphemeral(say('Saved', words.length ? `Now filtering **${words.length}** word(s).` : 'Banned-word list cleared.', OK));
});

// ─────────────────────────────────────────────────────────────
// REACTION ROLES module — /rr-add builds a set, /rr-panel posts a
// button panel where a click toggles the role on the presser.
// ─────────────────────────────────────────────────────────────
const pendingRR = new Map(); // `${nexus}:${admin}` -> { label, emoji }
aero.command('rr-add', (i) => {
  if (!on(i.nexus_id, 'reactionroles')) return i.replyEphemeral('The Reaction Roles module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Reaction role', custom_id: 'rr:label',
    inputs: [
      { id: 'label', label: 'Button label', style: 'short', required: true, placeholder: 'e.g. Gamer' },
      { id: 'emoji', label: 'Emoji (optional)', style: 'short', required: false, placeholder: '🎮' },
    ],
  }, { spaceId: i.space_id });
});
aero.component('rr:label', (i) => {
  pendingRR.set(`${i.nexus_id}:${i.invoker.id}`, { label: (i.fields?.label || 'Role').trim().slice(0, 40), emoji: (i.fields?.emoji || '').trim().slice(0, 8) });
  return i.reply({
    embeds: [{ title: 'Pick the role', description: 'Choose the role this button grants.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'role', custom_id: 'rr:pick', placeholder: 'Pick a role', min: 1, max: 1 }] }],
  });
});
aero.component('rr:pick', (i) => {
  const p = pendingRR.get(`${i.nexus_id}:${i.invoker.id}`) || { label: 'Role', emoji: '' };
  pendingRR.delete(`${i.nexus_id}:${i.invoker.id}`);
  const roleId = i.values?.[0];
  const list = (cfg(i.nexus_id).reaction_roles || []).filter((r) => r.role_id !== roleId);
  list.push({ label: p.label, emoji: p.emoji, role_id: roleId });
  store.setConfig(i.nexus_id, { reaction_roles: list.slice(0, 20) });
  return i.update(say('Added', `**${p.emoji ? p.emoji + ' ' : ''}${p.label}** → <@&${roleId}>. Post the panel with /rr-panel.`, OK));
});
aero.command('rr-clear', (i) => {
  store.setConfig(i.nexus_id, { reaction_roles: [] });
  return i.replyEphemeral('✅ Cleared the reaction-role buttons.');
});
function rrPanel(nexusId) {
  const list = cfg(nexusId).reaction_roles || [];
  if (!list.length) return null;
  // Buttons carry the role id in their custom_id, so the click handler is
  // stateless. Up to 5 buttons per row.
  const rows = [];
  for (let n = 0; n < list.length; n += 5) {
    rows.push({ components: list.slice(n, n + 5).map((r) => ({
      type: 'button', style: 'secondary',
      label: `${r.emoji ? r.emoji + ' ' : ''}${r.label}`,
      custom_id: `rr:toggle:${r.role_id}`,
    })) });
  }
  return {
    embeds: [{ title: '🎭 Pick your roles', description: 'Tap a button to add a role, tap again to remove it.', color: BRAND }],
    components: rows,
  };
}
aero.command('rr-panel', (i) => {
  if (!on(i.nexus_id, 'reactionroles')) return i.replyEphemeral('The Reaction Roles module is off in this Nexus.');
  const panel = rrPanel(i.nexus_id);
  return panel ? i.reply(panel) : i.replyEphemeral('No reaction roles set up yet. Add some with /rr-add.');
});
// Track who holds which button-role in memory so a second tap removes it. (The
// grant itself is server-authoritative; this just decides add vs remove.)
// The custom_id encodes the role id (`rr:toggle:<roleId>`); since the SDK maps
// component handlers by EXACT custom_id, dynamic ids are caught by the `'*'`
// wildcard handler and dispatched here by prefix.
const rrHeld = new Set(); // `${nexus}:${user}:${role}`
async function handleReactionRoleToggle(i) {
  if (!on(i.nexus_id, 'reactionroles')) return i.replyEphemeral('Reaction roles are off right now.');
  const roleId = i.custom_id.split(':')[2];
  const key = `${i.nexus_id}:${i.invoker.id}:${roleId}`;
  try {
    if (rrHeld.has(key)) {
      await aero.removeRole(i.nexus_id, i.invoker.id, roleId);
      rrHeld.delete(key);
      return i.replyEphemeral('➖ Role removed.');
    }
    await aero.assignRole(i.nexus_id, i.invoker.id, roleId);
    rrHeld.add(key);
    return i.replyEphemeral('➕ Role added.');
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
// Wildcard: the SDK maps component handlers by exact custom_id, so every
// dynamic id (role id / reminder id baked in) is routed here by prefix.
aero.component('*', (i) => {
  const id = typeof i.custom_id === 'string' ? i.custom_id : '';
  if (id.startsWith('rr:toggle:')) return handleReactionRoleToggle(i);
  if (id.startsWith('remind:cancel:')) return handleRemindCancel(i);
  if (id.startsWith('pm:')) return handleMultiVote(i);
  if (id.startsWith('guess:')) return handleGuess(i);
  if (id.startsWith('trivia:')) return handleTrivia(i);
  if (id.startsWith('ttt:') && /^ttt:\d+$/.test(id)) return handleTtt(i);
  if (id.startsWith('hang:')) return handleHangman(i);
  if (id.startsWith('c4:') && /^c4:\d+$/.test(id)) return handleC4(i);
  if (id.startsWith('scramble:submit:')) return handleScrambleSubmit(i);
  // A /note run with an inline @member carries the target in the modal id.
  if (id.startsWith('mod:note:')) return saveNote(i, id.slice('mod:note:'.length), (i.fields?.note || '').trim());
  if (id.startsWith('roul:')) return handleRoulette(i);
  if (id.startsWith('dbet:')) return handleDiceBet(i);
  if (id === 'hl:high' || id === 'hl:low') return handleHL(i);
  if (id.startsWith('rpsl:')) return handleRpsl(i);
  if (id === 'cs:flip') return handleCoinStreak(i);
  if (id.startsWith('rt:')) return handleReactionTest(i);
  if (id === 'page:next') return handlePage(i, 'next');
  if (id === 'page:prev') return handlePage(i, 'prev');
  if (id === 'page:none') return i.replyEphemeral(' ');
  return undefined; // not ours — ignore
});

// ─────────────────────────────────────────────────────────────
// ANNOUNCE + EMBED — /announce posts a plain rich announcement to the
// current space; /embed builds a titled embed with an optional colour
// and image. Both admin-gated.
// ─────────────────────────────────────────────────────────────
// Both /announce and /embed build their embed, then show a PRIVATE preview with
// Post / Discard buttons — nothing hits the space until the author confirms, so
// a typo never goes public. The pending embed + target space are held per
// author until they act on it.
const pendingPost = new Map(); // `${nexus}:${user}` -> { embed, spaceId }
function previewReply(i, embed) {
  pendingPost.set(`${i.nexus_id}:${i.invoker.id}`, { embed, spaceId: i.space_id });
  return i.replyEphemeral({
    embeds: [embed],
    components: [{ components: [
      { type: 'button', style: 'success', label: 'Post it', custom_id: 'post:confirm' },
      { type: 'button', style: 'secondary', label: 'Discard', custom_id: 'post:discard' },
    ] }],
  });
}
aero.component('post:confirm', async (i) => {
  const key = `${i.nexus_id}:${i.invoker.id}`;
  const pending = pendingPost.get(key);
  if (!pending) return i.update(say('Expired', 'That preview expired. Run the command again.', WARN_C));
  pendingPost.delete(key);
  try {
    await aero.sendMessage(i.nexus_id, pending.spaceId, { embeds: [pending.embed] });
    return i.update(say('Posted', '✅ Your message is now live in the space.', OK));
  } catch (e) { return i.update(say('Failed', `❌ ${e.message}`, DANGER_C)); }
});
aero.component('post:discard', (i) => {
  pendingPost.delete(`${i.nexus_id}:${i.invoker.id}`);
  return i.update(say('Discarded', 'Nothing was posted.', WARN_C));
});

aero.command('announce', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Announcement', custom_id: 'post:announce',
  inputs: [
    { id: 'title', label: 'Title', style: 'short', required: true, placeholder: 'Nexus update' },
    { id: 'body', label: 'Message', style: 'paragraph', required: true, placeholder: 'What do you want to announce?' },
  ],
}, { spaceId: i.space_id }));
aero.component('post:announce', (i) => {
  const title = (i.fields?.title || '').trim();
  const body = (i.fields?.body || '').trim();
  if (!title || !body) return i.replyEphemeral('Both a title and a message are required.');
  return previewReply(i, { title: `📢 ${title}`, description: body, color: BRAND });
});
aero.command('embed', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Build an embed', custom_id: 'post:embed',
  inputs: [
    { id: 'title', label: 'Title', style: 'short', required: false, placeholder: 'Optional' },
    { id: 'body', label: 'Description', style: 'paragraph', required: true, placeholder: 'Supports **markdown**' },
    { id: 'color', label: 'Colour (hex)', style: 'short', required: false, placeholder: '#5865F2' },
    { id: 'image', label: 'Image URL', style: 'short', required: false, placeholder: 'https://…' },
  ],
}, { spaceId: i.space_id }));
aero.component('post:embed', (i) => {
  const f = i.fields || {};
  const body = (f.body || '').trim();
  if (!body) return i.replyEphemeral('An embed needs at least a description.');
  const color = /^#?[0-9a-fA-F]{6}$/.test((f.color || '').trim())
    ? (f.color.trim().startsWith('#') ? f.color.trim() : `#${f.color.trim()}`)
    : BRAND;
  const embed = { description: body, color };
  if (f.title?.trim()) embed.title = f.title.trim();
  if (/^https?:\/\//.test((f.image || '').trim())) embed.image = { url: f.image.trim() };
  return previewReply(i, embed);
});

// /slowmode — set a space's slow mode (admin). 0 turns it off.
async function doSlowmode(i, secondsRaw) {
  const seconds = parseInt(String(secondsRaw).trim(), 10);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 21600) return i.replyEphemeral('Enter 0 to 21600 seconds, e.g. `/slowmode 10`.');
  try {
    await aero.setSlowmode(i.nexus_id, i.space_id, seconds);
    return i.replyEphemeral(seconds ? `🐢 Slow mode set to ${seconds}s here.` : '✅ Slow mode turned off here.');
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
}
aero.command('slowmode', (i) => inlineText(i, (v) => doSlowmode(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Slow mode', custom_id: 'setup:slowmode',
  inputs: [{ id: 'seconds', label: 'Seconds between messages (0 = off)', style: 'short', required: true, placeholder: 'e.g. 10' }],
}, { spaceId: i.space_id })));
aero.component('setup:slowmode', (i) => doSlowmode(i, i.fields?.seconds || ''));

// /invite — create a fresh invite link for this Nexus (admin).
aero.command('invite', async (i) => {
  try {
    const { invite } = await aero.createInvite(i.nexus_id, { expiresInDays: 7, maxUses: 0 });
    const code = invite?.code || invite?.id;
    return i.replyEphemeral(say('Invite created', code ? `Share this code: **${code}** (valid 7 days).` : 'Invite created.', OK));
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// /roles-remove — take a self-assign role back off yourself.
aero.command('roles-remove', (i) => {
  if (!on(i.nexus_id, 'roles')) return i.replyEphemeral('The Roles module is off in this Nexus.');
  const roles = cfg(i.nexus_id).self_roles;
  if (!roles.length) return i.replyEphemeral('No self-assign roles are set up.');
  return i.replyEphemeral({
    embeds: [{ title: 'Remove a role', description: 'Pick a role to remove from yourself.', color: BRAND }],
    components: [{ components: [{
      type: 'select', kind: 'string', custom_id: 'roles:unpick', placeholder: 'Select a role to remove', min: 1, max: 1,
      options: roles.map((r) => ({ label: r.label, value: r.value })),
    }] }],
  });
});
aero.component('roles:unpick', async (i) => {
  try {
    await aero.removeRole(i.nexus_id, i.invoker.id, i.values?.[0]);
    return i.replyEphemeral('✅ Role removed.');
  } catch (e) { return i.replyEphemeral(`❌ ${e.message}`); }
});

// /roles-add — add a self-assign role to the /roles menu (label via modal, role
// via a follow-up picker keyed by the label the admin just typed).
const pendingRoleLabel = new Map(); // `${nexus}:${user}` -> label
aero.command('roles-add', (i) => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Add a self-assign role',
  custom_id: 'setup:rolelabel',
  inputs: [{ id: 'label', label: 'Label shown in the menu', style: 'short', required: true, placeholder: 'e.g. Gamer' }],
}, { spaceId: i.space_id }));
aero.component('setup:rolelabel', (i) => {
  pendingRoleLabel.set(`${i.nexus_id}:${i.invoker.id}`, (i.fields?.label || '').trim().slice(0, 40) || 'Role');
  return i.reply({
    embeds: [{ title: 'Pick the role', description: 'Choose which role this menu option assigns.', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'role', custom_id: 'setup:rolepick', placeholder: 'Pick a role', min: 1, max: 1 }] }],
  });
});
aero.component('setup:rolepick', (i) => {
  const label = pendingRoleLabel.get(`${i.nexus_id}:${i.invoker.id}`) || 'Role';
  pendingRoleLabel.delete(`${i.nexus_id}:${i.invoker.id}`);
  const roleId = i.values?.[0];
  const roles = cfg(i.nexus_id).self_roles.filter((r) => r.value !== roleId);
  roles.push({ label, value: roleId });
  store.setConfig(i.nexus_id, { self_roles: roles.slice(0, 25) });
  return i.update(say('Role added', `Added **${label}** to the /roles menu.`, OK));
});

// /roles-clear — wipe this Nexus's self-assign roles.
aero.command('roles-clear', (i) => {
  store.setConfig(i.nexus_id, { self_roles: [] });
  return i.replyEphemeral('✅ Cleared the self-assign roles.');
});

// /config — show what's configured for this Nexus.
aero.command('config', (i) => {
  const t = cfg(i.nexus_id);
  return i.replyEphemeral(say('Velixar config', [
    `**Welcome space:** ${t.welcome_space ? `set` : 'not set (/welcome-setup)'}`,
    `**Ticket panel:** ${t.ticket_title}`,
    `**Ticket topics:** ${(t.ticket_categories || []).join(', ') || 'single button'}`,
    `**Ticket staff role:** ${t.ticket_staff_role ? 'set' : 'not set (/ticket-staff)'}`,
    `**Self-assign roles:** ${t.self_roles.length ? t.self_roles.map((r) => r.label).join(', ') : 'none (/roles-add)'}`,
  ].join('\n')));
});

// /userinfo — pick a member, see their public stats (XP/level + warnings if
// the Levels/Moderation modules are on). Open to everyone.
async function doUserinfo(i, target, respond) {
  const lines = [];
  if (on(i.nexus_id, 'levels')) {
    const pts = store.getXp(i.nexus_id, target);
    lines.push(`**Level:** ${levelFor(pts)} · **${pts}** XP`);
    const d = store.getDaily(i.nexus_id, target);
    if (d.streak > 0) lines.push(`**Daily streak:** 🔥 ${d.streak}`);
  }
  if (on(i.nexus_id, 'moderation')) {
    try { const { count } = await aero.getWarnings(i.nexus_id, target); lines.push(`**Warnings:** ${count || 0}`); } catch { /* ignore */ }
  }
  const afk = on(i.nexus_id, 'afk') ? store.getAfk(i.nexus_id, target) : null;
  if (afk) lines.push(`**AFK:** *${afk.reason}*`);
  return respond(say('👤 Member info', `<@${target}>\n\n${lines.join('\n') || 'No stats to show (modules are off).'}`));
}
aero.command('userinfo', (i) => {
  const target = i.options?.user;
  if (target) return doUserinfo(i, target, (m) => i.reply(m));
  return i.reply({
    embeds: [{ title: 'Member info', description: 'Pick a member to look up. (tip: `/userinfo @name`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'info:user', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('info:user', (i) => doUserinfo(i, i.values?.[0], (m) => i.update(m)));

// /nexusstats — a quick Velixar summary for this Nexus.
aero.command('nexusstats', (i) => {
  const xp = store.xpStats(i.nexus_id);
  const top = store.topXp(i.nexus_id, 1)[0];
  const g = on(i.nexus_id, 'counting') ? store.getCounting(i.nexus_id) : null;
  const lines = [
    `**Members with XP:** ${xp.members}`,
    `**Total XP tracked:** ${xp.total}`,
    top ? `**Top member:** <@${top.user_id}> (${top.points} XP)` : null,
    `**Open tickets:** ${store.openTicketCount(i.nexus_id)}`,
    `**Active giveaways:** ${store.activeGiveawayCount(i.nexus_id)}`,
    g && g.space_id ? `**Counting:** at ${g.current} (best ${g.best})` : null,
  ].filter(Boolean);
  return i.replyEphemeral(say('📊 Nexus stats', lines.join('\n')));
});

// ─────────────────────────────────────────────────────────────
// Always-on utility
// ─────────────────────────────────────────────────────────────
const START_TS = Date.now();
function humanDuration(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s % 60}s`].filter(Boolean).join(' ');
}

aero.command('ping', (i) => i.replyEphemeral(say('🏓 Pong', 'Velixar is online and responding.', OK)));

aero.command('uptime', (i) => i.replyEphemeral(say('⏱️ Uptime', `Velixar has been running for **${humanDuration(Date.now() - START_TS)}**.`)));

aero.command('aeroinfo', (i) => i.replyEphemeral({
  embeds: [{
    title: `About ${aero.aero.name}`,
    description: [
      'An all-in-one Ballastra Aero built on the public SDK.',
      '',
      `**Installed in:** ${aero.installations.length} Nexus(es)`,
      `**Uptime:** ${humanDuration(Date.now() - START_TS)}`,
      '**Commands:** run /help to see them all',
    ].join('\n'),
    color: BRAND,
  }],
}));
aero.command('about', (i) => i.replyEphemeral(say('Velixar', 'The all-in-one Aero for your Nexus: levels, moderation, tickets, giveaways, fun and more. Run /help to explore. Every feature is a module you toggle in Nexus settings.', BRAND)));

// /math evaluates a simple arithmetic expression (numbers and + - * / ( ) only).
const doMath = (i, raw) => {
  const expr = (raw || '').trim();
  if (!/^[0-9+\-*/(). %]+$/.test(expr)) return i.replyEphemeral('Only numbers and + - * / ( ) % are allowed, e.g. `/math 2 + 2 * 10`.');
  try {
    // Guarded eval: the regex above rejects anything but arithmetic, so this can
    // only compute a number.
    const result = Function(`"use strict"; return (${expr});`)();
    if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('bad');
    return i.replyEphemeral(say('🧮 Result', `\`${expr}\` = **${result}**`, OK));
  } catch { return i.replyEphemeral('That is not a valid expression.'); }
};
aero.command('math', (i) => inlineText(i, (v) => doMath(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Calculator', custom_id: 'util:math',
  inputs: [{ id: 'expr', label: 'Expression', style: 'short', required: true, placeholder: '2 + 2 * 10' }],
}, { spaceId: i.space_id })));
aero.component('util:math', (i) => doMath(i, i.fields?.expr || ''));

// /timestamp turns "N minutes from now" into an absolute time.
const doTs = (i, raw) => {
  const mins = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(mins)) return i.replyEphemeral('Enter a number of minutes, e.g. `/timestamp 90`.');
  const when = new Date(Date.now() + mins * 60000);
  return i.replyEphemeral(say('🕒 Timestamp', `${mins} minute(s) from now is **${when.toLocaleString()}**.`));
};
aero.command('timestamp', (i) => inlineText(i, (v) => doTs(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Timestamp', custom_id: 'util:ts',
  inputs: [{ id: 'mins', label: 'Minutes from now', style: 'short', required: true, placeholder: '90' }],
}, { spaceId: i.space_id })));
aero.component('util:ts', (i) => doTs(i, i.fields?.mins || ''));

// ─────────────────────────────────────────────────────────────
// Utility & Info batch — Ballastra-class helpers. All always-on (no module
// gate) and self-contained. Each text command is inline-first with a modal
// fallback, matching the rest of Velixar.
// ─────────────────────────────────────────────────────────────

// /avatar — show a member's avatar (or your own). Uses the member select when
// no inline @mention is given.
aero.command('avatar', (i) => {
  const target = i.options?.user || i.invoker.id;
  if (i.options?.user) return i.reply(say('🖼️ Avatar', `Avatar for <@${target}> · open their profile to view it full size.`));
  return i.reply({
    embeds: [{ title: '🖼️ Avatar', description: 'Pick a member to view their avatar. (tip: `/avatar @name`)', color: BRAND }],
    components: [{ components: [{ type: 'select', kind: 'member', custom_id: 'util:avatar', placeholder: 'Pick a member', min: 1, max: 1 }] }],
  });
});
aero.component('util:avatar', (i) => i.update(say('🖼️ Avatar', `Avatar for <@${i.values?.[0]}> · open their profile to view it full size.`)));

// /nexusinfo — a compact card about this Nexus.
aero.command('nexusinfo', (i) => {
  const xp = store.xpStats(i.nexus_id);
  return i.replyEphemeral(rich({
    title: '🏛️ Nexus info',
    description: 'A snapshot of this community.',
    fields: [
      { name: 'Members with XP', value: String(xp.members), inline: true },
      { name: 'Total XP', value: String(xp.total), inline: true },
      { name: 'Open tickets', value: String(store.openTicketCount(i.nexus_id)), inline: true },
      { name: 'Giveaways', value: String(store.activeGiveawayCount(i.nexus_id)), inline: true },
    ],
    footer: 'Velixar',
  }));
});

// /roleinfo — describe a role picked from the role select.
aero.command('roleinfo', (i) => i.reply({
  embeds: [{ title: '🎭 Role info', description: 'Pick a role to inspect.', color: BRAND }],
  components: [{ components: [{ type: 'select', kind: 'role', custom_id: 'util:roleinfo', placeholder: 'Pick a role', min: 1, max: 1 }] }],
}));
aero.component('util:roleinfo', (i) => i.update(say('🎭 Role info', `Role <@&${i.values?.[0]}> · self-assignable via /roles if the owner added it there.`)));

// /membercount — quick tracked-member count.
aero.command('membercount', (i) => i.replyEphemeral(say('👥 Members', `**${store.xpStats(i.nexus_id).members}** members have earned XP so far in this Nexus.`)));

// /snowflake — decode a Ballastra-style id's creation time (best-effort;
// UUID-style ids just echo back).
const doSnowflake = (i, raw) => {
  const id = String(raw).trim();
  if (/^\d{17,20}$/.test(id)) {
    const ts = Number((BigInt(id) >> 22n) + 1420070400000n);
    return i.replyEphemeral(say('❄️ Snowflake', `\`${id}\` was created around **${new Date(ts).toLocaleString()}**.`));
  }
  return i.replyEphemeral(say('❄️ Snowflake', `\`${id}\` is not a numeric snowflake. Ballastra ids are UUIDs and carry no embedded timestamp.`, WARN_C));
};
aero.command('snowflake', (i) => inlineText(i, (v) => doSnowflake(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Snowflake', custom_id: 'util:snowflake',
  inputs: [{ id: 'text', label: 'ID', style: 'short', required: true, placeholder: '175928847299117063' }],
}, { spaceId: i.space_id })));
aero.component('util:snowflake', (i) => doSnowflake(i, i.fields?.text || ''));

// A small family of text transforms sharing one inline+modal pattern.
function textUtil(name, title, custom_id, transform, placeholder = 'type something') {
  const run = (i, v) => {
    const out = transform(String(v));
    return i.replyEphemeral(say(title, out ? `\`\`\`\n${out.slice(0, 1800)}\n\`\`\`` : '(nothing to show)'));
  };
  aero.command(name, (i) => inlineText(i, (v) => run(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
    title, custom_id, inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder }],
  }, { spaceId: i.space_id })));
  aero.component(custom_id, (i) => run(i, i.fields?.text || ''));
}
textUtil('base64', '🔐 Base64', 'util:base64', (s) => Buffer.from(s, 'utf8').toString('base64'), 'hello world');
textUtil('base64decode', '🔓 Base64 decode', 'util:b64d', (s) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return '(not valid base64)'; } }, 'aGVsbG8=');
textUtil('binary', '💾 Binary', 'util:binary', (s) => [...s].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' '), 'hi');
textUtil('leet', '🕶️ Leetspeak', 'util:leet', (s) => s.replace(/[aAeEiIoOtTsS]/g, (c) => ({ a: '4', e: '3', i: '1', o: '0', t: '7', s: '5' }[c.toLowerCase()])), 'elite hacker');
textUtil('clapify', '👏 Clapify', 'util:clapify', (s) => s.split(/\s+/).filter(Boolean).join(' 👏 '), 'say it louder');
textUtil('vaporwave', '🌴 Vaporwave', 'util:vapor', (s) => [...s].map((c) => { const code = c.charCodeAt(0); return code >= 33 && code <= 126 ? String.fromCharCode(code + 65248) : c === ' ' ? '　' : c; }).join(''), 'aesthetic');

// /wordcount — count words + characters in a passage.
const doWordcount = (i, raw) => {
  const s = String(raw);
  const words = (s.trim().match(/\S+/g) || []).length;
  return i.replyEphemeral(say('🔢 Word count', `**${words}** words · **${s.length}** characters · **${s.split('\n').length}** line(s).`));
};
aero.command('wordcount', (i) => inlineText(i, (v) => doWordcount(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Word count', custom_id: 'util:wordcount',
  inputs: [{ id: 'text', label: 'Text', style: 'paragraph', required: true, placeholder: 'paste a paragraph' }],
}, { spaceId: i.space_id })));
aero.component('util:wordcount', (i) => doWordcount(i, i.fields?.text || ''));

// /colorinfo — validate a hex colour and preview it as a rich embed accent.
const doColorinfo = (i, raw) => {
  const hex = String(raw).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return i.replyEphemeral('Give a 6-digit hex colour, e.g. `/colorinfo 5865F2`.');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return i.replyEphemeral(rich({
    title: `🎨 #${hex.toUpperCase()}`,
    description: `The accent stripe shows this colour.`,
    color: `#${hex.toUpperCase()}`,
    fields: [
      { name: 'HEX', value: `#${hex.toUpperCase()}`, inline: true },
      { name: 'RGB', value: `${r}, ${g}, ${b}`, inline: true },
    ],
  }));
};
aero.command('colorinfo', (i) => inlineText(i, (v) => doColorinfo(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Colour info', custom_id: 'util:colorinfo',
  inputs: [{ id: 'text', label: 'Hex colour', style: 'short', required: true, placeholder: '5865F2' }],
}, { spaceId: i.space_id })));
aero.component('util:colorinfo', (i) => doColorinfo(i, i.fields?.text || ''));

// /lengthconvert — a tiny unit converter (a genuinely handy staple).
const doLength = (i, raw) => {
  const m = String(raw).trim().match(/^([\d.]+)\s*(km|m|cm|mm|mi|ft|in)\s+(km|m|cm|mm|mi|ft|in)$/i);
  if (!m) return i.replyEphemeral('Format: `/lengthconvert 10 km mi` (units: km m cm mm mi ft in).');
  const toM = { km: 1000, m: 1, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254 };
  const val = parseFloat(m[1]) * toM[m[2].toLowerCase()] / toM[m[3].toLowerCase()];
  return i.replyEphemeral(say('📏 Convert', `**${m[1]} ${m[2]}** = **${val.toFixed(4).replace(/\.?0+$/, '')} ${m[3]}**`, OK));
};
aero.command('lengthconvert', (i) => inlineText(i, (v) => doLength(i, v), () => aero.openModal(i.nexus_id, i.invoker.id, {
  title: 'Length convert', custom_id: 'util:length',
  inputs: [{ id: 'text', label: 'e.g. 10 km mi', style: 'short', required: true, placeholder: '10 km mi' }],
}, { spaceId: i.space_id })));
aero.component('util:length', (i) => doLength(i, i.fields?.text || ''));

// /poll-multi: a 2 to 5 option poll with a live per-option tally.
aero.command('poll-multi', (i) => {
  if (!on(i.nexus_id, 'fun')) return i.replyEphemeral('The Fun module is off in this Nexus.');
  return aero.openModal(i.nexus_id, i.invoker.id, {
    title: 'Multi-option poll', custom_id: 'poll:multi',
    inputs: [
      { id: 'question', label: 'Question', style: 'short', required: true, placeholder: 'Best pizza topping?' },
      { id: 'options', label: 'Options (comma-separated, 2 to 5)', style: 'short', required: true, placeholder: 'Pepperoni, Mushroom, Pineapple' },
    ],
  }, { spaceId: i.space_id });
});
// Poll state keyed by the posted message id, so every voter's press re-renders
// the same tally. Held in memory (a poll is short-lived).
const multiPolls = new Map(); // messageId -> { question, options:[], votes: Map<user,idx> }
aero.component('poll:multi', async (i) => {
  const question = (i.fields?.question || '').trim();
  const options = (i.fields?.options || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
  if (options.length < 2) return i.replyEphemeral('Give 2 to 5 options, comma-separated.');
  const votes = new Map();
  const res = await i.reply(multiPollView(question, options, votes));
  const messageId = res?.message?.id;
  if (messageId) multiPolls.set(String(messageId), { question, options, votes });
  return undefined;
});
function multiPollView(question, options, votes) {
  const counts = options.map((_, idx) => [...votes.values()].filter((v) => v === idx).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const body = options.map((o, idx) => {
    const pct = total ? Math.round((counts[idx] / total) * 100) : 0;
    const filled = total ? Math.round((counts[idx] / total) * 10) : 0;
    return `**${o}**\n\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${counts[idx]} · ${pct}%`;
  }).join('\n');
  return {
    embeds: [{ title: `📊 ${question}`, description: `${body}\n\n${total} vote${total === 1 ? '' : 's'}`, color: BRAND }],
    components: [{ components: options.map((o, idx) => ({ type: 'button', style: 'secondary', label: `${idx + 1}`, custom_id: `pm:${idx}` })) }],
  };
}
function handleMultiVote(i) {
  const poll = multiPolls.get(String(i.message_id));
  if (!poll) return i.replyEphemeral('This poll is no longer active.');
  const idx = parseInt(i.custom_id.split(':')[1], 10);
  poll.votes.set(i.invoker.id, idx);
  return i.update(multiPollView(poll.question, poll.options, poll.votes));
}

// ─────────────────────────────────────────────────────────────
// HELP — a categorised, navigable help menu (Ballastra-class): a landing
// embed with a category dropdown; picking a category shows its commands.
// ─────────────────────────────────────────────────────────────
const HELP_CATEGORIES = [
  { key: 'levels', emoji: '📊', label: 'Levels', desc: 'XP, ranks and rewards', cmds: [
    ['rank', 'Your level + XP (or @member)'], ['level', 'Quick level check'], ['xp', 'Raw XP total'], ['progress', 'Progress bar'], ['nextlevel', 'XP to next level'],
    ['leaderboard', 'Top members by XP'], ['top', 'Top 5'], ['daily', 'Daily XP + streak'], ['level-roles', 'Level-up role rewards'], ['level-role-add', 'Reward a role at a level (admin)'],
    ['givexp', 'Give/remove XP (admin)'],
  ] },
  { key: 'economy', emoji: '💰', label: 'Economy', desc: 'Coins, shop and gambling', cmds: [
    ['balance', 'Your coin balance'], ['bank', 'Wallet + bank'], ['networth', 'Total worth'], ['deposit', 'Wallet → bank'], ['withdraw', 'Bank → wallet'],
    ['work', 'Earn coins hourly'], ['daily-coins', 'Daily coins + streak'], ['weekly', 'Weekly bonus'], ['beg', 'Beg for coins'], ['crime', 'Risky coins'],
    ['fish', 'Go fishing'], ['hunt', 'Go hunting'], ['mine', 'Go mining'], ['pay', 'Pay a member'], ['give-coins', 'Send coins'],
    ['rich', 'Richest members'], ['richest', 'Coin leaderboard'], ['shop', 'Browse the shop'], ['buy', 'Buy an item'], ['sell', 'Sell an item'],
    ['use', 'Use an item'], ['inventory', 'Your items'], ['gamble', 'Bet coins'], ['coinflip-bet', 'Coinflip wager'], ['roulette', 'Bet on a colour'],
    ['dice-bet', 'High/low dice'], ['lottery', 'Buy a ticket'], ['blackjack', 'Play blackjack'], ['rob', 'Rob a member'],
  ] },
  { key: 'games', emoji: '🎮', label: 'Games', desc: 'Play with friends', cmds: [
    ['trivia', 'Answer for XP'], ['tictactoe', 'Challenge to tic-tac-toe'], ['connect4', 'Challenge to Connect 4'], ['hangman', 'Guess the word'], ['unscramble', 'Unscramble for XP'],
    ['dice-duel', 'Roll vs Velixar'], ['number', 'Guess 1-10'], ['guessnumber', 'Guess 1-100'], ['higherlower', 'Higher or lower'], ['wordle-lite', 'Wordle in 6 tries'],
    ['anagram', 'Unscramble a word'], ['mathrace', 'Solve fast'], ['slotmachine', 'Free 3-reel spin'], ['rps-lizard', 'RPS-Lizard-Spock'], ['emojiquiz', 'Guess from emojis'],
    ['reactiontest', 'Click speed test'], ['coinstreak', 'Longest heads streak'],
  ] },
  { key: 'fun', emoji: '🎉', label: 'Fun', desc: 'Toys and randomness', cmds: [
    ['roll', 'Roll a d6'], ['dice', 'Roll any die'], ['coinflip', 'Flip a coin'], ['flip', 'Quick flip'], ['eightball', 'Magic 8-ball'],
    ['choose', 'Pick an option'], ['poll', 'Yes/no poll'], ['poll-multi', 'Multi-option poll'], ['vote', 'Yes/no/abstain vote'], ['rps', 'Rock paper scissors'],
    ['slots', 'Slot machine'], ['ship', 'Ship two members'], ['love', 'Love compatibility'], ['rate', 'Rate something'], ['roll-team', 'Split into teams'],
    ['iq', 'IQ meter'], ['simp', 'Simp meter'], ['vibecheck', 'Vibe check'], ['pp', 'PP meter'], ['howfunny', 'Funny meter'],
    ['coolness', 'Coolness'], ['braincells', 'Brain cells'], ['flames', 'FLAMES game'], ['randomnumber', 'Random in a range'], ['rolldice', 'Roll N dice'],
    ['pickone', 'Pick an option'], ['yesno', 'Yes/no/maybe'], ['repeat', 'Echo text'], ['owoify', 'OwOify text'], ['magic8', 'Magic 8-ball'],
  ] },
  { key: 'text', emoji: '🔡', label: 'Text & Social', desc: 'Transforms and interactions', cmds: [
    ['mock', 'MoCkInG case'], ['reverse', 'Reverse text'], ['clap', 'Clap 👏 text'], ['spaceout', 'S p a c e'], ['emojify', 'Emoji letters'],
    ['hug', 'Hug a member'], ['pat', 'Pat'], ['highfive', 'High-five'], ['slap', 'Slap'], ['poke', 'Poke'],
    ['kiss', 'Kiss'], ['cuddle', 'Cuddle'], ['bonk', 'Bonk'], ['wave', 'Wave'], ['dance', 'Dance'],
    ['cry', 'Cry on'], ['bite', 'Bite'], ['yeet', 'Yeet'], ['tickle', 'Tickle'], ['boop', 'Boop'],
    ['handshake', 'Handshake'], ['salute', 'Salute'], ['joke', 'A joke'], ['fact', 'A fact'], ['advice', 'Advice'],
    ['quote', 'A quote'], ['inspire', 'Inspiration'], ['wouldyourather', 'Would you rather'], ['truthordare', 'Truth or dare'], ['veli', 'Your veli count'],
    ['velitop', 'veli leaderboard'],
  ] },
  { key: 'roles', emoji: '🎭', label: 'Roles', desc: 'Self-assign + reaction roles', cmds: [
    ['roles', 'Self-assign menu'], ['roles-remove', 'Remove your role'], ['rr-panel', 'Reaction-role panel'],
    ['roles-add', 'Add self-role (admin)'], ['rr-add', 'Add rr button (admin)'],
  ] },
  { key: 'mod', emoji: '🛡️', label: 'Moderation', desc: 'Keep the Nexus safe', cmds: [
    ['warn', 'Warn a member'], ['warnings', "View warnings"], ['warnlist', 'Warning history'], ['unwarn', 'Clear warnings'], ['timeout', 'Timeout 10m'],
    ['tempmute', 'Timeout N min'], ['timeout-clear', 'Remove a timeout'], ['kick', 'Kick'], ['ban', 'Ban'], ['softban', 'Ban to clear messages'],
    ['note', 'Add a staff note'], ['notes', 'Read staff notes'], ['notes-clear', 'Clear notes'], ['purge', 'Delete recent messages'], ['purge-user', 'Purge N messages'],
    ['lock', 'Lock space'], ['unlock', 'Unlock space'], ['slowmode', 'Set slow mode'], ['slowmode-off', 'Clear slow mode'], ['role-give', 'Give a role'],
    ['role-take', 'Take a role'], ['automod', 'AutoMod settings'], ['modstats', 'Moderation status'], ['modhelp', 'Moderator cheat-sheet'],
  ] },
  { key: 'utility', emoji: '🧰', label: 'Utility', desc: 'Handy tools', cmds: [
    ['userinfo', 'Member info'], ['nexusstats', 'Nexus summary'], ['nexusinfo', 'Nexus info card'], ['membercount', 'Member count'], ['ping', 'Is Velixar up'],
    ['uptime', 'Uptime'], ['aeroinfo', 'About Velixar'], ['avatar', 'Show an avatar'], ['roleinfo', 'Role info'], ['math', 'Calculator'],
    ['timestamp', 'Time from now'], ['snowflake', 'Decode an id'], ['colorinfo', 'Inspect a hex colour'], ['lengthconvert', 'Convert units'], ['wordcount', 'Count words'],
    ['base64', 'Encode base64'], ['base64decode', 'Decode base64'], ['binary', 'Text to binary'], ['leet', 'Leetspeak'], ['clapify', 'Clap 👏 between'],
    ['vaporwave', 'Ａｅｓｔｈｅｔｉｃ'], ['password', 'Strong password'], ['randomcolor', 'Random colour'], ['countdown', 'Live countdown'], ['remind', 'Set a reminder'],
    ['remindlist', 'Your reminders'], ['remindme', 'Set a reminder'], ['afk', 'Go AFK'], ['tag', 'Post a tag'], ['tag-list', 'List tags'],
  ] },
  { key: 'community', emoji: '🏛️', label: 'Community', desc: 'Tickets, suggestions, giveaways', cmds: [
    ['panel', 'Ticket panel'], ['ticket-list', 'Open tickets'], ['suggest', 'Submit a suggestion'], ['suggestions-list', 'Suggestions info'], ['giveaway', 'Start a giveaway'],
    ['announce', 'Post an announcement'], ['embed', 'Build an embed'], ['count-status', 'Counting status'],
  ] },
];
// Total commands across the help categories, computed once for the landing card.
const HELP_TOTAL = HELP_CATEGORIES.reduce((n, c) => n + c.cmds.length, 0);

function helpLanding() {
  return {
    embeds: [{
      title: '📖 Velixar Help',
      description: [
        `**${HELP_TOTAL} commands** across **${HELP_CATEGORIES.length} categories**. Pick a category below to browse.`,
        '',
        // Each category shows its command count, so the menu reads at a glance.
        ...HELP_CATEGORIES.map((c) => `${c.emoji} **${c.label}**  ·  ${c.cmds.length} commands`),
        '',
        '_Tip: type a command name after `/` and Velixar shows an inline argument hint._',
      ].join('\n'),
      color: BRAND,
      footer: { text: `Velixar · ${HELP_TOTAL} commands` },
    }],
    components: [{ components: [{
      type: 'select', kind: 'string', custom_id: 'help:cat', placeholder: 'Browse a category',
      options: HELP_CATEGORIES.map((c) => ({ label: `${c.label} (${c.cmds.length})`, value: c.key, description: c.desc, emoji: c.emoji })),
    }] }],
  };
}
function helpCategory(key) {
  const c = HELP_CATEGORIES.find((x) => x.key === key) || HELP_CATEGORIES[0];
  return {
    embeds: [{
      title: `${c.emoji} ${c.label}`,
      // `desc` is the category's one-liner; command lines use a middot, never an
      // em-dash, to match Ballastra's copy style.
      description: [
        `_${c.desc}_`,
        '',
        ...c.cmds.map(([name, d]) => `\`/${name}\`  ·  ${d}`),
      ].join('\n'),
      color: BRAND,
      footer: { text: `${c.cmds.length} commands · pick another category below` },
    }],
    components: [{ components: [{
      type: 'select', kind: 'string', custom_id: 'help:cat', placeholder: 'Browse a category',
      options: HELP_CATEGORIES.map((x) => ({ label: `${x.label} (${x.cmds.length})`, value: x.key, description: x.desc, emoji: x.emoji, default: x.key === c.key })),
    }] }],
  };
}
aero.command('help', (i) => i.replyEphemeral(helpLanding()));
aero.component('help:cat', (i) => i.update(helpCategory(i.values?.[0])));

// ─────────────────────────────────────────────────────────────
// PREFIX COMMANDS — classic "!command" shortcuts (Discord/OwO style) for the
// most-reached commands, in addition to the slash commands above. Needs the
// message.created subscription (declared in aero.json). The prefix ctx gives
// { command, args, text, invoker, nexus_id, space_id, reply }. Module gates
// still apply so a Nexus that turns a module off gets nothing here either.
// ─────────────────────────────────────────────────────────────
const pOn = (ctx, key) => aero.moduleEnabled(ctx.nexus_id, key);
// Resolve the first <@id> mention in the args to a target user id.
const pMention = (ctx) => { const m = (ctx.text || '').match(/<@!?(\d+)>/); return m ? m[1] : null; };

aero.prefix('!');

aero.prefixCommand('ping', (ctx) => ctx.reply(say('🏓 Pong', 'Velixar is online and responding.', OK)));
aero.prefixCommand('help', (ctx) => ctx.reply(helpLanding()));
aero.prefixCommand('roll', (ctx) => ctx.reply(say('🎲 Dice', `${ctx.invoker.name} rolled a **${1 + Math.floor(Math.random() * 6)}**.`, OK)));
aero.prefixCommand('flip', async (ctx) => { await animateFlip(ctx, '🪙 Flip', (heads, side) => say('🪙 Flip', `${heads ? '🌕' : '🌑'} **${side}**`, OK)); });
aero.prefixCommand('coinflip', async (ctx) => { await animateFlip(ctx, '🪙 Coin flip', (heads, side) => say('🪙 Coin flip', `${heads ? '🌕' : '🌑'} ${ctx.invoker.name} flipped **${side}**!`, OK)); });
aero.prefixCommand('8ball', (ctx) => pOn(ctx, 'fun')
  ? ctx.reply(say('🎱 The 8-ball says', EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]))
  : ctx.reply('The Fun module is off in this Nexus.'));

// !rank / !level — your XP (Levels module).
aero.prefixCommand('rank', (ctx) => {
  if (!pOn(ctx, 'levels')) return ctx.reply('The Levels module is off in this Nexus.');
  const target = pMention(ctx) || ctx.invoker.id;
  const points = store.getXp(ctx.nexus_id, target);
  const lvl = levelFor(points);
  const p = progressBar(points);
  return ctx.reply(rich({
    title: `📊 ${pMention(ctx) ? 'Member' : ctx.invoker.name}`,
    description: `${pMention(ctx) ? `<@${target}>\n\n` : ''}\`${p.bar}\`  **${p.have}/${p.need}** XP to level ${lvl + 1}`,
    color: OK,
    fields: [
      { name: 'Level', value: `**${lvl}**`, inline: true },
      { name: 'Total XP', value: `**${points.toLocaleString()}**`, inline: true },
    ],
    footer: 'Velixar · chat to earn XP',
  }));
});
aero.prefixCommand('level', (ctx) => {
  if (!pOn(ctx, 'levels')) return ctx.reply('The Levels module is off in this Nexus.');
  const target = pMention(ctx) || ctx.invoker.id;
  return ctx.reply(say('📈 Level', `<@${target}> is level **${levelFor(store.getXp(ctx.nexus_id, target))}** with **${store.getXp(ctx.nexus_id, target)}** XP.`, OK));
});

// !balance / !bal / !daily / !rich — economy shortcuts.
aero.prefixCommand('balance', (ctx) => ecoPrefixBalance(ctx));
aero.prefixCommand('bal', (ctx) => ecoPrefixBalance(ctx));
function ecoPrefixBalance(ctx) {
  if (!pOn(ctx, 'economy')) return ctx.reply('The Economy module is off in this Nexus.');
  const c = store.getCoins(ctx.nexus_id, ctx.invoker.id);
  return ctx.reply(rich({
    title: '💰 Your wallet',
    description: `You're carrying ${fmtCoins(c.balance || 0)}.`,
    color: OK,
    fields: [
      { name: 'Wallet', value: fmtCoins(c.balance || 0), inline: true },
      { name: 'Bank', value: fmtCoins(c.bank || 0), inline: true },
      { name: 'Net worth', value: fmtCoins((c.balance || 0) + (c.bank || 0)), inline: true },
    ],
    footer: 'Velixar',
  }));
}
aero.prefixCommand('daily', (ctx) => {
  if (!pOn(ctx, 'economy')) return ctx.reply('The Economy module is off in this Nexus.');
  const d = store.getDaily(ctx.nexus_id, ctx.invoker.id);
  const now = Date.now();
  if (now - d.last_claim < DAY) {
    const hrs = Math.ceil((DAY - (now - d.last_claim)) / (60 * 60 * 1000));
    return ctx.reply(say('Already claimed', `Your next daily is in **${hrs}h**.`, WARN_C));
  }
  const streak = now - d.last_claim < 2 * DAY ? d.streak + 1 : 1;
  const reward = 100 + Math.min(streak, 30) * 20;
  store.setDaily(ctx.nexus_id, ctx.invoker.id, now, streak);
  store.addCoins(ctx.nexus_id, ctx.invoker.id, reward);
  return ctx.reply(say('🎁 Daily coins', `+${fmtCoins(reward)} · 🔥 **${streak}-day** streak.`, OK));
});
aero.prefixCommand('rich', (ctx) => {
  if (!pOn(ctx, 'economy')) return ctx.reply('The Economy module is off in this Nexus.');
  const rows = store.topCoins(ctx.nexus_id, 10);
  if (!rows.length) return ctx.reply(say('💰 Richest', 'No one has coins yet. Try !work!'));
  const body = rows.map((r, n) => `${MEDALS[n] || `**${n + 1}.**`} <@${r.user_id}> · ${fmtCoins(r.balance)}`).join('\n');
  return ctx.reply(say('💰 Richest members', body));
});

// !hug @member and friends — social actions via prefix.
for (const [name, emoji, verb] of [['hug', '🤗', 'hug'], ['pat', '👋', 'pat'], ['kiss', '😘', 'kiss'], ['slap', '🖐️', 'slap'], ['poke', '👉', 'poke']]) {
  aero.prefixCommand(name, (ctx) => {
    if (!pOn(ctx, 'fun')) return ctx.reply('The Fun module is off in this Nexus.');
    const target = pMention(ctx);
    if (!target) return ctx.reply(`Mention someone: \`!${name} @member\`.`);
    const gif = gifFor(name);
    return ctx.reply({ embeds: [{ description: `${emoji} <@${ctx.invoker.id}> ${verb}s <@${target}>!`, color: BRAND, ...(gif ? { image: { url: gif } } : {}) }] });
  });
}

// A friendly catch-all so "!something" that isn't a command nudges to !help.
aero.prefixCommand('*', (ctx) => ctx.reply(say('Unknown command', `\`!${ctx.command}\` isn't a Velixar prefix command. Try \`!help\` or use \`/${ctx.command}\`.`, WARN_C)));

// Recover after a restart: re-arm timers for giveaways that were still running.
// (Reminders are swept by the interval above, so they need no re-arming.)
for (const g of store.activeGiveaways()) {
  scheduleGiveaway(g.message_id, g.ends_at - Date.now());
}
const pendingReminders = store.allReminders().length;
if (pendingReminders) console.log(`[velixar] ${pendingReminders} reminder(s) pending.`);

// Dev sanity: warn if the Portal declares a command we forgot to handle.
const missing = aero.unhandledCommands?.() ?? [];
if (missing.length) console.warn(`[velixar] declared but unhandled command(s): ${missing.join(', ')}`);

console.log('[velixar] ready. Commands + modules registered.');
