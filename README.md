# Velixar

An all-in-one Ballastra Aero with **200 commands**. **One Aero, many
Nexuses**: each Nexus owner turns modules on or off and configures Velixar for
their own Nexus, from inside it. Nothing is hard-coded to a single Nexus.

> **Ownership.** Velixar is a **public** Aero — anyone can install and use it in
> their own Nexus. It is **privately owned by Saith** as an individual, and run
> personally; it is not owned by any organisation or platform, and is not a
> Ballastra business venture.

Sixteen toggle-able modules (Nexus settings → Aeros → Velixar → Modules) plus a
large set of always-on fun and utility commands. The full, authoritative command
list with per-command permissions lives in [`aero.json`](./aero.json); run
`/help` in any Nexus for a categorised overview. Modules:

| Module | Key | Commands | Needs |
| --- | --- | --- | --- |
| Welcome | `welcome` | (auto on join) | Send messages |
| Moderation | `moderation` | `/warn` `/warnings` `/timeout` `/tempmute` `/purge` | Moderate chat, Kick/timeout, Manage messages |
| AutoMod | `automod` | `/automod` `/automod-words` | Moderate chat (warns violators) |
| Logging | `logging` | (auto) + `/modlog-setup` | Send messages |
| Levels | `levels` | `/rank` `/leaderboard` `/daily` `/level-roles` `/level-role-add` `/givexp` | Read messages, Send messages, Manage roles (for rewards) |
| Fun | `fun` | `/roll` `/coinflip` `/eightball` `/choose` `/poll` | Send messages |
| Roles | `roles` | `/roles` `/roles-remove` | Manage roles |
| Reaction roles | `reactionroles` | `/rr-panel` `/rr-add` `/rr-clear` | Manage roles |
| Reminders | `reminders` | `/remind` `/remindlist` | Send messages |
| Suggestions | `suggestions` | `/suggest` | Send messages |
| Giveaways | `giveaways` | `/giveaway` | Send messages, Manage messages (edits the entry embed) |
| AFK | `afk` | `/afk` | Send messages |
| Counting | `counting` | `/count-status` + `/count-setup` | Read messages, Send messages |
| Economy | `economy` | `/balance` `/work` `/daily-coins` `/pay` `/rich` `/gamble` `/rob` | Send messages |
| Tags | (always-on) | `/tag` `/tag-list` `/tag-add` `/tag-delete` | Send messages |
| Tickets | `tickets` | `/panel` | Manage spaces, Manage roles, Send messages |

Fun and utility commands (jokes, dice, RPS, slots, polls, votes, math, password,
countdown and many more) are always on when their module (Fun) is enabled or,
for pure utilities, at all times. See `/help` or `aero.json` for the complete
list.

**AutoMod** filters banned words, spam, excessive caps and mention-spam; a hit
warns the member (auto-escalating) and logs it. **Logging** records mod actions
and joins/leaves to a mod-log space (`/modlog-setup`). **Reaction roles** post a
button panel (`/rr-panel`) where a tap toggles a role. Levels announces level-ups
and grants **level-role rewards**; **/daily** gives a streak bonus. **AFK** marks
you away and warns anyone who mentions you. Reminders and giveaways persist
across restarts.

Plus `/help`, `/announce`, `/embed` and the setup commands below (always on).

## Per-Nexus setup (each owner runs these in their Nexus)

Velixar stores each Nexus's settings in its own database (keyed by nexus id), so
one running Aero serves every Nexus. Configure it with commands, not env:

| Command | What it does |
| --- | --- |
| `/ticket-setup` | Form: ticket panel title, description, button, color, topics |
| `/ticket-staff` | Pick the role added + pinged in each ticket |
| `/welcome-setup` | Pick the space where new members are greeted |
| `/suggest-setup` | Pick the space where `/suggest` posts land |
| `/modlog-setup` | Pick the mod-log space for the Logging module |
| `/count-setup` | Pick the counting-game space |
| `/automod` | View + toggle AutoMod filters (spam / caps / mentions) |
| `/automod-words` | Set the AutoMod banned-word list |
| `/rr-add` | Add a reaction-role button (label + emoji + role) |
| `/rr-clear` | Remove all reaction-role buttons |
| `/roles-add` | Add a self-assign role to the `/roles` menu (label + role picker) |
| `/roles-clear` | Remove all self-assign roles |
| `/level-role-add` | Reward a role when a member reaches a chosen level |
| `/givexp` | Give or remove a member's XP |
| `/announce` | Post a titled announcement to the current space |
| `/embed` | Build + post a custom embed (title, colour, image) |
| `/slowmode` | Set the current space's slow mode |
| `/invite` | Create a fresh 7-day invite link |
| `/config` | Show what's configured for this Nexus |

