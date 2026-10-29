/**
 * Regression benchmark.
 *
 * Three modes, because they cost very different amounts:
 *
 *   --dry        (default) No model calls. For every problem in the set it checks that the
 *                official metadata and Java template can be retrieved, that the contract
 *                parses, that a deterministic harness can be built, and that the validator
 *                rejects systematically mutated signatures (renamed method, swapped
 *                parameters, changed return type). Free apart from LeetCode requests.
 *
 *   --new        Runs the current pipeline end to end.
 *
 *   --old        Reproduces the ORIGINAL generation prompt (no interface contract, no
 *                constraints, no official examples) and measures it with the *same*
 *                instruments as --new, so the comparison is apples to apples.
 *
 * Usage:
 *   node scripts/bench.ts                       # dry checks over the whole set
 *   node scripts/bench.ts --new --limit 6       # live run, current pipeline
 *   node scripts/bench.ts --old --new           # A/B on the same problems
 *   node scripts/bench.ts --new --only two-sum,lru-cache
 */

import { fetchProblemBySlug } from '../src/lib/leetcode.ts';
import { buildContract, describeContract, validateSignature } from '../src/lib/java/contract.ts';
import { buildCompileOnlyHarness, buildHarness } from '../src/lib/java/harness.ts';
import { solveProblem } from '../src/lib/pipeline.ts';
import { GeminiClient, extractJavaCode } from '../src/lib/gemini.ts';
import { runJava, selectRunner } from '../src/lib/runner/index.ts';
import type { Problem, JavaContract } from '../src/lib/types.ts';

type BenchCase = { slug: string; covers: string };

/** Chosen to cover each shape the audit flagged as a signature-hallucination risk. */
const CASES: BenchCase[] = [
  { slug: 'two-sum', covers: 'array, multiple params, array return' },
  { slug: 'longest-common-prefix', covers: 'strings, String[] param, String return' },
  { slug: 'binary-tree-level-order-traversal', covers: 'tree helper type, List<List<Integer>> return' },
  { slug: 'number-of-islands', covers: 'graph/grid, char[][] param' },
  { slug: 'climbing-stairs', covers: 'dynamic programming, single int param' },
  { slug: 'move-zeroes', covers: 'void return with in-place mutation' },
  { slug: 'merge-two-sorted-lists', covers: 'linked-list helper type, node return' },
  { slug: 'lru-cache', covers: 'design problem: constructor + void and int methods' },
  { slug: 'implement-trie-prefix-tree', covers: 'design problem: boolean methods, unusual names (startsWith)' },
  { slug: 'spiral-matrix', covers: 'matrix param, List<Integer> return, unusual method name' },
  { slug: 'valid-parentheses', covers: 'string param, boolean return' },
  { slug: 'kth-largest-element-in-an-array', covers: 'unusual method name (findKthLargest), two params' },

  // Signature traps: the required method name cannot be inferred from the title, which is
  // exactly where a model that was never shown the official template guesses wrong.
  { slug: 'string-to-integer-atoi', covers: 'trap: method is myAtoi, not atoi' },
  { slug: 'powx-n', covers: 'trap: method is myPow with a double return and (double, int) params' },
  { slug: 'sqrtx', covers: 'trap: method is mySqrt, not sqrt' },
  { slug: 'excel-sheet-column-title', covers: 'trap: method is convertToTitle' },
  { slug: 'find-the-index-of-the-first-occurrence-in-a-string', covers: 'trap: method is strStr' },
];

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const runNew = flag('new');
const runOld = flag('old');
const dryOnly = !runNew && !runOld;
const limit = Number(value('limit') ?? CASES.length);
const only = value('only')?.split(',').map((s) => s.trim());

const selected = CASES.filter((c) => (only ? only.includes(c.slug) : true)).slice(0, limit);

/* ------------------------------------------------------------------ *
 * Signature mutations: a correct algorithm with a broken interface    *
 * must fail the gate.                                                 *
 * ------------------------------------------------------------------ */

type Mutation = { name: string; apply: (code: string, contract: JavaContract) => string | undefined; expect: string[] };

