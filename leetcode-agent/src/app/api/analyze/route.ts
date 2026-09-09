import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function POST(req: Request) {
  try {
    const { problemText } = await req.json();

    if (!problemText) {
      return NextResponse.json({ error: 'problemText is required' }, { status: 400 });
    }

    const prompt = `
You are an expert algorithm analyst. Analyze the following LeetCode problem.
Extract the core task, expected time and space complexity, and edge cases.
Format the output as a strict JSON object:
{
  "task": "A brief summary",
  "expectedTimeComplexity": "O(...)",
  "expectedSpaceComplexity": "O(...)",
  "edgeCases": ["case1"],
  "insights": ["insight1"]
}

Problem Description:
${problemText}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 500,
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from Gemini");

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(jsonMatch?.[0] || text);

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('Error analyzing problem:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to analyze' }, { status: 500 });
  }
}
