import { NextResponse } from 'next/server';

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
1. Provide ONLY the Java code (class Solution). Do NOT include any explanations, markdown code blocks, or conversational text.
2. The code should be a single Java class named Solution with the method for the problem.
3. Make the code clean, well-commented, and optimal.

Problem Description:
${problemText}

Problem Analysis:
${JSON.stringify(analysis, null, 2)}
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
        model: 'google/gemini-2.5-flash:free',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await res.json();
    let code = data.choices?.[0]?.message?.content;
    if (!code) {
      throw new Error(data.error?.message || 'No response from OpenRouter');
    }

    code = code.replace(/```java/gi, '').replace(/```/g, '').trim();

    return NextResponse.json({ success: true, data: { code } });
  } catch (error: any) {
    console.error('Error generating code:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to generate code' }, { status: 500 });
  }
}
