# review-bot

A private GitHub App that reviews my pull requests with a free model from
OpenRouter. It only acts on repos I own, only on PRs from people listed in
`reviewbot.json`, and I can pull any other PR into review by commenting
`/review`.

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
  and posts the review. Private repos get 2000 free minutes a month; a review is
  one or two of them.
- **OpenRouter `openrouter/free`.** A router that picks whichever free model is
  up. Free models are rate limited (about 20 requests a minute and a daily cap
  that grows once the account has had 10 dollars of credit). The client
  retries on 429 and 5xx.

No VPS. Oracle Cloud would work but is one more machine to keep alive for a
job that runs a few times a day.

## Who gets reviewed

`reviewbot.json` is the whole policy:

| key | meaning |
| --- | --- |
| `owner` | the only login that may issue `/review` |
| `allowed_repo_owners` | repos under any other owner are ignored, even if the App is installed there |
| `allowed_authors` | PRs by these logins are reviewed on open, reopen, ready-for-review and every push |
| `model` | OpenRouter model id |
| `post_verdicts` | `false` posts everything as a comment review; `true` lets the model approve or request changes |
| `max_diff_chars` | budget for the diff sent to the model; files past it are listed, not shown |
| `ignore_paths` | exact names, `*.suffix`, or `dir/` prefixes to leave out |

PRs from anyone else are skipped with a reason in the Actions log. Comment
`/review` on the PR as the owner and it gets reviewed anyway; the bot reacts
with eyes so you know it heard. `/review` also forces a fresh review on a head
the bot already covered. Draft PRs wait until they are marked ready.

The App itself is set to "Only on this account" at creation, so nobody else can
install it. The `allowed_repo_owners` check is a second lock in case that
setting ever changes.

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
EVENT_JSON='{"event":"pull_request","action":"opened","repo":"Project516/x","pr":1,"installation":123,"author":"Project516","sender":"Project516","draft":false}' \
  node --env-file=.env src/review.js
```

Changes under `worker/` deploy on merge to `master`. Everything else takes
effect on the next review run, since the workflow checks out `master`.

## License

AGPL-3.0-only. See `LICENSE`.
