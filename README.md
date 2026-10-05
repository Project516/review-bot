# review-bot

A GitHub App that reviews pull requests with free OpenRouter models. It
reviews only repos under accounts you list, only PRs from authors you list, and
any other PR when the owner comments `/review`. It runs on a free Cloudflare
Worker and GitHub Actions, with no server.

Nothing in this repo names the accounts, repos or people it works for. That list
is one Actions secret, and the logs name nothing either.

## What it does on a PR

- Reads the diff, the code around each change at the head commit, and the CI
  results, and posts one review with inline comments.
- Checks each comment against the code before posting, and drops claims the
  repo contradicts or that rest on facts it was not shown.
- Approves when nothing needs fixing, so repos that auto-merge can use it as the
  gate. It requests changes only for a defect that survived the check.
- Answers replies on its threads, and lifts its own request for changes, or a
  comment held back by open threads, once every thread is settled.

```
webhook -> Cloudflare Worker -> repository_dispatch -> Actions in this repo -> OpenRouter -> review
```

## Add it to a repo

1. Fork this repo and run `scripts/setup.sh`. It walks through the OpenRouter
   key, Cloudflare token, webhook secret, dispatch token, Worker deploy, and App
   creation and install, and sets each GitHub secret as it goes.
2. List who it works for in the `REVIEWBOT_POLICY` secret:
   `{"owner": "your-login", "allowed_repo_owners": ["your-login", "your-org"], "allowed_authors": ["your-login"]}`.
   Then run the `Deploy worker` workflow, which hands the owner list to the
   Worker. With the secret unset, nothing is reviewed.
3. Install the App on the repo. The dispatch token expires after a year, and the
   Worker answers 502 until it is replaced.

## Config

`reviewbot.json`, for settings that name no one:

| key | meaning |
| --- | --- |
| `models` | OpenRouter ids, tried in order. The weekly `Refresh model pins` PR re-picks them |
| `model_selection` | re-pin thresholds, `excluded_ids`, and the `fallback` router tried last |
| `post_verdicts` | `false` posts every review as a plain comment |
| `verify` | `false` skips the check on comments before they are posted |
| `max_diff_chars`, `max_facts_chars`, `max_verify_chars` | budgets for what the model is sent |
| `max_output_tokens` | room for one answer, enough for a reasoning model's thinking |
| `ignore_paths` | exact names, `*.suffix`, or `dir/` prefixes to skip |
| `sync_branch_prefixes` | branch prefixes of upstream sync PRs, empty by default. A merge-commit head on one is reviewed only where it differs from the upstream parent |

## More

The code is the documentation. `AGENTS.md` has the design rules, layout and
glossary. `pnpm test` runs the tests, and the comments in `src/review.js` show
how to run the reviewer by hand.

AGPL-3.0-only, see `LICENSE`.
