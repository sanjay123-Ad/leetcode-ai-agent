import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: Request) {
  try {
    const { problemText, analysis } = await req.json();

    if (!problemText || !analysis) {
      return NextResponse.json({ error: 'problemText and analysis are required' }, { status: 400 });
    }

    const prompt = `
You are an expert Java developer and algorithm solver.
Write an optimal LeetCode Java solution (class Solution) for this problem.

Requirements:
1. Provide ONLY a standard "class Solution" containing the solution method.
2. Do NOT include markdown code blocks, main method, or extra explanations.
3. Make the code optimal and complete.

Problem: ${problemText}
Analysis: ${JSON.stringify(analysis)}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: {
        maxOutputTokens: 1000,
      }
    });

    let code = response.text;
    if (!code) throw new Error("No response from Gemini");

    code = code.replace(/```java/gi, '').replace(/```/g, '').trim();

    return NextResponse.json({ success: true, data: { code } });
  } catch (error: any) {
    console.error('Error generating code:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to generate code' }, { status: 500 });
  }
}
