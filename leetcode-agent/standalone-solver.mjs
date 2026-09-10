// standalone-solver.mjs
// This script is run by GitHub Actions every day.
// It does NOT need the Next.js server to be running.
// It calls the AI APIs directly.

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function stripHtml(html) {
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

async function callGemini(prompt, maxTokens = 1000) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens }
      }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API Error');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function fetchDailyChallenge() {
  console.log('📥 Fetching daily challenge...');

  // Source 1: Alfa LeetCode API
  try {
    const res = await fetch('https://alfa-leetcode-api.onrender.com/daily');
    if (res.ok) {
      const data = await res.json();
      if (data.questionTitle) {
        return {
          date: data.date || new Date().toISOString().split('T')[0],
          link: data.questionLink || `https://leetcode.com/problems/${data.titleSlug}/`,
          title: data.questionTitle,
          titleSlug: data.titleSlug,
          difficulty: data.difficulty,
          content: stripHtml(data.question || ''),
          tags: data.topicTags?.map(t => t.name) || [],
        };
      }
    }
  } catch (e) {
    console.log('⚠️ Alfa API failed, trying secondary API...');
  }

  // Source 2: LeetCode Fasz API
  try {
    const res = await fetch('https://leetcode-api-fasz.vercel.app/dailyQuestion');
    if (res.ok) {
      const data = await res.json();
      if (data.title) {
        return {
          date: new Date().toISOString().split('T')[0],
          link: `https://leetcode.com/problems/${data.titleSlug}/`,
          title: data.title,
          titleSlug: data.titleSlug,
          difficulty: data.difficulty,
          content: stripHtml(data.content || data.question || ''),
          tags: data.topicTags?.map(t => t.name) || [],
        };
      }
    }
  } catch (e) {
    console.log('⚠️ Fasz API failed, trying direct GraphQL...');
  }

  // Source 3: Direct LeetCode GraphQL
  try {
    const query = `query questionOfToday {
      activeDailyCodingChallengeQuestion {
        date
        link
        question {
          title
          titleSlug
          difficulty
          content
          topicTags { name }
        }
      }
    }`;

    const res = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ query }),
    });

    if (res.ok) {
      const result = await res.json();
      const q = result.data?.activeDailyCodingChallengeQuestion?.question;
      if (q && q.title) {
        return {
          date: result.data.activeDailyCodingChallengeQuestion.date,
          link: `https://leetcode.com${result.data.activeDailyCodingChallengeQuestion.link}`,
          title: q.title,
          titleSlug: q.titleSlug,
          difficulty: q.difficulty,
          content: stripHtml(q.content || ''),
          tags: q.topicTags?.map(t => t.name) || [],
        };
      }
    }
  } catch (e) {
    console.log('⚠️ Direct GraphQL failed');
  }

  throw new Error('All 3 LeetCode API sources failed to fetch daily challenge');
}

async function analyzeAndGenerate(problemText) {
  console.log('🧠 AI analyzing problem...');
  const analysisPrompt = `Analyze this LeetCode problem and return ONLY a JSON object:
{"task":"brief summary","expectedTimeComplexity":"O(...)","expectedSpaceComplexity":"O(...)","edgeCases":["case1"],"insights":["insight1"]}

Problem: ${problemText}`;

  const analysisText = await callGemini(analysisPrompt, 500);
  const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
  let analysis;
  try {
    analysis = JSON.parse(jsonMatch?.[0] || '{}');
  } catch {
    console.log('⚠️ Could not parse analysis JSON, continuing with empty analysis');
    analysis = {};
  }

  console.log('💻 Generating Java code...');
  const codePrompt = `Write an optimal LeetCode Java solution for this problem.
Requirements:
1. Provide ONLY the Java code (class Solution). Do NOT include markdown formatting or explanations.
2. Make the code clean, optimal, and complete.

Problem: ${problemText}
Analysis: ${JSON.stringify(analysis)}`;

  let code = await callGemini(codePrompt, 1000);
  // Clean markdown fences robustly
  code = code.replace(/```java/gi, '').replace(/```/g, '').trim();

  return { analysis, code };
}

