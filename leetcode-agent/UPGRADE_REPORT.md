# Upgrade Report — AI LeetCode Agent

Audit, fixes, validation results and outstanding risks for the upgrade from v0.1.0 to v0.2.0.

Everything in this document was measured on this machine on 2026-10-28 against the live
Gemini, Judge0 and LeetCode APIs. Where something was not measured, it says so.

---

## 1. Original root causes and how they were fixed

### 1.1 The highest-priority defect: no interface grounding

LeetCode rejects a solution whose method name, parameter types, order, return type or class
shape differs from its template, however correct the algorithm. The original pipeline asked
the model to write a `class Solution` from the problem *prose* and never requested the
official template — even though LeetCode's GraphQL API returns it, for free, in the same
call as the statement.

So the method name was a guess every time. On well-known problems the guess is usually right
(the model has them memorised); on a new daily challenge, or on one of LeetCode's deliberate
naming traps (`myAtoi`, `myPow`, `mySqrt`, `convertToTitle`, `strStr`), it is a coin flip.
And nothing in the pipeline could tell the difference.

**Fixed by three things, in this order:**

1. `src/lib/leetcode.ts` now asks LeetCode GraphQL for `metaData` and `codeSnippets`
   alongside the statement, and cross-checks that every field belongs to the same problem.
   When the official Java template cannot be retrieved, the run is capped at `unverified`
   and explicitly refuses to call the result submission-ready, rather than guessing.
2. The official snippet is treated as immutable. `src/lib/prompts.ts` hands it to the model
   verbatim with the instruction to reproduce the declarations character for character and
   implement inside them. Every repair prompt restates it, so a repair cannot drift off the
   contract.
3. `src/lib/java/contract.ts` validates the result deterministically — see §3.

### 1.2 The model certified its own work

The original `testCode()` asked Gemini to emit `Main` **and** `Solution`, with expected
values recalled from the statement, then trusted the `ALL_TESTS_PASSED` string that same
model chose to print. In the baseline run captured during the audit, the harness contained a
verbatim copy of the solution: the artifact under test was a different object from the
artifact that got saved, and the verdict was whatever the model decided.

**Fixed:** `src/lib/java/harness.ts` builds the harness in TypeScript from LeetCode's own
`exampleTestcases` and the `Output:` values parsed from the statement, and injects the
solution verbatim. The model writes no assertions and cannot replace the code under test.
Values are compared through a canonical serialisation shared by both sides (so `6`, `6.0`
and `6.00000` agree). When a parameter type or an expected value cannot be handled, the case
is reported as unsupported — never guessed.

It also emits, in the same program and therefore at no extra quota cost, a
**shared-instance replay**: every example is run again against one reused instance, which
catches state leaking between judge calls — a real LeetCode rejection cause that example
tests alone never reveal.

### 1.3 Repairs that damaged working code

A compile error in an LLM-written harness was attributed to the solution, and `debugCode()`
was then told "the tests failed" and asked to rewrite code that may have been correct.
Nothing recorded that attempt 1 might have been better than attempt 3.

**Fixed:** `src/lib/pipeline.ts` classifies every outcome (`compile_error`, `wrong_answer`,
`runtime_error`, `timeout`, `infrastructure_error`) and uses a different prompt for each,
carrying the actual compiler output or the actual failing case. The best candidate is kept by
verification rank, not by recency, so a later worse attempt cannot overwrite a better one.
Repairs are bounded: at most 2 interface repairs and 4 attempts in total, with an execution
budget of 3.

### 1.4 Transient failures looked like bad AI

A single Gemini 503 aborted the whole run (this happened live during the audit). Judge0 HTTP
errors were parsed as execution results, so a quota message was scored as a failing test and
burned two more model calls "fixing" code that had never run. No call had a timeout.

**Fixed:** all outbound traffic goes through `src/lib/http.ts` (per-attempt timeout,
exponential backoff with jitter on 429/5xx and transport errors). `src/lib/runner/judge0.ts`
checks the HTTP status before interpreting a body and reports infrastructure failures as
such; the pipeline then stops instead of blaming the solution.

### 1.5 Degraded input

`stripHtml` decoded six entities and discarded all block structure. Today's problem reached
the model with ten literal `&rarr;` tokens and its examples glued to its constraints.

