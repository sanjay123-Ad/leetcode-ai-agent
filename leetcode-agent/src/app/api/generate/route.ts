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
    if (!code) {
      throw new Error("No response from Gemini");
    }

    // Clean up any potential markdown code blocks if the AI accidentally includes them
    code = code.replace(/```java/gi, '').replace(/```/g, '').trim();

    return NextResponse.json({ success: true, data: { code: code.trim() } });
  } catch (error: any) {
    console.error('Error generating code:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to generate code' }, { status: 500 });
  }
}
