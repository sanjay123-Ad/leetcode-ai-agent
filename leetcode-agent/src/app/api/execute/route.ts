import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { problemText, code } = await req.json();

    if (!problemText || !code) {
      return NextResponse.json({ error: 'problemText and code are required' }, { status: 400 });
    }

    const prompt = `
You are an expert Java Test Engineer.
I have a LeetCode problem description and a proposed Java solution for it.
Your task is to write a single, complete, runnable Java class named "Main".
This Main class MUST contain:
1. The exact proposed solution code inside class Solution.
2. A public static void main(String[] args) method.
3. Inside the main method, create at least 3 strict test cases based on the problem description (including edge cases).
4. Run the solution against these test cases.
5. If ANY test fails, print "TEST_FAILED" followed by the details.
6. If ALL tests pass perfectly, print "ALL_TESTS_PASSED".

Provide ONLY the raw Java code for the Main class and Solution class. Do not include markdown blocks or extra text.

Problem:
${problemText}

Solution to test:
${code}
    `;

    const apiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/sanjay123-Ad/leetcode-ai-agent',
        'X-Title': 'LeetCode AI Agent',
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-coder-32b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    let testCode = data.choices?.[0]?.message?.content;
    if (!testCode) {
      throw new Error(data.error?.message || 'No response from OpenRouter');
    }

    testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

    // Now execute it via Judge0
    const judge0Response = await fetch('https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': process.env.JUDGE0_API_KEY || '',
        'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
      },
      body: JSON.stringify({
        language_id: 62, // Java
        source_code: testCode,
      })
    });

    const execution = await judge0Response.json();
    return NextResponse.json({ success: true, data: { testCode, execution } });
  } catch (error: any) {
    console.error('Error executing code:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to execute' }, { status: 500 });
  }
}