**Fixed:** `src/lib/html.ts` decodes named and numeric entities, drops zero-width noise, and
preserves the line structure of examples, bullet lists and constraint blocks. The
`Constraints:` block is extracted separately and passed to the model as its own section.

### 1.6 Everything else from the audit

| Audit finding | Status |
| --- | --- |
| C1 Supabase project host does not resolve (DNS NXDOMAIN) | Persistence is optional: Supabase → local `history.json` → none, with the outcome reported in the response. The dead host no longer hides behind a warning |
| C2 LLM-written test oracle | Fixed (§1.2) |
| C3 Official `exampleTestcases` fetched and discarded | Now drive the harness |
| C4 No method-signature grounding | Fixed (§1.1) |
| C5 Design problems forced into `class Solution` | `metaData.classname` is honoured; constructors and `void` methods are part of the contract and the harness replays operation sequences |
| C6 No retry on transient model failures | Bounded backoff in `http.ts` |
| C7 No timeouts anywhere | Per-attempt timeouts on every call |
| C8 Judge0 HTTP errors parsed as results | Status checked; infrastructure failures separated |
| C9 Dead fallback source (`leetcode-api-fasz` → HTTP 404) | Removed. GraphQL is primary; the community mirror is used only as a *pointer* to today's slug, never as a source of statement or contract |
| C10 Incomplete entity decoding, lost structure | Fixed (§1.5) |
| C11 Module-scope env assertions crashing imports | `src/lib/config.ts` reads lazily and reports missing variables with an actionable message; `src/lib/supabase.ts` is now a thin deprecated re-export that cannot crash on import |
| C12 Secrets: plaintext `CRON_SECRET` in the `.bat`, secret in a query string, public anon key used for writes | The `.bat` reads `.env.local` and stores no secret; `/api/cron` accepts `Authorization: Bearer` or `x-cron-secret` (query parameter still works, deprecated) and compares in constant time; `SUPABASE_SERVICE_ROLE_KEY` is preferred for writes; the unused `OPENROUTER_API_KEY` is documented as unused |
| No `maxDuration`, 52 s measured pipeline | Every route exports a `maxDuration` |
| Two competing cron paths, self-fetching HTTP | `/api/cron` calls the pipeline in-process; the CLI and the web app share one implementation |
| Fake pipeline progress, unused `logs` | Real progress: `POST /api/auto-solve?stream=1` streams NDJSON events that the UI renders live |
| `problem_history` written but never read | `GET /api/history` plus a "Recent runs" panel |
| 29 lint errors (`no-explicit-any`) | 0 errors, 0 warnings |
| 4 copies of the same 4 prompts | One `src/lib/prompts.ts`, used by the routes and the CLI |

---

## 2. Verification status, reported honestly

Nothing in the UI, the API or the email says "Accepted" or "100% correct". Each run reports
which of these was established:

| Status | Meaning |
| --- | --- |
| `unverified` | No contract available, or no code produced |
| `signature_invalid` | Does not match the official interface — LeetCode would reject it |
| `signature_valid` | Interface matches; not executed (no runner available, or execution unavailable) |
| `compile_failed` | Does not compile |
| `compiled` | Compiles, but the examples could not be verified deterministically |
| `example_tests_passed` | Reproduced LeetCode's published example outputs |
| `additional_tests_passed` | …and the extra no-oracle checks passed |
| `verified_by_leetcode` | **Never set by this agent.** Only a real submission can establish it |

`submissionReady` is true only when the official examples passed *and* the problem metadata
was self-consistent. Every response also carries `readinessReason` in plain language.

---

## 3. Signature validation architecture

`src/lib/java/parse.ts` (424 lines) → `src/lib/java/contract.ts` (312 lines). No LLM is
involved in deciding whether a signature is correct.

**Parsing.** A regex over Java source cannot be trusted: it trips over generics
(`Map<String, List<Integer>>`), C-style declarators (`int nums[]`), varargs, annotations,
nested classes, strings containing braces, and comments containing code — and LeetCode's own
templates contain commented-out class definitions. So the source is first *masked* (comments
and literal contents replaced by spaces of equal length, which keeps every offset valid),
then scanned structurally with brace, paren and angle-bracket depth tracking. Method bodies
are deliberately opaque: `javac` is the right tool for those, and it runs later.

