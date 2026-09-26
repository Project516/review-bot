# review-bot

A self-hosted GitHub App that reviews your pull requests with a free model from
OpenRouter. It only acts on repos under accounts you list, only on PRs from
people you list, and you can pull any other PR into review by commenting
`/review`.

This repo is the code, not a configuration. Nothing in it names the accounts,
repos or people it works for: that list lives in one GitHub secret, and the
Actions log it leaves behind names nothing either. To run your own, fork it and
run the setup wizard.

## How it runs, for free

```
GitHub webhook  ->  Cloudflare Worker (relay)  ->  repository_dispatch  ->  GitHub Actions on this repo  ->  OpenRouter  ->  PR review
```

A GitHub App needs an HTTPS endpoint to receive webhooks, so something has to be
listening. Nothing else needs a server:

- **Cloudflare Worker, free plan.** Verifies the webhook signature, keeps the
  few events that matter, and forwards a small job to this repo. That is all
  it does, on purpose: a free Worker gets 10 ms of CPU and 30 seconds of
  background time per request, and free models take longer than that.
- **GitHub Actions on this repo.** `repository_dispatch` starts the `Review`
  workflow, which fetches the diff with an installation token, asks OpenRouter,
  and posts the review. The PR being reviewed can be in any repo the App is
  installed on; the minutes are always spent here.
- **OpenRouter free models.** `reviewbot.json` pins a few of the stronger free
  models, and each attempt goes to the next one on the list. Free models are
  rate limited (about 20 requests a minute and a daily cap that grows once the
  account has had 10 dollars of credit). The client retries on 429 and 5xx, on a
  model that is gone from the free list, and whenever the reply is not a review,
  so a retry is how the job gets off a model that is down or thinks out loud. A
  model that answers 404 is dropped from the rest of that run, so a pin that
  left the free list costs one attempt and not the whole run. The
  `openrouter/free` router is held back as the last resort rather than used as
  a pin: it hands some requests to tiny models and safety classifiers, and a
  tiny model will concede a point it should not, so it only gets a run when
  every pin is dead. Only a parsed review is posted, so working notes cannot
  land on a PR.