const MUTATIONS: Mutation[] = [
  {
    name: 'renamed method',
    expect: ['wrong_method_name', 'missing_method'],
    apply: (code, contract) => {
      const method = contract.methods.find((m) => !m.isConstructor);
      if (!method) return undefined;
      return code.replace(new RegExp(`\\b${method.name}\\s*\\(`), `renamed${method.name[0].toUpperCase()}${method.name.slice(1)}(`);
    },
  },
  {
    name: 'swapped parameter order',
    expect: ['wrong_param_types'],
    apply: (code, contract) => {
      const method = contract.methods.find((m) => !m.isConstructor && m.paramTypes.length >= 2);
      if (!method) return undefined;
      const signature = new RegExp(`(${method.name}\\s*\\()([^)]*)(\\))`);
      const match = signature.exec(code);
      if (!match) return undefined;
      const params = match[2].split(',').map((p) => p.trim());
      if (params.length < 2) return undefined;
      // Swapping two parameters of the same type is not a contract change at all, so
      // there would be nothing for the validator to catch.
      if (method.paramTypes[0] === method.paramTypes[1]) return undefined;
      // Swap the first two declarations, keeping the names so the body still compiles.
      const [a, b] = params;
      const swapped = [b, a, ...params.slice(2)].join(', ');
      return code.replace(signature, `$1${swapped}$3`);
    },
  },
  {
    name: 'changed return type',
    expect: ['wrong_return_type'],
    apply: (code, contract) => {
      const method = contract.methods.find((m) => !m.isConstructor && m.returnType !== 'void');
      if (!method) return undefined;
      const replacement = method.returnType === 'int' ? 'long' : 'Object';
      return code.replace(new RegExp(`${escapeRegExp(method.returnType)}\\s+${method.name}\\s*\\(`), `${replacement} ${method.name}(`);
    },
  },
  {
    name: 'added main method',
    expect: ['unexpected_main'],
    apply: (code) => code.replace(/\}\s*$/, '    public static void main(String[] args) { }\n}'),
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * The original (pre-upgrade) generation prompt, kept verbatim          *
 * ------------------------------------------------------------------ */

function legacyPrompt(problemText: string): string {
  return `
Write an optimal LeetCode Java solution (class Solution) for this problem.
Provide ONLY the Java code (class Solution). Do NOT include markdown code blocks or explanations.

Problem: ${problemText}
Analysis: {}
  `;
}

type Row = {
  slug: string;
  covers: string;
  metadata: boolean;
  contract?: string;
  harness: 'deterministic' | 'compile-only' | 'none';
  harnessCases?: number;
  mutationsCaught?: string;
  oldSignature?: boolean;
  oldStatus?: string;
  newSignature?: boolean;
  newStatus?: string;
  newReady?: boolean;
  newAttempts?: number;
  notes: string[];
};

async function dryCheck(problem: Problem, contract: JavaContract, row: Row) {
  // A reference solution is not available offline, so mutations are applied to the
  // official template itself with a trivial body — enough to exercise the gate.
  const stub = contract.source.replace(/\{\s*\n\s*\n\s*\}/g, '{ throw new UnsupportedOperationException(); }');
  const baseline = validateSignature(stub, contract);
  const caught: string[] = [];

  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(stub, contract);
    if (!mutated || mutated === stub) {
      caught.push(`${mutation.name}: n/a`);
      continue;
    }
    const result = validateSignature(mutated, contract);
    const codes: string[] = result.violations.map((v) => v.code);
    const hit = mutation.expect.some((code) => codes.includes(code));
    caught.push(`${mutation.name}: ${hit ? 'caught' : `MISSED (${codes.join(',') || 'no violations'})`}`);
  }

  row.mutationsCaught = caught.join(' | ');
  if (!baseline.valid && baseline.violations.some((v) => v.code !== 'empty_body')) {
    row.notes.push(`official template itself failed validation: ${baseline.violations.map((v) => v.code).join(',')}`);
  }
}

async function runLegacy(problem: Problem, contract: JavaContract, row: Row) {
  const gemini = new GeminiClient();
  const response = await gemini.generate({ prompt: legacyPrompt(problem.statement), maxOutputTokens: 1000 });
  const code = extractJavaCode(response.text);
  const signature = validateSignature(code, contract);

  row.oldSignature = signature.valid;

  if (!signature.valid) {
    row.oldStatus = `signature_invalid (${signature.violations.map((v) => v.code).join(',')})`;
    return;
  }

  // Measured with the same deterministic harness as the new pipeline.
  const harness = buildHarness(problem, contract, code);
  const source = harness.supported ? harness.source : buildCompileOnlyHarness(contract, code);
  const outcome = await runJava({ source });
  row.oldStatus = harness.supported
    ? outcome.kind === 'passed'
      ? 'example_tests_passed'
      : outcome.kind
    : outcome.kind === 'passed'
      ? 'compiled'
      : outcome.kind;
}

async function runCurrent(problem: Problem, row: Row) {
  const result = await solveProblem(problem, { explain: false });
  row.newSignature = result.checks.signatureValid;
  row.newStatus = result.status;
  row.newReady = result.submissionReady;
  row.newAttempts = result.attempts.length;
  if (!result.submissionReady) row.notes.push(result.readinessReason.slice(0, 120));
  return result;
}

