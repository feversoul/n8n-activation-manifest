# n8n activation manifest

[![test](https://github.com/feversoul/n8n-activation-manifest/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-activation-manifest/actions/workflows/test.yml)

Which workflows are active is a per-instance fact that n8n's Git source control does not carry. This repo keeps that fact in one JSON file in Git, one column per environment, and a small tool makes an instance match it after each pull, through the public API: it activates what the file lists as active for that environment, deactivates the rest, and never activates anything the file does not list.

The tool comes twice with the same logic: `apply-manifest.mjs`, one Node file without dependencies for a pipeline, and `workflows/apply-activation-manifest.json`, an n8n workflow you call over a webhook. The repo also measures what publish and unpublish really do on n8n 2.47.7, because some of it decides how such a tool has to work.

The Enterprise source-control pull itself was **not** run here (no licence). Two community instances stand in for TEST and PROD, with the same workflow files imported under the same ids.

| Asked in the thread                                               | Answer in this repo                                                                                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does scripting activation after the pull from a list in Git work? | Yes. Same manifest, two instances: TEST ended with Order intake and Smoke test active, PROD with Order intake and Daily reconciliation. A second run changed nothing and restarted nothing.              |
| Activation as configuration or as code?                           | As code: the manifest is reviewed in Git like the workflows. Credentials and the API key stay with each environment.                                                                                     |
| What default for newly promoted workflows?                        | Inactive. A workflow that arrived on both instances stayed off on both and was reported as "not in the manifest", until the manifest listed it for PROD. `"default": "active"` is refused.               |
| How to stop a TEST-only or WIP workflow going live on PROD?       | It is not listed for PROD, so the tool never activates it there, and if somebody activates it by hand the next run switches it off again. A dry run in the pull request shows that before anything runs. |
| Is `POST /workflows/{id}/activate` the right call?                | It works, but the 2.47.7 API description marks it deprecated in favour of `/publish` and `/unpublish`. Both gave the same answers. The tool uses `/publish`; `--endpoints activate` uses the old pair.   |
| Does a 200 from that call mean the workflow runs?                 | No. See below: the triggers start afterwards, and two broken workflows got 200 and `active: true`.                                                                                                       |
| What does `autoPublish` on the pull do with this?                 | Read in the image, not run: see "What the pull does".                                                                                                                                                    |

## What was measured

n8n 2.47.7 in Docker, regular mode, SQLite, default settings. Every lab workflow has a webhook that answers which workflow and which version is live, so "active" was checked by calling it.

| What was done                                                                 | What n8n did                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow imported, never published                                            | `active: false`, `activeVersionId: null`.                                                                                                                                                 |
| `POST /workflows/{id}/publish` (or `/activate`), no body                      | 200, `active: true`, `activeVersionId` = `versionId`. The webhook answered 404 right after the call and 200 about 0.3 s later: the call answers before the triggers are started.          |
| The same call again                                                           | 200, and two more entries in the publish history (`deactivated`, `activated`). Publishing what is already published restarts it. So the tool makes no call when the state is right.       |
| `POST /workflows/{id}/unpublish` (or `/deactivate`), also when already off    | 200, `active: false`, `activeVersionId: null`.                                                                                                                                            |
| Publish a workflow without a trigger node                                     | 400 `Workflow cannot be activated because it has no trigger node...`. Stays unpublished.                                                                                                  |
| Publish a workflow whose trigger has no credential (IMAP)                     | 400 `Cannot publish workflow: 1 node have configuration issues: Node "New mail": - Missing required credential: imap`. Stays unpublished.                                                 |
| Publish a workflow whose webhook path another active workflow has             | 409 `There is a conflict with one of the webhooks.` Stays unpublished.                                                                                                                    |
| Publish a workflow whose schedule has an invalid cron expression              | **200, `active: true`, `activeVersionId` set**, and it stays that way. The error is only in the log and in the editor's status route.                                                     |
| Publish a workflow whose trigger cannot reach its server (Redis, closed port) | **200, `active: true`.** The editor's status route said `in_progress`, and after about two minutes `failed` (`Workflow publication processing exceeded its deadline`, seen once by hand). |
| `GET /rest/workflows/{id}/publication-status`                                 | 401 with an API key. With a login session: `published`, `in_progress`, `failed` or `not_published`, and the error of each trigger. The public API has no such field.                      |
| A published workflow gets a newer version (the editor's Save)                 | `active: true`, `activeVersionId` unchanged, `versionId` new. The webhook kept answering with the old version.                                                                            |
| Publish that workflow, no body                                                | The latest version goes live.                                                                                                                                                             |
| Publish it with `{ "versionId": "<older version>" }`                          | That version goes live. `versionId` (the latest) is left alone.                                                                                                                           |
| Publish with a `versionId` the instance does not have                         | 404 `Version not found`. The published version stays.                                                                                                                                     |
| Publish an id that does not exist                                             | 404 `You do not have permission to activate this workflow...`                                                                                                                             |
| Publish an archived workflow (by hand, once)                                  | 400 `Cannot activate an archived workflow.`                                                                                                                                               |

Two more, measured by hand and not part of the test suite:

- **Unpublish one workflow and publish another on the same webhook path.** With the publish sent right after the unpublish, 9 of 12 handovers got 409 and kept getting it for as long as I retried (up to 60 s), while the webhook answered 404 `Published version not found`. With a 2 second pause after the unpublish, 12 of 12 worked at the first call. A stuck one came loose after publishing the old workflow again, unpublishing it, waiting 3 seconds and publishing the new one. The tool therefore unpublishes first and waits 3 seconds before the first publish.
- **`N8N_USE_WORKFLOW_PUBLICATION_SERVICE=false`** (the default is `true`). The invalid cron expression then got 400 `There was a problem activating the workflow: "Invalid cron expression"` and stayed unpublished. The publish call for the unreachable Redis had not answered after three minutes.

## What the pull does

Not run, only read in the `n8nio/n8n:2.47.7` image. `POST /source-control/pull` takes `autoPublish` (`@n8n/api-types`, `pull-work-folder-request.dto.js`, default `none`):

> Controls automatic workflow publishing after import:
>
> - `none`: Keep workflows in their local published state (default)
> - `all`: Publish all imported workflows
> - `published`: Publish only workflows that were published locally before import

The decision is in `n8n-workflow`, `workflow-environments-helper.js`:

```js
// Archived workflows should never be activated
if (isRemoteArchived) return false;
if (autoPublish === "all") return true;
// For 'published' mode, only activate existing workflows that were previously active
if (autoPublish === "published" && !isNewWorkflow && isLocalPublished)
  return true;
return false;
```

As I read `source-control-import.service.ee.js`: with `none`, a workflow that is published on the instance keeps its old `activeVersionId` while its content is replaced, and a new workflow arrives unpublished. That is the "newer version next to the published one" state from the table above, where the old version stays live. So after a pull with `none` there are two things to do for a workflow that should be active: activate it if it is off, and publish the latest version if it is on. The tool does both. The import also takes `versionId` from the file, so a version id should be the same on every instance after a pull; the stand-in used here (`n8n import:workflow`) gave each instance its own.

## The manifest

```json
{
  "environments": ["dev", "test", "prod"],
  "default": "inactive",
  "workflows": {
    "amOrders00000001": {
      "name": "Order intake",
      "dev": "active",
      "test": "active",
      "prod": "active"
    },
    "amReconcile00001": { "name": "Daily reconciliation", "prod": "active" },
    "amSmoke000000001": {
      "name": "Smoke test",
      "test": "active",
      "prod": "inactive"
    },
    "amInvoices000001": { "prod": { "state": "active", "versionId": "0f6c…" } }
  }
}
```

- The keys are workflow ids, which a Git pull keeps. `name` and `note` are for the reader. With `"matchBy": "name"` the keys are workflow names instead; a name that two workflows on the instance share is refused.
- A state is `active`, `inactive` or `ignore` (leave it as it is). An environment that an entry does not mention gets the default.
- `default` is `inactive` (everything else is switched off) or `ignore` (everything else is left alone and reported). It cannot be `active`.
- `{ "state": "active", "versionId": "…" }` pins the version that must be live, whatever is newer.
- `"stale": "report"` (or `--stale report`): an active workflow whose published version is not the latest is reported and fails the run, instead of getting the latest version published.
- A mistake refuses the whole manifest and nothing is changed: an environment that is not in `environments` (a typo such as `prd` would otherwise switch everything off), an unknown field or state.

## The command line

```sh
# in the pull request: what would change on PROD?  exit 2 when something would
N8N_API_KEY=... node apply-manifest.mjs --manifest activation.json --env prod --url https://n8n.example.com --dry-run

# after the pull on PROD
N8N_API_KEY=... node apply-manifest.mjs --manifest activation.json --env prod --url https://n8n.example.com
```

It lists the workflows (`GET /workflows`, paged), plans, sends every unpublish, waits 3 seconds, sends every publish, lists again and compares. Exit code 0: the instance matches. 1: something failed, or the manifest was refused. 2: dry run with pending changes. `--json` prints the full report. All options are at the top of the file.

```text
prod
  amOrders00000001   Order intake                 active   → active   in sync
  amReconcile00001   Daily reconciliation         inactive → active   activate  [done]
  amSmoke000000001   Smoke test                   active   → inactive deactivate  [done]
  amNoTrigger00001   Broken: no trigger           inactive → active   activate  [FAILED: HTTP 400: Workflow cannot be activated because it has no trigger node...]
  amWip00000000001   WIP experiment               active   → inactive deactivate (not in the manifest)  [done]
  amInvoices000001   Invoice export               inactive → inactive not in the manifest, inactive
```

A failed call does not stop the run: the rest is applied and the exit code is 1. GET and HEAD may retry a dropped connection up to three times; an HTTP error or a timeout is not retried. If a publish or unpublish gets no response, the CLI reports the outcome as unknown and reads the resulting workflow state without resending the write. Check that state and, if needed, trigger readiness before applying again. A matching read does not prove which call changed the state. A workflow listed as active that is not on the instance, or is archived, also gives 1.

**`--check-triggers`** covers the two 200-but-broken cases above. It needs `N8N_EMAIL` and `N8N_PASSWORD` of a user who can see the workflows, logs in, and reads the editor's `publication-status` for every workflow that should be active, waiting up to `--wait` seconds (default 30) for ones still starting. Anything but `published` fails the run with n8n's error text. This route is not part of the public API and may change; without the option the tool only knows what the public API says.

## The apply workflow

`workflows/apply-activation-manifest.json` does the same from inside the instance, for when no pipeline can reach the API. It carries the same `plan` and `settle` functions as the command line (`scripts/build.mjs` copies them into its Code nodes).

```sh
curl -X POST https://n8n.example.com/webhook/activation-manifest/apply \
  -H 'X-Apply-Token: ...' -H 'content-type: application/json' \
  -d '{ "environment": "prod", "dryRun": false, "manifest": { ... } }'
```

- Without `"dryRun": false` it changes nothing and answers the plan.
- `environment` must equal the `ENVIRONMENT` in its **Settings** node, so a PROD call that reaches TEST is refused (400).
- 200 with the report when the instance matches, 409 when something failed, 400 when the manifest was refused, 403 without the token.
- It never deactivates itself, listed or not.
- It has no `--check-triggers`.

## Add it to your n8n

Needs the public API, so a self-hosted n8n or a Cloud plan that has it. Not tested on n8n Cloud.

1. Put `activation.json` in the repository your instances pull from, or next to your pipeline. Start from `activation.example.json`. List the apply workflow as active if you use it (the command line would otherwise switch it off).
2. On each instance: **Settings > n8n API > Create an API key** with the scopes `workflow:list`, `workflow:activate`, `workflow:deactivate`.
3. Pull with `autoPublish` `none`, then run `apply-manifest.mjs` with that instance's `--env`, `--url` and key. Run it with `--dry-run` first.
4. Or import the workflow: create an **n8n API** credential (the key; Base URL `https://<your n8n>/api/v1`) and select it in the four HTTP nodes, create a **Header Auth** credential (name `X-Apply-Token`, a long random value) for the **Apply** webhook, set `ENVIRONMENT` and `API_URL` in **Settings**, publish it.

## Try it locally

```sh
git clone https://github.com/feversoul/n8n-activation-manifest
cd n8n-activation-manifest
npm run test:e2e
```

Needs Docker and Node 20 or newer, about 3 minutes. The tests create the owner and the API keys through n8n's own endpoints (`POST /rest/owner/setup`, `POST /rest/api-keys`); the tool's key has only the three scopes above. `KEEP_STACK=1` leaves both instances up.

By hand: `cp .env.example .env`, fill it in, `docker compose up -d`, open `http://localhost:5678` (TEST) and `http://localhost:5679` (PROD), create the owner and an API key on each, then run the command line against them with `activation.example.json`. The lab webhooks (`/webhook/lab/orders`, `/reconcile`, `/smoke`, `/wip`) have no authentication. Keep them on a local stack.

After changing `apply-manifest.mjs` or `scripts/build.mjs`, run `npm run build` to write the workflow files again.

## What was tested

`npm run test:e2e` from a fresh stack, two instances of n8n 2.47.7, regular mode, SQLite: **17 of 17 passed**.

| Test                                                                                                                 | Result |
| -------------------------------------------------------------------------------------------------------------------- | ------ |
| Starting point: same ids on both instances, nothing published but the apply workflow                                 | passed |
| The API: publish, publish again (restart), activate, unpublish twice, deactivate, unknown id                         | passed |
| Dry run: a different plan per environment from one manifest, exit 2, nothing changes                                 | passed |
| Apply: TEST and PROD end up different, and the webhooks agree                                                        | passed |
| Second run: no change, exit 0, no new entry in the publish history                                                   | passed |
| Workflow activated by hand and not listed: switched off; with `"default": "ignore"` left on and reported             | passed |
| Newly arrived workflow: off on both and reported; active on PROD only once listed for PROD                           | passed |
| Workflow removed from the manifest: deactivated at the next run                                                      | passed |
| Mistakes (`--env prd`, `"default": "active"`, unknown field, unknown state): refused, nothing changes; missing id: 1 | passed |
| Publish refused (no trigger, missing credential, webhook conflict): reason reported, the rest applied, exit 1, twice | passed |
| One workflow hands its webhook path to another in one run                                                            | passed |
| Invalid cron and unreachable server: 200 from the API, exit 0 without `--check-triggers`, exit 1 with it             | passed |
| Unpublished edits: `--stale report`, publish latest, pinned version, unknown version, `--endpoints activate`         | passed |
| Match by name: same result; a shared name is refused; an archived workflow is reported                               | passed |
| Paging: two workflows per request gives the same plan                                                                | passed |
| The apply workflow: 403, wrong environment 400, dry run, apply, path handover, 409 with n8n's reason, keeps itself   | passed |
| A connection dropped before the answer: the call is sent again and the run succeeds; a 500 is not repeated           | passed |

## What was not tested, and other limits

- **The source-control pull.** Everything about `autoPublish` and about what a pull leaves behind is read from the code of the image. New workflows were imported with `n8n import:workflow`, the "newer version" state was made with the editor's Save.
- Version ids across instances. The stand-in gives each instance its own, so pinning was tested with the instance's own version id.
- n8n Cloud, queue mode, multi-main, PostgreSQL, projects and folders, any version other than 2.47.7. On an older n8n without `/publish`, use `--endpoints activate`; without `activeVersionId` the tool falls back to `active` and cannot see unpublished edits (that fallback was not run).
- More than 250 workflows in the apply workflow. Its cursor paging is configured but every test fit on one page. The command line was tested with pages of two.
- The 3 second pause is a fixed wait, not a signal from n8n. It was enough 12 of 12 times on an idle machine. If a handover still gets 409, see "What was measured" for what cleared it.
- `--check-triggers` uses the editor's internal route and a password. A trigger that is still `in_progress` when `--wait` runs out is reported as a problem, although it may yet start.
- A deactivated workflow that has runs in flight, and waiting executions, were not looked at.
- `n8n import:workflow` over a workflow that is published on a running instance (by hand, once): the API then said `active: false` while the running process still served its webhook. Do not use the CLI import as a pull on a live instance.
- The tool does not delete, archive or create workflows, and does not touch credentials or variables.
- The apply workflow runs on the instance it changes. If n8n is down, or the workflow itself is unpublished, nothing applies the manifest.

## License

MIT
