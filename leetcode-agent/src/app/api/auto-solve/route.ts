import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper: Analyze the problem
async function analyzeProblem(problemText: string) {
  const prompt = `
You are an expert algorithm analyst. Analyze the following LeetCode problem.
Extract the core task, the expected time and space complexity, and edge cases.
Format the output as a strict JSON object with the following schema:
{
  "task": "A brief summary of what needs to be done",
  "expectedTimeComplexity": "e.g., O(n log n)",
  "expectedSpaceComplexity": "e.g., O(1)",
  "edgeCases": ["edge case 1", "edge case 2"],
  "insights": ["insight 1", "insight 2"]
}

Problem Description:
${problemText}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' },
  });

  const text = response.text;
  if (!text) throw new Error('No analysis response from Gemini');
  return JSON.parse(text);
}

// Helper: Generate Java code
async function generateCode(problemText: string, analysis: any) {
  const prompt = `
You are an expert Java developer and algorithm solver.
I will provide you with a LeetCode problem description and an analysis of the problem.
Your task is to write the optimal Java solution based on the analysis provided.

Requirements:
1. Provide ONLY the Java code. Do not include any explanations, markdown code blocks, or conversational text.
2. The code should be a single Java class (typically named Solution) with the main method for the problem.
3. Make the code clean, well-commented, and optimal.

Problem Description:
${problemText}

Problem Analysis:
${JSON.stringify(analysis, null, 2)}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  let code = response.text;
  if (!code) throw new Error('No code response from Gemini');
  code = code.replace(/```java/gi, '').replace(/```/g, '').trim();
  return code;
}

// Helper: Generate test wrapper and execute via Judge0
async function testCode(problemText: string, code: string) {
  const prompt = `
You are an expert Java Test Engineer.
I have a LeetCode problem description and a proposed Java solution for it.
Your task is to write a single, complete, runnable Java class named "Main".
This Main class MUST contain:
1. The exact proposed solution code.
2. A public static void main(String[] args) method.
3. Inside the main method, create at least 5 strict test cases based on the problem description (including edge cases).
4. Run the solution against these test cases.
5. If ANY test fails, print "TEST_FAILED" followed by the details.
6. If ALL tests pass perfectly, print "ALL_TESTS_PASSED".

Provide ONLY the Java code for the Main class. Do not include markdown blocks.

Problem:
${problemText}

Solution to test:
${code}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  let testCode = response.text;
  if (!testCode) throw new Error('No test code response from Gemini');
  testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

  // Execute via Judge0
  const judge0Response = await fetch('https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-RapidAPI-Key': process.env.JUDGE0_API_KEY || '',
      'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
    },
    body: JSON.stringify({
      language_id: 62,
      source_code: testCode.trim(),
    })
  });

  const executionResult = await judge0Response.json();
  return { testCode: testCode.trim(), execution: executionResult };
}

// Helper: Debug failed code
async function debugCode(problemText: string, code: string, errorOutput: string) {
  const prompt = `
You are an expert Java developer. The following Java solution for a LeetCode problem has a bug.
Here is the error output from running tests:
${errorOutput}

Here is the original problem:
${problemText}

Here is the buggy code:
${code}

Please fix the code. Provide ONLY the fixed Java code. No explanations, no markdown.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  let fixedCode = response.text;
  if (!fixedCode) throw new Error('No debug response from Gemini');
  fixedCode = fixedCode.replace(/```java/gi, '').replace(/```/g, '').trim();
  return fixedCode;
}

export async function POST(req: Request) {
  const MAX_RETRIES = 3;
  const steps: any[] = [];

  try {
    const { problemText, challengeInfo } = await req.json();

    if (!problemText) {
      return NextResponse.json({ error: 'problemText is required' }, { status: 400 });
    }

    // STEP 1: Analyze
    steps.push({ step: 'analyze', status: 'running' });
    const analysis = await analyzeProblem(problemText);
    steps[steps.length - 1] = { step: 'analyze', status: 'done', data: analysis };

    // STEP 2: Generate Code
    steps.push({ step: 'generate', status: 'running' });
    let code = await generateCode(problemText, analysis);
    steps[steps.length - 1] = { step: 'generate', status: 'done', data: { code } };

    // STEP 3: Test + Debug Loop
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      steps.push({ step: `test_attempt_${attempt}`, status: 'running' });
      const testResult = await testCode(problemText, code);
      const execution = testResult.execution;

      const stdout = execution.stdout || '';
      const stderr = execution.stderr || '';
      const compileOutput = execution.compile_output || '';
      const passed = stdout.includes('ALL_TESTS_PASSED') && execution.status?.id === 3;

      steps[steps.length - 1] = {
        step: `test_attempt_${attempt}`,
        status: passed ? 'passed' : 'failed',
        data: { stdout, stderr, compileOutput, statusDescription: execution.status?.description }
      };

      if (passed) {
        // Log to Supabase
        if (challengeInfo) {
          await supabase.from('problem_history').insert([{
            title: challengeInfo.title,
            difficulty: challengeInfo.difficulty,
            code: code,
            attempts: attempt,
            passed: true
          }]);
        }

        return NextResponse.json({
          success: true,
          data: {
            analysis,
            finalCode: code,
            attempts: attempt,
            allPassed: true,
            steps,
          }
        });
      }

      // If not the last attempt, debug and retry
      if (attempt < MAX_RETRIES) {
        steps.push({ step: `debug_attempt_${attempt}`, status: 'running' });
        const errorInfo = `Status: ${execution.status?.description}\nStdout: ${stdout}\nStderr: ${stderr}\nCompiler: ${compileOutput}`;
        code = await debugCode(problemText, code, errorInfo);
        steps[steps.length - 1] = { step: `debug_attempt_${attempt}`, status: 'done', data: { fixedCode: code } };
      }
    }

    // All retries exhausted
    if (challengeInfo) {
      await supabase.from('problem_history').insert([{
        title: challengeInfo.title,
        difficulty: challengeInfo.difficulty,
        code: code,
        attempts: MAX_RETRIES,
        passed: false
      }]);
    }

    return NextResponse.json({
      success: true,
      data: {
        analysis,
        finalCode: code,
        attempts: MAX_RETRIES,
        allPassed: false,
        steps,
      }
    });

  } catch (error: any) {
    console.error('Auto-solve error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Auto-solve failed', steps }, { status: 500 });
  }
}
