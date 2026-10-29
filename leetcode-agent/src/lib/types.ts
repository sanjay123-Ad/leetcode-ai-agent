/** Shared types for the agent pipeline. */

import type { LogEntry } from './log.ts';

/** LeetCode `metaData` for a normal algorithm problem. */
export type AlgorithmMetaData = {
  name: string;
  params: { name: string; type: string }[];
  return: { type: string };
  /** Present on a few problems; we only read it for diagnostics. */
  manual?: boolean;
};

/** LeetCode `metaData` for a design (constructor-based) problem. */
export type DesignMetaData = {
  classname: string;
  constructor: { params: { name: string; type: string }[] };
  methods: { name: string; params: { name: string; type: string }[]; return?: { type: string } }[];
  return?: { type: string };
  systemdesign?: boolean;
};

export type ProblemMetaData = AlgorithmMetaData | DesignMetaData;

export function isDesignMetaData(meta: ProblemMetaData): meta is DesignMetaData {
  return typeof (meta as DesignMetaData).classname === 'string';
}

/** A problem as retrieved from LeetCode, with provenance about what was actually obtained. */
export type Problem = {
  titleSlug: string;
  title: string;
  /** LeetCode internal id. */
  questionId?: string;
  /** The number shown on leetcode.com. */
  questionFrontendId?: string;
  difficulty: string;
  link: string;
  /** The daily-challenge date (YYYY-MM-DD) when this came from the daily endpoint. */
  date?: string;
  /** Statement as plain text, block structure preserved. */
  statement: string;
  /** Raw `Constraints:` block, when the statement has one. */
  constraints: string;
  topicTags: string[];
  /** Official example inputs, one case per entry (newline-separated arguments within a case). */
  exampleTestcases: string[];
  /** `Output:` values parsed from the statement, in document order. */
  exampleOutputs: string[];
  /** Official Java template. The source of truth for the interface contract. */
  javaSnippet?: string;
  metaData?: ProblemMetaData;
  /** Where each piece came from, and whether the contract is trustworthy. */
  provenance: {
    dailySource: string;
    detailSource: string;
    hasJavaSnippet: boolean;
    hasMetaData: boolean;
    /** False when the daily pointer and the detail record disagree. */
    consistent: boolean;
    warnings: string[];
  };
};

/** The interface contract a generated solution must satisfy, parsed from the official snippet. */
export type JavaType = {
  /** Normalised source form, e.g. `int[]`, `List<List<Integer>>`, `TreeNode`. */
  text: string;
};

export type JavaMethodContract = {
  name: string;
  returnType: string;
  paramTypes: string[];
  paramNames: string[];
  modifiers: string[];
  isConstructor: boolean;
};

export type JavaContract = {
  className: string;
  kind: 'algorithm' | 'design';
  methods: JavaMethodContract[];
  /** Helper types the snippet references but does not define (TreeNode, ListNode, ...). */
  requiredHelpers: string[];
  /** The official snippet this contract was parsed from. */
  source: string;
};

export type SignatureViolation = {
  code:
    | 'missing_class'
    | 'wrong_class_name'
    | 'missing_method'
    | 'wrong_method_name'
    | 'wrong_return_type'
    | 'wrong_param_count'
    | 'wrong_param_types'
    | 'missing_constructor'
    | 'not_public'
    | 'unexpected_main'
    | 'empty_body'
    | 'unparseable'
    | 'extra_public_class'
    | 'redefines_helper'
    | 'package_declaration';
  message: string;
  expected?: string;
  actual?: string;
};

export type SignatureValidation = {
  valid: boolean;
  violations: SignatureViolation[];
  /** What the validator actually found, for the repair prompt and for reporting. */
  observed: { className?: string; methods: JavaMethodContract[] };
};

/** Honest verification ladder. Never collapse these into "Accepted". */
export type VerificationStatus =
  | 'unverified'
  | 'signature_invalid'
  | 'compile_failed'
  | 'signature_valid'
  | 'compiled'
  | 'example_tests_passed'
  | 'additional_tests_passed'
  | 'verified_by_leetcode';

export type ExecutionOutcome = {
  kind: 'passed' | 'wrong_answer' | 'compile_error' | 'runtime_error' | 'timeout' | 'infrastructure_error' | 'skipped';
  stdout: string;
  stderr: string;
  compileOutput: string;
  /** Per-case results, when the harness reported them. */
  cases: { index: number; passed: boolean; expected?: string; actual?: string; label?: string }[];
  message?: string;
  runner: 'local-jdk' | 'judge0' | 'none';
  timeMs?: number;
};

export type SolveAttempt = {
  attempt: number;
  code: string;
  signature: SignatureValidation;
  execution?: ExecutionOutcome;
  status: VerificationStatus;
  /** What triggered the next repair, if any. */
  repairReason?: string;
};

export type SolveResult = {
  problem: Problem;
  analysis?: ProblemAnalysis;
  /** The best candidate found, by verification status. */
  finalCode: string;
  status: VerificationStatus;
  statusDetail: string;
  /** Explicit ladder flags, so the UI never has to infer them. */
  checks: {
    officialMetadata: boolean;
    signatureValid: boolean;
    compiled: boolean;
    exampleTestsPassed: boolean;
    additionalTestsPassed: boolean;
    verifiedByLeetCode: false;
  };
  attempts: SolveAttempt[];
  /** True only when every official example case ran and passed. */
  submissionReady: boolean;
  readinessReason: string;
  logs: string[];
  events: LogEntry[];
  usage: { geminiCalls: number; promptTokens: number; outputTokens: number; judge0Submissions: number; elapsedMs: number };
  persistence?: { target: 'supabase' | 'local-file' | 'none'; ok: boolean; detail: string };
};

export type ProblemAnalysis = {
  task: string;
  algorithm?: string;
  expectedTimeComplexity: string;
  expectedSpaceComplexity: string;
  edgeCases: string[];
  insights: string[];
  /** Short natural-language walkthrough used for the explanation panel. */
  approach?: string;
};
