// End-to-end tests: apply-manifest.mjs and the apply workflow against two real
// n8n instances that stand in for TEST and PROD (npm run test:e2e).
//
// Both instances imported the same workflow files with the same ids and
// nothing is published, the way workflows arrive from a Git pull. Workflows
// that "arrive with a later pull" are imported into the running containers
// with the n8n CLI. Every lab workflow has a webhook that answers which
// workflow and which version of it is live, so "active" is checked by calling
// it, not only by reading the API.
//
// The tests run in order and build on each other.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { apply, request } from '../apply-manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const URLS = { test: process.env.TEST_URL ?? 'http://localhost:55689', prod: process.env.PROD_URL ?? 'http://localhost:55690' };
const OWNER = { email: 'owner@example.com', firstName: 'Lab', lastName: 'Owner', password: 'Lab-owner-1234' };
const COMPOSE = ['compose', '--env-file', 'test/test.env', '-f', 'docker-compose.yml', '-f', 'test/docker-compose.yml', '-p', 'activation-test'];
const TOKEN = 'test-apply-token';

const APPLY = 'amApply000000001';
const ORDERS = 'amOrders00000001';
const RECONCILE = 'amReconcile00001';
const SMOKE = 'amSmoke000000001';
const WIP = 'amWip00000000001';
const INVOICES = 'amInvoices000001';
const ORDERS_NEXT = 'amOrdersNext0001';
const NO_TRIGGER = 'amNoTrigger00001';
const NO_CREDENTIAL = 'amNoCredential01';
const BAD_CRON = 'amBadCron0000001';
const UNREACHABLE = 'amUnreachable001';
const TWIN_ONE = 'amTwinOne0000001';
const GHOST = 'amGhost000000001';

const keys = { test: {}, prod: {} };
const cookies = {};
const scratch = mkdtempSync(join(tmpdir(), 'activation-manifest-'));
const findings = [];
const finding = (what, measured) => findings.push({ what, measured });

// The manifest the tests keep changing, as a team would in Git.
const manifest = {
  environments: ['test', 'prod'],
  default: 'inactive',
  workflows: {
    [APPLY]: { name: 'Apply activation manifest', test: 'active', prod: 'active' },
    [ORDERS]: { name: 'Order intake', test: 'active', prod: 'active' },
    [RECONCILE]: { name: 'Daily reconciliation', prod: 'active' },
    [SMOKE]: { name: 'Smoke test', test: 'active', prod: 'inactive' },
  },
};
const copy = (value) => JSON.parse(JSON.stringify(value));

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
};

