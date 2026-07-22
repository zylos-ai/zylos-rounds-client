#!/usr/bin/env node
/**
 * rounds CLI — agent-friendly management client for zylos-rounds.
 *
 * Talks to the admin API with a bearer API key (named keys in the server DB,
 * managed via `token` commands); never touches the database. Designed for AI
 * agents: JSON output, stdin for long text, zero interactive prompts.
 *
 * Credential resolution (first hit wins):
 *   1. --url / --key flags
 *   2. ROUNDS_URL / ROUNDS_API_KEY environment variables
 *   3. cli.json {"url": "...", "apiKey": "..."} in, in order:
 *      $ROUNDS_HOME → ~/.rounds → ~/zylos/components/rounds
 *      (the server writes a same-host cli.json into its data dir at key
 *      mint/migration time, so a local install works with zero setup)
 *
 * A remote agent (Claude Code, Codex, the coco avatar, any framework — no
 * zylos required) only needs ~/.rounds/cli.json pointing at the server's
 * public URL — see client/SKILL.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const CLIENT_VERSION = '0.25.1';

const HELP = `rounds CLI v${CLIENT_VERSION} — manage the Rounds app via its admin API

Usage: cli.js [--url U] [--key K] <command> [args]
       cli.js version                 print client version (no server call)

Members
  member list                         roster with per-task links, context/profile
  member add <name> [--language L]    add (or re-activate) a member; mints their daily-task link (L: zh|en)
  member remove <id>                  deactivate a member (history kept, links die)
  member rename <id> <new-name>       rename a member (name is unique; links/history unaffected)
  member set-context <id> [text]      set 基础背景 (text arg or stdin; empty clears)
  member set-profile <id> [text]      overwrite 动态画像 (text arg or stdin; empty clears)
  member set-language <id> [zh|en]    set conversation/UI language (empty = team default)

Agent brain
  brain get                           team_background + probing_guidance
  brain set <team-background|probing-guidance|profile-instruction> [text]  (text arg or stdin)

Knowledge base
  knowledge list
  knowledge search <query...>
  knowledge add --title T [--tags G] [text]              (content from text arg or stdin)
  knowledge update <id> [--title T] [--tags G] [text]
  knowledge remove <id>

Follow-ups (补充/跟进) — append info to a task; carried into its next cycle
  followup list --task <id>                             follow-ups on a task (newest first)
  followup add --task <id> [--scope team] [--by NAME] [text]   default scope=private; content from arg or stdin
  followup remove <id>

Communication tasks (沟通任务)
  task list                           all tasks with current-cycle progress
  task show <id> [--cycle KEY]        detail: per-member links/status/summaries + cycle digest
  task create --title T --members 1,2,3|all [brief]
                                      create a task; brief from text arg or stdin;
                                      [--questions Q] [--deadline YYYY-MM-DD]
                                      [--digest-instruction I] [--probe-instruction P]
                                      oneshot only: [--auto-digest YYYY-MM-DDTHH:MM] [--close-on-digest true]
                                      recurring (implied by --cadence): --cadence daily|weekly|interval
                                                 [--dow 1,5] [--every N] [--anchor YYYY-MM-DD]
  task update <id> [--title T] [--questions Q] [--deadline D]
                   [--digest-instruction I] [--probe-instruction P] [--auto-digest ISO|none]
                   [--close-on-digest true|false] [--cadence ... --dow ... --every N] [brief]
  task links <id>                     per-member conversation links for a task
  task cycles <id>                    cycle keys a task has data/digests for
  task reset-link <taskId> <memberId> rotate one member's link for a task (old link dies)
  task digest <id> [--cycle KEY] [--close true|false]
                                      generate/overwrite a digest (recurring: per cycle)
  task close <id> | task reopen <id>  (closing the built-in daily pauses the standup)
  task remove <id>                    delete a non-builtin task and its links

Reports & settings
  report today | report <YYYY-MM-DD>  day digest (structured + transcripts)
  report history                      per-day submission counts
  settings get
  settings set [--model M] [--voice V] [--time-zone TZ] [--language zh|en] [--profile-model M] [--digest-model M]
               [--voice-provider S] [--profile-provider S] [--digest-provider S]
                                      models for 画像/汇总 + provider slug per slot + IANA time zone; '' reverts to default

API keys (v0.17)
  token list                          named management API keys (never shows secrets)
  token create <name>                 mint a named key — plaintext shown ONCE in the response
  token rotate <id>                   re-mint the secret for a key (old plaintext dies immediately)
  token revoke <id>                   revoke a key
                                      (rotate flow: create new -> switch clients -> revoke old)

Providers (v0.8)
  provider list
  provider add <name> --base-url URL [--slug S] [--api-key K] [--realtime true] [--models true]
  provider set <slug> [--name N] [--base-url URL] [--api-key K|--clear-api-key] [--realtime B] [--models B]
  provider remove <slug>              refused while referenced by a slot or builtin
  provider models <slug>              fetch the provider's /v1/models list
  provider test <slug> [--model M]    connectivity probe (with --model: one minimal completion)

All output is JSON. Long text is best piped via stdin:
  cat notes.md | cli.js member set-context 3
`;

function fail(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

/** Pull --flags out of argv (flags may appear anywhere). */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? '';
      i++;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

