#!/usr/bin/env node
// Makes one n8n instance match an activation manifest, through the public API.
// No dependencies, Node 20 or newer. Copy this one file into your pipeline.
//
//   N8N_API_KEY=... node apply-manifest.mjs --manifest activation.json --env prod --url https://n8n.example.com [--dry-run]
//
//   --manifest <file>    the manifest (JSON), see activation.example.json
//   --env <name>         which environment of the manifest this instance is
//   --url <address>      the instance, without /api/v1 (or N8N_URL)
//   --dry-run            show what would change, change nothing
//   --stale report       do not publish unpublished edits of an active workflow, only report them
//   --endpoints activate use POST /activate and /deactivate (n8n before /publish and /unpublish existed)
//   --check-triggers     also ask n8n whether the triggers of the active workflows really started
//                        (needs N8N_EMAIL and N8N_PASSWORD, see below)
//   --wait <seconds>     how long --check-triggers waits for triggers that are still starting (default 30)
//   --settle <seconds>   pause between the last unpublish and the first publish (default 3)
//   --json               print the report as JSON
//   --page-size <n>      workflows per list request (default 100, at most 250)
//
// Only reads retry a dropped connection. A write without a response may
// already have taken effect; it is not retried by the CLI.
//
// The API key comes from N8N_API_KEY. Scopes: workflow:list, workflow:activate,
// workflow:deactivate.
//
// --check-triggers: on n8n 2.47.7 the publish call answers 200 before the
// triggers are started, and the public API never says whether they did. Only
// the editor's own route GET /rest/workflows/{id}/publication-status does, and
// it takes a login session, not an API key. With N8N_EMAIL and N8N_PASSWORD of
// a user who can see the workflows, the tool logs in and reads it.
//
// Exit code: 0 the instance matches the manifest (after applying, or already)
//            1 something failed or the manifest was refused
//            2 --dry-run only: changes are pending

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// What to do so that `workflows` (the instance's list from GET /workflows)
// matches `manifest` for `environment`. Pure: no network, no clock. The apply
// workflow runs this same function in a Code node, so it uses nothing from
// outside its own body.
export function plan(manifest, environment, workflows, options = {}) {
  const errors = [];
  const rows = [];
  const fail = (message) => (errors.push(message), { errors, rows: [], actions: [] });
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  if (!isObject(manifest)) return fail('the manifest is not a JSON object');
  const environments = manifest.environments;
  if (!Array.isArray(environments) || environments.length === 0 || environments.some((name) => typeof name !== 'string' || !name)) {
    return fail('"environments" must list the environment names, for example ["dev", "test", "prod"]');
  }
  if (!environments.includes(environment)) return fail(`environment "${environment}" is not in "environments" (${environments.join(', ')})`);

  const fallback = manifest.default ?? 'inactive';
  // No way to say "everything else is active": a workflow goes live by being listed.
  if (!['inactive', 'ignore'].includes(fallback)) return fail('"default" must be "inactive" or "ignore"');
  const matchBy = manifest.matchBy ?? 'id';
  if (!['id', 'name'].includes(matchBy)) return fail('"matchBy" must be "id" or "name"');
  const stale = options.stale ?? manifest.stale ?? 'publish';
  if (!['publish', 'report'].includes(stale)) return fail('"stale" must be "publish" or "report"');
  if (!isObject(manifest.workflows)) return fail('"workflows" must be an object: workflow id (or name) → state per environment');

  // Read every entry before touching anything: one bad entry refuses the whole manifest.
  const wanted = [];
  for (const [key, entry] of Object.entries(manifest.workflows)) {
    if (!isObject(entry)) {
      errors.push(`"${key}": must be an object such as { "prod": "active" }`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (field !== 'name' && field !== 'note' && !environments.includes(field)) errors.push(`"${key}": "${field}" is not an environment (${environments.join(', ')})`);
    }
    const value = entry[environment];
    const listed = value !== undefined;
    const state = isObject(value) ? value.state : (value ?? fallback);
    const versionId = isObject(value) ? value.versionId : undefined;
    if (!['active', 'inactive', 'ignore'].includes(state)) errors.push(`"${key}": state for ${environment} must be "active", "inactive" or "ignore"`);
    if (versionId !== undefined && (typeof versionId !== 'string' || !versionId || state !== 'active')) errors.push(`"${key}": "versionId" must be a version id and goes with "state": "active"`);
    wanted.push({ key, label: entry.name, state, versionId: versionId ?? null, listed });
  }

  const published = (workflow) => ('activeVersionId' in workflow ? workflow.activeVersionId !== null : workflow.active === true);
  const before = (workflow) => ({ active: published(workflow), versionId: workflow.versionId ?? null, activeVersionId: workflow.activeVersionId ?? null });
  const matched = new Set();

  for (const want of wanted) {
    const found = workflows.filter((workflow) => (matchBy === 'id' ? String(workflow.id) === want.key : workflow.name === want.key));
    if (found.length > 1) errors.push(`"${want.key}": ${found.length} workflows on this instance have that name (${found.map((workflow) => workflow.id).join(', ')})`);
    const workflow = found[0];
    const row = { key: want.key, id: workflow ? String(workflow.id) : null, name: workflow?.name ?? want.label ?? null, listed: true, desired: want.state, pinned: want.versionId, before: workflow ? before(workflow) : null, action: null, versionId: null, status: 'ok', problem: null };
    rows.push(row);
    if (!workflow) {
      // Listed as active but not here: the pull did not bring it, or the id is wrong.
      row.status = want.state === 'active' ? 'missing' : 'absent';
      if (want.state === 'active') row.problem = 'listed as active, but no such workflow on this instance';
      continue;
    }
    matched.add(String(workflow.id));
    if (options.self && String(workflow.id) === options.self) {
      row.status = 'self';
      continue;
    }
    if (want.state === 'ignore') {
      row.status = 'ignored';
    } else if (want.state === 'inactive') {
      if (row.before.active) Object.assign(row, { action: 'unpublish', status: 'deactivate' });
    } else if (workflow.isArchived) {
      Object.assign(row, { status: 'archived', problem: 'listed as active, but the workflow is archived' });
    } else if (!row.before.active) {
      Object.assign(row, { action: 'publish', versionId: want.versionId, status: 'activate' });
    } else if (want.versionId && row.before.activeVersionId !== want.versionId) {
      Object.assign(row, { action: 'publish', versionId: want.versionId, status: 'switch_version' });
    } else if (!want.versionId && row.before.activeVersionId && row.before.versionId && row.before.activeVersionId !== row.before.versionId) {
      // Active, but the published version is not the latest one: what a pull
      // with autoPublish "none" leaves behind for an already published workflow.
      if (stale === 'publish') Object.assign(row, { action: 'publish', status: 'publish_latest' });
      else Object.assign(row, { status: 'stale', problem: 'active, but the published version is not the latest version' });
    }
  }

  // Everything on the instance that the manifest does not mention.
  for (const workflow of workflows) {
    const id = String(workflow.id);
    if (matched.has(id)) continue;
    const row = { key: null, id, name: workflow.name ?? null, listed: false, desired: fallback, pinned: null, before: before(workflow), action: null, versionId: null, status: 'unlisted', problem: null };
    if (options.self && id === options.self) row.status = 'self';
    else if (fallback === 'ignore') row.status = row.before.active ? 'unlisted_active' : 'unlisted';
    else if (row.before.active) Object.assign(row, { action: 'unpublish', status: 'deactivate_unlisted' });
    else if (workflow.isArchived) continue;
    rows.push(row);
  }

  if (errors.length > 0) return { errors, rows: [], actions: [] };
  // Unpublish first, so a workflow that takes over a webhook path from another
  // one finds the path free.
  const actions = [...rows.filter((row) => row.action === 'unpublish'), ...rows.filter((row) => row.action === 'publish')].map((row) => ({ id: row.id, action: row.action, versionId: row.versionId }));
  return { errors, rows, actions };
}

// Puts the answers of the API calls (`results`: id → { status, message }) and
// the instance's list after applying (`after`) onto the plan. Pure as well.
// `health`: id → { status, errors } from the editor's publication-status, or
// nothing when it was not asked for.
export function settle(planned, results, after, dryRun, health = {}) {
  const byId = new Map((after ?? []).map((workflow) => [String(workflow.id), workflow]));
  const published = (workflow) => ('activeVersionId' in workflow ? workflow.activeVersionId !== null : workflow.active === true);
  const rows = planned.rows.map((row) => {
    const out = { ...row, result: row.action ? 'planned' : 'none', error: null, after: row.before };
    const check = (final) => {
      const seen = health[row.id];
      if (!seen || row.desired !== 'active' || !final?.active) return;
      out.triggers = seen.status;
      if (seen.status !== 'published') out.problem = `published, but n8n reports its triggers as "${seen.status}"${seen.errors.length ? `: ${seen.errors.join('; ')}` : ''}`;
    };
    if (!row.action || dryRun) return check(row.before), out;
    const answer = results[row.id];
    const now = byId.get(row.id);
    out.after = now ? { active: published(now), versionId: now.versionId ?? null, activeVersionId: now.activeVersionId ?? null } : null;
    const accepted = answer && answer.status >= 200 && answer.status < 300;
    // Do not take the 200 for it: read the workflow again and compare.
    const target = row.versionId ?? out.after?.versionId;
    const reached = out.after !== null && (row.action === 'unpublish' ? !out.after.active : out.after.active && (!out.after.activeVersionId || out.after.activeVersionId === target));
    if (accepted && reached) {
      out.result = 'applied';
      check(out.after);
    } else {
      out.result = 'failed';
      out.error = accepted ? 'the API accepted the call, but the workflow is not in the wanted state afterwards' : answer ? `HTTP ${answer.status}: ${answer.message}` : 'no answer';
    }
    return out;
  });
  const count = (test) => rows.filter(test).length;
  const summary = {
    inSync: count((row) => !row.action && !row.problem && row.listed && row.status === 'ok'),
    changed: count((row) => row.result === 'applied'),
    pending: count((row) => row.result === 'planned'),
    failed: count((row) => row.result === 'failed'),
    problems: count((row) => row.problem && row.result !== 'failed'),
    unlisted: count((row) => !row.listed && row.status !== 'self'),
  };
  const ok = planned.errors.length === 0 && summary.failed === 0 && summary.problems === 0;
  return { ok, drift: summary.pending > 0 || summary.problems > 0, dryRun: Boolean(dryRun), errors: planned.errors, summary, rows };
}

// --- the command line ---------------------------------------------------------

function parse(argv) {
  const args = { stale: undefined, endpoints: 'publish', pageSize: 100, wait: 30, settle: 3 };
  const names = { '--manifest': 'manifest', '--env': 'env', '--url': 'url', '--stale': 'stale', '--endpoints': 'endpoints', '--page-size': 'pageSize', '--wait': 'wait', '--settle': 'settle' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--check-triggers') args.checkTriggers = true;
    else if (names[arg] && argv[i + 1] !== undefined) args[names[arg]] = argv[++i];
    else throw new Error(`unknown or incomplete option ${arg}`);
  }
  args.url = (args.url ?? process.env.N8N_URL ?? '').replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  args.pageSize = Number(args.pageSize);
  args.wait = Number(args.wait);
  args.settle = Number(args.settle);
  if (!(args.wait >= 0) || !(args.settle >= 0)) throw new Error('--wait and --settle must be a number of seconds');
  if (!args.manifest || !args.env || !args.url) throw new Error('--manifest, --env and --url (or N8N_URL) are required');
  if (!['publish', 'activate'].includes(args.endpoints)) throw new Error('--endpoints must be "publish" or "activate"');
  if (!(args.pageSize >= 1 && args.pageSize <= 250)) throw new Error('--page-size must be 1 to 250');
  return args;
}

// Reads may recover from a dropped connection. A lost write response does not
// say whether the server applied it. A repeated publish can restart triggers
// even when the final published version is unchanged.
export async function request(url, init = {}, attempts = 4) {
  const method = (init.method ?? 'GET').toUpperCase();
  const retryRead = method === 'GET' || method === 'HEAD';
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (!retryRead || error?.name === 'TimeoutError' || error?.name === 'AbortError' || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
}

function client(url, key) {
  const call = async (method, path, body) => {
    const response = await request(`${url}/api/v1${path}`, {
      method,
      headers: { 'x-n8n-api-key': key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, json, message: json?.message ?? text.slice(0, 300) };
  };
  return {
    async list(pageSize) {
      const all = [];
      let cursor = '';
      do {
        const page = await call('GET', `/workflows?limit=${pageSize}&excludePinnedData=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (page.status !== 200) throw new Error(`GET /workflows answered HTTP ${page.status}: ${page.message}`);
        all.push(...page.json.data);
        cursor = page.json.nextCursor;
      } while (cursor);
      return all;
    },
    publish: (id, versionId, endpoints) => call('POST', `/workflows/${encodeURIComponent(id)}/${endpoints === 'activate' ? 'activate' : 'publish'}`, versionId ? { versionId } : {}),
    unpublish: (id, endpoints) => call('POST', `/workflows/${encodeURIComponent(id)}/${endpoints === 'activate' ? 'deactivate' : 'unpublish'}`),
  };
}

// The editor's view of a published workflow: "published", "in_progress",
// "failed" or "not_published", with the error of each trigger that failed.
// Not part of the public API: it is what the editor itself calls.
async function session(url, email, password) {
  const headers = { 'browser-id': 'apply-manifest', 'content-type': 'application/json' };
  const login = await request(`${url}/rest/login`, { method: 'POST', headers, body: JSON.stringify({ emailOrLdapLoginId: email, password }) });
  if (login.status !== 200) throw new Error(`login for --check-triggers answered HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return async (id, waitSeconds) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const response = await request(`${url}/rest/workflows/${encodeURIComponent(id)}/publication-status`, { headers: { ...headers, cookie } });
      if (response.status !== 200) return { status: `unknown (HTTP ${response.status})`, errors: [] };
      const { data } = await response.json();
      if (data.status !== 'in_progress' || Date.now() >= deadline) return { status: data.status, errors: (data.triggers ?? []).map((trigger) => trigger.errorMessage).filter(Boolean) };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
}

export async function apply({ manifest, env, url, apiKey, dryRun = false, stale, endpoints = 'publish', pageSize = 100, login = null, wait = 30, settleSeconds = 3 }) {
  const api = client(url, apiKey);
  const planned = plan(manifest, env, await api.list(pageSize), { stale });
  const results = {};
  if (!dryRun) {
    let unpublished = false;
    for (const step of planned.actions) {
      try {
        // Unpublish answers before n8n has taken the webhooks down. A publish
        // of a workflow with the same webhook path that comes too early gets a
        // 409, and on n8n 2.47.7 keeps getting it afterwards. So wait once.
        if (step.action === 'publish' && unpublished && settleSeconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));
          unpublished = false;
        }
        const answer = step.action === 'publish' ? await api.publish(step.id, step.versionId, endpoints) : await api.unpublish(step.id, endpoints);
        if (step.action === 'unpublish') unpublished = true;
        results[step.id] = { status: answer.status, message: answer.message };
      } catch (error) {
        results[step.id] = { status: 0, message: `write outcome unknown; not retried. Check the observed state before reapplying (${String(error.message ?? error)})` };
      }
    }
  }
  const after = dryRun || planned.actions.length === 0 ? null : await api.list(pageSize);
  const health = {};
  if (login && planned.errors.length === 0) {
    const statusOf = await session(url, login.email, login.password);
    const live = new Set((after ?? []).filter((workflow) => workflow.activeVersionId).map((workflow) => String(workflow.id)));
    for (const row of planned.rows) {
      if (row.desired === 'active' && row.id && (after ? live.has(row.id) : row.before.active)) health[row.id] = await statusOf(row.id, wait);
    }
  }
  return { environment: env, ...settle(planned, results, after, dryRun, health) };
}

const LABELS = {
  ok: 'in sync',
  activate: 'activate',
  switch_version: 'publish the pinned version',
  publish_latest: 'publish the latest version',
  deactivate: 'deactivate',
  deactivate_unlisted: 'deactivate (not in the manifest)',
  stale: 'STALE',
  missing: 'MISSING',
  archived: 'ARCHIVED',
  absent: 'not on this instance',
  ignored: 'ignored',
  unlisted: 'not in the manifest, inactive',
  unlisted_active: 'NOT IN THE MANIFEST, ACTIVE (left alone: default is "ignore")',
  self: 'this tool, left alone',
};

export function text(report) {
  const lines = [`${report.environment}${report.dryRun ? ' (dry run, nothing changed)' : ''}`];
  for (const error of report.errors) lines.push(`  refused: ${error}`);
  for (const row of report.rows) {
    const state = row.before ? (row.before.active ? 'active' : 'inactive') : '-';
    const outcome = [row.result === 'applied' ? 'done' : row.result === 'failed' ? `FAILED: ${row.error}` : row.result === 'planned' ? 'would do' : '', row.problem ? `PROBLEM: ${row.problem}` : ''].filter(Boolean).join('; ');
    lines.push(`  ${(row.id ?? row.key).padEnd(18)} ${String(row.name ?? '').slice(0, 28).padEnd(28)} ${state.padEnd(8)} → ${row.desired.padEnd(8)} ${LABELS[row.status] ?? row.status}${outcome ? `  [${outcome}]` : ''}`);
  }
  const s = report.summary;
  lines.push(`  ${s.inSync} in sync, ${s.changed} changed, ${s.pending} pending, ${s.failed} failed, ${s.problems} problems, ${s.unlisted} not in the manifest`);
  lines.push(report.ok ? (report.drift ? '  drift: the instance does not match the manifest yet' : '  ok: the instance matches the manifest') : '  NOT OK');
  return lines.join('\n');
}

async function main() {
  const args = parse(process.argv.slice(2));
  const apiKey = process.env.N8N_API_KEY;
  if (!apiKey) throw new Error('set N8N_API_KEY');
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  let login = null;
  if (args.checkTriggers) {
    if (!process.env.N8N_EMAIL || !process.env.N8N_PASSWORD) throw new Error('--check-triggers needs N8N_EMAIL and N8N_PASSWORD');
    login = { email: process.env.N8N_EMAIL, password: process.env.N8N_PASSWORD };
  }
  const report = await apply({ manifest, env: args.env, url: args.url, apiKey, dryRun: args.dryRun, stale: args.stale, endpoints: args.endpoints, pageSize: args.pageSize, login, wait: args.wait, settleSeconds: args.settle });
  console.log(args.json ? JSON.stringify(report, null, 2) : text(report));
  return !report.ok ? 1 : report.dryRun && report.drift ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`apply-manifest: ${error.message}`);
      process.exit(1);
    },
  );
}