async function until(check, timeoutMs = 30_000, what = 'the condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// --- docker ---------------------------------------------------------------------

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `docker ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
const compose = (args, options) => docker([...COMPOSE, ...args], options);
// A workflow file "arrives": imported with the same id on the running instance,
// unpublished. Only used for workflows the instance does not have yet.
const arrive = async (env, ...files) => {
  for (const file of files) compose(['exec', '-T', env, 'n8n', 'import:workflow', `--input=/bootstrap/lab/later/${file}.json`]);
  await ready(env);
};

// Every call of the tests goes through this: a connection that drops before
// an answer came is tried again (the import above takes seconds, and n8n
// closes idle keep-alive connections meanwhile).
const http = (url, init) => request(url, init, 6);
// n8n answers and says it is ready. Connection errors and the "starting up"
// answer both mean: not yet.
const ready = (env) => until(async () => (await fetch(`${URLS[env]}/healthz/readiness`, { signal: AbortSignal.timeout(5_000) })).status === 200, 180_000, `${env} to be ready`);

// --- n8n ----------------------------------------------------------------------------

const api = async (env, method, path, body) => {
  const response = await http(`${URLS[env]}/api/v1${path}`, {
    method,
    headers: { 'x-n8n-api-key': keys[env].harness, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response) };
};
const rest = async (env, method, path, body, headers = { cookie: cookies[env] }) => {
  const response = await http(`${URLS[env]}/rest${path}`, {
    method,
    headers: { 'browser-id': 'lab', 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await json(response), headers: response.headers };
};

const workflow = async (env, id) => (await api(env, 'GET', `/workflows/${id}`)).body;
const events = async (env, id) => ((await workflow(env, id)).activeVersion?.workflowPublishHistory ?? []).length;
// id → true/false for every workflow of the instance.
async function active(env) {
  const { body } = await api(env, 'GET', '/workflows?limit=250&excludePinnedData=true');
  return Object.fromEntries(body.data.map((item) => [item.id, item.activeVersionId !== null]));
}
const activeIds = async (env) => Object.entries(await active(env)).filter(([, on]) => on).map(([id]) => id).sort();

// What the lab webhook says: { status, workflow, version }.
async function called(env, slug) {
  const response = await http(`${URLS[env]}/webhook/lab/${slug}`);
  const body = await json(response);
  return { status: response.status, workflow: body.workflow, version: body.version };
}
// Publishing answers before the webhook is registered, so wait for it.
const live = (env, slug, want = {}) =>
  until(async () => {
    const answer = await called(env, slug);
    return answer.status === 200 && (!want.workflow || answer.workflow === want.workflow) && (!want.version || answer.version === want.version) ? answer : null;
  }, 20_000, `${env} /webhook/lab/${slug} to answer ${JSON.stringify(want)}`);
const gone = (env, slug) => until(async () => (await called(env, slug)).status === 404, 20_000, `${env} /webhook/lab/${slug} to be gone`);

// Saves a new version without publishing it, the way the editor's Save does.
async function saveDraft(env, id, version) {
  const current = (await rest(env, 'GET', `/workflows/${id}`)).body.data;
  for (const node of current.nodes) {
    if (node.name === 'Answer') node.parameters.assignments.assignments.find((entry) => entry.name === 'version').value = version;
  }
  const saved = await rest(env, 'PATCH', `/workflows/${id}`, { nodes: current.nodes, connections: current.connections, versionId: current.versionId });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  return saved.body.data;
}

// --- the tool -------------------------------------------------------------------------

// As a library, with the tool's own key (three scopes).
const run = (env, document = manifest, options = {}) => apply({ manifest: document, env, url: URLS[env], apiKey: keys[env].tool, ...options });
const rowOf = (report, id) => report.rows.find((row) => row.id === id || row.key === id);
const statuses = (report, ids) => Object.fromEntries(ids.map((id) => [id, rowOf(report, id)?.status]));

// As the command line, the way a pipeline runs it.
function cli(env, document, ...args) {
  return cliAs(env, env, document, ...args);
}
// `instance`: which n8n is called. `env`: what --env says.
function cliAs(instance, env, document, ...args) {
  const file = join(scratch, `manifest-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(document));
  const result = spawnSync(process.execPath, ['apply-manifest.mjs', '--manifest', file, '--env', env, '--url', URLS[instance], '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, N8N_API_KEY: keys[instance].tool, N8N_EMAIL: OWNER.email, N8N_PASSWORD: OWNER.password },
  });
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {}
  return { code: result.status, report, stderr: result.stderr };
}

