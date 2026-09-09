'use client';

import { useState } from 'react';

type PipelineStep = {
  step: string;
  status: string;
  data?: any;
};

export default function Home() {
  // Manual mode state
  const [problemText, setProblemText] = useState('');
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [loadingCode, setLoadingCode] = useState(false);
  const [analysis, setAnalysis] = useState<any>(null);
  const [code, setCode] = useState('');
  const [loadingTest, setLoadingTest] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [error, setError] = useState('');

  // Auto mode state
  const [autoMode, setAutoMode] = useState(false);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoSteps, setAutoSteps] = useState<PipelineStep[]>([]);
  const [autoResult, setAutoResult] = useState<any>(null);
  const [dailyChallenge, setDailyChallenge] = useState<any>(null);
  const [fetchingChallenge, setFetchingChallenge] = useState(false);

  // =================== MANUAL MODE HANDLERS ===================
  const handleAnalyze = async () => {
    if (!problemText.trim()) return;
    setLoadingAnalysis(true);
    setError('');
    setAnalysis(null);
    setCode('');
    setTestResult(null);
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemText }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setAnalysis(result.data);
    } catch (err: any) {
      setError(err.message || 'Something went wrong with analysis');
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const handleGenerateCode = async () => {
    if (!problemText.trim() || !analysis) return;
    setLoadingCode(true);
    setError('');
    setCode('');
    setTestResult(null);
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemText, analysis }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setCode(result.data.code);
    } catch (err: any) {
      setError(err.message || 'Something went wrong generating code');
    } finally {
      setLoadingCode(false);
    }
  };

  const handleRunTests = async () => {
    if (!problemText.trim() || !code) return;
    setLoadingTest(true);
    setError('');
    setTestResult(null);
    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemText, code }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setTestResult(result.data.execution);
    } catch (err: any) {
      setError(err.message || 'Failed to run tests');
    } finally {
      setLoadingTest(false);
    }
  };

  // =================== AUTO MODE HANDLERS ===================
  const handleFetchDaily = async () => {
    setFetchingChallenge(true);
    setError('');
    setDailyChallenge(null);
    setAutoResult(null);
    setAutoSteps([]);
    try {
      const response = await fetch('/api/daily-challenge');
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setDailyChallenge(result.data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch daily challenge');
    } finally {
      setFetchingChallenge(false);
    }
  };

  const handleAutoSolve = async (problemContent: string, challengeInfo: any) => {
    setAutoLoading(true);
    setError('');
    setAutoResult(null);
    setAutoSteps([
      { step: 'analyze', status: 'running' },
    ]);
    try {
      const response = await fetch('/api/auto-solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problemText: problemContent, challengeInfo }),
      });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setAutoResult(result.data);
      setAutoSteps(result.data.steps || []);
    } catch (err: any) {
      setError(err.message || 'Auto-solve failed');
    } finally {
      setAutoLoading(false);
    }
  };

  const handleFullAuto = async () => {
    setFetchingChallenge(true);
    setError('');
    setDailyChallenge(null);
    setAutoResult(null);
    setAutoSteps([{ step: 'fetch_challenge', status: 'running' }]);

    try {
      const challengeRes = await fetch('/api/daily-challenge');
      const challengeResult = await challengeRes.json();
      if (!challengeResult.success) throw new Error(challengeResult.error);

      setDailyChallenge(challengeResult.data);
      setAutoSteps(prev => [
        { step: 'fetch_challenge', status: 'done', data: challengeResult.data },
      ]);
      setFetchingChallenge(false);

      await handleAutoSolve(challengeResult.data.content, challengeResult.data);
    } catch (err: any) {
      setError(err.message || 'Full auto failed');
      setFetchingChallenge(false);
      setAutoLoading(false);
    }
  };

  const getStepIcon = (status: string) => {
    if (status === 'running') return '⏳';
    if (status === 'done' || status === 'passed') return '✅';
    if (status === 'failed') return '❌';
    return '⬜';
  };

  const getStepLabel = (step: string) => {
    const labels: Record<string, string> = {
      fetch_challenge: 'Fetching Daily Challenge',
      analyze: 'AI Analyzing Problem',
      generate: 'AI Generating Java Code',
      test_attempt_1: 'Running Tests (Attempt 1)',
      test_attempt_2: 'Running Tests (Attempt 2)',
      test_attempt_3: 'Running Tests (Attempt 3)',
      debug_attempt_1: 'AI Debugging Code (Retry 1)',
      debug_attempt_2: 'AI Debugging Code (Retry 2)',
    };
    return labels[step] || step;
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white p-8 font-sans pb-20">
      <div className="max-w-6xl mx-auto space-y-8">

        {/* Header */}
        <div className="space-y-3">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            AI LeetCode Agent
          </h1>
          <p className="text-neutral-400">
            Fully autonomous AI agent that fetches, analyzes, solves, and tests LeetCode challenges.
          </p>

          {/* Mode Toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => setAutoMode(false)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${!autoMode ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              Manual Mode
            </button>
            <button
              onClick={() => setAutoMode(true)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${autoMode ? 'bg-emerald-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'}`}
            >
              🤖 Full Auto Mode
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* =================== AUTO MODE =================== */}
        {autoMode && (
          <div className="space-y-6">
            {/* Big Auto Button */}
            <button
              onClick={handleFullAuto}
              disabled={autoLoading || fetchingChallenge}
              className="w-full bg-gradient-to-r from-emerald-600 to-blue-600 hover:from-emerald-500 hover:to-blue-500 disabled:from-neutral-700 disabled:to-neutral-700 text-white font-bold text-lg py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 hover:shadow-emerald-500/40 flex items-center justify-center gap-3"
            >
              {(autoLoading || fetchingChallenge) ? (
                <span className="animate-pulse">🤖 Agent is working autonomously...</span>
              ) : (
                <span>🚀 Auto-Solve Today&apos;s LeetCode Challenge</span>
              )}
            </button>

            {/* Pipeline Progress */}
            {autoSteps.length > 0 && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl">
                <h2 className="text-lg font-semibold mb-4 text-neutral-200">Pipeline Progress</h2>
                <div className="space-y-3">
                  {autoSteps.map((s, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <span className="text-lg">{getStepIcon(s.status)}</span>
                      <span className={s.status === 'running' ? 'text-yellow-400 animate-pulse' : s.status === 'passed' || s.status === 'done' ? 'text-emerald-400' : s.status === 'failed' ? 'text-red-400' : 'text-neutral-400'}>
                        {getStepLabel(s.step)}
                      </span>
                    </div>
                  ))}

                  {autoLoading && (
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-lg animate-spin">⚙️</span>
                      <span className="text-yellow-400 animate-pulse">Processing...</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Daily Challenge Info */}
            {dailyChallenge && (
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-neutral-200">Today&apos;s Challenge</h2>
                  <span className={`text-xs font-bold px-3 py-1 rounded-full ${dailyChallenge.difficulty === 'Easy' ? 'bg-emerald-500/20 text-emerald-400' : dailyChallenge.difficulty === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                    {dailyChallenge.difficulty}
                  </span>
                </div>
                <h3 className="text-xl font-bold text-white">{dailyChallenge.title}</h3>
                <p className="text-xs text-neutral-500">Date: {dailyChallenge.date}</p>
                <div className="flex gap-2 flex-wrap">
                  {dailyChallenge.tags?.map((tag: string, i: number) => (
                    <span key={i} className="text-xs bg-neutral-800 text-neutral-300 px-2 py-1 rounded-md">{tag}</span>
                  ))}
                </div>
                <a href={dailyChallenge.link} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-sm underline">
                  View on LeetCode →
                </a>
              </div>
            )}

            {/* Auto Result */}
            {autoResult && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Analysis */}
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-4">
                  <h2 className="text-lg font-semibold border-b border-neutral-800 pb-2">AI Analysis</h2>
                  <div>
                    <h3 className="text-sm font-medium text-emerald-400 mb-1">Core Task</h3>
                    <p className="text-sm text-neutral-300 bg-neutral-950 p-3 rounded-lg border border-neutral-800">{autoResult.analysis?.task}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="text-sm font-medium text-blue-400 mb-1">Time</h3>
                      <div className="text-sm text-neutral-300 bg-neutral-950 p-2 rounded-lg border border-neutral-800 font-mono">{autoResult.analysis?.expectedTimeComplexity}</div>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-purple-400 mb-1">Space</h3>
                      <div className="text-sm text-neutral-300 bg-neutral-950 p-2 rounded-lg border border-neutral-800 font-mono">{autoResult.analysis?.expectedSpaceComplexity}</div>
                    </div>
                  </div>
                  {autoResult.analysis?.edgeCases && (
                    <div>
                      <h3 className="text-sm font-medium text-amber-400 mb-2">Edge Cases</h3>
                      <ul className="space-y-1">
                        {autoResult.analysis.edgeCases.map((ec: string, i: number) => (
                          <li key={i} className="text-sm text-neutral-300 flex items-start gap-2 bg-neutral-950 p-2 rounded-lg border border-neutral-800">
                            <span className="text-amber-500">•</span><span>{ec}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Final Code + Status */}
                <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl space-y-4">
                  <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                    <h2 className="text-lg font-semibold">Final Solution</h2>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-neutral-500">Attempts: {autoResult.attempts}</span>
                      <span className={`text-xs font-bold px-3 py-1 rounded-full ${autoResult.allPassed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {autoResult.allPassed ? '✅ ALL TESTS PASSED' : '❌ TESTS FAILED'}
                      </span>
                    </div>
                  </div>
                  <pre className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg overflow-x-auto text-sm text-neutral-300 font-mono max-h-[500px] overflow-y-auto">
                    <code>{autoResult.finalCode}</code>
                  </pre>
                  <p className="text-xs text-neutral-500 italic">
                    This code is ready to submit on LeetCode. Copy it and paste it directly into the LeetCode editor.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================== MANUAL MODE =================== */}
        {!autoMode && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Input Section */}
            <div className="space-y-4">
              <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 shadow-xl">
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Problem Description
                </label>
                <textarea
                  value={problemText}
                  onChange={(e) => setProblemText(e.target.value)}
                  className="w-full h-[400px] bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-sm text-neutral-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                  placeholder="Paste the problem statement here..."
                />
                <button
                  onClick={handleAnalyze}
                  disabled={loadingAnalysis || !problemText.trim()}
                  className="mt-4 w-full bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {loadingAnalysis ? (
                    <span className="animate-pulse">Analyzing...</span>
                  ) : (
                    <span>Analyze Problem</span>
                  )}
                </button>
              </div>
            </div>

            {/* Results Section */}
            <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-xl flex flex-col h-full max-h-[800px] overflow-y-auto">
              <h2 className="text-xl font-semibold border-b border-neutral-800 pb-2 mb-4 shrink-0">Analysis Results</h2>

              {!analysis && !loadingAnalysis && (
                <div className="text-neutral-500 text-sm italic flex-1 flex items-center justify-center min-h-[200px]">
                  Waiting for problem analysis...
                </div>
              )}

              {loadingAnalysis && (
                <div className="space-y-4 animate-pulse">
                  <div className="h-4 bg-neutral-800 rounded w-3/4"></div>
                  <div className="h-4 bg-neutral-800 rounded w-1/2"></div>
                  <div className="h-4 bg-neutral-800 rounded w-5/6"></div>
                </div>
              )}

              {analysis && !loadingAnalysis && (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-medium text-emerald-400 mb-1">Core Task</h3>
                    <p className="text-sm text-neutral-300 bg-neutral-950 p-3 rounded-lg border border-neutral-800">{analysis.task}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="text-sm font-medium text-blue-400 mb-1">Time Complexity</h3>
                      <div className="text-sm text-neutral-300 bg-neutral-950 p-2 rounded-lg border border-neutral-800 font-mono">{analysis.expectedTimeComplexity}</div>
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-purple-400 mb-1">Space Complexity</h3>
                      <div className="text-sm text-neutral-300 bg-neutral-950 p-2 rounded-lg border border-neutral-800 font-mono">{analysis.expectedSpaceComplexity}</div>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-amber-400 mb-2">Edge Cases</h3>
                    <ul className="space-y-2">
                      {analysis.edgeCases?.map((ec: string, i: number) => (
                        <li key={i} className="text-sm text-neutral-300 flex items-start gap-2 bg-neutral-950 p-2 rounded-lg border border-neutral-800">
                          <span className="text-amber-500 mt-0.5">•</span><span>{ec}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {analysis.insights && analysis.insights.length > 0 && (
                    <div>
                      <h3 className="text-sm font-medium text-indigo-400 mb-2">Algorithm Insights</h3>
                      <ul className="space-y-2">
                        {analysis.insights.map((insight: string, i: number) => (
                          <li key={i} className="text-sm text-neutral-300 flex items-start gap-2 bg-neutral-950 p-2 rounded-lg border border-neutral-800">
                            <span className="text-indigo-500 mt-0.5">💡</span><span>{insight}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="pt-4 border-t border-neutral-800">
                    <button
                      onClick={handleGenerateCode}
                      disabled={loadingCode}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors"
                    >
                      {loadingCode ? <span className="animate-pulse">Generating Java Code...</span> : <span>Generate Java Solution</span>}
                    </button>
                  </div>
                  {code && (
                    <div className="mt-6 space-y-4">
                      <h3 className="text-sm font-medium text-emerald-400 mb-2">Generated Java Code</h3>
                      <pre className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg overflow-x-auto text-sm text-neutral-300 font-mono">
                        <code>{code}</code>
                      </pre>
                      <button
                        onClick={handleRunTests}
                        disabled={loadingTest}
                        className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white font-medium py-2.5 rounded-lg transition-colors mt-4"
                      >
                        {loadingTest ? <span className="animate-pulse">Running Tests...</span> : <span>Run AI Tests (Judge0)</span>}
                      </button>
                    </div>
                  )}
                  {testResult && (
                    <div className="mt-6 space-y-2 border-t border-neutral-800 pt-4">
                      <h3 className="text-sm font-medium text-purple-400 mb-2">Test Results</h3>
                      <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg">
                        {testResult.status?.description && (
                          <div className="mb-2 text-sm font-bold">
                            Status: <span className={testResult.status.id === 3 ? "text-emerald-400" : "text-red-400"}>{testResult.status.description}</span>
                          </div>
                        )}
                        {testResult.stdout && (
                          <div><p className="text-xs text-neutral-500 mb-1">Output</p><pre className="text-sm text-neutral-300 font-mono whitespace-pre-wrap">{testResult.stdout}</pre></div>
                        )}
                        {testResult.stderr && (
                          <div className="mt-2"><p className="text-xs text-red-500 mb-1">Error</p><pre className="text-sm text-red-400 font-mono whitespace-pre-wrap">{testResult.stderr}</pre></div>
                        )}
                        {testResult.compile_output && (
                          <div className="mt-2"><p className="text-xs text-amber-500 mb-1">Compiler</p><pre className="text-sm text-amber-400 font-mono whitespace-pre-wrap">{testResult.compile_output}</pre></div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
