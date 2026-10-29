/**
 * The solve pipeline.
 *
 * Understand -> constraints -> algorithm -> generate -> **validate** -> repair -> explain.
 *
 * The important property is the order of the gates. Signature validation is free and local,
 * so it runs before anything is executed and before any Judge0 quota is spent; execution
 * runs on a harness this code generated from LeetCode's own examples; and the verification
 * status that comes out the other end says exactly what was proven and nothing more.
 *
 * Repairs are bounded and category-specific: a compile error, a wrong answer, a crash and
 * an infrastructure failure are four different problems, and the last one is never blamed
 * on the solution.
 */

import { GeminiClient, GeminiError, extractJavaCode, extractJsonObject } from './gemini.ts';
import { RunLogger, type LogEntry } from './log.ts';
import { buildContract, describeContract, describeViolationsForRepair, validateSignature, ContractError } from './java/contract.ts';
import { buildHarness, buildCompileOnlyHarness, type HarnessBuild } from './java/harness.ts';
import { runJava, judge0SubmissionCount, type RunnerChoice } from './runner/index.ts';
import {
  analysisPrompt,
  compileRepairPrompt,
  explanationPrompt,
  generationPrompt,
  runtimeRepairPrompt,
  signatureRepairPrompt,
  wrongAnswerRepairPrompt,
} from './prompts.ts';
import type {
  ExecutionOutcome,
  JavaContract,
  Problem,
  ProblemAnalysis,
  SolveAttempt,
  SolveResult,
  VerificationStatus,
} from './types.ts';

const STATUS_RANK: Record<VerificationStatus, number> = {
  unverified: 0,
  signature_invalid: 1,
  compile_failed: 2,
  signature_valid: 3,
  compiled: 4,
  example_tests_passed: 5,
  additional_tests_passed: 6,
  verified_by_leetcode: 7,
};

/** The slice of the Gemini client the pipeline needs, so tests can supply a stub. */
export type GeminiLike = Pick<GeminiClient, 'generate' | 'usage' | 'model'>;

export type SolveOptions = {
  /** Total code-producing attempts, including the first. */
  maxAttempts?: number;
  /** How many of those attempts may be spent purely on interface repairs. */
  maxSignatureRepairs?: number;
  /** Upper bound on execution runs, i.e. on Judge0 submissions when Judge0 is the runner. */
  maxExecutions?: number;
  runner?: RunnerChoice;
  /** Generate the final explanation (one extra model call). */
  explain?: boolean;
  signal?: AbortSignal;
  onEvent?: (entry: LogEntry) => void;
  gemini?: GeminiLike;
  /** Injection seam for tests; defaults to the real local-JDK/Judge0 selection. */
  execute?: (request: { source: string; signal?: AbortSignal }) => Promise<ExecutionOutcome>;
};

export type Explanation = {
  summary: string;
  steps: string[];
  timeComplexity: string;
  spaceComplexity: string;
  edgeCases: string[];
};

export type SolveOutput = SolveResult & { explanation?: Explanation; contract?: string };