- **A weekly job that re-pins them.** The free list turns over, so the pins go
  stale. `Refresh model pins` runs on Mondays, reads the OpenRouter catalog,
  ranks the free models by the coding score OpenRouter publishes for them, and
  opens a PR with the new order. It never pushes to master and never merges:
  you read the ranking and decide. That PR is opened with the workflow's own
  token, and GitHub does not let an event raised with that token trigger other
  workflows, so the job asks for the `Test` run on its branch itself rather than
  leaving it ungated. See [Which models it uses](#which-models-it-uses).

No VPS. Oracle Cloud would work but is one more machine to keep alive for a
job that runs a few times a day. A public repo gets unlimited Actions minutes
on standard runners, so the reviews cost nothing however many run.

- **House style is enforced, not requested.** The prompt tells the model to
  write with periods, commas, colons and parentheses, and `src/style.js` then
  rewrites any long dash that still arrives: a comma between clause halves, a
  space after a finished sentence. Hyphens, number ranges, command flags and
  anything inside code are left alone. A dash it cannot classify is left as it
  is, because a mangled sentence is worse than a dashed one. The rewrite sits in
  the parse layer, so it covers the summary, every comment and every thread
  reply.

- **A review is given facts, not just a diff.** The model cannot read the rest of
  the repo, run anything, or look anything up, so `src/facts.js` gathers what it
  can reach: the base version of each changed file, the names of what already
  sits in a folder when the PR adds a file there, and the check runs at the head
  commit. Whatever could not be gathered is named in the prompt, so a gap never
  reads as an all-clear. A model given only a diff tends to report a setting as
  wrong when something else in the repo already sets it that way, or to assert a
  fact about the world it has no way of checking. This is what stops both. The
  block is budgeted too, because a pull request touching thirty files would
  otherwise send more base code than the model can hold and the run would fail on
  every model in the rotation instead of reviewing less.

## Who gets reviewed

Policy comes from two places. Who it works for is a secret; how it reviews is
in the repo.

`REVIEWBOT_POLICY`, an Actions secret holding one JSON object:

```json
{
  "owner": "your-login",
  "allowed_repo_owners": ["your-login", "your-org"],
  "allowed_authors": ["your-login", "a-teammate"]
}
```

| key | meaning |
| --- | --- |
| `owner` | the only login that may issue `/review` |
| `allowed_repo_owners` | accounts and orgs whose repos may be reviewed; anything else is dropped, even if the App is installed there |
| `allowed_authors` | PRs by these logins are reviewed on open, reopen, ready-for-review and every push |

Unset it and the lists are empty, so nothing is reviewed. Changing it takes
effect on the next review run, and on the Worker once you run the `Deploy
worker` workflow.

`reviewbot.json`, checked in, for everything that gives nothing away:

| key | meaning |
| --- | --- |
| `models` | OpenRouter model ids, tried in order, one per attempt. Never the `openrouter/` routers, which are a fallback, not a pin |
| `model_selection` | optional thresholds for the weekly re-pin: `pin` (how many to keep, default 5), `min_context`, `min_completion_tokens`, `excluded_ids` (ids never pinned or tried, for a model that qualifies but answers every request with an error the ranking has no way to see) |
| `post_verdicts` | `false` posts everything as a comment review; `true` lets the model approve or request changes |
| `max_diff_chars` | budget for the diff sent to the model; files past it are listed, not shown |
| `max_facts_chars` | budget for the gathered facts; past it, base code is cut first and the cut files are named as a gap |
| `ignore_paths` | exact names, `*.suffix`, or `dir/` prefixes to leave out |

PRs from anyone else are skipped with a reason in the Actions log. Comment
`/review` on the PR as the owner and it gets reviewed anyway; the bot reacts
with eyes so you know it heard. `/review` also forces a fresh review on a head
the bot already covered. Draft PRs wait until they are marked ready.

### Which models it uses

The pins in `reviewbot.json` are the models a run tries, one per attempt. The
`Refresh model pins` workflow re-picks them every Monday, and here is how.

It fetches `https://openrouter.ai/api/v1/models` and keeps the free models that
could actually review a PR. A model qualifies when it is free, reads and writes
text, has a coding score OpenRouter publishes, holds at least 65536 tokens of
context, and allows at least 16384 output tokens. Unbenchmarked models are left
out on purpose, because that is where the content-safety classifiers and the 2B
models live, and those are what concede a point they should hold. The ones left
out are listed in the PR with the reason.

The qualified models are sorted by coding score, then agentic score, then
intelligence score, then context, and the top `model_selection.pin` (5 by
default) become the pins. A run then tries the pins in that order, then the
runners-up the last refresh recorded, then `openrouter/free`. A pin that has
left the catalog costs one wasted attempt, the model is dropped from the rest of
that run, and the next name takes over. The router is only reached when every
name ahead of it is gone, which is the one case the free router cannot cause on
its own.

The runners-up are written into `reviewbot.json` as `model_runners_up` and a
review run reads them from there. It does not fetch the catalog on the way to a
review: a review should not depend on OpenRouter answering twice, and it should
not pay a second round trip to discover a list that only changes weekly. The key
is absent until the first refresh run, and a review before then runs on the pins
and the router alone.

The workflow opens a pull request with the new order, and it is left open for
you. It never pushes to master and never merges. Read the ranking, disagree if
you like, and merge it or edit it. A week where the ranking matches the pins
opens nothing. Run it by hand any time with the `Refresh model pins` workflow,
or look at the result without touching the repo:

```bash
DRY_RUN=1 node src/refresh-models.js
```

### Replies

Reply to one of the bot's inline review comments and, if you are the owner or
an allowed author, it reads the thread, the whole PR diff and the check runs
at head, then answers: it concedes when the fix landed or your pushback is
right, or pushes back with its reasoning. A comment saying CI passed does not
count on its own; a concern about the build or tests is only dropped when the
check runs on the head commit show it. A conceded reply marks the thread
settled and resolves it, and once every thread from the bot's last
`REQUEST_CHANGES` review is settled, it approves the PR so the requested
changes are lifted. After three replies in one thread without
agreement it stops and leaves it for you. Replies from anyone else are
skipped. The App needs the "Pull request review comment" webhook event for
this to work; add it if you set the App up before this existed.

Resolving a thread is the one call GitHub gates behind Contents write, so the
App holds it, but every job runs on a token narrowed to Contents read, Issues
and Pull requests write, and Checks read. Only the resolve call mints a token
with Contents write, and the code never uses it for anything else. An App set
up before this needs Contents raised to Read and write and Checks added as
Read-only, and each installation has to accept the new permissions, or every
job fails at the token step.

### Keeping it yours

An App owned by a user account can only be installed on another account, an org
you own included, if it is set to "Any account". So it is, and
`allowed_repo_owners` is what makes it yours instead:

- **The Worker drops anything else before it costs anything.** The deploy
  workflow reads the owner list out of `REVIEWBOT_POLICY` and passes it to the
  Worker, which answers a webhook from an unlisted owner with `ignored` and
  never dispatches. A stranger who installs the App gets a bot that does
  nothing and spends none of this repo's Actions minutes.
- **The reviewer checks the same list again**, so a stale Worker cannot leak a
  review onto someone else's PR.
- **`/review` is owner-only.** On a shared org repo, other members' PRs are not
  reviewed unless their login is in `allowed_authors`, and their `/review`
  comments do nothing.

### What the Actions log shows

This repo is public, so its run titles and logs are world readable, and the
repos being reviewed are not. Nothing on either names a repo, an owner or an
author, and the one place the names exist is a secret, which Actions masks on
its way to a log. A run is titled with `ref`, an eight character HMAC of the repo name
keyed by the webhook secret, and every line the reviewer prints is passed
through a redactor first (`src/log.js`), including error stacks and the API
paths inside them. Same repo, same `ref`, so runs are still tellable apart, and
the mapping back is only guessable by someone who already holds the webhook
secret.

## Setup

Merge this repo to `master` first, then from a clone:

```
scripts/setup.sh
```

It walks through the seven things only a human can do (OpenRouter key,
Cloudflare token, webhook secret, dispatch token, first Worker deploy, App
creation, App install) and writes each value to the right GitHub secret or
variable as it goes. Re-run it any time; it keeps what it already has in
`.env`, which is gitignored.

What ends up where:

| name | kind | used by |
| --- | --- | --- |
| `APP_ID` | Actions variable | Review workflow |
| `APP_PRIVATE_KEY` | Actions secret | Review workflow |
| `OPENROUTER_API_KEY` | Actions secret | Review workflow |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Actions secrets | Deploy worker workflow |
| `REVIEWBOT_POLICY` | Actions secret | Review workflow, and the owner list the deploy workflow gives the Worker |
| `WEBHOOK_SECRET`, `DISPATCH_TOKEN` | Actions secrets, pushed into the Worker on deploy | Worker |

`DISPATCH_TOKEN` is a fine-grained personal access token limited to this repo
with Contents read and write. It expires after a year at most; when it does the
Worker starts answering 502 and nothing gets reviewed.

## Development

```
pnpm test            # node --test, no dependencies
```

To run the reviewer by hand against a real PR, put the Actions values in `.env`
(`APP_ID`, `APP_PRIVATE_KEY`, `OPENROUTER_API_KEY`) and describe the job:

```
EVENT_JSON='{"event":"pull_request","action":"opened","repo":"you/x","pr":1,"installation":123,"author":"you","sender":"you","draft":false,"ref":"local"}' \
  REVIEWBOT_POLICY='{"owner":"you","allowed_repo_owners":["you"],"allowed_authors":["you"]}' \
  node --env-file=.env src/review.js
```

Changes under `worker/` deploy the Worker on merge to `master`, and the
`Deploy worker` workflow can be run by hand after a policy change. Everything else takes
effect on the next review run, since the workflow checks out `master`.

## License

AGPL-3.0-only. See `LICENSE`.
