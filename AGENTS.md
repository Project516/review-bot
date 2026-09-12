# review-bot

## What it is for

A self-hosted GitHub App that reviews one person's pull requests with a free
OpenRouter model. One owner, a short list of trusted authors, a `/review`
comment to opt anyone else in. Read `README.md` for the flow and setup.

## Direction

- Free to run and nothing to babysit. Cloudflare Worker free plan plus GitHub
  Actions on this repo. No servers, no databases, no queues.
- Zero runtime dependencies. Node 22 built-ins and the Workers runtime cover
  everything needed; keep it that way.
- Policy lives in config, not in code. Settings that give nothing away are in
  `reviewbot.json`; who the bot works for is in the `REVIEWBOT_POLICY` secret.
  The deploy workflow hands the owner list to the Worker so an unwanted install
  is dropped before it costs a run. It is passed, never re-typed.
- Nothing checked into this repo names an account, a repo or a person, in code,
  config, commit messages, PR descriptions or docs. It is public and the repos
  it reviews are not. Placeholders in docs read `your-login`, `your-org`.
- A review must never be wrong about where it points. Inline comments are
  checked against the real diff and anything the model got wrong is moved into
  the review body rather than dropped or guessed.
- Fail loud in the Actions log, quiet on the PR. A skipped PR gets a log line,
  not a comment.
- Nothing in a run title or a log line may name a repo, an owner or an author. New log output goes
  through the redactor in `src/log.js`, and new workflow expressions use
  `client_payload.ref`, never `client_payload.repo`.

## Layout

- `worker/` Cloudflare Worker relay, deployed by `.github/workflows/deploy-worker.yml`.
- `src/review.js` entry point run by `.github/workflows/review.yml`.
- `src/log.js` the log redactor. `src/config.js` `reviewbot.json` plus the
  policy secret. `src/policy.js` who gets reviewed. `src/diff.js` patch parsing and budget.
  `src/prompt.js` model prompt and lenient JSON parsing. `src/github.js` App
  JWT, installation token, tiny REST client. `src/openrouter.js` completion
  with retries.
- `test/` `node --test` suites for everything that does not need the network.
- `scripts/setup.sh` human setup wizard, kept because setup repeats on a fresh
  account.

## Working here

- `pnpm test` before a PR. CI runs the same thing.
- This repo's own PRs are reviewed by this bot once it is installed here. The
  review arrives as a PR review from the App's bot user with a footer naming
  the model.
- No emojis anywhere, no AI co-authors, commits with the machine's global git
  identity. Branch and PR for everything; never push to `master`.

## Glossary

- **job**: the small object the Worker dispatches (`repo`, `pr`, `installation`,
  `event`, `action`, `author`, `sender`, `draft`, `comment_id`, `ref`). The reviewer
  decides from it and from the loaded config alone.
- **owner**: the single login in `REVIEWBOT_POLICY` that may issue `/review`.
- **allowed author**: a login whose PRs get reviewed automatically.
- **forced review**: a review requested with `/review`. Skips the author list
  and the already-reviewed check.
- **ref**: the Worker's anonymous handle for a repo, an HMAC of the full name
  keyed by the webhook secret. The only name for a repo that reaches the public
  Actions log.
- **marker**: the `<!-- review-bot head=SHA -->` comment in each review body,
  used to avoid reviewing the same head commit twice.
- **stray comment**: a model comment whose path or line is not in the diff.
  It is listed in the review body under "Other notes" instead of inline.