export function resolveTarget(flags, env, home) {
  if (flags.url && flags.key) return { url: flags.url, key: flags.key };
  if (env.ROUNDS_URL && env.ROUNDS_API_KEY) return { url: env.ROUNDS_URL, key: env.ROUNDS_API_KEY };
  // cli.json {url, apiKey} — remote/client mode. Searched in order:
  // $ROUNDS_HOME, ~/.rounds (portable client install), zylos component data dir.
  const dirs = [
    env.ROUNDS_HOME,
    path.join(home, '.rounds'),
    path.join(home, 'zylos/components/rounds'),
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, 'cli.json'), 'utf8'));
      if (c.url && c.apiKey) return { url: c.url, key: c.apiKey };
    } catch { /* keep searching */ }
  }
  return null;
}

function readStdin() {
  if (process.stdin.isTTY) return '';
  return fs.readFileSync(0, 'utf8');
}

/** Long-text argument: explicit arg wins, otherwise piped stdin. */
function textInput(arg) {
  return (arg !== undefined ? String(arg) : readStdin()).trim();
}

async function call(target, method, apiPath, body) {
  const url = `${target.url.replace(/\/+$/, '')}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${target.key}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`request failed: ${e.message} (${url})`);
  }
  if (res.status === 204) return {};
  let data;
  try {
    data = await res.json();
  } catch {
    fail(`non-JSON response (http ${res.status}) from ${url}`);
  }
  if (!res.ok) fail(`http ${res.status}: ${data.error || 'request failed'}`);
  return data;
}

const BRAIN_KEYS = { 'team-background': 'team_background', 'probing-guidance': 'probing_guidance', 'profile-instruction': 'profile_instruction' };

async function run(target, cmd, sub, args, flags) {
  const get = p => call(target, 'GET', p);
  const put = (p, b) => call(target, 'PUT', p, b);
  const post = (p, b) => call(target, 'POST', p, b);
  const del = p => call(target, 'DELETE', p);
  const id = v => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) fail(`invalid id: ${v}`);
    return n;
  };

  switch (`${cmd} ${sub}`) {
    case 'member list': return get('/api/members');
    case 'member add': {
      if (!args[0]) fail('usage: member add <name> [--language zh|en]');
      const body = { name: args[0] };
      if (flags.language !== undefined) body.language = flags.language;
      return post('/api/members', body);
    }
    case 'member remove': return del(`/api/members/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));
    case 'member set-context': return put(`/api/members/${id(args[0])}/context`, { context: textInput(args[1]) });
    case 'member set-profile': return put(`/api/members/${id(args[0])}/profile`, { profile: textInput(args[1]) });
    case 'member set-language': return put(`/api/members/${id(args[0])}/language`, { language: args[1] ?? '' });
    case 'member rename': {
      if (!args[0] || !args[1]) fail('usage: member rename <id> <new-name>');
      return put(`/api/members/${id(args[0])}/name`, { name: args.slice(1).join(' ') });
    }

    case 'brain get': return get('/api/context');
    case 'brain set': {
      const key = BRAIN_KEYS[args[0]];
      if (!key) fail('usage: brain set <team-background|probing-guidance|profile-instruction> [text]');
      return put('/api/context', { [key]: textInput(args[1]) });
    }

    case 'knowledge list': return get('/api/knowledge');
    case 'knowledge search': {
      if (!args.length) fail('usage: knowledge search <query...>');
      return get(`/api/knowledge/search?q=${encodeURIComponent(args.join(' '))}&limit=${flags.limit || 5}`);
    }
    case 'knowledge add': {
      if (!flags.title) fail('usage: knowledge add --title T [--tags G] [text|stdin]');
      const content = textInput(args[0]);
      if (!content) fail('knowledge content required (text arg or stdin)');
      return post('/api/knowledge', { title: flags.title, content, tags: flags.tags || '' });
    }
    case 'knowledge update': {
      const kid = id(args[0]);
      const existing = (await get('/api/knowledge')).knowledge.find(k => k.id === kid);
      if (!existing) fail(`knowledge ${kid} not found`);
      const content = textInput(args[1]) || existing.content;
      return put(`/api/knowledge/${kid}`, {
        title: flags.title ?? existing.title,
        content,
        tags: flags.tags ?? existing.tags,
      });
    }
    case 'knowledge remove': return del(`/api/knowledge/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));

    case 'followup list': {
      if (!flags.task) fail('usage: followup list --task <id>');
      return get(`/api/followups?task_id=${id(flags.task)}`);
    }
    case 'followup add': {
      if (!flags.task) fail('usage: followup add --task <id> [--scope team] [--by NAME] <text|stdin>');
      const content = textInput(args[0]);
      if (!content) fail('follow-up content required (text arg or stdin)');
      return post('/api/followups', {
        task_id: id(flags.task),
        content,
        scope: flags.scope === 'team' ? 'team' : 'private',
        author: flags.by || '',
      });
    }
    case 'followup remove': return del(`/api/followups/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));

    case 'task list': return get('/api/tasks');
    case 'task show': {
      const q = flags.cycle ? `?cycle=${encodeURIComponent(flags.cycle)}` : '';
      return get(`/api/tasks/${id(args[0])}${q}`);
    }
    case 'task create': {
      if (!flags.title) fail('usage: task create --title T --members 1,2,3|all [brief]');
      let memberIds;
      if (!flags.members || flags.members === 'all') {
        memberIds = (await get('/api/members')).members.map(mb => mb.id);
      } else {
        memberIds = flags.members.split(',').map(s => Number(s.trim())).filter(Boolean);
      }
      const body = { title: flags.title, member_ids: memberIds };
      if (flags.cadence) {
        body.type = 'recurring';
        body.cadence_type = flags.cadence;
        if (flags.dow) body.cadence_dow = flags.dow;
        if (flags.every) body.cadence_interval_days = Number(flags.every);
        if (flags.anchor) body.cadence_anchor = flags.anchor;
      }
      const brief = textInput(args[0]);
      if (brief) body.brief = brief;
      if (flags.questions) body.questions = flags.questions;
      if (flags.deadline) body.deadline = flags.deadline;
      if (flags['digest-instruction'] !== undefined) body.digest_instruction = flags['digest-instruction'];
      if (flags['probe-instruction'] !== undefined) body.probe_instruction = flags['probe-instruction'];
      if (flags['auto-digest']) body.digest_auto_at = flags['auto-digest'];
      if (flags['close-on-digest'] !== undefined) body.digest_close_linked = flags['close-on-digest'] !== 'false';
      return post('/api/tasks', body);
    }
    case 'task update': {
      const tid = id(args[0]);
      const body = {};
      if (flags.title) body.title = flags.title;
      if (flags.questions !== undefined) body.questions = flags.questions;
      if (flags.deadline !== undefined) body.deadline = flags.deadline;
      if (flags['digest-instruction'] !== undefined) body.digest_instruction = flags['digest-instruction'];
      if (flags['probe-instruction'] !== undefined) body.probe_instruction = flags['probe-instruction'];
      if (flags['auto-digest'] !== undefined) body.digest_auto_at = flags['auto-digest'] === 'none' ? '' : flags['auto-digest'];
      if (flags['close-on-digest'] !== undefined) body.digest_close_linked = flags['close-on-digest'] !== 'false';
      if (flags.cadence) {
        body.cadence_type = flags.cadence;
        if (flags.dow) body.cadence_dow = flags.dow;
        if (flags.every) body.cadence_interval_days = Number(flags.every);
        if (flags.anchor) body.cadence_anchor = flags.anchor;
      }
      const brief = textInput(args[1]);
      if (brief) body.brief = brief;
      if (!Object.keys(body).length) fail('nothing to update');
      return put(`/api/tasks/${tid}`, body);
    }
    case 'task links': {
      const t = await get(`/api/tasks/${id(args[0])}`);
      return {
        id: t.id, title: t.title, status: t.status, cycle_key: t.cycle_key,
        links: (t.members || []).map(mb => ({ member_id: mb.member_id, name: mb.name, link: mb.link })),
        test_member: t.test_member || undefined,
      };
    }
    case 'task cycles': {
      const t = await get(`/api/tasks/${id(args[0])}`);
      return { id: t.id, title: t.title, current_cycle_key: t.current_cycle_key ?? t.cycle_key, cycles: t.cycles || [] };
    }
    case 'task reset-link': {
      if (args.length < 2) fail('usage: task reset-link <taskId> <memberId>');
      return post(`/api/tasks/${id(args[0])}/members/${id(args[1])}/reset-token`, {});
    }
    case 'task digest': {
      const body = {};
      if (flags.cycle) body.cycle = flags.cycle;
      if (flags.close !== undefined) body.close = flags.close !== 'false';
      return post(`/api/tasks/${id(args[0])}/digest`, body);
    }
    case 'task close': return post(`/api/tasks/${id(args[0])}/close`, {});
    case 'task reopen': return post(`/api/tasks/${id(args[0])}/reopen`, {});
    case 'task remove': return del(`/api/tasks/${id(args[0])}`).then(() => ({ ok: true, removed: id(args[0]) }));

    case 'report today': {
      const date = (await get('/api/auth/me')).date;
      return get(`/api/reports/${date}`);
    }
    case 'report history': return get('/api/reports/history');

    case 'settings get': return get('/api/settings');
    case 'settings set': {
      const body = {};
      if (flags.model) body.model = flags.model;
      if (flags.voice) body.voice = flags.voice;
      if (flags['profile-model'] !== undefined) body.profile_model = flags['profile-model'];
      if (flags['digest-model'] !== undefined) body.digest_model = flags['digest-model'];
      if (flags['time-zone'] !== undefined) body.time_zone = flags['time-zone'];
      if (flags.language !== undefined) body.language = flags.language;
      for (const slot of ['voice', 'profile', 'digest']) {
        if (flags[`${slot}-provider`] !== undefined) body[`${slot}_provider`] = flags[`${slot}-provider`];
      }
      if (!Object.keys(body).length) fail('usage: settings set [--model M] [--voice V] [--time-zone TZ] [--profile-model M] [--digest-model M] [--voice-provider S] [--profile-provider S] [--digest-provider S]');
      return put('/api/settings', body);
    }

    case 'token list': return get('/api/tokens');
    case 'token create': {
      if (!args[0]) fail('usage: token create <name>');
      return post('/api/tokens', { name: args[0] });
    }
    case 'token rotate': return post(`/api/tokens/${id(args[0])}/rotate`, {});
    case 'token revoke': return del(`/api/tokens/${id(args[0])}`);

    case 'provider list': return get('/api/providers');
    case 'provider add': {
      const body = { name: args[0] };
      if (!body.name) fail('usage: provider add <name> --base-url URL [--slug S] [--api-key K] [--realtime true] [--models true]');
      if (flags['base-url']) body.base_url = flags['base-url'];
      if (flags.slug) body.slug = flags.slug;
      if (flags['api-key']) body.api_key = flags['api-key'];
      if (flags.realtime !== undefined) body.cap_realtime = flags.realtime !== 'false';
      if (flags.models !== undefined) body.cap_models = flags.models !== 'false';
      return post('/api/providers', body);
    }
    case 'provider set': {
      const slug = args[0] || fail('usage: provider set <slug> [--name N] [--base-url URL] [--api-key K|--clear-api-key] [--realtime true|false] [--models true|false]');
      const body = {};
      if (flags.name) body.name = flags.name;
      if (flags['base-url']) body.base_url = flags['base-url'];
      if (flags['clear-api-key'] !== undefined) body.clear_api_key = true;
      else if (flags['api-key'] !== undefined) body.api_key = flags['api-key'];
      if (flags.realtime !== undefined) body.cap_realtime = flags.realtime !== 'false';
      if (flags.models !== undefined) body.cap_models = flags.models !== 'false';
      return put(`/api/providers/${slug}`, body);
    }
    case 'provider remove': return del(`/api/providers/${args[0] || fail('usage: provider remove <slug>')}`).then(() => ({ ok: true, removed: args[0] }));
    case 'provider models': return get(`/api/providers/${args[0] || fail('usage: provider models <slug>')}/models`);
    case 'provider test': {
      const slug = args[0] || fail('usage: provider test <slug> [--model M]');
      return post(`/api/providers/${slug}/test`, flags.model ? { model: flags.model } : {});
    }

    default:
      if (cmd === 'report' && /^\d{4}-\d{2}-\d{2}$/.test(sub || '')) return get(`/api/reports/${sub}`);
      fail(`unknown command: ${cmd} ${sub || ''} (run with --help)`);
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  if (flags.help !== undefined || rest[0] === 'help' || !rest.length) {
    console.log(HELP);
    return;
  }
  if (flags.version !== undefined || rest[0] === 'version') {
    console.log(JSON.stringify({ name: 'rounds-client', version: CLIENT_VERSION }));
    return;
  }
  const target = resolveTarget(flags, process.env, process.env.HOME || '');
  if (!target) fail('no credentials: pass --url/--key, set ROUNDS_URL/ROUNDS_API_KEY, or provide cli.json in $ROUNDS_HOME, ~/.rounds/ or ~/zylos/components/rounds/');
  const out = await run(target, rest[0], rest[1], rest.slice(2), flags);
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => fail(e.message));
}