`/panel` then posts the ticket panel this Nexus configured. Opening a ticket
creates a private Space for that member (one open ticket per person), pings the
staff role, and posts a **Close ticket** button that locks the Space.

## Who can run what (command permissions)

Ballastra gates commands backend-side by a **`required_permission`** you set per
command in the Portal (it's also declared in [`aero.json`](./aero.json) as the
source of truth). A member without that permission gets "You do not have
permission to run this command"; the Nexus owner is always allowed. Commands
with no `required_permission` are open to every member.

| Access | Commands | Required permission |
| --- | --- | --- |
| **Everyone** | `/help` `/config` `/userinfo` `/nexusstats` `/rank` `/leaderboard` `/daily` `/level-roles` `/roll` `/coinflip` `/eightball` `/choose` `/poll` `/roles` `/roles-remove` `/rr-panel` `/remind` `/remindlist` `/afk` `/suggest` `/count-status` | *(none)* |
| **Moderators** | `/warn` `/warnings` `/timeout` `/tempmute` `/automod` `/automod-words` | `manage_members` |
| | `/purge` | `manage_messages` |
| | `/slowmode` | `manage_spaces` |
| | `/invite` | `manage_invites` |
| **Role managers** | `/roles-add` `/roles-clear` `/level-role-add` `/rr-add` `/rr-clear` | `manage_roles` |
| **Admins** | `/givexp` `/giveaway` `/suggest-setup` `/modlog-setup` `/count-setup` `/announce` `/embed` `/panel` `/ticket-setup` `/ticket-staff` `/welcome-setup` | `manage_nexus` |

> The Aero **also** needs the matching permission granted to it at install time
> to actually perform the action (e.g. Moderate/Kick for `/timeout`, Manage
> roles for `/level-role-add`). Two independent gates: the caller must be allowed
> to run the command, and the Aero must be allowed to do the work.

## Install & run

1. **Create the Aero** in the Developer Portal, copy its token (shown once).

2. **Declare the modules** (Portal → your Aero → **Modules**), keys exactly:
   `welcome`, `moderation`, `automod`, `logging`, `levels`, `fun`, `roles`,
   `reactionroles`, `reminders`, `suggestions`, `giveaways`, `afk`, `counting`,
   `economy`, `tickets`.

3. **Declare the commands + events + listing.** The single source of truth is
   [`aero.json`](./aero.json), the manifest shipped with this example lists all
   100 commands, the three events (`member.joined`, `member.left`,
   `message.created`) and the directory listing. Copy the command names into the
   Portal's **Commands** tab and subscribe to the events in the **Events** tab.

   Velixar also loads `aero.json` at boot (`createAero({ manifest })`) so
   `aero.unhandledCommands()` can warn if a declared command has no handler, a
   handy check that the Portal and the code stay in sync.

4. **Install** into any Nexus, grant the permissions above, turn on the modules
   you want, then run the setup commands in that Nexus.

5. **Run it:**

   ```bash
   npm install
   cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
   # fill in AERO_TOKEN, then:
   npm start
   ```

## Project layout

```
velixar-aero/
  index.js        all of Velixar's command + event logic
  store.js        SQLite persistence (per-Nexus config, XP, tickets)
  package.json    depends on @ballastra/aero + better-sqlite3
  .env.example    copy to .env (just the token + base URL)
  .gitignore
  README.md
```

This is a standalone project: it talks to Ballastra only through the public
`@ballastra/aero` SDK and keeps its own data in a local SQLite file, so you can
host it anywhere (your PC, a VPS, a container) and serve any number of Nexuses.

## What it demonstrates

- **One Aero, many Nexuses** with per-Nexus config in the Aero's own store.
- **Modules** gating every feature (`aero.moduleEnabled`, live `onModuleToggled`).
- **Modals** for setup forms, **role/space selects** for pickers.
- **Ephemeral** replies (setup confirmations, `/rank`) only the caller sees.
- **Update** in place (the `/poll` tally changes under the buttons).
- Embeds, buttons, moderation, role assignment, and Space creation: the full
  runtime surface, on the public SDK.