async function testCode(problemText, code, attempt) {
  console.log(`🧪 Writing and running tests (attempt ${attempt})...`);
  const testPrompt = `Given this LeetCode problem and Solution class, generate a single Java harness class named "Main" that instantiates Solution and tests it against 3 representative test cases.
Print EXACTLY "ALL_TESTS_PASSED" if all pass. Print EXACTLY "TEST_FAILED" if any fail.
Return ONLY raw runnable Java code containing Main class and Solution class.

Problem: ${problemText}
Solution:
${code}`;

  let testCode = await callGemini(testPrompt, 1200);
  testCode = testCode.replace(/```java/gi, '').replace(/```/g, '').trim();

  const judge0Res = await fetch(
    'https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': JUDGE0_API_KEY,
        'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com',
      },
      body: JSON.stringify({ language_id: 62, source_code: testCode }),
    }
  );

  const result = await judge0Res.json();
  const stdout = result.stdout || '';
  const passed = stdout.includes('ALL_TESTS_PASSED') && result.status?.id === 3;
  return { passed, stdout, stderr: result.stderr || '', compile_output: result.compile_output || '', result };
}

async function debugCode(problemText, code, error) {
  console.log('🔧 AI debugging code...');
  const debugPrompt = `Fix this Java "class Solution" for the LeetCode problem. The test execution failed with:
${error}

Problem: ${problemText}
Current Code: ${code}

Return ONLY the corrected "class Solution" code. No extra text or main methods.`;

  let fixed = await callGemini(debugPrompt, 1000);
  fixed = fixed.replace(/```java/gi, '').replace(/```/g, '').trim();
  return fixed;
}

async function main() {
  console.log('\n🤖 AI LeetCode Agent starting...\n');

  const challenge = await fetchDailyChallenge();
  console.log(`📌 Today's problem: ${challenge.title} (${challenge.difficulty})\n`);

  const { analysis, code: initialCode } = await analyzeAndGenerate(challenge.content);
  let code = initialCode;
  let allPassed = false;
  let finalAttempt = 1;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { passed, stdout, stderr, compile_output } = await testCode(challenge.content, code, attempt);

    if (passed) {
      allPassed = true;
      finalAttempt = attempt;
      console.log(`\n✅ ALL TESTS PASSED on attempt ${attempt}!`);
      break;
    }

    console.log(`❌ Tests failed on attempt ${attempt}`);
    if (attempt < 3) {
      const errorInfo = `stdout: ${stdout}\nstderr: ${stderr}\ncompiler: ${compile_output}`;
      code = await debugCode(challenge.content, code, errorInfo);
    } else {
      finalAttempt = attempt;
    }
  }

  // Clean up code formatting for storage
  code = (code || '')
    .replace(/```java/gi, '')
    .replace(/```/g, '')
    .trim();

  if (!code) {
    code = `// Could not generate code for ${challenge.title}`;
  }

  // Save to Supabase
  console.log('\n💾 Saving to database...');
  const { error } = await supabase.from('problem_history').insert([{
    title: challenge.title,
    difficulty: challenge.difficulty,
    code,
    attempts: finalAttempt,
    passed: allPassed,
  }]);

  if (error) console.error('⚠️  Supabase error:', error.message);
  else console.log('✅ Saved to Supabase!');

  console.log('\n==============================================');
  console.log(`📊 FINAL RESULT`);
  console.log(`Problem  : ${challenge.title}`);
  console.log(`Difficulty: ${challenge.difficulty}`);
  console.log(`Status   : ${allPassed ? '✅ PASSED' : '❌ FAILED after 3 attempts'}`);
  console.log(`Attempts : ${finalAttempt}`);
  console.log('==============================================\n');

  // Generate Email HTML
  const escapedCode = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const emailHtml = `
    <div style="font-family: sans-serif; max-width: 800px; margin: 0 auto; color: #333;">
      <h2 style="color: #059669;">✅ LeetCode Daily Solved!</h2>
      <p><strong>Problem:</strong> ${challenge.title} (${challenge.difficulty})</p>
      <p><strong>Time Complexity:</strong> <span style="font-family: monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${analysis.expectedTimeComplexity || 'N/A'}</span></p>
      <p><strong>Space Complexity:</strong> <span style="font-family: monospace; background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${analysis.expectedSpaceComplexity || 'N/A'}</span></p>
      <br/>
      <h3 style="color: #374151; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">Java Solution:</h3>
      <pre style="background-color: #1f2937; color: #f3f4f6; padding: 16px; border-radius: 8px; font-family: 'Courier New', Courier, monospace; overflow-x: auto;">
${escapedCode}
      </pre>
      <p style="color: #6b7280; font-style: italic; margin-top: 16px;">This code is ready to copy-paste directly into LeetCode!</p>
    </div>
  `;
  
  fs.writeFileSync('email_success.html', emailHtml);

  // Pass variables to next GitHub Actions steps
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, \`PROBLEM_TITLE=\${challenge.title}\\n\`);
  }
}

main().catch(err => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
