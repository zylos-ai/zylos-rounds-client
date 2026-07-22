---
name: rounds-client
description: >-
  Remote management client for a Rounds server (delegated 1:1 voice
  conversations for teams — daily standups, retros, topic rounds). Manage
  members, tasks, the agent's brain (background / probing / profiles),
  knowledge base, reports, digests and settings over HTTPS with a bearer
  API key. Works from any agent runtime (Claude Code, Codex, or a bare
  terminal) — no zylos installation and no server-side access required.
  Use when asked about rounds, 日报, standup, 汇报, digests, member links,
  画像, or when managing a remote Rounds deployment.
version: 0.25.1
type: capability

lifecycle:
  npm: false
---

# Rounds Client

`cli.js` (this directory) is a zero-dependency Node.js (>= 18) HTTP client
for the Rounds management API. It never touches the server's database — every
operation goes through the REST API with a bearer key.

## Setup (one time)

Get two values from whoever runs the Rounds server:

- **URL** — the server's public base URL (e.g. `https://host/rounds`)
- **API key** — a named bearer key minted for this client (`cli.js token
  create <name>` on the server, or admin Settings → API Keys; the server's
  first start also prints a bootstrap key named `default`)

Store them in `~/.rounds/cli.json`:

```bash
mkdir -p ~/.rounds
cat > ~/.rounds/cli.json <<'EOF'
{ "url": "https://your-server/rounds", "apiKey": "PASTE_SERVICE_TOKEN" }
EOF
chmod 600 ~/.rounds/cli.json
```

The key is a secret: keep `cli.json` at mode 600, never commit it, never
paste it into documents. Alternatives to `cli.json`: `--url`/`--key` flags,
or `ROUNDS_URL`/`ROUNDS_API_KEY` environment variables (first hit wins).

## Usage

```bash
node cli.js help                 # full command reference
node cli.js report today         # who has reported today + summaries
node cli.js member list          # roster with per-task links
node cli.js member add "Alice"   # returns her personal talk link
node cli.js member rename 3 "Linfan"   # rename a member (links & history unaffected)
node cli.js task list            # recurring + one-off communication tasks
node cli.js task digest 1 --cycle 2026-07-20   # (re)generate a cycle digest
node cli.js followup list --task 1             # follow-ups (补充/跟进) — ALWAYS review before adding (see convention below)
node cli.js followup add --task 1 [--scope team] "..."   # append a follow-up (default scope=private)
node cli.js followup remove 5                   # drop a superseded entry
node cli.js brain get            # team background / probing / profile rules
node cli.js knowledge search "release process"
node cli.js settings get         # model / voice / language / providers
```

**Follow-up convention (all agents must follow).** A follow-up (补充/跟进) records
new info or progress on a task, carried into its next cycle. **Always run
`followup list --task <id>` before adding one.** If your new entry is progress or a
decision on the **same topic** as an existing follow-up, **replace it — `followup
remove` the stale entry, then add the current state — instead of accumulating
duplicates** (no in-place edit; replace = remove + add). Example: a standup raises
"套餐方向待对齐"; once the team agrees, replace it with "套餐方向已达成共识：…" rather
than keeping both. One current follow-up per topic.

Long text is passed via stdin:

```bash
node cli.js brain set team-background <<'EOF'
We are the Acme platform team...
EOF
```

All output is JSON — pipe to `jq` or parse directly. Errors exit non-zero
with a one-line message on stderr.

## Install / update this client

Zylos users — the client is a versioned component, mirrored on every
release to [zylos-ai/zylos-rounds-client](https://github.com/zylos-ai/zylos-rounds-client):

```bash
zylos add rounds-client       # install
zylos upgrade rounds-client   # update
```

Any other runtime — copy the two files into a skills directory:

```bash
DEST=~/.claude/skills/rounds-client   # or any skills dir your runtime reads
mkdir -p "$DEST"
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-rounds/main/scripts/cli.js -o "$DEST/cli.js"
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-rounds/main/client/SKILL.md -o "$DEST/SKILL.md"
```

`node cli.js version` prints the installed client version; updating a
manual copy means re-downloading `cli.js`.

## Server deployment

See `docs/deploy-standalone.md` in the repo for running the server itself
(Docker or bare metal): https://github.com/zylos-ai/zylos-rounds
