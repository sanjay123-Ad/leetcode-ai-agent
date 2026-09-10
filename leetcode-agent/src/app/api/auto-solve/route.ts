import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper: Analyze problem
async function analyzeProblem(problemText: string) {
  const prompt = `
Analyze this LeetCode problem.
Extract core task, expected time and space complexity, and edge cases.
Format as strict JSON:
{
  "task": "summary",
  "expectedTimeComplexity": "O(...)",
  "expectedSpaceComplexity": "O(...)",
  "edgeCases": ["case1"],
  "insights": ["insight1"]
}

Problem Description:
${problemText}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      maxOutputTokens: 500,
    }
  });

  const text = response.text;
  if (!text) throw new Error('No analysis response from Gemini');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch?.[0] || text);
}

// Helper: Generate Java code
async function generateCode(problemText: string, analysis: any) {
  const prompt = `
Write an optimal LeetCode Java solution (class Solution) for this problem.
Provide ONLY the Java code (class Solution). Do NOT include markdown code blocks or explanations.

Problem: ${problemText}
Analysis: ${JSON.stringify(analysis)}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: {
      maxOutputTokens: 1000,
    }
  });

  let code = response.text;
  if (!code) throw new Error('No code response from Gemini');
  return code.replace(/```java/gi, '').replace(/```/g, '').trim();
}

// Helper: Generate test wrapper and execute via Judge0
async function testCode(problemText: string, code: string) {
  const prompt = `
Write a runnable Java class named "Main" that tests the following solution against 3 test cases.
Print EXACTLY "ALL_TESTS_PASSED" if all pass. Print EXACTLY "TEST_FAILED" if any fail.
Return ONLY raw Java code containing Main and Solution classes, no markdown.

Problem: ${problemText}
Solution: ${code}
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: {
      maxOutputTokens: 1200,
    }
  });

  let testCode = response.text;
  if (!testCode) throw new Error('No test code response from Gemini');
  testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

  const judge0Response = await fetch('https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': process.env.JUDGE0_API_KEY || '',
      'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
    },
    body: JSON.stringify({
      language_id: 62,
      source_code: testCode,
    })
  });

  const executionResult = await judge0Response.json();
  return { testCode, execution: executionResult };
}

// Helper: Debug failed code
async function debugCode(problemText: string, code: string, errorOutput: string) {
  const prompt = `
Fix this Java "class Solution" for the LeetCode problem. The tests failed with error:
${errorOutput}

Problem: ${problemText}
Current Code: ${code}

Provide ONLY the corrected "class Solution" code without markdown or main method.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: prompt,
    config: {
      maxOutputTokens: 1000,
    }
  });

  let fixedCode = response.text;
  if (!fixedCode) throw new Error('No debug response from Gemini');
  return fixedCode.replace(/```java/gi, '').replace(/```/g, '').trim();
}

export async function POST(req: Request) {
  const logs: string[] = [];
  const addLog = (msg: string) => {
    console.log(msg);
    logs.push(msg);
  };

  try {
    const body = await req.json();
    const problemText = body.problemText || body.problem?.content;
    const title = body.challengeInfo?.title || body.problem?.title || 'Daily Problem';
    const difficulty = body.challengeInfo?.difficulty || body.problem?.difficulty || 'Medium';

    if (!problemText) {
      return NextResponse.json({ error: 'Valid problem content is required' }, { status: 400 });
    }

    addLog(`🚀 Starting Autonomous Solve pipeline for: "${title}"`);

    // Step 1: Analyze
    addLog('🧠 Phase 1: AI Analyzing problem statement & constraints...');
    const analysis = await analyzeProblem(problemText);
    addLog(`✅ Analysis complete! Target Time: ${analysis.expectedTimeComplexity}, Space: ${analysis.expectedSpaceComplexity}`);

    // Step 2: Generate Initial Code
    addLog('💻 Phase 2: Generating optimal Java solution...');
    let currentCode = await generateCode(problemText, analysis);
    addLog('✅ Initial Java code generated.');

    // Step 3: Self-Healing Testing Loop (Up to 3 Attempts)
    let passed = false;
    let attempts = 0;
    let lastExecutionResult: any = null;

    for (let i = 1; i <= 3; i++) {
      attempts = i;
      addLog(`🧪 Phase 3 (Attempt ${i}/3): Generating unit tests & compiling on Judge0...`);

      const { execution } = await testCode(problemText, currentCode);
      lastExecutionResult = execution;

      const stdout = execution.stdout || '';
      const stderr = execution.stderr || '';
      const compileOutput = execution.compile_output || '';

      if (stdout.includes('ALL_TESTS_PASSED') && execution.status?.id === 3) {
        passed = true;
        addLog(`🎉 SUCCESS! All test cases passed on Attempt ${i}!`);
        break;
      } else {
        addLog(`❌ Attempt ${i} Failed.`);
        if (stderr) addLog(`Stderr: ${stderr.trim()}`);
        if (compileOutput) addLog(`Compilation Error: ${compileOutput.trim()}`);
        if (stdout) addLog(`Stdout: ${stdout.trim()}`);

        if (i < 3) {
          addLog(`🔧 Self-Healing: Triggering AI Debugger to fix code...`);
          const errorContext = `stdout: ${stdout}\nstderr: ${stderr}\ncompile_output: ${compileOutput}`;
          currentCode = await debugCode(problemText, currentCode, errorContext);
          addLog(`✅ AI Debugger refactored code. Retrying...`);
        }
      }
    }

    // Clean code before saving
    const finalCode = currentCode.replace(/```java/gi, '').replace(/```/g, '').trim();

    // Step 4: Save Result to Supabase Database
    addLog('💾 Phase 4: Saving solution record to Supabase database...');
    const { data: dbData, error: dbError } = await supabase
      .from('problem_history')
      .insert([
        {
          title,
          difficulty,
          code: finalCode,
          attempts,
          passed,
        }
      ])
      .select();

    if (dbError) {
      addLog(`⚠️ Supabase Warning: ${dbError.message}`);
    } else {
      addLog(`✅ Successfully saved to Supabase! Record ID: ${dbData?.[0]?.id}`);
    }

    return NextResponse.json({
      success: true,
      data: {
        analysis,
        finalCode,
        allPassed: passed,
        attempts,
        execution: lastExecutionResult,
        logs,
        steps: [
          { step: 'analyze', status: 'done' },
          { step: 'generate', status: 'done' },
          { step: `test_attempt_${attempts}`, status: passed ? 'passed' : 'failed' },
        ],
      }
    });

  } catch (error: any) {
    console.error('Error in auto-solve pipeline:', error);
    addLog(`💥 Pipeline Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message, logs }, { status: 500 });
  }
}
