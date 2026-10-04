# review-bot

## What it is for

A self-hosted GitHub App that reviews one person's pull requests with a free
OpenRouter model. One owner, a short list of trusted authors, a `/review`
comment to opt anyone else in. `README.md` has the setup.

## Direction

- Free to run and nothing to babysit. Cloudflare Worker free plan plus GitHub
  Actions on this repo. No servers, databases or queues, and no VPS: one more
  machine to keep alive for a job that runs a few times a day.
- Zero runtime dependencies. Node 22 built-ins and the Workers runtime cover
  everything; keep it that way.
- Policy lives in config, not in code. Settings that give nothing away are in
  `reviewbot.json`; who the bot works for is in the `REVIEWBOT_POLICY` secret.
  The deploy workflow hands the owner list to the Worker so an unwanted install
  is dropped before it costs a run. It is passed, never re-typed.
- The pins in `reviewbot.json` are the best free models as of the last weekly
  re-pin, and a human merges that PR. A run is never handed a model that is not
  free, and the free router is the last resort, never a pin, so a review never
  lands on a tiny model just because it was up.
- Nothing checked into this repo names an account, a repo or a person, in code,
  config, commit messages, PR descriptions or docs. It is public and the repos
  it reviews are not. Placeholders read `your-login`, `your-org`.
- A review must never be wrong about where it points. Inline comments are
  checked against the real diff, and one the model got wrong moves into the
  review body.
- A review must not guess about what it cannot see. The prompt says what the
  model has (the diff, the code around each change at head, the checks) and
  names every gap, so a silence never reads as an all-clear. It carries today's
  date, because the model's knowledge is older. `src/verify.js` drops comments
  the code contradicts or that rest on a fact nobody showed. Nothing here is
  specific to one repository or language.
- A clean review approves, because auto-merge repos wait on the bot. A review
  that could not be done properly (unchecked comments, an unseen file, an
  incomplete model, open earlier points) stays a comment and says why.
- Fail loud in the Actions log, quiet on the PR. A skipped PR gets a log line,
  not a comment.
- Only a parsed review is published. Working notes, a classifier verdict or a
  truncated chain of thought is retried, and a job that never gets a review
  fails instead of posting one.
- Nothing in a run title or a log line may name a repo, an owner or an author.
  New log output goes through the redactor in `src/log.js`, and new workflow
  expressions use `client_payload.ref`, never `client_payload.repo`.

## Layout

- `worker/` the Cloudflare Worker relay, deployed by `deploy-worker.yml`.
- `src/review.js` the entry point `review.yml` runs. `src/reply.js` answers
  replies on review threads. The rest of `src/` is one concern per file, named
  for it, and each opens with a comment saying what it is for.
- `test/` `node --test` suites for everything that does not need the network.
- `scripts/setup.sh` the setup wizard, kept because setup repeats on a fresh
  account.

## Working here

- `pnpm test` before a PR. CI runs the same thing.
- This repo's PRs are reviewed by the bot as the App's bot user, with a footer
  naming the model.
- No emojis anywhere, no AI co-authors, commits with the machine's global git
  identity. Branch and PR for everything; never push to `master`.

## Glossary

- **job**: the small object the Worker dispatches (`repo`, `pr`, `installation`,
  `event`, `action`, `author`, `sender`, `draft`, `comment_id`, `ref`, `thread`).
  The reviewer decides from it and the loaded config alone.
- **owner**: the single login in `REVIEWBOT_POLICY` that may issue `/review`.
- **allowed author**: a login whose PRs get reviewed automatically.
- **forced review**: one requested with `/review`. It skips the author list but
  not the already-reviewed check, because a second read of an unchanged head
  says nothing new.
- **ref**: the Worker's anonymous handle for a repo, an HMAC of the full name
  keyed by the webhook secret. The only name for a repo that reaches the public
  Actions log.
- **marker**: the `<!-- review-bot head=SHA -->` comment in each review body,
  used to avoid reviewing the same head commit twice.
- **stray comment**: a model comment whose path or line is not in the diff,
  listed in the review body under "Other notes".
- **settled**: a bot review thread whose latest bot reply carries the
  `<!-- review-bot settled -->` marker. The concern is dropped from future
  reviews, and once every thread from one review is settled that review's
  `REQUEST_CHANGES` is lifted.
