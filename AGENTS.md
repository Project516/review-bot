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
- A review must not guess about what it cannot see. The model gets a diff and
  nothing else, so the prompt says so, and `src/facts.js` hands it what can be
  gathered: the base version of each changed file, the names of what sits beside
  a file the PR adds, and the check runs at head. A gap is named in the prompt,
  so a silence never reads as an all-clear. Nothing in there is specific to one
  repository or one language: this reviews whatever it is pointed at.
- Fail loud in the Actions log, quiet on the PR. A skipped PR gets a log line,
  not a comment.
- Only a parsed review is ever published. A reply that is working notes, a
  safety classifier verdict, or a chain of thought cut off by the token limit
  is retried, and a job that never gets a review fails instead of posting one.
- Nothing in a run title or a log line may name a repo, an owner or an author. New log output goes
  through the redactor in `src/log.js`, and new workflow expressions use
  `client_payload.ref`, never `client_payload.repo`.

## Layout

- `worker/` Cloudflare Worker relay, deployed by `.github/workflows/deploy-worker.yml`.
- `src/review.js` entry point run by `.github/workflows/review.yml`.
- `src/log.js` the log redactor. `src/config.js` `reviewbot.json` plus the
  policy secret. `src/policy.js` who gets reviewed. `src/diff.js` patch parsing and budget.
  `src/prompt.js` model prompts, lenient JSON parsing, and the house style
  applied to model text. `src/style.js` rewrites the long dashes out of a
  review before it is published. `src/facts.js` gathers what the model cannot
  fetch for itself. `src/github.js` App
  JWT, installation token, tiny REST and GraphQL client. `src/openrouter.js`
  completion with retries. `src/reply.js` answers a reply on one of the bot's
  review threads, and approves the PR once every thread from the last
  `REQUEST_CHANGES` review is settled. `src/facts.js` gathers what a review can
  check instead of guess at: base versions of the changed files, the names beside
  a file the PR adds, and the check runs at head.
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
  `event`, `action`, `author`, `sender`, `draft`, `comment_id`, `ref`, `thread`).
  The reviewer decides from it and from the loaded config alone.
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
- **settled**: a bot review thread whose latest bot reply carries the
  `<!-- review-bot settled -->` marker, meaning the concern is dropped from
  future reviews and, once every thread from the same review is settled,
  clears that review's `REQUEST_CHANGES`.
