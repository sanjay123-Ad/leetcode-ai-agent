/**
 * Response shapes shared between the route handlers and the client.
 * Types only — safe to import from a client component.
 */

import type { LogEntry } from './log.ts';
import type { ProblemAnalysis, SignatureViolation, VerificationStatus } from './types.ts';
import type { HistoryEntry } from './persistence.ts';

export type { HistoryEntry };

export type ApiEnvelope<T> = { success: true; data: T } | { success: false; error: string };

export type DailyChallenge = {
  date: string;
  link: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  content: string;
  tags: string[];
  exampleTestcases: string;
  questionId?: string;
  questionFrontendId?: string;
  constraints?: string;
  javaSnippet?: string;
  exampleOutputs?: string[];
  provenance?: {
    dailySource: string;
    detailSource: string;
    hasJavaSnippet: boolean;
    hasMetaData: boolean;
    consistent: boolean;
    warnings: string[];
  };
};

export type ExecutionCase = { index: number; passed: boolean; expected?: string; actual?: string; label?: string };

export type AttemptDetail = {
  attempt: number;
  status: VerificationStatus;
  signatureValid: boolean;
  violations: SignatureViolation[];
  execution?: { kind: string; runner: string; message?: string; cases: ExecutionCase[] };
  repairReason?: string;
};

export type Explanation = {
  summary: string;
  steps: string[];
  timeComplexity: string;
  spaceComplexity: string;
  edgeCases: string[];
};

export type SolveChecks = {
  officialMetadata: boolean;
  signatureValid: boolean;
  compiled: boolean;
  exampleTestsPassed: boolean;
  additionalTestsPassed: boolean;
  verifiedByLeetCode: false;
};

export type SolveResponse = {
  analysis?: ProblemAnalysis;
  finalCode: string;
  allPassed: boolean;
  attempts: number;
  logs: string[];
  status: VerificationStatus;
  statusDetail: string;
  checks: SolveChecks;
  submissionReady: boolean;
  readinessReason: string;
  problem: {
    title: string;
    titleSlug: string;
    difficulty: string;
    questionFrontendId?: string;
    link: string;
    tags: string[];
    constraints?: string;
    javaSnippet?: string;
    exampleTestcases: string[];
    exampleOutputs: string[];
    provenance: DailyChallenge['provenance'];
  };
  contract?: string;
  explanation?: Explanation;
  resolvedBy: 'slug' | 'text';
  attemptDetails: AttemptDetail[];
  events: LogEntry[];
  usage: { geminiCalls: number; promptTokens: number; outputTokens: number; judge0Submissions: number; elapsedMs: number };
  persistence?: { target: string; ok: boolean; detail: string };
  execution?: { kind: string; runner: string; message?: string; cases: ExecutionCase[] };
};

export type AnalyzeResponse = ProblemAnalysis & {
  problem: {
    title: string;
    titleSlug: string;
    difficulty: string;
    constraints?: string;
    javaSnippet?: string;
    exampleTestcases: string[];
    exampleOutputs: string[];
  };
  contract?: string;
  groundedOnOfficialInterface: boolean;
};

export type GenerateResponse = {
  code: string;
  contract: string;
  javaSnippet: string;
  signature: { valid: boolean; violations: SignatureViolation[] };
  signatureRepairAttempted: boolean;
  verified: false;
};

export type ExecuteResponse = {
  signature: { valid: boolean; violations: SignatureViolation[] };
  executed: boolean;
  compileOnly?: boolean;
  harnessReason?: string;
  verifiableCases?: number;
  extraChecks?: string[];
  verification: string;
  reason?: string;
  execution?: {
    kind: string;
    runner: string;
    message?: string;
    stdout: string;
    stderr: string;
    compileOutput: string;
    cases: ExecutionCase[];
  };
};

export type HistoryResponse = {
  source: string;
  detail?: string;
  entries: HistoryEntry[];
};

/** Labels for the verification ladder. Nothing here ever says "Accepted". */
export const STATUS_LABELS: Record<VerificationStatus, string> = {
  unverified: 'Unverified',
  signature_invalid: 'Signature invalid',
  compile_failed: 'Compile failed',
  signature_valid: 'Signature valid',
  compiled: 'Compiled',
  example_tests_passed: 'Example tests passed',
  additional_tests_passed: 'Example + extra checks passed',
  verified_by_leetcode: 'Verified by LeetCode',
};

export type StreamMessage =
  | { type: 'problem'; data: { title: string; difficulty: string; titleSlug: string } }
  | { type: 'event'; data: LogEntry }
  | { type: 'result'; data: SolveResponse }
  | { type: 'error'; error: string };
