/**
 * Every prompt the agent uses, in one place.
 *
 * Previously the same four prompts were copy-pasted across three route files and the CLI
 * script, so improving one of them improved one code path. They are also materially
 * different now: each carries the official interface contract, the real constraints and
 * the official examples, instead of asking the model to infer all three from prose.
 */

import type { JavaContract, Problem, ProblemAnalysis } from './types.ts';
import type { ExecutionOutcome } from './types.ts';

/** Caps the statement so a pathological problem cannot blow the token budget. */
function statementFor(problem: Problem, limit = 6000): string {
  const text = problem.statement;
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[statement truncated]`;
}

function examplesBlock(problem: Problem): string {
  if (problem.exampleTestcases.length === 0) return '(no official example cases were available)';
  return problem.exampleTestcases
    .map((input, i) => {
      const expected = problem.exampleOutputs[i];
      return `Case ${i + 1}:\n  input:\n${input
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}\n  expected output: ${expected ?? '(not available)'}`;
    })
    .join('\n');
}

const CODE_RULES = [
  'Return Java source code only. No markdown fences, no prose, no explanation.',
  'Do not write a package declaration.',
  'Do not write a main method.',
  'Do not redefine helper classes such as ListNode or TreeNode — the judge already defines them.',
  'You may add private helper methods and extra imports, but the required public interface must stay exactly as given.',
  'The code must be complete and compile as-is.',
];

export function analysisPrompt(problem: Problem, contract?: JavaContract): string {
  return `You are an expert competitive-programming analyst. Analyse this LeetCode problem before any code is written.

PROBLEM: ${problem.title} (${problem.difficulty})

STATEMENT:
${statementFor(problem)}

${problem.constraints ? `CONSTRAINTS:\n${problem.constraints}\n` : ''}
OFFICIAL EXAMPLES:
${examplesBlock(problem)}

${contract ? `REQUIRED JAVA INTERFACE (fixed, do not change):\n${contract.source}\n` : ''}
Respond with ONLY this JSON object:
{
  "task": "one or two sentences stating exactly what must be computed",
  "algorithm": "the algorithm or data structure you will use, named precisely",
  "approach": "the solution strategy in 3-5 short steps, referring to the constraints",
  "expectedTimeComplexity": "O(...) justified by the constraints",
  "expectedSpaceComplexity": "O(...)",
  "edgeCases": ["concrete edge cases implied by the constraints"],
  "insights": ["observations that make the chosen approach correct or fast enough"]
}

Derive the complexity target from the stated constraints, not from habit: say which input bound forces it.`;
}

export function generationPrompt(problem: Problem, contract: JavaContract, analysis?: ProblemAnalysis): string {
  return `You are an expert Java engineer. Implement this LeetCode problem.

PROBLEM: ${problem.title} (${problem.difficulty})

STATEMENT:
${statementFor(problem)}

${problem.constraints ? `CONSTRAINTS:\n${problem.constraints}\n` : ''}
OFFICIAL EXAMPLES (your code must reproduce these exactly):
${examplesBlock(problem)}

${
  analysis
    ? `AGREED APPROACH:
- algorithm: ${analysis.algorithm ?? 'n/a'}
- approach: ${analysis.approach ?? analysis.task}
- target time complexity: ${analysis.expectedTimeComplexity}
- target space complexity: ${analysis.expectedSpaceComplexity}
- edge cases to handle: ${(analysis.edgeCases ?? []).join('; ') || 'n/a'}
`
    : ''
}
REQUIRED INTERFACE — this is LeetCode's official Java template. Reproduce these declarations
character for character (class name, method names, parameter types and order, return types)
and write your implementation inside them:
\`\`\`java
${contract.source}
\`\`\`

RULES:
${CODE_RULES.map((rule) => `- ${rule}`).join('\n')}

Write the complete solution now.`;
}

export function signatureRepairPrompt(code: string, violationReport: string): string {
  return `Your previous answer does not match LeetCode's official Java interface, so LeetCode would
reject it even if the algorithm is correct.

${violationReport}

YOUR PREVIOUS CODE:
\`\`\`java
${code}
\`\`\`

Fix ONLY the interface: keep the algorithm and its logic, rename and re-type as needed so the
declarations match the required interface exactly.

RULES:
${CODE_RULES.map((rule) => `- ${rule}`).join('\n')}

Return the corrected code.`;
}