**The contract** comes from the official snippet, not from `metaData` (`metaData` is used
only to pick the right class and to cross-check). It records the class name, whether the
problem is algorithm- or design-shaped, every declared method with its normalised parameter
types, order and return type, and which helper types (`ListNode`, `TreeNode`, …) the judge
provides.

**Validation** compares a generated solution against that contract and emits specific,
actionable violations:

`wrong_method_name` · `wrong_return_type` · `wrong_param_types` · `wrong_param_count` ·
`wrong_class_name` · `missing_class` · `missing_method` · `missing_constructor` ·
`not_public` · `empty_body` · `unexpected_main` · `redefines_helper` ·
`extra_public_class` · `package_declaration` · `unparseable`

Two details worth calling out: when the algorithm is right but the name is wrong, the
validator says so explicitly ("Method must be named `twoSum`, but the solution defines
`findTwoSum` with the same signature"), which makes the repair prompt precise; and
overloads are resolved by exact parameter-type match, so a correct overload sitting beside a
wrong one is accepted.

**Then compilation.** A valid signature is necessary but not sufficient, so the harness still
compiles the solution — and because the harness calls the method with the exact declared
argument types and assigns its result, `javac` independently enforces the contract.

**Ordering.** Signature validation is free and local, so it runs *before* anything is
executed. Code that LeetCode would reject never consumes Judge0 quota.

---

## 4. Daily Challenge workflow

```
1  resolve today's slug          LeetCode GraphQL (community mirror only as a fallback pointer)
2  verify identity               slug + title + date cross-checked; drift is warned about
3  fetch the official record     statement, constraints, examples, metaData, codeSnippets.java
4  analyse                       task, algorithm, approach, complexity targets, edge cases
5  generate                      inside the official template, with constraints and examples
6  validate signature            deterministic, local, free
7  repair interface              bounded (≤2), contract restated each time
8  build harness                 from the official examples, in TypeScript
9  compile and run               local JDK if present, else Judge0 (1 submission per attempt)
10 repair by category            compile error / wrong answer / crash / timeout — never for
                                 an infrastructure failure
11 keep the best candidate       by verification rank, not recency
12 explain                       complexity and steps for the code that is actually reported
13 persist                       Supabase → local file → none, outcome reported
14 report                        verification ladder + readiness reason, never "Accepted"
```

A stale or disagreeing source cannot silently swap in a different problem: the mirror only
supplies a slug, and every field is then fetched from LeetCode itself and cross-checked.

---

## 5. Files changed

### Added — shared library

| File | Purpose |
| --- | --- |
| `src/lib/config.ts` | Lazy, validated environment access |
| `src/lib/http.ts` | Timeouts, bounded retries, error classification for every outbound call |
| `src/lib/log.ts` | Structured run log, streamed to the UI and stored with the run |
| `src/lib/html.ts` | Entity decoding and structure-preserving statement text; output/constraint extraction |
| `src/lib/leetcode.ts` | Official problem retrieval with provenance and consistency checks |
| `src/lib/gemini.ts` | One Gemini client: retries, usage accounting, code/JSON extraction |
| `src/lib/prompts.ts` | Every prompt, in one place |
| `src/lib/java/parse.ts` | Java declaration parser |
| `src/lib/java/contract.ts` | Official interface → contract; deterministic signature validation |
| `src/lib/java/harness.ts` | Deterministic harness generation from official examples |
| `src/lib/runner/{index,local,judge0,types}.ts` | Local JDK runner, Judge0 runner, selection |
| `src/lib/pipeline.ts` | The gates, in order, with bounded category-specific repairs |
| `src/lib/persistence.ts` | Optional history: Supabase → local file → none |
| `src/lib/problem-input.ts` | Slug/URL/text → `Problem` |
| `src/lib/types.ts`, `src/lib/api-types.ts` | Shared types (replacing 29 uses of `any`) |

### Added — tests, tooling, docs

`src/lib/__tests__/` (11 files, 170 tests) · `vitest.config.ts` · `scripts/daily-solve.ts` ·
`scripts/bench.ts` · `src/app/api/history/route.ts` · `src/app/agent-console.tsx` ·
`.env.example` · `UPGRADE_REPORT.md` · rewritten `README.md`

### Rewritten

| File | Change |
| --- | --- |
| `src/app/api/daily-challenge/route.ts` | GraphQL-first, returns the official contract; dead mirror removed |
| `src/app/api/auto-solve/route.ts` | Calls the shared pipeline; adds `?stream=1` progress streaming and the verification ladder |
| `src/app/api/analyze/route.ts` | Shared prompt; reports whether it is grounded on the official interface |
| `src/app/api/generate/route.ts` | Generates inside the official template and signature-checks (and repairs once) before responding |
| `src/app/api/execute/route.ts` | Deterministic harness instead of an LLM-written one; refuses to execute a signature-invalid solution |
| `src/app/api/cron/route.ts` | In-process pipeline, header-based secret, constant-time comparison |
| `src/app/page.tsx` | Server component supplying initial history |
| `src/app/agent-console.tsx` | Client UI: live pipeline log, verification ladder, official template vs generated solution, per-case results, explanation, history |
| `standalone-solver.mjs` | Thin shim over `scripts/daily-solve.ts`, so CI runs the same pipeline as the app |
| `src/lib/supabase.ts` | Deprecated re-export; no longer crashes on import |
| `../.github/workflows/daily-solve.yml` | Node 24, JDK on the runner (free compilation), lint + tests before the solve, honest subject line, history artifact, recipient from a secret |
| `../run-daily-agent.bat` | No stored secret; runs the pipeline directly |
| `package.json` | `test`/`daily`/`bench` scripts; `@google/genai` and `@supabase/supabase-js` dropped (both now unused — one HTTP path with shared retries serves the app and the CLI); `vitest` added |
| `tsconfig.json`, `.gitignore`, `README.md` | Supporting changes |

### Removed

Nothing. `src/lib/supabase.ts` was turned into a deprecated re-export rather than deleted,
and `standalone-solver.mjs` is still the entry point CI and the scheduler call.

---

## 6. Checks

All run on this machine, 2026-10-28, on the final state of the code:

| Check | Before | After |
| --- | --- | --- |
| `npx tsc --noEmit` | clean | clean |
| `npm run lint` | **29 errors**, 6 warnings | **0 errors, 0 warnings** |
| `npm run build` | succeeds | succeeds (9 routes + 1 page) |
| `npm test` | *no test runner existed* | **170 tests in 11 files, all passing** (4.4 s, no network, no API keys) |
| `npm audit` | 8 vulnerabilities (3 critical) | 1 critical (pre-existing, see §9) |

### 6.1 Unit test coverage

Deterministic, offline, and written against the specific failure modes in the audit:

| File | Tests | What it pins down |
| --- | --- | --- |
| `contract.test.ts` | 30 | The signature gate. Accepts correct code, C-style declarators, fully-qualified JDK types, private helpers, comment-only decoys and the right overload; rejects renamed methods, wrong return types, swapped/extra/missing parameters, wrong class names, non-public methods, empty bodies, stray `main`, redefined helper classes, two public top-level classes, package declarations and prose |
| `pipeline.test.ts` | 17 | Gate ordering: a signature-invalid solution is never executed; a renamed method is repaired and the repair prompt restates the contract; the repair budget is respected; compile errors, wrong answers and timeouts get different prompts carrying real evidence; an infrastructure failure is never blamed on the solution; the best candidate is kept, not the last; a missing template means "refuse to guess"; `verifiedByLeetCode` is never set |
| `harness.test.ts` | 20 | The solution is injected verbatim; expectations come from the official examples; `ALL_TESTS_PASSED` appears nowhere; void methods check the mutated argument; `ListNode`/`TreeNode` are built from the official array form; unsupported types and missing outputs are reported rather than guessed; design operation sequences replay in order |
| `parse.test.ts` | 15 | Masking of comments/strings, generics, varargs, C-style arrays, constructors, nested classes, field initialisers that look like declarations |
| `judge0.test.ts` | 12 | Every status id maps to the right category; 429/401/internal/unreachable are infrastructure, not wrong answers; base64 round-trip |
| `http.test.ts` | 10 | Retries a 503 then succeeds; retries a 429 to the limit; never retries a 400; honours a custom retry list; reports transport errors; respects caller aborts; always sends a timeout signal |
| `gemini.test.ts` | 18 | Code/JSON extraction from fenced, prose-wrapped and plain responses; thought parts ignored; truncation flagged; error classification; the key travels in a header, never in the URL |
| `leetcode.test.ts` | 15 | Official contract retrieval; missing snippet and unparseable metaData are flagged; a slug mismatch marks the run inconsistent; the mirror is pointer-only; stale dates warn; legacy response shape preserved |
| `persistence.test.ts` | 9 | Local fallback, append semantics, unreachable Supabase, legacy-column retry, serverless skip, never throws |
| `problem-input.test.ts` | 10 | Slug/URL/legacy-body parsing; pasted text is marked as having no official interface |
| `html.test.ts` | 14 | Entity decoding with no residue, block structure preserved, inline and design-style `Output:` parsing, constraints extraction |

---

## 7. Benchmark results

### 7.1 Contract retrieval, harness construction and the signature gate (free, no model calls)

`node scripts/bench.ts` over 17 problems chosen to cover every shape the audit flagged:
arrays, strings, trees, graphs/grids, dynamic programming, `void` returns with in-place
mutation, linked-list and tree helper types, collection returns, multi-parameter methods,
constructor-based design problems, and five deliberate naming traps where the required
method name cannot be guessed from the title (`myAtoi`, `myPow`, `mySqrt`, `convertToTitle`,
`strStr`).

| Measure | Result |
| --- | --- |
| Official metadata + Java template retrieved | **17 / 17** |
| Contract parsed from the official snippet | **17 / 17** |
| Deterministic harness built from the official examples | **17 / 17** |
| Signature mutations caught (renamed method, swapped parameters, changed return type, stray `main`) | **all; 0 missed** |

The mutation check is the direct answer to "a correct algorithm with an incorrect method
signature must fail the validation gate": each problem's official template is mutated four
ways and the validator must reject each one. Swapping two parameters *of the same type* is
not a contract change at all, so those cases are reported as not applicable rather than
counted as either a catch or a miss.

End-to-end confirmation through the HTTP API, with a correct Two Sum algorithm under a
renamed method:

```
POST /api/execute {"titleSlug":"two-sum", code: …public int[] findTwoSum(int[] nums, int target)…}
→ { "signature": { "valid": false,
      "violations": [{ "code": "wrong_method_name",
        "message": "Method must be named \"twoSum\", but the solution defines \"findTwoSum\" with the same signature." }] },
    "executed": false, "verification": "signature_invalid" }
```

The solution was rejected **before** any Judge0 quota was spent.

### 7.2 A/B against the original prompt (live, 13 problems)

Both arms were measured with the *same* instruments: the new signature validator and the new
deterministic harness. The only difference is how the code was generated — the original
prompt (statement prose only, no contract, no constraints, no examples) versus the current
pipeline.

| | Original prompt | Upgraded pipeline |
| --- | --- | --- |
| Signature matches the official interface | **13 / 13** | **13 / 13** |
| Official examples passed | **13 / 13** | **13 / 13** |
| Reported as submission-ready | n/a — the old pipeline had no such concept | **13 / 13** |

**This did not reproduce the signature hallucination, and I am not going to claim it did.**
With `gemini-3.5-flash-lite` on these 13 problems — including the five naming traps — the
original prompt produced the correct method name every time. These are problems the model
has effectively memorised; the hallucination you observed is most likely on new or rare
problems (a fresh daily challenge), where there is nothing to recall.

What changed is not the hit rate on familiar problems; it is that the result is now
**checked instead of assumed**. The old pipeline could not have told you which of the 13 was
right, and §7.3 shows what its verdict was actually worth.

**Cost, measured.** Across the 13 problems the upgraded pipeline used exactly **2 model calls
and 1 Judge0 submission per problem** (27 337 tokens in total) with the explanation step
disabled, as the benchmark runs it; 3 calls with the explanation step on.

Compared like for like on the same problem — today's daily challenge, which was also the
audit's baseline run:

| | Original pipeline (audit baseline) | Upgraded pipeline (§8 demo) |
| --- | --- | --- |
| Model calls | 3 | 3 |
| Judge0 submissions | 1 | 1 |
| Tokens | 3 642 | 3 916 |
| Wall clock | 52.1 s | 49 s |
| What was actually verified | nothing checkable — the model graded itself | signature, compilation, 3 official examples, 3 replay checks |

The verification is therefore not something you pay extra for: the signature gate is local and
free, the harness is generated in TypeScript, and running everything in one submission keeps
Judge0 usage at one call per attempt. The worst case is bounded at 4 attempts and 3
submissions, versus the original's unbounded-in-practice 3 rounds of harness regeneration.

### 7.3 Does the verdict mean anything? (the measurement that matters)

Two deliberately **wrong** solutions with correct signatures — Two Sum returning the values
instead of the indices, and Valid Parentheses counting brackets without matching their types
— were put through both verification approaches:

| Problem | Bug | Original: model writes the test | Upgraded: harness from official examples |
| --- | --- | --- | --- |
| Two Sum | returns values, not indices | **`ALL_TESTS_PASSED`** ❌ false positive | `wrong_answer`, 0/6 — `case 1: expected [0,1], got [2,7]` |
| Valid Parentheses | ignores bracket types | **`ALL_TESTS_PASSED`** ❌ false positive | `wrong_answer`, 6/10 — `case 3: expected false, got true` |

**2 out of 2 wrong solutions were certified as passing by the original approach**, by two
different mechanisms: for Two Sum the model kept the wrong solution and invented expected
values that matched its wrong output; for Valid Parentheses it silently replaced the solution
in the harness with its own correct version and tested *that*. Both would have been saved
and shown as "ready to submit on LeetCode".

The deterministic harness caught both, with the exact failing inputs.

This is the defect that made outputs feel unreliable: not that the model was especially bad,
but that nothing in the pipeline could tell a good answer from a bad one.

---

## 8. Final demonstration — today's daily challenge

Run through the web UI at `http://localhost:3000`, 2026-10-28, with live streaming progress:

| | |
| --- | --- |
| **Problem** | **3882. Minimum XOR Path in a Grid** (Medium) |
| Source | `leetcode-graphql`, provenance consistent, no warnings |
| **Official Java template** | `class Solution { public int minCost(int[][] grid) { } }` |
| Parsed contract | `algorithm class Solution: int minCost(int[][])` |
| Analysis | DP over reachable XOR values; target `O(m*n*K)` time, justified by `m*n <= 1000` and `0 <= grid[i][j] <= 1023` |
| **Signature validation** | ✅ matches the official template exactly (attempt 1, no repair needed) |
| **Compilation** | ✅ (Judge0; no JDK on this machine) |
| **Tests** | ✅ 6/6 — 3 official example cases plus 3 shared-instance replays |
| **Final status** | `additional_tests_passed` · submission-ready: **yes** |
| Honest caveat shown to the user | "LeetCode's hidden tests are still unproven" |
| Verified by LeetCode | ⬜ **not claimed** |
| Cost | 1 attempt, 3 model calls, 1 Judge0 submission, 3 916 tokens, 49 s |
| History | Supabase unreachable (reported, not hidden) → appended to `history.json` |

The generated solution — a per-cell set of reachable XOR values, returning the minimum at the
bottom-right cell — is in `history.json` and was displayed with its complexity analysis and a
step-by-step explanation of *that* code.

No LeetCode submission was made, so acceptance against the hidden tests is unknown. The agent
says exactly that.

---

## 9. Remaining limitations and risks

1. **Hidden tests are not checked.** Only LeetCode's published examples are. `submissionReady`
   means "passed everything we can check from outside", not "will be accepted". Closing this
   gap would need authenticated submission to LeetCode, which this project does not do.
2. **Expected values are parsed from the statement.** Problems whose statements do not publish
   a comparable output, or that accept any valid answer, fall back to a compile-only check and
   are reported as `compiled`, not as verified. Of the 17 benchmark problems, 0 needed this
   fallback, but it will happen.
3. **Helper types beyond `ListNode` and `TreeNode`** (e.g. `Node` in clone-graph problems) are
   not modelled by the harness; those problems get the compile-only check.
4. ~~One pre-existing critical advisory remains.~~ **Resolved — see §11.** `npm audit` now
   reports **0 vulnerabilities** across 489 dependencies.
5. **The Supabase project no longer exists** (`ENOTFOUND` on its host; `supabase.co` itself
   resolves). History currently goes to `history.json`. If you recreate the project, add a
   `status text` and `submission_ready boolean` column — the code tries those first and falls
   back to the original five columns automatically. Prefer `SUPABASE_SERVICE_ROLE_KEY` for
   writes so the public anon key does not need INSERT permission.
6. **Judge0 free-tier quota is shared with the benchmark.** A local JDK removes the dependency
   entirely; the GitHub Actions workflow now installs one, so the daily run costs no quota.
   This machine has no JDK, so every measurement above used Judge0.
7. **The daily email recipient comes from a `MAIL_TO` secret** instead of being hardcoded.
   The workflow now checks for the mail secrets and skips the mail steps with a warning when
   they are missing, so an unset `MAIL_TO` can no longer send to an empty recipient. See
   §11.4 for how to set it.
8. **This folder is not a git repository**, so nothing is committed and the GitHub Actions
   workflow has never run. `git init` plus a remote would activate it.
9. **Model choice is unchanged** (`gemini-3.5-flash-lite`), per your instruction. `GEMINI_MODEL`
   switches it without code changes if you later want to benchmark a stronger model.
10. **The benchmark is not a correctness proof.** 17 problems is a sample, and the A/B in §7.2
    used problems the model knows well. A run against a month of daily challenges would be a
    better measure of real-world behaviour.

---

## 10. Setup and execution

```bash
cd leetcode-agent
npm install
cp .env.example .env.local        # fill in GEMINI_API_KEY (required)
npm run dev                       # http://localhost:3000
```

Optional but recommended: install a JDK 17+ so `javac` is on `PATH`. The agent then compiles
and runs solutions locally — free, faster, and no Judge0 quota. Without it, set
`JUDGE0_API_KEY`; without either, solutions are signature-checked only and reported as
`signature_valid`.

```bash
npm test                          # 170 deterministic tests, no network or keys needed
npm run lint
npm run build
npm run daily                     # solve today's challenge from the CLI
node scripts/daily-solve.ts two-sum   # or a specific problem
node scripts/bench.ts             # free regression checks
node scripts/bench.ts --old --new # live A/B (costs model calls and Judge0 quota)
```

Scheduled runs:

- **GitHub Actions** — `.github/workflows/daily-solve.yml`, daily at 02:30 UTC. Secrets:
  `GEMINI_API_KEY`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_TO`, and optionally
  `JUDGE0_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- **Windows** — `setup-scheduler.bat` (run once as Administrator) registers
  `run-daily-agent.bat`, which now reads `.env.local` and stores no secret.
- **HTTP** — `GET /api/cron` with `Authorization: Bearer $CRON_SECRET`.


---

## 11. Addendum — Next.js security upgrade (2026-10-28)

### 11.1 What the advisories actually were

`npm audit`'s summary line said "1 critical", but that was one *package* with **11
advisories** attached, three of them critical. The full set against `next@16.3.4`:

| Severity | Advisory | Vulnerable range |
| --- | --- | --- |
| **critical** | [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) — unauthenticated RCE in the Image Optimization API when SVG files are used | `>=16.0.0 <=16.4.0` |
| **critical** | [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) — unauthenticated RCE in `use cache` functions returning typed arrays | `>=16.0.0 <=16.4.0` |
| **critical** | [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j) — RCE in `next/og` ImageResponse | `>=16.2.0 <16.3.6` |
| high | [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) — SSRF in Image Optimization | `>=16.0.0 <16.3.8` |
| high | [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r) — DoS in App Router Server Actions | `>=16.0.0 <=16.4.0` |
| moderate | [GHSA-4jqv-mc3x-m676](https://github.com/advisories/GHSA-4jqv-mc3x-m676) — cache poisoning of SSG/ISR pages when self-hosted | `>=16.0.0 <16.3.8` |
| moderate | [GHSA-mcj8-r9mp-w47p](https://github.com/advisories/GHSA-mcj8-r9mp-w47p) — cache poisoning causing cross-user content substitution and persistent DoS | `>=16.0.0 <16.3.8` |
| moderate | [GHSA-f87g-xv8r-7p7x](https://github.com/advisories/GHSA-f87g-xv8r-7p7x) — info disclosure via `dynamicParams` bypass in metadata image routes | `>=16.0.0 <16.3.8` |
| moderate | [GHSA-3w37-wq28-93x7](https://github.com/advisories/GHSA-3w37-wq28-93x7) — pending `use cache` fill leaking Draft Mode content | `>=16.3.0 <16.3.8` |
| moderate | [GHSA-h694-7cp9-m8p3](https://github.com/advisories/GHSA-h694-7cp9-m8p3) — cache leak across root param values in nested `use cache` | `>=16.3.0 <16.3.8` |
| low | [GHSA-39w2-rjm5-chcv](https://github.com/advisories/GHSA-39w2-rjm5-chcv) — info disclosure in the dev server's MCP endpoint | `>=16.0.0 <16.3.8` |

**Correction to §9 item 4 of the original report:** it named only GHSA-h694-7cp9-m8p3 and
called it the critical one. That advisory is in fact moderate; the three criticals are the
ones listed above. The earlier text under-reported the severity picture.

### 11.2 Version selected

The widest vulnerable ranges end at `<=16.4.0`, so the **minimum patched stable version is
16.4.1**. Installed: **`next@16.4.3`** — the newest patch of the same `16.4` line and what
npm's `fixAvailable` recommends (`isSemVerMajor: false`). Staying inside major 16 and minor
16.4 keeps the upgrade a patch-level move rather than a blind jump to a new major; 16.4.3 is
also the current `latest` dist-tag, and 16.5 exists only as canary builds, which were not
considered.

`eslint-config-next` was moved from `16.3.4` to `16.4.3` as well, since the project pins it
to the exact Next version and the lint rules ship with it. React stays at `19.2.8`, which
satisfies `next@16.4.3`'s peer range (`^18.2.0 || ^19.0.0`). No other dependency changed and
nothing new was added.

### 11.3 Verification after the upgrade

| Check | Result |
| --- | --- |
| `npm test` | **170 / 170 passing**, 11 files |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run build` | succeeds — 9 API routes + 1 dynamic page, same route table as before |
| `npm audit` | **0 vulnerabilities** across 489 dependencies (was 8, incl. 3 critical) |

Functional verification against the running dev server on 16.4.3:

| Route | Result |
| --- | --- |
| `GET /api/daily-challenge` | 3882. Minimum XOR Path in a Grid (Medium); legacy fields intact; `javaSnippet`, `exampleOutputs` and consistent provenance returned |
| `GET /api/history` | reads back the local history file |
| `POST /api/execute` with a renamed method | `signature_invalid`, `executed: false`, `wrong_method_name` — still rejected before any execution |
| `POST /api/auto-solve?stream=1` | 10 streamed progress events, then `additional_tests_passed`, `submissionReady: true`, 6/6 cases (3 official + 3 shared-instance), 3 model calls, 1 Judge0 submission, 43 s; all legacy response fields present; Supabase failure reported and history appended locally |
| `GET /` | renders, with the live "Recent runs" panel |

No new warnings or deprecation notices appeared in the dev server output.

### 11.4 Breaking changes

**None affecting this project.** 16.3.4 → 16.4.3 is a minor-plus-patch move inside major 16;
the bundled upgrade guide documents no breaking change for 16.4, only that
`eslint-config-next@16.4.0+` additionally supports ESLint 10 (this project uses ESLint 9,
which remains supported). Signature validation, the deterministic harness, the daily
challenge automation and the streaming UI all behave as before, as measured above.

### 11.5 `MAIL_TO` configuration

`MAIL_TO` is a **GitHub Actions repository secret**, not an application environment variable
— the agent never sends mail itself, so it does not belong in `.env.local`.

From the GitHub UI: repository → *Settings* → *Secrets and variables* → *Actions* → *New
repository secret* → name `MAIL_TO`, value the destination address. Repeat for
`MAIL_USERNAME` and `MAIL_PASSWORD`.

With the `gh` CLI:

```bash
gh secret set MAIL_TO --body "you@example.com"
gh secret set MAIL_USERNAME --body "your.gmail.address@gmail.com"
gh secret set MAIL_PASSWORD   # paste a Gmail App Password when prompted
gh secret list                # confirm
```

`MAIL_PASSWORD` must be a Gmail App Password, not the account password. `MAIL_TO` accepts a
comma-separated list.

The workflow gained a **Check email configuration** step: when `MAIL_TO`, `MAIL_USERNAME` or
`MAIL_PASSWORD` is missing it sets `configured=false`, emits a GitHub warning annotation, and
both mail steps are skipped. The solve itself still runs and its history is still uploaded as
an artifact. Previously an unset `MAIL_TO` would have attempted a send with an empty
recipient.

While validating this, the workflow was found to be **unparseable YAML**: a `description`
string introduced in the previous change used `\'` inside single quotes, which YAML does not
accept as an escape. GitHub would have rejected the file. It is fixed and the workflow now
parses, with 11 steps and both `schedule` and `workflow_dispatch` triggers.
