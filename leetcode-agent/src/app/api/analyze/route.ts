import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { problemText } = await req.json();

    if (!problemText) {
      return NextResponse.json({ error: 'problemText is required' }, { status: 400 });
    }

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
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(data.error?.message || 'No response from OpenRouter');
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsedData = JSON.parse(jsonMatch?.[0] || text);

    return NextResponse.json({ success: true, data: parsedData });
  } catch (error: any) {
    console.error('Error analyzing problem:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to analyze' }, { status: 500 });
  }
}