async function main() {
  const runner = await selectRunner('auto');
  console.log(`# Benchmark\n`);
  console.log(`mode: ${[dryOnly && 'dry', runOld && 'old', runNew && 'new'].filter(Boolean).join(' + ')}`);
  console.log(`problems: ${selected.length}`);
  console.log(`runner: ${runner?.name ?? 'none (compile/run unavailable)'}`);
  console.log(`started: ${new Date().toISOString()}\n`);

  const rows: Row[] = [];
  let geminiCalls = 0;
  let judge0 = 0;
  let tokens = 0;

  for (const benchCase of selected) {
    const row: Row = { slug: benchCase.slug, covers: benchCase.covers, metadata: false, harness: 'none', notes: [] };
    rows.push(row);

    try {
      const problem = await fetchProblemBySlug(benchCase.slug);
      if (!problem) {
        row.notes.push('LeetCode returned no record');
        continue;
      }

      row.metadata = problem.provenance.hasJavaSnippet && problem.provenance.hasMetaData;
      if (!problem.javaSnippet) {
        row.notes.push('no official Java template');
        continue;
      }

      const contract = buildContract(problem.javaSnippet, problem.metaData);
      row.contract = describeContract(contract);

      const harness = buildHarness(problem, contract, contract.source);
      row.harness = harness.supported ? 'deterministic' : 'compile-only';
      row.harnessCases = harness.supported ? harness.verifiableCases : 0;
      if (!harness.supported) row.notes.push(`harness: ${harness.reason.slice(0, 100)}`);

      await dryCheck(problem, contract, row);

      if (runOld) await runLegacy(problem, contract, row);
      if (runNew) {
        const result = await runCurrent(problem, row);
        geminiCalls += result.usage.geminiCalls;
        judge0 += result.usage.judge0Submissions;
        tokens += result.usage.promptTokens + result.usage.outputTokens;
      }

      console.log(
        `${row.slug.padEnd(36)} meta=${row.metadata ? 'y' : 'n'} harness=${row.harness}(${row.harnessCases}) ` +
          `${runOld ? `old=${row.oldSignature ? 'sig-ok' : 'SIG-FAIL'}/${row.oldStatus ?? '-'} ` : ''}` +
          `${runNew ? `new=${row.newStatus} ready=${row.newReady ? 'yes' : 'no'}` : ''}`,
      );
    } catch (error) {
      row.notes.push(`error: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`${row.slug.padEnd(36)} ERROR ${row.notes[row.notes.length - 1]}`);
    }
  }

  /* ---- summary ---- */

  const withContract = rows.filter((r) => r.contract);
  const missed = rows.flatMap((r) => (r.mutationsCaught ?? '').split(' | ').filter((m) => m.includes('MISSED')));

  console.log('\n## Summary\n');
  console.log(`official metadata retrieved : ${rows.filter((r) => r.metadata).length}/${rows.length}`);
  console.log(`contract parsed             : ${withContract.length}/${rows.length}`);
  console.log(`deterministic harness built : ${rows.filter((r) => r.harness === 'deterministic').length}/${rows.length}`);
  console.log(`signature mutations missed  : ${missed.length} ${missed.length ? JSON.stringify(missed) : ''}`);

  if (runOld) {
    const ok = rows.filter((r) => r.oldSignature === true).length;
    const measured = rows.filter((r) => r.oldSignature !== undefined).length;
    const passed = rows.filter((r) => r.oldStatus === 'example_tests_passed').length;
    console.log(`\nORIGINAL prompt: signature valid ${ok}/${measured}, official examples passed ${passed}/${measured}`);
  }

  if (runNew) {
    const measured = rows.filter((r) => r.newStatus !== undefined).length;
    const sig = rows.filter((r) => r.newSignature === true).length;
    const ready = rows.filter((r) => r.newReady === true).length;
    console.log(`UPGRADED pipeline: signature valid ${sig}/${measured}, submission-ready ${ready}/${measured}`);
    console.log(`cost: ${geminiCalls} model call(s), ${judge0} Judge0 submission(s), ${tokens} tokens`);
  }

  const outFile = value('out') ?? 'bench-results.json';
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    outFile,
    `${JSON.stringify({ startedAt: new Date().toISOString(), runner: runner?.name ?? null, rows, usage: { geminiCalls, judge0, tokens } }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nwrote ${outFile}`);
}

main().catch((error: unknown) => {
  console.error('bench failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
