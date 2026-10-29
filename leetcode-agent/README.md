# AI LeetCode Agent

An agent that fetches a LeetCode problem, writes a Java solution **inside LeetCode's own
interface**, and then proves as much about that solution as it can before showing it to you.

The important part is the last bit. Generating plausible Java is easy; the agent's job is to
tell you honestly whether what it generated would actually be accepted. It never reports
"Accepted" or "100% correct" — it reports which checks passed.

```
Understand → Constraints → Algorithm → Generate → Validate signature → Compile → Run official examples → Explain
```

## What it guarantees, and what it doesn't

Every run reports a verification ladder. Each rung is a separate, checkable claim:

| Rung | Means |
| --- | --- |
| **Official metadata** | LeetCode returned the Java template and `metaData` for this exact problem |
| **Signature valid** | Class name, method names, parameter types and order, and return types match the official template — checked by a Java declaration parser, not by an LLM |
| **Compiled** | `javac` accepted the solution |
| **Example tests passed** | The solution reproduced LeetCode's published example outputs, in a harness generated from those examples |
| **Additional checks passed** | Extra no-oracle checks passed (e.g. no state leaking between test cases) |
| **Verified by LeetCode** | Never set. Only a real submission can establish this |

**Passing every rung still does not prove the solution is accepted.** LeetCode's hidden tests
and time limits are not visible from outside, and the agent says so.

## Setup

Requires **Node 22.18+ or 24+** (the CLI runs TypeScript directly, with no build step).

```bash
cd leetcode-agent
npm install
cp .env.example .env.local   # then fill in GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Only `GEMINI_API_KEY` is required ([get one here](https://aistudio.google.com/apikey)).

**For compiling and running solutions**, the agent prefers a local JDK — free, fast, no
quota. Install any JDK 17+ and make sure `javac` is on `PATH`. If there is no JDK it falls
back to [Judge0 on RapidAPI](https://rapidapi.com/judge0-official/api/judge0-ce) when
`JUDGE0_API_KEY` is set. With neither, solutions are still signature-checked, and the run is
reported as `signature_valid` rather than verified.

Run history is optional: Supabase if configured and reachable, otherwise a local
`history.json`, otherwise nothing. A failure to persist never fails a run.

## Commands

```bash
npm run dev        # Next.js dev server
npm run build      # production build
npm test           # 170 deterministic unit tests, no network and no API keys needed
npm run lint       # eslint
npm run daily      # solve today's daily challenge from the CLI
npm run bench      # regression benchmark (see below)
```

`npm run daily` also accepts a slug: `node scripts/daily-solve.ts two-sum`.

## Benchmark

```bash
node scripts/bench.ts                     # free: metadata, contract, harness and mutation checks
node scripts/bench.ts --new --limit 6     # live run of the current pipeline
node scripts/bench.ts --old --new         # A/B against the original prompt, same instruments
```

The dry mode costs no model calls. It verifies, for every problem in the set, that the
official contract can be retrieved and parsed, that a deterministic harness can be built,
and that the signature validator rejects systematically mutated signatures (renamed method,
swapped parameters, changed return type, stray `main`).

Measured results are in [UPGRADE_REPORT.md](./UPGRADE_REPORT.md).

## Daily automation and email notifications

The scheduled run lives in [`.github/workflows/daily-solve.yml`](../.github/workflows/daily-solve.yml)
(02:30 UTC daily, plus a manual trigger that optionally takes a problem slug). It installs a
JDK, so compilation and execution cost no Judge0 quota.

Email is **optional**. The workflow checks for the mail secrets first and, if any are
missing, skips both mail steps and writes a warning into the run summary instead of failing
the job or sending to an empty recipient.

`MAIL_TO` is a **GitHub Actions repository secret**, not an app environment variable — the
agent itself never sends mail, so it does not belong in `.env.local`.

**Set it from the GitHub UI:** repository → *Settings* → *Secrets and variables* → *Actions*
→ *New repository secret* → name `MAIL_TO`, value the destination address (for example
`you@example.com`). Repeat for `MAIL_USERNAME` and `MAIL_PASSWORD`.

**Or with the `gh` CLI:**

```bash
gh secret set MAIL_TO --body "you@example.com"
gh secret set MAIL_USERNAME --body "your.gmail.address@gmail.com"
gh secret set MAIL_PASSWORD   # paste a Gmail App Password when prompted
```

Notes:

- `MAIL_PASSWORD` must be a [Gmail App Password](https://support.google.com/accounts/answer/185833),
  not your account password; Gmail rejects plain passwords on SMTP.
- `MAIL_TO` accepts several addresses separated by commas.
- The subject line states the verification level (`VERIFIED: 1. Two Sum` or
  `UNVERIFIED (signature_invalid): …`), so an unverified run is never reported as a success.
- To check what is configured: `gh secret list`.

Required secrets for the solve itself: `GEMINI_API_KEY`. Optional: `JUDGE0_API_KEY` (only
used if the runner has no JDK), `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and the `GEMINI_MODEL`
repository *variable*.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/daily-challenge` | Today's official problem, including `javaSnippet`, `metaData`, constraints, example inputs/outputs and a `provenance` block |
| `POST /api/auto-solve` | Full pipeline. Body: `{ titleSlug }` or `{ url }` (preferred) or `{ problemText }`. Add `?stream=1` for newline-delimited progress events |
| `POST /api/analyze` | Analysis step only |
| `POST /api/generate` | Generation step only; returns the code plus its signature validation |
| `POST /api/execute` | Compiles and runs a solution against the official examples |
| `GET /api/cron` | Scheduled daily run. Send the secret as `Authorization: Bearer <CRON_SECRET>` |
| `GET /api/history` | Recent runs |

Every response keeps the fields the previous version returned, so existing callers continue
to work; the verification fields are additions.

## How it works

```
src/lib/
  leetcode.ts        official problem retrieval (GraphQL first; metaData + codeSnippets)
  html.ts            statement → text, with entities decoded and block structure kept
  gemini.ts          one Gemini client: retries, timeouts, usage accounting
  prompts.ts         every prompt, in one place
  java/parse.ts      Java declaration parser (masking, generics, arrays, nested classes)
  java/contract.ts   official interface → contract; deterministic signature validation
  java/harness.ts    test harness generated from LeetCode's own examples
  runner/            local JDK runner, Judge0 runner, selection
  pipeline.ts        the gates, in order, with bounded category-specific repairs
  persistence.ts     optional history (Supabase → local file → none)
```

The CLI (`scripts/daily-solve.ts`) imports the same pipeline the web app uses, so there is
one implementation of the prompts and one of the verification logic.

### Why the harness is generated in TypeScript

An earlier version asked the model to write both the test harness *and* the solution, then
believed the `ALL_TESTS_PASSED` string that same model chose to print. That is not a test.
Here, expected values come from LeetCode's published examples, the harness is assembled by
`java/harness.ts`, and the solution is injected verbatim. When a type or an expected value
cannot be handled, the case is reported as unsupported — never guessed.

## Known limitations

- **Hidden tests and time limits are not checked.** Only the published examples are.
- Expected values are parsed from the `Output:` lines in the statement. Problems whose
  statement does not publish a comparable output (or that accept any valid answer) fall back
  to a compile-only check, reported as `compiled`.
- Helper types beyond `ListNode` and `TreeNode` (for example `Node` in the clone-graph
  problems) are not modelled by the harness; those problems get the compile-only check.
- Java only.
