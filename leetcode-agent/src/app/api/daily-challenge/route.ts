import { NextResponse } from 'next/server';

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function GET() {
  // Try multiple APIs with fallback
  const apis = [
    {
      url: 'https://alfa-leetcode-api.onrender.com/daily',
      parse: (result: any) => {
        if (!result.questionTitle) throw new Error('Invalid response');
        return {
          date: result.date,
          link: result.questionLink,
          title: result.questionTitle,
          titleSlug: result.titleSlug,
          difficulty: result.difficulty,
          content: stripHtml(result.question || ''),
          tags: result.topicTags?.map((t: any) => t.name) || [],
          exampleTestcases: result.exampleTestcases,
        };
      }
    },
    {
      url: 'https://leetcode-api-fasz.vercel.app/dailyQuestion',
      parse: (result: any) => {
        if (!result.title) throw new Error('Invalid response');
        return {
          date: new Date().toISOString().split('T')[0],
          link: `https://leetcode.com/problems/${result.titleSlug}/`,
          title: result.title,
          titleSlug: result.titleSlug,
          difficulty: result.difficulty,
          content: stripHtml(result.content || result.question || ''),
          tags: result.topicTags?.map((t: any) => t.name) || [],
          exampleTestcases: result.exampleTestcases || '',
        };
      }
    },
    {
      // Direct LeetCode GraphQL - last resort
      url: 'https://leetcode.com/graphql',
      method: 'POST',
      body: JSON.stringify({
        query: `query questionOfToday {
          activeDailyCodingChallengeQuestion {
            date
            link
            question {
              title titleSlug difficulty content
              topicTags { name }
              exampleTestcaseList
            }
          }
        }`
      }),
      parse: (result: any) => {
        const q = result?.data?.activeDailyCodingChallengeQuestion;
        if (!q) throw new Error('Invalid response');
        return {
          date: q.date,
          link: `https://leetcode.com${q.link}`,
          title: q.question.title,
          titleSlug: q.question.titleSlug,
          difficulty: q.question.difficulty,
          content: stripHtml(q.question.content || ''),
          tags: q.question.topicTags?.map((t: any) => t.name) || [],
          exampleTestcases: q.question.exampleTestcaseList,
        };
      }
    }
  ];

  for (const api of apis) {
    try {
      const res = await fetch(api.url, {
        method: (api as any).method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: (api as any).body || undefined,
      });

      if (!res.ok) continue;

      const result = await res.json();
      const data = api.parse(result);

      return NextResponse.json({ success: true, data });
    } catch {
      continue; // Try next API
    }
  }

  return NextResponse.json(
    { success: false, error: 'All LeetCode API sources failed. Please try again in a few minutes.' },
    { status: 503 }
  );
}
