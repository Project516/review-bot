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
- **OpenRouter `openrouter/free`.** A router that picks whichever free model is
  up. Free models are rate limited (about 20 requests a minute and a daily cap
  that grows once the account has had 10 dollars of credit). The client
  retries on 429 and 5xx.

No VPS. Oracle Cloud would work but is one more machine to keep alive for a
job that runs a few times a day. A public repo gets unlimited Actions minutes
on standard runners, so the reviews cost nothing however many run.

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
| `model` | OpenRouter model id |
| `post_verdicts` | `false` posts everything as a comment review; `true` lets the model approve or request changes |
| `max_diff_chars` | budget for the diff sent to the model; files past it are listed, not shown |
| `ignore_paths` | exact names, `*.suffix`, or `dir/` prefixes to leave out |

PRs from anyone else are skipped with a reason in the Actions log. Comment
`/review` on the PR as the owner and it gets reviewed anyway; the bot reacts
with eyes so you know it heard. `/review` also forces a fresh review on a head
the bot already covered. Draft PRs wait until they are marked ready.

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
