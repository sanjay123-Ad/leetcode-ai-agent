'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LogEntry } from '@/lib/log.ts';
import {
  STATUS_LABELS,
  type AnalyzeResponse,
  type ApiEnvelope,
  type DailyChallenge,
  type ExecuteResponse,
  type GenerateResponse,
  type HistoryResponse,
  type SolveChecks,
  type SolveResponse,
  type StreamMessage,
} from '@/lib/api-types.ts';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!result.success) throw new Error(result.error);
  return result.data;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const CHECK_LABELS: { key: keyof SolveChecks; label: string; hint: string }[] = [
  { key: 'officialMetadata', label: 'Official metadata', hint: 'LeetCode returned the Java template and metaData for this problem' },
  { key: 'signatureValid', label: 'Signature valid', hint: 'Class, method names, parameter types/order and return type match the official template' },
  { key: 'compiled', label: 'Compiled', hint: 'javac accepted the solution' },
  { key: 'exampleTestsPassed', label: 'Example tests passed', hint: "Reproduced LeetCode's published example outputs" },
  { key: 'additionalTestsPassed', label: 'Additional checks passed', hint: 'Extra no-oracle checks, e.g. no state leaking between cases' },
  { key: 'verifiedByLeetCode', label: 'Verified by LeetCode', hint: 'Only true with real submission evidence — this agent never claims it' },
];

