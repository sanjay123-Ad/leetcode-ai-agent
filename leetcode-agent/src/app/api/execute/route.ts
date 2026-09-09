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
    if (!testCode) {
      throw new Error("No response from Gemini");
    }

    testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

    // Now execute it via Judge0
    const judge0Response = await fetch('https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': process.env.JUDGE0_API_KEY || '',
        'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
      },
      body: JSON.stringify({
        language_id: 62, // Java
        source_code: testCode,
      })
    });

    const executionResult = await judge0Response.json();

    return NextResponse.json({ 
      success: true, 
      data: { 
        testCode: testCode.trim(), 
        execution: executionResult 
      } 
    });
  } catch (error: any) {
    console.error('Error in execute route:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to execute' }, { status: 500 });
  }
}
