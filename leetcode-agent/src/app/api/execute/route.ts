import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: Request) {
  try {
    const { problemText, code } = await req.json();

    if (!problemText || !code) {
      return NextResponse.json({ error: 'problemText and code are required' }, { status: 400 });
    }

    const prompt = `
Given this LeetCode problem and Solution class, generate a single Java harness class named "Main" that instantiates Solution and tests it against 3 test cases.
Print EXACTLY "ALL_TESTS_PASSED" if all pass. Print EXACTLY "TEST_FAILED" if any fail.
Return ONLY raw Java code containing Main and Solution classes.

Problem: ${problemText}
Solution: ${code}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: {
        maxOutputTokens: 1200,
      }
    });

    let testCode = response.text;
    if (!testCode) throw new Error("No response from Gemini");

    testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

    // Execute via Judge0
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