export async function solveProblem(problem: Problem, options: SolveOptions = {}): Promise<SolveOutput> {
  const {
    maxAttempts = 4,
    maxSignatureRepairs = 2,
    maxExecutions = 3,
    runner = 'auto',
    explain = true,
    signal,
    onEvent,
    execute = (request) => runJava(request, runner),
  } = options;

  const startedAt = Date.now();
  const logger = new RunLogger({ prefix: 'solve', onEntry: onEvent });
  const judge0Before = judge0SubmissionCount();
  const gemini = options.gemini ?? new GeminiClient();
  const attempts: SolveAttempt[] = [];

  logger.info('start', `Solving "${problem.title}" (${problem.difficulty}) — model ${gemini.model}`);

  /* ---- Gate 0: the official interface contract ---------------------------- */

  let contract: JavaContract | undefined;
  let contractProblem: string | undefined;

  if (!problem.javaSnippet) {
    contractProblem =
      'LeetCode returned no official Java template for this problem, so the required interface is unknown.';
  } else {
    try {
      contract = buildContract(problem.javaSnippet, problem.metaData);
      logger.info('contract', `Official interface: ${describeContract(contract)}`, {
        helpers: contract.requiredHelpers,
      });
    } catch (error) {
      contractProblem = `The official Java template could not be parsed: ${
        error instanceof ContractError || error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  if (!problem.provenance.consistent) {
    logger.warn('contract', 'Problem metadata is inconsistent across sources; treating the result as unverified', {
      warnings: problem.provenance.warnings,
    });
  }

  if (!contract) {
    logger.error('contract', contractProblem ?? 'No interface contract available');
    return finish({
      problem,
      attempts,
      logger,
      startedAt,
      judge0Before,
      gemini,
      finalCode: '',
      status: 'unverified',
      statusDetail: contractProblem ?? 'No interface contract available',
      readinessReason:
        'Refusing to guess the required method signature: without LeetCode\'s official Java template the result cannot be called submission-ready.',
      exampleTestsPassed: false,
      additionalTestsPassed: false,
      compiled: false,
      signatureValid: false,
    });
  }

  /* ---- Step 1: understand the problem ------------------------------------- */

  let analysis: ProblemAnalysis | undefined;
  try {
    logger.info('analyze', 'Analysing statement, constraints and algorithm choice');
    const response = await gemini.generate({
      prompt: analysisPrompt(problem, contract),
      maxOutputTokens: 1400,
      json: true,
      temperature: 0.2,
      signal,
    });
    analysis = extractJsonObject<ProblemAnalysis>(response.text);
    if (!analysis) {
      logger.warn('analyze', 'Analysis response was not valid JSON; continuing without it');
    } else {
      logger.info(
        'analyze',
        `Plan: ${analysis.algorithm ?? 'unspecified'} — target ${analysis.expectedTimeComplexity} time, ${analysis.expectedSpaceComplexity} space`,
      );
    }
  } catch (error) {
    // Analysis is advisory: losing it degrades quality but must not abort the run.
    logger.warn('analyze', `Analysis step failed: ${describeError(error)}`);
  }

  /* ---- Step 2..N: generate, validate, repair ------------------------------ */

  let code = '';
  let signatureRepairs = 0;
  let executions = 0;
  let bestCode = '';
  let bestStatus: VerificationStatus = 'unverified';
  let bestDetail = 'No candidate was produced.';
  let bestOutcome: ExecutionOutcome | undefined;
  let harnessNote = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    /* generate or repair */
    try {
      if (attempt === 1) {
        logger.info('generate', `Generating solution against the official interface (attempt ${attempt})`);
        const response = await gemini.generate({
          prompt: generationPrompt(problem, contract, analysis),
          maxOutputTokens: 3000,
          temperature: 0.1,
          signal,
        });
        if (response.truncated) logger.warn('generate', 'Model hit the output cap; the code may be incomplete');
        code = extractJavaCode(response.text);
      } else {
        const previous = attempts[attempts.length - 1];
        const reason = previous.repairReason ?? 'unknown';
        logger.info('repair', `Repairing (attempt ${attempt}): ${reason}`);
        const prompt = repairPromptFor(previous, problem, contract);
        const response = await gemini.generate({ prompt, maxOutputTokens: 3000, temperature: 0.2, signal });
        if (response.truncated) logger.warn('repair', 'Model hit the output cap; the code may be incomplete');
        code = extractJavaCode(response.text);
      }
    } catch (error) {
      logger.error('generate', `Model call failed: ${describeError(error)}`);
      if (attempts.length === 0) {
        return finish({
          problem, attempts, logger, startedAt, judge0Before, gemini, analysis,
          finalCode: '',
          status: 'unverified',
          statusDetail: `The model could not produce a solution: ${describeError(error)}`,
          readinessReason: 'No code was generated.',
          exampleTestsPassed: false, additionalTestsPassed: false, compiled: false, signatureValid: false,
          contract,
        });
      }
      break;
    }

    /* free gate: interface contract */
    const signature = validateSignature(code, contract);
    const record: SolveAttempt = { attempt, code, signature, status: 'unverified' };

    if (!signature.valid) {
      record.status = 'signature_invalid';
      logger.warn(
        'signature',
        `Interface check failed: ${signature.violations.map((v) => v.code).join(', ')}`,
        signature.violations,
      );
      for (const violation of signature.violations) logger.info('signature', `  ${violation.message}`);

      if (STATUS_RANK[record.status] > STATUS_RANK[bestStatus]) {
        bestStatus = record.status;
        bestCode = code;
        bestDetail = signature.violations.map((v) => v.message).join(' ');
      }

      if (signatureRepairs < maxSignatureRepairs && attempt < maxAttempts) {
        signatureRepairs++;
        record.repairReason = 'signature';
        attempts.push(record);
        continue;
      }

      attempts.push(record);
      logger.error('signature', 'Interface repair budget exhausted; refusing to call this submission-ready');
      break;
    }

    record.status = 'signature_valid';
    logger.info('signature', 'Interface matches the official template exactly');
    if (STATUS_RANK[record.status] > STATUS_RANK[bestStatus]) {
      bestStatus = record.status;
      bestCode = code;
      bestDetail = 'Signature matches the official template; not executed.';
    }

    /* execution gate */
    if (executions >= maxExecutions) {
      logger.warn('execute', 'Execution budget exhausted; stopping with the best candidate so far');
      attempts.push(record);
      break;
    }

    const harness: HarnessBuild = buildHarness(problem, contract, code);
    let compileOnly = false;
    let source: string;

    if (harness.supported) {
      source = harness.source;
      harnessNote = `${harness.verifiableCases} official example case(s) checked deterministically${
        harness.extraChecks.length > 0 ? `, plus ${harness.extraChecks.join(' and ')}` : ''
      }`;
      logger.info('harness', `Built deterministic harness: ${harnessNote}`);
      for (const note of harness.notes) logger.warn('harness', note);
    } else {
      compileOnly = true;
      source = buildCompileOnlyHarness(contract, code);
      harnessNote = `example cases could not be verified deterministically (${harness.reason})`;
      logger.warn('harness', `Falling back to a compile-only check: ${harness.reason}`);
    }

    executions++;
    const outcome = await execute({ source, signal });
    record.execution = outcome;
    bestOutcome = outcome;
    logger.info('execute', `${outcome.kind} via ${outcome.runner}: ${outcome.message ?? ''}`.trim(), {
      cases: outcome.cases,
    });

    if (outcome.kind === 'infrastructure_error') {
      // Not the solution's fault: do not repair, do not retry, report plainly.
      record.status = 'signature_valid';
      attempts.push(record);
      logger.error('execute', `Execution unavailable: ${outcome.message}`);
      bestStatus = 'signature_valid';
      bestCode = code;
      bestDetail = `Signature valid, but the code could not be executed: ${outcome.message}`;
      break;
    }

    if (outcome.kind === 'compile_error') {
      record.status = 'compile_failed';
      record.repairReason = 'compile';
      if (STATUS_RANK[record.status] > STATUS_RANK[bestStatus]) {
        bestStatus = record.status;
        bestCode = code;
        bestDetail = 'The solution does not compile.';
      }
      attempts.push(record);
      if (attempt < maxAttempts) continue;
      break;
    }

    if (outcome.kind === 'passed') {
      record.status = compileOnly ? 'compiled' : 'example_tests_passed';

      if (!compileOnly && harness.supported && harness.extraChecks.length > 0) {
        // The extra checks ran inside the same program, so passing everything means the
        // no-oracle stability checks passed too.
        record.status = 'additional_tests_passed';
      }

      if (STATUS_RANK[record.status] > STATUS_RANK[bestStatus]) {
        bestStatus = record.status;
        bestCode = code;
        bestDetail = compileOnly
          ? `Compiles against the official interface, but ${harnessNote}.`
          : harnessNote;
      }
      attempts.push(record);
      logger.info('verify', `Verification level reached: ${record.status}`);
      break;
    }

    /* wrong answer, runtime error or timeout */
    record.status = 'compiled';
    record.repairReason = outcome.kind === 'wrong_answer' ? 'wrong_answer' : 'runtime';
    if (STATUS_RANK[record.status] > STATUS_RANK[bestStatus]) {
      bestStatus = record.status;
      bestCode = code;
      bestDetail = `Compiles, but ${outcome.message ?? outcome.kind} on the official examples.`;
    }
    attempts.push(record);
    if (attempt >= maxAttempts) break;
  }

  /* ---- Step N+1: explanation (only for code we are reporting) ------------- */

  let explanation: Explanation | undefined;
  if (explain && bestCode) {
    try {
      const response = await gemini.generate({
        prompt: explanationPrompt(problem, bestCode),
        maxOutputTokens: 1000,
        json: true,
        temperature: 0.2,
        signal,
      });
      explanation = extractJsonObject<Explanation>(response.text);
    } catch (error) {
      logger.warn('explain', `Explanation step failed: ${describeError(error)}`);
    }
  }

  const exampleTestsPassed = bestStatus === 'example_tests_passed' || bestStatus === 'additional_tests_passed';

  return finish({
    problem,
    attempts,
    logger,
    startedAt,
    judge0Before,
    gemini,
    analysis,
    explanation,
    contract,
    finalCode: bestCode,
    status: bestStatus,
    statusDetail: bestDetail,
    readinessReason: readinessReasonFor(bestStatus, bestDetail, bestOutcome),
    exampleTestsPassed,
    additionalTestsPassed: bestStatus === 'additional_tests_passed',
    compiled: STATUS_RANK[bestStatus] >= STATUS_RANK.compiled,
    signatureValid: STATUS_RANK[bestStatus] >= STATUS_RANK.signature_valid,
  });
}

function repairPromptFor(previous: SolveAttempt, problem: Problem, contract: JavaContract): string {
  switch (previous.repairReason) {
    case 'signature':
      return signatureRepairPrompt(previous.code, describeViolationsForRepair(previous.signature, contract));
    case 'compile':
      return compileRepairPrompt(problem, contract, previous.code, previous.execution?.compileOutput ?? previous.execution?.stderr ?? '');
    case 'wrong_answer':
      return wrongAnswerRepairPrompt(problem, contract, previous.code, previous.execution!);
    case 'runtime':
      return runtimeRepairPrompt(problem, contract, previous.code, previous.execution!);
    default:
      return generationPrompt(problem, contract);
  }
}

function readinessReasonFor(status: VerificationStatus, detail: string, outcome?: ExecutionOutcome): string {
  switch (status) {
    case 'additional_tests_passed':
      return 'Signature matches the official template, the code compiles, every official example passes, and the extra no-oracle checks pass. LeetCode\'s hidden tests are still unproven.';
    case 'example_tests_passed':
      return 'Signature matches the official template, the code compiles and every official example passes. LeetCode\'s hidden tests are still unproven.';
    case 'compiled':
      return `Signature matches and the code compiles, but correctness was not established: ${detail}`;
    case 'signature_valid':
      return `Signature matches the official template, but the code was not executed: ${outcome?.message ?? detail}`;
    case 'compile_failed':
      return 'The solution does not compile, so it is not ready to submit.';
    case 'signature_invalid':
      return `The solution does not match LeetCode's required interface, so it would be rejected: ${detail}`;
    default:
      return detail;
  }
}

function describeError(error: unknown): string {
  if (error instanceof GeminiError) return error.message;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type FinishArgs = {
  problem: Problem;
  attempts: SolveAttempt[];
  logger: RunLogger;
  startedAt: number;
  judge0Before: number;
  gemini: GeminiLike;
  analysis?: ProblemAnalysis;
  explanation?: Explanation;
  contract?: JavaContract;
  finalCode: string;
  status: VerificationStatus;
  statusDetail: string;
  readinessReason: string;
  exampleTestsPassed: boolean;
  additionalTestsPassed: boolean;
  compiled: boolean;
  signatureValid: boolean;
};

function finish(args: FinishArgs): SolveOutput {
  const usage = {
    ...args.gemini.usage(),
    judge0Submissions: judge0SubmissionCount() - args.judge0Before,
    elapsedMs: Date.now() - args.startedAt,
  };

  const submissionReady = args.exampleTestsPassed && args.problem.provenance.consistent;

  args.logger.info(
    'done',
    `Status: ${args.status} | submission-ready: ${submissionReady ? 'yes' : 'no'} | ` +
      `${usage.geminiCalls} model call(s), ${usage.judge0Submissions} Judge0 submission(s), ${Math.round(usage.elapsedMs / 1000)}s`,
  );

  return {
    problem: args.problem,
    analysis: args.analysis,
    explanation: args.explanation,
    contract: args.contract ? describeContract(args.contract) : undefined,
    finalCode: args.finalCode,
    status: args.status,
    statusDetail: args.statusDetail,
    checks: {
      officialMetadata: args.problem.provenance.hasJavaSnippet && args.problem.provenance.hasMetaData,
      signatureValid: args.signatureValid,
      compiled: args.compiled,
      exampleTestsPassed: args.exampleTestsPassed,
      additionalTestsPassed: args.additionalTestsPassed,
      verifiedByLeetCode: false,
    },
    attempts: args.attempts,
    submissionReady,
    readinessReason: args.readinessReason,
    logs: args.logger.lines(),
    events: args.logger.all(),
    usage,
  };
}