export default function AgentConsole({ initialHistory }: { initialHistory: HistoryResponse }) {
  const [autoMode, setAutoMode] = useState(true);
  const [error, setError] = useState('');

  /* ---------------- auto mode ---------------- */
  const [autoLoading, setAutoLoading] = useState(false);
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [solve, setSolve] = useState<SolveResponse | null>(null);
  const [challenge, setChallenge] = useState<DailyChallenge | null>(null);
  const [slugInput, setSlugInput] = useState('');

  /* ---------------- manual mode ---------------- */
  const [problemText, setProblemText] = useState('');
  const [manualSlug, setManualSlug] = useState('');
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [generated, setGenerated] = useState<GenerateResponse | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [loadingCode, setLoadingCode] = useState(false);
  const [loadingTest, setLoadingTest] = useState(false);

  /* ---------------- history ---------------- */
  // Rendered by the server component, which reads the database directly. Refreshing the
  // route re-runs that read on the server, so neither the Supabase key nor the history
  // token is ever sent to the browser - and /api/history stays available only to
  // authenticated callers.
  const router = useRouter();
  const history = initialHistory;

  const refreshHistory = useCallback(() => {
    router.refresh();
  }, [router]);

  const runSolve = async (target: { titleSlug?: string; url?: string }) => {
    setAutoLoading(true);
    setError('');
    setEvents([]);
    setSolve(null);

    try {
      const response = await fetch('/api/auto-solve?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });

      if (!response.ok && !response.body) {
        const payload = (await response.json()) as ApiEnvelope<SolveResponse>;
        throw new Error(payload.success ? 'Unknown error' : payload.error);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('The server did not return a readable stream.');

      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as StreamMessage;
          if (message.type === 'event') setEvents((previous) => [...previous, message.data]);
          else if (message.type === 'result') setSolve(message.data);
          else if (message.type === 'error') setError(message.error);
        }
      }
      refreshHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Auto-solve failed');
    } finally {
      setAutoLoading(false);
    }
  };

  const handleDaily = async () => {
    setError('');
    setChallenge(null);
    try {
      const daily = await getJson<DailyChallenge>('/api/daily-challenge');
      setChallenge(daily);
      await runSolve({ titleSlug: daily.titleSlug });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to fetch the daily challenge');
    }
  };

  const handleSpecificProblem = async () => {
    const value = slugInput.trim();
    if (!value) return;
    setChallenge(null);
    await runSolve(value.includes('leetcode.com') ? { url: value } : { titleSlug: value });
  };

  const handleAnalyze = async () => {
    if (!problemText.trim() && !manualSlug.trim()) return;
    setLoadingAnalysis(true);
    setError('');
    setAnalysis(null);
    setGenerated(null);
    setExecuteResult(null);
    try {
      setAnalysis(
        await postJson<AnalyzeResponse>('/api/analyze', {
          titleSlug: manualSlug.trim() || undefined,
          problemText: problemText.trim() || undefined,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Analysis failed');
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const handleGenerate = async () => {
    setLoadingCode(true);
    setError('');
    setGenerated(null);
    setExecuteResult(null);
    try {
      setGenerated(
        await postJson<GenerateResponse>('/api/generate', {
          titleSlug: manualSlug.trim() || analysis?.problem?.titleSlug,
          problemText: problemText.trim() || undefined,
          analysis: analysis ?? undefined,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Code generation failed');
    } finally {
      setLoadingCode(false);
    }
  };

  const handleRunTests = async () => {
    if (!generated) return;
    setLoadingTest(true);
    setError('');
    setExecuteResult(null);
    try {
      setExecuteResult(
        await postJson<ExecuteResponse>('/api/execute', {
          titleSlug: manualSlug.trim() || analysis?.problem?.titleSlug,
          code: generated.code,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Execution failed');
    } finally {
      setLoadingTest(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8 font-sans pb-20">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="space-y-3">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            AI LeetCode Agent
          </h1>
          <p className="text-neutral-400">
            Fetches the official problem, generates Java inside LeetCode&apos;s own interface, then validates the
            signature and runs the official examples before reporting anything.
          </p>

          <div className="flex gap-2">
            <button
              onClick={() => setAutoMode(true)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${autoMode ? 'bg-emerald-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              🤖 Auto Mode
            </button>
            <button
              onClick={() => setAutoMode(false)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${!autoMode ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              Manual Mode
            </button>
          </div>
        </header>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl text-sm whitespace-pre-wrap">
            {error}
          </div>
        )}

        {autoMode ? (
          <section className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
              <button
                onClick={handleDaily}
                disabled={autoLoading}
                className="w-full bg-gradient-to-r from-emerald-600 to-blue-600 hover:from-emerald-500 hover:to-blue-500 disabled:from-neutral-700 disabled:to-neutral-700 text-white font-bold text-lg py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-3"
              >
                {autoLoading ? (
                  <span className="animate-pulse">🤖 Working…</span>
                ) : (
                  <span>🚀 Solve Today&apos;s Daily Challenge</span>
                )}
              </button>

              <div className="flex gap-2">
                <input
                  value={slugInput}
                  onChange={(event) => setSlugInput(event.target.value)}
                  placeholder="two-sum or a LeetCode URL"
                  className="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 text-sm text-neutral-200 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSpecificProblem}
                  disabled={autoLoading || !slugInput.trim()}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-neutral-800 hover:bg-neutral-700 disabled:text-neutral-600 transition-colors"
                >
                  Solve
                </button>
              </div>
            </div>

            {(events.length > 0 || autoLoading) && <PipelineLog events={events} running={autoLoading} />}

            {challenge && <ChallengeCard challenge={challenge} />}

            {solve && <SolveReport solve={solve} />}
          </section>
        ) : (
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 shadow-xl space-y-3">
                <label className="block text-sm font-medium text-neutral-300">
                  LeetCode slug or URL <span className="text-neutral-500">(recommended)</span>
                </label>
                <input
                  value={manualSlug}
                  onChange={(event) => setManualSlug(event.target.value)}
                  placeholder="two-sum"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-200 focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-neutral-500">
                  With a slug the agent uses LeetCode&apos;s official Java template, so the generated signature can be
                  checked. With pasted text only, code generation is not possible — the required signature is unknown.
                </p>

                <label className="block text-sm font-medium text-neutral-300 pt-2">Problem description (optional)</label>
                <textarea
                  value={problemText}
                  onChange={(event) => setProblemText(event.target.value)}
                  className="w-full h-[320px] bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-sm text-neutral-200 focus:outline-none focus:border-blue-500"
                  placeholder="Paste the problem statement here…"
                />
                <button
                  onClick={handleAnalyze}
                  disabled={loadingAnalysis || (!problemText.trim() && !manualSlug.trim())}
                  className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors"
                >
                  {loadingAnalysis ? <span className="animate-pulse">Analyzing…</span> : <span>Analyze Problem</span>}
                </button>
              </div>
            </div>

            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-5 max-h-[800px] overflow-y-auto">
              <h2 className="text-xl font-semibold border-b border-neutral-800 pb-2">Analysis</h2>

              {!analysis && !loadingAnalysis && (
                <p className="text-neutral-500 text-sm italic">Waiting for problem analysis…</p>
              )}

              {loadingAnalysis && (
                <div className="space-y-3 animate-pulse">
                  <div className="h-4 bg-neutral-800 rounded w-3/4" />
                  <div className="h-4 bg-neutral-800 rounded w-1/2" />
                  <div className="h-4 bg-neutral-800 rounded w-5/6" />
                </div>
              )}

              {analysis && (
                <div className="space-y-5">
                  <Field label="Core task" tone="emerald">
                    {analysis.task}
                  </Field>
                  {analysis.algorithm && (
                    <Field label="Algorithm" tone="indigo">
                      {analysis.algorithm}
                    </Field>
                  )}
                  {analysis.approach && (
                    <Field label="Approach" tone="blue">
                      {analysis.approach}
                    </Field>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Time" tone="blue" mono>
                      {analysis.expectedTimeComplexity}
                    </Field>
                    <Field label="Space" tone="purple" mono>
                      {analysis.expectedSpaceComplexity}
                    </Field>
                  </div>

                  {analysis.contract && (
                    <Field label="Official interface" tone="emerald" mono>
                      {analysis.contract}
                    </Field>
                  )}

                  <BulletList label="Edge cases" tone="amber" items={analysis.edgeCases} />
                  <BulletList label="Insights" tone="indigo" items={analysis.insights} />

                  <div className="pt-3 border-t border-neutral-800 space-y-3">
                    {!analysis.groundedOnOfficialInterface && (
                      <p className="text-xs text-amber-400">
                        No official Java template was retrieved, so code generation is disabled. Add the problem slug
                        above to enable it.
                      </p>
                    )}
                    <button
                      onClick={handleGenerate}
                      disabled={loadingCode || !analysis.groundedOnOfficialInterface}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors"
                    >
                      {loadingCode ? <span className="animate-pulse">Generating…</span> : <span>Generate Java Solution</span>}
                    </button>
                  </div>

                  {generated && (
                    <div className="space-y-3">
                      <SignatureBadge valid={generated.signature.valid} violations={generated.signature.violations} />
                      <CodeBlock code={generated.code} />
                      <button
                        onClick={handleRunTests}
                        disabled={loadingTest}
                        className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors"
                      >
                        {loadingTest ? <span className="animate-pulse">Running…</span> : <span>Run Official Example Tests</span>}
                      </button>
                    </div>
                  )}

                  {executeResult && <ExecutionPanel result={executeResult} />}
                </div>
              )}
            </div>
          </section>
        )}

        {history.entries.length > 0 ? (
          <HistoryPanel history={history} />
        ) : history.source === 'locked' ? (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-lg font-semibold mb-1">Recent runs</h2>
            <p className="text-sm text-neutral-400">{history.detail}</p>
            <p className="text-xs text-neutral-500 mt-2">
              Unlock this browser once with{' '}
              <code className="font-mono text-neutral-400">/api/history/session?token=&lt;HISTORY_API_TOKEN&gt;</code>
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------- components ----------------------------- */

function Field({
  label,
  children,
  tone,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  tone: 'emerald' | 'blue' | 'purple' | 'amber' | 'indigo';
  mono?: boolean;
}) {
  const toneClass = {
    emerald: 'text-emerald-400',
    blue: 'text-blue-400',
    purple: 'text-purple-400',
    amber: 'text-amber-400',
    indigo: 'text-indigo-400',
  }[tone];

  return (
    <div>
      <h3 className={`text-sm font-medium mb-1 ${toneClass}`}>{label}</h3>
      <div
        className={`text-sm text-neutral-300 bg-neutral-950 p-3 rounded-lg border border-neutral-800 ${mono ? 'font-mono text-xs' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

function BulletList({ label, items, tone }: { label: string; items?: string[]; tone: 'amber' | 'indigo' }) {
  if (!items || items.length === 0) return null;
  const toneClass = tone === 'amber' ? 'text-amber-400' : 'text-indigo-400';
  const bullet = tone === 'amber' ? '•' : '💡';

  return (
    <div>
      <h3 className={`text-sm font-medium mb-2 ${toneClass}`}>{label}</h3>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={index}
            className="text-sm text-neutral-300 flex items-start gap-2 bg-neutral-950 p-2 rounded-lg border border-neutral-800"
          >
            <span className={toneClass}>{bullet}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeBlock({ code, max = 'max-h-[460px]' }: { code: string; max?: string }) {
  return (
    <pre
      className={`bg-neutral-950 border border-neutral-800 p-4 rounded-lg overflow-x-auto text-xs text-neutral-300 font-mono ${max} overflow-y-auto`}
    >
      <code>{code}</code>
    </pre>
  );
}

function PipelineLog({ events, running }: { events: LogEntry[]; running: boolean }) {
  const icon = (level: LogEntry['level']) => (level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅');

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
      <h2 className="text-lg font-semibold mb-4 text-neutral-200">Pipeline</h2>
      <div className="space-y-2 max-h-72 overflow-y-auto font-mono text-xs">
        {events.map((event, index) => (
          <div key={index} className="flex items-start gap-2">
            <span>{icon(event.level)}</span>
            <span className="text-neutral-500 w-20 shrink-0">{event.stage}</span>
            <span className={event.level === 'error' ? 'text-red-400' : event.level === 'warn' ? 'text-amber-400' : 'text-neutral-300'}>
              {event.message}
            </span>
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-2 text-yellow-400">
            <span className="animate-spin">⚙️</span>
            <span className="animate-pulse">working…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function difficultyClass(difficulty: string): string {
  if (difficulty === 'Easy') return 'bg-emerald-500/20 text-emerald-400';
  if (difficulty === 'Medium') return 'bg-amber-500/20 text-amber-400';
  if (difficulty === 'Hard') return 'bg-red-500/20 text-red-400';
  return 'bg-neutral-700 text-neutral-300';
}

function ChallengeCard({ challenge }: { challenge: DailyChallenge }) {
  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-200">Today&apos;s Challenge</h2>
        <span className={`text-xs font-bold px-3 py-1 rounded-full ${difficultyClass(challenge.difficulty)}`}>
          {challenge.difficulty}
        </span>
      </div>
      <h3 className="text-xl font-bold text-white">
        {challenge.questionFrontendId ? `${challenge.questionFrontendId}. ` : ''}
        {challenge.title}
      </h3>
      <p className="text-xs text-neutral-500">
        Date: {challenge.date} · source: {challenge.provenance?.dailySource ?? 'unknown'}
      </p>
      <div className="flex gap-2 flex-wrap">
        {challenge.tags?.map((tag) => (
          <span key={tag} className="text-xs bg-neutral-800 text-neutral-300 px-2 py-1 rounded-md">
            {tag}
          </span>
        ))}
      </div>
      <a
        href={challenge.link}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 text-sm underline inline-block"
      >
        View on LeetCode →
      </a>
    </div>
  );
}

function SignatureBadge({ valid, violations }: { valid: boolean; violations: { code: string; message: string }[] }) {
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${valid ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-red-500/40 bg-red-500/10 text-red-300'}`}
    >
      <p className="font-semibold">
        {valid ? '✅ Signature matches the official LeetCode interface' : '❌ Signature does not match the official interface'}
      </p>
      {!valid && (
        <ul className="mt-2 space-y-1 text-xs">
          {violations.map((violation, index) => (
            <li key={index}>
              <span className="font-mono text-red-400">[{violation.code}]</span> {violation.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseTable({ cases }: { cases: { label?: string; passed: boolean; expected?: string; actual?: string }[] }) {
  if (cases.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-neutral-500 text-left">
            <th className="py-1 pr-3">case</th>
            <th className="py-1 pr-3">result</th>
            <th className="py-1 pr-3">expected</th>
            <th className="py-1">actual</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((testCase, index) => (
            <tr key={index} className="border-t border-neutral-800">
              <td className="py-1 pr-3 text-neutral-400">{testCase.label ?? index + 1}</td>
              <td className={`py-1 pr-3 ${testCase.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                {testCase.passed ? 'PASS' : 'FAIL'}
              </td>
              <td className="py-1 pr-3 text-neutral-300 max-w-[220px] truncate">{testCase.expected ?? '—'}</td>
              <td className="py-1 text-neutral-300 max-w-[220px] truncate">{testCase.actual ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionPanel({ result }: { result: ExecuteResponse }) {
  const execution = result.execution;

  return (
    <div className="space-y-3 border-t border-neutral-800 pt-4">
      <h3 className="text-sm font-medium text-purple-400">Verification</h3>
      <p className="text-sm text-neutral-300">
        <span className="font-mono text-xs bg-neutral-800 px-2 py-1 rounded">{result.verification}</span>{' '}
        {result.reason ?? execution?.message ?? ''}
      </p>
      {result.compileOnly && (
        <p className="text-xs text-amber-400">
          Compile-only check: {result.harnessReason}
        </p>
      )}
      {execution && (
        <>
          <p className="text-xs text-neutral-500">
            runner: {execution.runner}
            {result.verifiableCases ? ` · ${result.verifiableCases} official case(s)` : ''}
          </p>
          <CaseTable cases={execution.cases} />
          {execution.compileOutput && (
            <div>
              <p className="text-xs text-amber-500 mb-1">Compiler</p>
              <pre className="text-xs text-amber-400 font-mono whitespace-pre-wrap">{execution.compileOutput.slice(0, 2000)}</pre>
            </div>
          )}
          {execution.stderr && (
            <div>
              <p className="text-xs text-red-500 mb-1">Stderr</p>
              <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap">{execution.stderr.slice(0, 1500)}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SolveReport({ solve }: { solve: SolveResponse }) {
  const lastExecution = solve.execution;

  return (
    <div className="space-y-6">
      <div
        className={`rounded-xl border p-6 shadow-xl space-y-4 ${
          solve.submissionReady ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {solve.problem.questionFrontendId ? `${solve.problem.questionFrontendId}. ` : ''}
              {solve.problem.title}
            </h2>
            <p className="text-xs text-neutral-400 mt-1">
              {solve.contract ? <span className="font-mono">{solve.contract}</span> : 'no official interface available'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold px-3 py-1 rounded-full ${difficultyClass(solve.problem.difficulty)}`}>
              {solve.problem.difficulty}
            </span>
            <span className="text-xs font-bold px-3 py-1 rounded-full bg-neutral-800 text-neutral-200">
              {STATUS_LABELS[solve.status]}
            </span>
          </div>
        </div>

        <p className="text-sm text-neutral-300">{solve.readinessReason}</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {CHECK_LABELS.map(({ key, label, hint }) => (
            <div key={key} className="flex items-start gap-2 bg-neutral-950/60 border border-neutral-800 rounded-lg p-2" title={hint}>
              <span>{solve.checks[key] ? '✅' : '⬜'}</span>
              <span className={`text-xs ${solve.checks[key] ? 'text-emerald-300' : 'text-neutral-500'}`}>{label}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-neutral-500">
          {solve.attempts} attempt(s) · {solve.usage.geminiCalls} model call(s) · {solve.usage.judge0Submissions} Judge0
          submission(s) · {solve.usage.promptTokens + solve.usage.outputTokens} tokens ·{' '}
          {Math.round(solve.usage.elapsedMs / 1000)}s
          {solve.persistence ? ` · history: ${solve.persistence.detail}` : ''}
        </p>

        {solve.problem.provenance?.warnings?.length ? (
          <ul className="text-xs text-amber-400 space-y-1">
            {solve.problem.provenance.warnings.map((warning, index) => (
              <li key={index}>⚠️ {warning}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-semibold border-b border-neutral-800 pb-2">Official Java template</h2>
          {solve.problem.javaSnippet ? (
            <CodeBlock code={solve.problem.javaSnippet} max="max-h-[200px]" />
          ) : (
            <p className="text-sm text-amber-400">Not available for this problem.</p>
          )}

          {solve.analysis && (
            <>
              <Field label="Core task" tone="emerald">
                {solve.analysis.task}
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Time" tone="blue" mono>
                  {solve.analysis.expectedTimeComplexity}
                </Field>
                <Field label="Space" tone="purple" mono>
                  {solve.analysis.expectedSpaceComplexity}
                </Field>
              </div>
              <BulletList label="Edge cases" tone="amber" items={solve.analysis.edgeCases} />
            </>
          )}
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-semibold border-b border-neutral-800 pb-2">Generated solution</h2>
          <CodeBlock code={solve.finalCode || '// no code was produced'} />

          {lastExecution && (
            <div className="space-y-2">
              <p className="text-xs text-neutral-500">
                {lastExecution.kind} via {lastExecution.runner} — {lastExecution.message}
              </p>
              <CaseTable cases={lastExecution.cases} />
            </div>
          )}

          <p className="text-xs text-neutral-500 italic">
            {solve.submissionReady
              ? 'Signature-checked and verified against LeetCode\'s official examples. Hidden tests are still unproven.'
              : 'Not verified — read the status above before submitting this.'}
          </p>
        </div>
      </div>

      {solve.explanation && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-semibold border-b border-neutral-800 pb-2">Explanation</h2>
          <p className="text-sm text-neutral-300">{solve.explanation.summary}</p>
          <ol className="space-y-2 list-decimal list-inside">
            {solve.explanation.steps?.map((step, index) => (
              <li key={index} className="text-sm text-neutral-300">
                {step}
              </li>
            ))}
          </ol>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Time complexity" tone="blue" mono>
              {solve.explanation.timeComplexity}
            </Field>
            <Field label="Space complexity" tone="purple" mono>
              {solve.explanation.spaceComplexity}
            </Field>
          </div>
          <BulletList label="Edge cases handled" tone="amber" items={solve.explanation.edgeCases} />
        </div>
      )}

      {solve.attemptDetails.length > 1 && (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-3">
          <h2 className="text-lg font-semibold border-b border-neutral-800 pb-2">Attempts</h2>
          {solve.attemptDetails.map((attempt) => (
            <div key={attempt.attempt} className="text-xs font-mono text-neutral-400 border-b border-neutral-800 pb-2">
              <span className="text-neutral-200">#{attempt.attempt}</span> {STATUS_LABELS[attempt.status]}
              {attempt.execution ? ` · ${attempt.execution.kind}: ${attempt.execution.message ?? ''}` : ''}
              {attempt.repairReason ? ` · repaired for: ${attempt.repairReason}` : ''}
              {attempt.violations.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-red-400">
                  {attempt.violations.map((violation, index) => (
                    <li key={index}>[{violation.code}] {violation.message}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryPanel({ history }: { history: HistoryResponse }) {
  const [open, setOpen] = useState<string | null>(null);

  const ms = (value?: number) => (value === undefined ? '-' : `${Math.round(value / 1000)}s`);
  const tests = (entry: HistoryResponse['entries'][number]) =>
    entry.testsTotal ? `${entry.testsPassed ?? 0}/${entry.testsTotal}` : '-';

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-3">
      <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <span className="text-xs text-neutral-500">
          source: {history.source}
          {history.detail ? ` — ${history.detail}` : ''}
        </span>
      </div>

      <div className="space-y-1">
        {history.entries.map((entry, index) => {
          const key = entry.executionId ?? `${entry.title}-${index}`;
          const expanded = open === key;

          return (
            <div key={key} className="border-b border-neutral-800/50 py-1">
              <button
                onClick={() => setOpen(expanded ? null : key)}
                className="w-full flex items-center justify-between text-sm text-left hover:bg-neutral-800/40 rounded px-1 transition-colors"
              >
                <span className="text-neutral-300 truncate">
                  {entry.questionId ? `${entry.questionId}. ` : ''}
                  {entry.title}
                </span>
                <span className="flex items-center gap-2 text-xs shrink-0">
                  <span className="text-neutral-600">{entry.solvedAt?.slice(0, 10) ?? ''}</span>
                  <span className={`px-2 py-0.5 rounded-full ${difficultyClass(entry.difficulty)}`}>{entry.difficulty}</span>
                  <span className="font-mono text-neutral-500">{entry.verificationStatus ?? 'unknown'}</span>
                  <span className="text-neutral-600">{expanded ? '-' : '+'}</span>
                </span>
              </button>

              {expanded && (
                <div className="mt-2 space-y-2 px-1 pb-2">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono text-neutral-400">
                    <span>attempts: {entry.attempts ?? '-'}</span>
                    <span>repairs: {entry.repairs ?? '-'}</span>
                    <span>tests: {tests(entry)}</span>
                    <span>runner: {entry.runner ?? '-'}</span>
                    <span>duration: {ms(entry.durationMs)}</span>
                    <span>tokens: {(entry.promptTokens ?? 0) + (entry.outputTokens ?? 0) || '-'}</span>
                    <span>email: {entry.emailStatus ?? '-'}</span>
                    <span className={entry.leetcodeAccepted ? 'text-emerald-400' : 'text-neutral-500'}>
                      leetcode: {entry.leetcodeAccepted ? 'accepted' : 'not confirmed'}
                    </span>
                  </div>

                  {entry.javaSignature && (
                    <p className="text-xs font-mono text-neutral-500 truncate">{entry.javaSignature}</p>
                  )}

                  {entry.code ? (
                    <CodeBlock code={entry.code} max="max-h-[320px]" />
                  ) : (
                    <p className="text-xs text-neutral-500 italic">No solution stored for this run.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
