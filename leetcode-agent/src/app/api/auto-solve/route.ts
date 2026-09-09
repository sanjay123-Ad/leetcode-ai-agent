import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

async function callOpenRouter(prompt: string, jsonMode = false) {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
  const body: any = {
    model: 'google/gemini-2.5-flash:free',
    messages: [{ role: 'user', content: prompt }],
  };

  if (jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/sanjay123-Ad/leetcode-ai-agent',
      'X-Title': 'LeetCode AI Agent',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(data.error?.message || 'OpenRouter API call failed');
  }
  return text;
}

// Helper: Analyze problem
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

  const text = await callOpenRouter(prompt, true);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch?.[0] || text);
}

// Helper: Generate Java code
async function generateCode(problemText: string, analysis: any) {
  const prompt = `
You are an expert Java developer and algorithm solver.
Write the optimal Java solution (class Solution) for this LeetCode problem based on analysis.
Provide ONLY the Java code (class Solution). Do NOT include markdown code blocks or explanations.

Problem: ${problemText}
Analysis: ${JSON.stringify(analysis, null, 2)}
  `;

  let code = await callOpenRouter(prompt);
  code = code.replace(/```java/gi, '').replace(/```/g, '').trim();
  return code;
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

  let testCode = await callOpenRouter(prompt);
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

  let fixedCode = await callOpenRouter(prompt);
  fixedCode = fixedCode.replace(/```java/gi, '').replace(/```/g, '').trim();
  return fixedCode;
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
        code: finalCode,
        passed,
        attempts,
        execution: lastExecutionResult,
        logs,
      }
    });

  } catch (error: any) {
    console.error('Error in auto-solve pipeline:', error);
    addLog(`💥 Pipeline Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message, logs }, { status: 500 });
  }
}