export function compileRepairPrompt(problem: Problem, contract: JavaContract, code: string, compilerOutput: string): string {
  return `Your Java solution for "${problem.title}" does not compile.

COMPILER OUTPUT:
${compilerOutput.slice(0, 2500)}

YOUR CODE:
\`\`\`java
${code}
\`\`\`

REQUIRED INTERFACE (must stay exactly as-is):
\`\`\`java
${contract.source}
\`\`\`

Note: the judge compiles your code with java.util.*, java.util.function.*, java.util.stream.*
and java.math.* already imported, and it defines any helper classes (ListNode, TreeNode)
itself — do not declare them.

Fix the compilation errors without changing the required interface.

RULES:
${CODE_RULES.map((rule) => `- ${rule}`).join('\n')}

Return the corrected code.`;
}

export function wrongAnswerRepairPrompt(
  problem: Problem,
  contract: JavaContract,
  code: string,
  outcome: ExecutionOutcome,
): string {
  const failures = outcome.cases
    .filter((c) => !c.passed)
    .slice(0, 6)
    .map((c) => `- case ${c.label ?? c.index}: expected ${c.expected}, your code produced ${c.actual}`)
    .join('\n');

  return `Your Java solution for "${problem.title}" compiles but produces wrong results on LeetCode's
own example cases.

FAILING OFFICIAL CASES:
${failures || outcome.message || 'no per-case detail available'}
${outcome.stderr ? `\nSTDERR:\n${outcome.stderr.slice(0, 800)}` : ''}

OFFICIAL EXAMPLES:
${examplesBlock(problem)}

YOUR CODE:
\`\`\`java
${code}
\`\`\`

REQUIRED INTERFACE (must stay exactly as-is):
\`\`\`java
${contract.source}
\`\`\`

Work out *why* those cases fail — re-read the statement and the constraints before editing.
Do not special-case the failing inputs; fix the underlying logic.

RULES:
${CODE_RULES.map((rule) => `- ${rule}`).join('\n')}

Return the corrected code.`;
}

export function runtimeRepairPrompt(
  problem: Problem,
  contract: JavaContract,
  code: string,
  outcome: ExecutionOutcome,
): string {
  return `Your Java solution for "${problem.title}" compiles but ${
    outcome.kind === 'timeout' ? 'exceeded the time limit' : 'crashed at runtime'
  }.

DETAIL:
${(outcome.message ?? '').slice(0, 500)}
${outcome.stdout ? `\nSTDOUT:\n${outcome.stdout.slice(0, 800)}` : ''}
${outcome.stderr ? `\nSTDERR:\n${outcome.stderr.slice(0, 800)}` : ''}

${problem.constraints ? `CONSTRAINTS:\n${problem.constraints}\n` : ''}
YOUR CODE:
\`\`\`java
${code}
\`\`\`

REQUIRED INTERFACE (must stay exactly as-is):
\`\`\`java
${contract.source}
\`\`\`

${
  outcome.kind === 'timeout'
    ? 'Replace the approach with one whose complexity fits the stated constraints.'
    : 'Find and fix the cause of the exception, including the edge cases the constraints allow.'
}

RULES:
${CODE_RULES.map((rule) => `- ${rule}`).join('\n')}

Return the corrected code.`;
}

export function explanationPrompt(problem: Problem, code: string): string {
  return `Explain this verified Java solution to "${problem.title}" for someone learning algorithms.

\`\`\`java
${code}
\`\`\`

Respond with ONLY this JSON object:
{
  "summary": "one sentence naming the technique used",
  "steps": ["3-6 short steps describing how the code works, in order"],
  "timeComplexity": "O(...) for this exact implementation, with the reason",
  "spaceComplexity": "O(...) for this exact implementation, with the reason",
  "edgeCases": ["edge cases this code handles and how"]
}

Describe the code as written. Do not describe a different or idealised implementation.`;
}