// The apply workflow, over its webhook.
async function webhook(env, body, token = TOKEN) {
  const response = await http(`${URLS[env]}/webhook/activation-manifest/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-apply-token': token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await json(response) };
}

before(async () => {
  for (const env of ['test', 'prod']) {
    await ready(env);

    // Owner and API keys through n8n's own endpoints, the ones the first-run
    // screen and Settings > n8n API use.
    let response = await rest(env, 'POST', '/owner/setup', OWNER, {});
    if (response.status !== 200) response = await rest(env, 'POST', '/login', { emailOrLdapLoginId: OWNER.email, password: OWNER.password }, {});
    assert.equal(response.status, 200, 'owner setup or login');
    cookies[env] = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

    // The key of the test itself.
    const harness = await rest(env, 'POST', '/api-keys', { label: `harness-${Date.now()}`, expiresAt: null, scopes: ['workflow:read', 'workflow:list', 'workflow:activate', 'workflow:deactivate', 'workflow:delete'] });
    assert.equal(harness.status, 200, JSON.stringify(harness.body).slice(0, 300));
    keys[env].harness = harness.body.data.rawApiKey;

    // The key of the tool: only what it needs. The same key goes into the
    // credential of the apply workflow, which bootstrap.sh created empty.
    const tool = await rest(env, 'POST', '/api-keys', { label: `tool-${Date.now()}`, expiresAt: null, scopes: ['workflow:list', 'workflow:activate', 'workflow:deactivate'] });
    assert.equal(tool.status, 200, JSON.stringify(tool.body).slice(0, 300));
    keys[env].tool = tool.body.data.rawApiKey;
    const credential = [{ id: 'amN8nApiKey00001', name: 'Activation manifest n8n API key', type: 'n8nApi', data: { apiKey: keys[env].tool, baseUrl: 'http://127.0.0.1:5678/api/v1' } }];
    compose(['exec', '-T', env, 'sh', '-c', 'cat > /tmp/credential.json && n8n import:credentials --input=/tmp/credential.json && rm /tmp/credential.json'], { input: JSON.stringify(credential) });
    await ready(env);
  }
});

after(() => {
  console.log('\nMeasured on this run:');
  for (const { what, measured } of findings) console.log(`- ${what}: ${measured}`);
});

test('the starting point: same ids on both instances, nothing published but the apply workflow', async () => {
  for (const env of ['test', 'prod']) assert.deepEqual(await activeIds(env), [APPLY]);
  const [onTest, onProd] = [await workflow('test', ORDERS), await workflow('prod', ORDERS)];
  assert.equal(onTest.id, onProd.id);
  assert.equal(onTest.active, false);
  assert.equal(onTest.activeVersionId, null);
  finding('A workflow that was imported and never published', `active ${onTest.active}, activeVersionId ${onTest.activeVersionId}, versionId set`);
  // The stand-in differs from a real pull here: `n8n import:workflow` gives each instance its own versionId.
  finding('versionId of the same file imported with the n8n CLI on two instances', onTest.versionId === onProd.versionId ? 'the same' : 'different on each instance');
});

test('the API: what publish, unpublish, activate and deactivate answer', async () => {
  const publish = await api('test', 'POST', `/workflows/${WIP}/publish`, {});
  assert.equal(publish.status, 200);
  assert.equal(publish.body.active, true);
  assert.equal(publish.body.activeVersionId, publish.body.versionId);
  // The call has answered. Is the webhook there yet?
  const atOnce = (await called('test', 'wip')).status;
  const started = Date.now();
  await live('test', 'wip');
  finding('POST /workflows/{id}/publish on an unpublished workflow', `200, active true, activeVersionId = versionId. Its webhook answered ${atOnce} right after the call${atOnce === 200 ? '' : ` and 200 ${Date.now() - started} ms later: publish answers before the triggers are started`}`);

  // Publishing what is already published is not a no-op: n8n takes it down and up again.
  const eventsBefore = await events('test', WIP);
  const again = await api('test', 'POST', `/workflows/${WIP}/publish`, {});
  assert.equal(again.status, 200);
  assert.equal(again.body.activeVersionId, publish.body.activeVersionId);
  const added = (await events('test', WIP)) - eventsBefore;
  assert.equal(added, 2, 'a deactivated and an activated event');
  finding('The same call on a workflow that is already published at that version', `200, same activeVersionId, and ${added} more entries in its publish history (deactivated, activated): n8n restarts it`);
  await live('test', 'wip');

  const legacy = await api('test', 'POST', `/workflows/${WIP}/activate`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.activeVersionId, publish.body.activeVersionId);
  finding('POST /workflows/{id}/activate (marked deprecated in the 2.47.7 API description)', '200, same answer as /publish');

  const unpublish = await api('test', 'POST', `/workflows/${WIP}/unpublish`);
  assert.equal(unpublish.status, 200);
  assert.equal(unpublish.body.active, false);
  assert.equal(unpublish.body.activeVersionId, null);
  await gone('test', 'wip');
  const twice = await api('test', 'POST', `/workflows/${WIP}/unpublish`);
  const legacyOff = await api('test', 'POST', `/workflows/${WIP}/deactivate`);
  assert.equal(twice.status, 200);
  assert.equal(legacyOff.status, 200);
  finding('POST /workflows/{id}/unpublish, and again, and /deactivate, on a workflow that is already off', `200, active false, activeVersionId null, every time`);

  const missing = await api('test', 'POST', `/workflows/${GHOST}/publish`, {});
  assert.equal(missing.status, 404);
  finding('Publish a workflow id that does not exist', `${missing.status} "${missing.body.message}"`);
});

test('dry run: each environment gets its own plan from the same manifest, nothing changes', async () => {
  const onTest = cli('test', manifest, '--dry-run');
  const onProd = cli('prod', manifest, '--dry-run');
  assert.equal(onTest.code, 2, onTest.stderr);
  assert.equal(onProd.code, 2, onProd.stderr);
  assert.deepEqual(statuses(onTest.report, [APPLY, ORDERS, RECONCILE, SMOKE, WIP]), { [APPLY]: 'ok', [ORDERS]: 'activate', [RECONCILE]: 'ok', [SMOKE]: 'activate', [WIP]: 'unlisted' });
  assert.deepEqual(statuses(onProd.report, [APPLY, ORDERS, RECONCILE, SMOKE, WIP]), { [APPLY]: 'ok', [ORDERS]: 'activate', [RECONCILE]: 'activate', [SMOKE]: 'ok', [WIP]: 'unlisted' });
  assert.equal(onProd.report.summary.pending, 2);
  assert.equal(onProd.report.drift, true);
  for (const env of ['test', 'prod']) assert.deepEqual(await activeIds(env), [APPLY]);
});

test('apply: TEST and PROD end up different, as the manifest says', async () => {
  const onTest = cli('test', manifest);
  const onProd = cli('prod', manifest);
  assert.equal(onTest.code, 0, onTest.stderr);
  assert.equal(onProd.code, 0, onProd.stderr);
  assert.equal(onTest.report.summary.changed, 2);
  assert.equal(onProd.report.summary.changed, 2);
  assert.deepEqual(await activeIds('test'), [APPLY, ORDERS, SMOKE].sort());
  assert.deepEqual(await activeIds('prod'), [APPLY, ORDERS, RECONCILE].sort());

  // And the triggers agree.
  await live('test', 'orders');
  await live('test', 'smoke');
  await live('prod', 'orders');
  await live('prod', 'reconcile');
  assert.equal((await called('test', 'reconcile')).status, 404);
  assert.equal((await called('prod', 'smoke')).status, 404);
  assert.equal((await called('prod', 'wip')).status, 404);
});

test('a second run changes nothing and does not restart anything', async () => {
  const eventsBefore = await events('prod', ORDERS);
  for (const env of ['test', 'prod']) {
    const again = cli(env, manifest);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.report.summary.changed, 0);
    assert.equal(again.report.summary.pending, 0);
    assert.equal(again.report.drift, false);
    assert.equal(cli(env, manifest, '--dry-run').code, 0);
  }
  assert.equal(await events('prod', ORDERS), eventsBefore, 'no publish call was made for a workflow that is already right');
});

test('a workflow switched on by hand that the manifest does not list is switched off again', async () => {
  // Somebody activates the work-in-progress workflow on PROD.
  assert.equal((await api('prod', 'POST', `/workflows/${WIP}/publish`, {})).status, 200);
  await live('prod', 'wip');

  const dry = await run('prod', manifest, { dryRun: true });
  assert.equal(rowOf(dry, WIP).status, 'deactivate_unlisted');
  assert.equal(dry.drift, true);

  const applied = await run('prod');
  assert.equal(rowOf(applied, WIP).result, 'applied');
  assert.equal(applied.ok, true);
  assert.equal((await active('prod'))[WIP], false);
  await gone('prod', 'wip');

  // With "default": "ignore" the tool leaves it alone and says so.
  assert.equal((await api('prod', 'POST', `/workflows/${WIP}/publish`, {})).status, 200);
  const ignoring = await run('prod', { ...copy(manifest), default: 'ignore' });
  assert.equal(rowOf(ignoring, WIP).status, 'unlisted_active');
  assert.equal(ignoring.summary.changed, 0);
  assert.equal((await active('prod'))[WIP], true);
  assert.equal((await run('prod')).summary.changed, 1);
  assert.equal((await active('prod'))[WIP], false);
});

test('a newly arrived workflow stays off on both until the manifest lists it', async () => {
  await arrive('test', 'invoice-export');
  await arrive('prod', 'invoice-export');
  for (const env of ['test', 'prod']) {
    const report = await run(env);
    assert.equal(rowOf(report, INVOICES).status, 'unlisted');
    assert.equal(report.summary.changed, 0);
    assert.equal(report.ok, true);
    assert.equal((await active(env))[INVOICES], false);
  }

  // The business signs it off for PROD only.
  manifest.workflows[INVOICES] = { name: 'Invoice export', prod: 'active' };
  assert.equal(rowOf(await run('test'), INVOICES).status, 'ok');
  assert.equal(rowOf(await run('prod'), INVOICES).result, 'applied');
  assert.equal((await active('test'))[INVOICES], false);
  assert.equal((await active('prod'))[INVOICES], true);
  await live('prod', 'invoices');
  assert.equal((await called('test', 'invoices')).status, 404);
});

test('a workflow removed from the manifest is deactivated at the next run', async () => {
  const smoke = manifest.workflows[SMOKE];
  delete manifest.workflows[SMOKE];
  const report = await run('test');
  assert.equal(rowOf(report, SMOKE).status, 'deactivate_unlisted');
  assert.equal(rowOf(report, SMOKE).result, 'applied');
  assert.equal((await active('test'))[SMOKE], false);
  await gone('test', 'smoke');
  manifest.workflows[SMOKE] = smoke;
  assert.equal((await run('test')).summary.changed, 1);
  await live('test', 'smoke');
});

test('a manifest with a mistake is refused as a whole, and a listed workflow that is not there fails the run', async () => {
  const stateBefore = await active('prod');
  const refuse = async (env, document, pattern) => {
    const result = cliAs('prod', env, document);
    assert.equal(result.code, 1);
    assert.equal(result.report.rows.length, 0, 'no plan at all');
    assert.match(result.report.errors.join('\n'), pattern);
  };
  // A typo in the environment name would otherwise deactivate everything.
  await refuse('prd', manifest, /environment "prd" is not in "environments"/);
  await refuse('prod', { ...copy(manifest), default: 'active' }, /"default" must be "inactive" or "ignore"/);
  await refuse('prod', { ...copy(manifest), workflows: { ...copy(manifest.workflows), [SMOKE]: { prd: 'active' } } }, /"prd" is not an environment/);
  await refuse('prod', { ...copy(manifest), workflows: { ...copy(manifest.workflows), [SMOKE]: { prod: 'on' } } }, /must be "active", "inactive" or "ignore"/);

  // Listed as active on PROD, but the pull never brought it.
  const ghost = cli('prod', { ...copy(manifest), workflows: { ...copy(manifest.workflows), [GHOST]: { prod: 'active', test: 'inactive' } } });
  assert.equal(ghost.code, 1);
  assert.equal(rowOf(ghost.report, GHOST).status, 'missing');
  assert.equal(ghost.report.ok, false);
  // On TEST the same entry says inactive: nothing to do, no failure.
  assert.equal(cli('test', { ...copy(manifest), workflows: { ...copy(manifest.workflows), [GHOST]: { prod: 'active', test: 'inactive' } } }).code, 0);
  assert.deepEqual(await active('prod'), stateBefore);
});

test('an activation the API refuses is reported with its reason, and the rest is still applied', async () => {
  await arrive('prod', 'broken-no-trigger', 'broken-missing-credential', 'order-intake-next');
  manifest.workflows[NO_TRIGGER] = { prod: 'active' };
  manifest.workflows[NO_CREDENTIAL] = { prod: 'active' };
  // Same webhook path as Order intake, which stays active: a conflict.
  manifest.workflows[ORDERS_NEXT] = { prod: 'active' };
  manifest.workflows[SMOKE].prod = 'active';

  const result = cli('prod', manifest);
  assert.equal(result.code, 1);
  const report = result.report;
  assert.equal(report.ok, false);
  assert.equal(report.summary.failed, 3);
  assert.equal(report.summary.changed, 1);
  assert.equal(rowOf(report, SMOKE).result, 'applied');
  for (const [id, pattern] of [
    [NO_TRIGGER, /^HTTP 400: .*no trigger node/],
    [NO_CREDENTIAL, /^HTTP 400: .*Missing required credential: imap/s],
    [ORDERS_NEXT, /^HTTP 409: .*conflict with one of the webhooks/],
  ]) {
    assert.equal(rowOf(report, id).result, 'failed');
    assert.match(rowOf(report, id).error, pattern);
    assert.equal((await active('prod'))[id], false);
    finding(`Publish refused: ${rowOf(report, id).name}`, rowOf(report, id).error.replace(/\s+/g, ' '));
  }
  await live('prod', 'smoke');
  await live('prod', 'orders', { workflow: 'orders' });

  // It keeps failing until someone fixes the workflow or the manifest.
  const again = cli('prod', manifest);
  assert.equal(again.code, 1);
  assert.equal(again.report.summary.failed, 3);
  assert.equal(again.report.summary.changed, 0);
  delete manifest.workflows[NO_TRIGGER];
  delete manifest.workflows[NO_CREDENTIAL];
});

test('one workflow hands its webhook path to another in a single run: unpublish goes first', async () => {
  manifest.workflows[ORDERS].prod = 'inactive';
  const report = await run('prod');
  assert.equal(report.ok, true, JSON.stringify(report.rows.filter((row) => row.error)));
  assert.equal(rowOf(report, ORDERS).result, 'applied');
  assert.equal(rowOf(report, ORDERS_NEXT).result, 'applied');
  await live('prod', 'orders', { workflow: 'orders-next' });

  // TEST is not touched by any of this.
  assert.equal((await called('test', 'orders')).workflow, 'orders');
});

test('a trigger that fails after the API said 200: only --check-triggers sees it', async () => {
  await arrive('prod', 'broken-cron', 'broken-unreachable');
  manifest.workflows[BAD_CRON] = { prod: 'active' };
  manifest.workflows[UNREACHABLE] = { prod: 'active' };

  // Through the public API alone everything looks fine.
  const blind = cli('prod', manifest);
  assert.equal(blind.code, 0, blind.stderr);
  assert.equal(rowOf(blind.report, BAD_CRON).result, 'applied');
  assert.equal(rowOf(blind.report, UNREACHABLE).result, 'applied');
  const cron = await workflow('prod', BAD_CRON);
  assert.equal(cron.active, true);
  assert.equal(cron.activeVersionId, cron.versionId);
  finding('Publish a workflow whose schedule has an invalid cron expression', 'public API: 200, active true, activeVersionId set, and it stays that way');
  finding('Publish a workflow whose trigger cannot reach its server (Redis on a closed port)', 'public API: 200, active true, activeVersionId set');

  // The editor's own status route knows better. An API key cannot read it.
  const withKey = await http(`${URLS.prod}/rest/workflows/${BAD_CRON}/publication-status`, { headers: { 'x-n8n-api-key': keys.prod.harness } });
  assert.equal(withKey.status, 401);
  finding('GET /rest/workflows/{id}/publication-status with an API key', `${withKey.status}`);

  const seen = cli('prod', manifest, '--check-triggers', '--wait', '45');
  assert.equal(seen.code, 1);
  assert.equal(seen.report.summary.changed, 0);
  const cronRow = rowOf(seen.report, BAD_CRON);
  assert.equal(cronRow.triggers, 'failed');
  assert.match(cronRow.problem, /Invalid cron expression/);
  const redisRow = rowOf(seen.report, UNREACHABLE);
  assert.ok(['in_progress', 'failed'].includes(redisRow.triggers), redisRow.triggers);
  assert.ok(redisRow.problem);
  // The healthy ones pass the same check.
  assert.equal(rowOf(seen.report, SMOKE).triggers, 'published');
  assert.equal(rowOf(seen.report, SMOKE).problem, null);
  finding('The same two, read with a login session', `invalid cron: "${cronRow.triggers}" (${cronRow.problem.split(': ').slice(1).join(': ')}); unreachable server: "${redisRow.triggers}" after 45 s`);

  delete manifest.workflows[BAD_CRON];
  delete manifest.workflows[UNREACHABLE];
  const cleaned = cli('prod', manifest, '--check-triggers');
  assert.equal(cleaned.code, 0, JSON.stringify(cleaned.report?.rows.filter((row) => row.problem || row.error)));
  assert.equal(cleaned.report.summary.changed, 2);
});

test('unpublished edits: the old version stays live until the tool publishes the latest one', async () => {
  const v1 = (await workflow('prod', SMOKE)).activeVersionId;
  await live('prod', 'smoke', { version: 'v1' });

  // What a pull with autoPublish "none" leaves behind for a published
  // workflow (read in the n8n source, see README): a newer version next to
  // the published one. Made here with the editor's Save.
  await saveDraft('prod', SMOKE, 'v2');
  const edited = await workflow('prod', SMOKE);
  assert.equal(edited.active, true);
  assert.equal(edited.activeVersionId, v1);
  assert.notEqual(edited.versionId, v1);
  await sleep(1000);
  assert.equal((await called('prod', 'smoke')).version, 'v1');
  finding('A published workflow gets a newer saved version', 'active true, activeVersionId unchanged, versionId new, the webhook still answers with the old version');

  // "stale": "report" only tells.
  const told = cli('prod', manifest, '--stale', 'report');
  assert.equal(told.code, 1);
  assert.equal(rowOf(told.report, SMOKE).status, 'stale');
  assert.equal(told.report.summary.changed, 0);
  assert.equal((await workflow('prod', SMOKE)).activeVersionId, v1);

  // The default publishes the latest version.
  assert.equal(rowOf(await run('prod', manifest, { dryRun: true }), SMOKE).status, 'publish_latest');
  const published = await run('prod');
  assert.equal(rowOf(published, SMOKE).result, 'applied');
  const now = await workflow('prod', SMOKE);
  assert.equal(now.activeVersionId, edited.versionId);
  await live('prod', 'smoke', { version: 'v2' });
  finding('POST /workflows/{id}/publish without a versionId on that workflow', 'publishes the latest version: activeVersionId = versionId, the webhook answers with the new version');
  assert.equal((await run('prod')).summary.changed, 0);

  // A pinned version: PROD runs exactly this one, whatever is newer.
  manifest.workflows[SMOKE].prod = { state: 'active', versionId: v1 };
  const pinned = await run('prod');
  assert.equal(rowOf(pinned, SMOKE).status, 'switch_version');
  assert.equal(rowOf(pinned, SMOKE).result, 'applied');
  const back = await workflow('prod', SMOKE);
  assert.equal(back.activeVersionId, v1);
  assert.equal(back.versionId, edited.versionId);
  await live('prod', 'smoke', { version: 'v1' });
  finding('POST /workflows/{id}/publish with { "versionId": <an older version> }', 'that version goes live, versionId (the latest) is left as it is');
  assert.equal((await run('prod')).summary.changed, 0, 'pinned and already there: nothing to do');

  // A version this instance does not have.
  manifest.workflows[SMOKE].prod = { state: 'active', versionId: '00000000-0000-4000-8000-000000000000' };
  const unknown = await run('prod');
  assert.equal(rowOf(unknown, SMOKE).result, 'failed');
  assert.match(rowOf(unknown, SMOKE).error, /^HTTP 404: Version not found/);
  assert.equal((await workflow('prod', SMOKE)).activeVersionId, v1);
  finding('Publish with a versionId the instance does not have', `${rowOf(unknown, SMOKE).error}; the published version stays`);

  // Back to "latest", this time through the older endpoints.
  manifest.workflows[SMOKE].prod = 'active';
  const legacy = await run('prod', manifest, { endpoints: 'activate' });
  assert.equal(rowOf(legacy, SMOKE).status, 'publish_latest');
  assert.equal(rowOf(legacy, SMOKE).result, 'applied');
  await live('prod', 'smoke', { version: 'v2' });
  finding('POST /workflows/{id}/activate without a body on a workflow with a newer version', 'publishes the latest version, like /publish');
});

test('match by name: same result, and a name that two workflows share is refused', async () => {
  const names = Object.fromEntries((await api('prod', 'GET', '/workflows?limit=250&excludePinnedData=true')).body.data.map((item) => [item.id, item.name]));
  const byName = { ...copy(manifest), matchBy: 'name', workflows: Object.fromEntries(Object.entries(manifest.workflows).map(([id, entry]) => [names[id], entry])) };
  const same = await run('prod', byName);
  assert.equal(same.ok, true, JSON.stringify(same.errors));
  assert.equal(same.summary.changed, 0);
  assert.equal(same.summary.inSync, (await run('prod')).summary.inSync);

  await arrive('prod', 'same-name-1', 'same-name-2');
  byName.workflows.Twin = { prod: 'active' };
  const stateBefore = await active('prod');
  const twins = await run('prod', byName);
  assert.equal(twins.ok, false);
  assert.match(twins.errors.join('\n'), /"Twin": 2 workflows on this instance have that name/);
  assert.deepEqual(await active('prod'), stateBefore);

  // An archived workflow cannot go live.
  assert.equal((await api('prod', 'POST', `/workflows/${TWIN_ONE}/archive`)).status, 200);
  const archived = await run('prod', { ...copy(manifest), workflows: { ...copy(manifest.workflows), [TWIN_ONE]: { prod: 'active' } } });
  assert.equal(rowOf(archived, TWIN_ONE).status, 'archived');
  assert.equal(archived.ok, false);
  assert.equal(archived.summary.changed, 0);
});

test('paging: two workflows per request gives the same plan', async () => {
  const whole = await run('prod', manifest, { dryRun: true, pageSize: 250 });
  const paged = await run('prod', manifest, { dryRun: true, pageSize: 2 });
  assert.ok(whole.rows.length > 6);
  assert.deepEqual(paged.rows.map((row) => [row.id, row.status]).sort(), whole.rows.map((row) => [row.id, row.status]).sort());
});

test('the apply workflow: token, environment check, dry run by default, apply, never switches itself off', async () => {
  assert.equal((await webhook('test', { environment: 'test', manifest }, null)).status, 403);
  assert.equal((await webhook('test', { environment: 'test', manifest }, 'wrong')).status, 403);

  // A call meant for PROD that reaches TEST.
  const wrong = await webhook('test', { environment: 'prod', dryRun: false, manifest });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.errors.join('\n'), /this instance is "test", the call asked for "prod"/);

  // The manifest does not list the apply workflow, and WIP becomes active on TEST.
  const document = copy(manifest);
  delete document.workflows[APPLY];
  document.workflows[WIP] = { test: 'active' };
  const stateBefore = await active('test');

  const dry = await webhook('test', { environment: 'test', manifest: document });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(rowOf(dry.body, WIP).result, 'planned');
  assert.equal(rowOf(dry.body, APPLY).status, 'self');
  assert.deepEqual(await active('test'), stateBefore);

  const applied = await webhook('test', { environment: 'test', dryRun: false, manifest: document });
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  assert.equal(applied.body.ok, true);
  assert.equal(rowOf(applied.body, WIP).result, 'applied');
  assert.equal(applied.body.summary.changed, 1);
  assert.equal((await active('test'))[APPLY], true);
  await live('test', 'wip');

  // Same plan as the command line makes from the same manifest.
  const viaCli = await run('test', document, { dryRun: true });
  const again = await webhook('test', { environment: 'test', dryRun: false, manifest: document });
  assert.equal(again.body.summary.changed, 0);
  assert.deepEqual(
    again.body.rows.filter((row) => row.id !== APPLY).map((row) => [row.id, row.status]).sort(),
    viaCli.rows.filter((row) => row.id !== APPLY).map((row) => [row.id, row.status]).sort(),
  );

  // Something that cannot be applied: 409, and the answer says what.
  document.workflows[GHOST] = { test: 'active' };
  const failed = await webhook('test', { environment: 'test', dryRun: false, manifest: document });
  assert.equal(failed.status, 409);
  assert.equal(failed.body.ok, false);
  assert.equal(rowOf(failed.body, GHOST).status, 'missing');

  // A webhook path changes hands in one call, as with the command line.
  await arrive('test', 'order-intake-next');
  document.workflows[ORDERS].test = 'inactive';
  document.workflows[ORDERS_NEXT] = { test: 'active' };
  delete document.workflows[GHOST];
  const handover = await webhook('test', { environment: 'test', dryRun: false, manifest: document });
  assert.equal(handover.status, 200, JSON.stringify(handover.body.rows?.filter((row) => row.error)));
  assert.equal(handover.body.summary.changed, 2);
  await live('test', 'orders', { workflow: 'orders-next' });

  // A refused publish comes back through the workflow with n8n's reason.
  await arrive('test', 'broken-no-trigger');
  document.workflows[NO_TRIGGER] = { test: 'active' };
  const refused = await webhook('test', { environment: 'test', dryRun: false, manifest: document });
  assert.equal(refused.status, 409);
  assert.equal(rowOf(refused.body, NO_TRIGGER).result, 'failed');
  assert.match(rowOf(refused.body, NO_TRIGGER).error, /^HTTP 400: .*no trigger node/);
});

test('a dropped read recovers; a dropped publish requires a new apply; an HTTP error is not retried', async () => {
  // A stand-in for the API that closes the first connection of every request
  // without answering, the way an idle keep-alive connection ends.
  const seen = {};
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    seen[key] = (seen[key] ?? 0) + 1;
    if (seen[key] === 1) return req.socket.destroy();
    res.setHeader('content-type', 'application/json');
    if (key === 'GET /api/v1/workflows') {
      const on = seen['POST /api/v1/workflows/one/publish'] >= 2;
      return res.end(JSON.stringify({ data: [{ id: 'one', name: 'One', active: on, versionId: 'v', activeVersionId: on ? 'v' : null }], nextCursor: null }));
    }
    if (key === 'POST /api/v1/workflows/one/publish') return res.end(JSON.stringify({ id: 'one' }));
    res.statusCode = 500;
    res.end(JSON.stringify({ message: 'no' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const options = { manifest: { environments: ['prod'], workflows: { one: { prod: 'active' } } }, env: 'prod', url, apiKey: 'k' };
    const report = await apply(options);
    assert.equal(report.ok, false);
    assert.match(report.rows[0].error, /write outcome unknown; not retried/);
    assert.equal(report.rows[0].after.active, false);
    assert.equal(seen['POST /api/v1/workflows/one/publish'], 1, 'one write, no automatic replay');
    assert.ok(seen['GET /api/v1/workflows'] >= 3);

    // We know this stand-in did not apply the first POST. A separate apply
    // observes the workflow as inactive and can publish it.
    const reapplied = await apply(options);
    assert.equal(reapplied.ok, true, JSON.stringify(reapplied.rows));
    assert.equal(reapplied.rows[0].result, 'applied');
    assert.equal(seen['POST /api/v1/workflows/one/publish'], 2);

    // A 500 is an answer: no second try.
    const failed = await request(`${url}/other`, {}, 4);
    assert.equal(failed.status, 500);
    assert.equal(seen['GET /other'], 2);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
