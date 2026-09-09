import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  // Protect with a secret key so random people can't trigger it
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get('secret');

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000';

    // Step 1: Fetch today's challenge
    const challengeRes = await fetch(`${baseUrl}/api/daily-challenge`);
    const challengeResult = await challengeRes.json();

    if (!challengeResult.success) {
      throw new Error(`Failed to fetch challenge: ${challengeResult.error}`);
    }

    const challenge = challengeResult.data;
    console.log(`[CRON] Fetched: ${challenge.title} (${challenge.difficulty})`);

    // Step 2: Auto-solve it
    const solveRes = await fetch(`${baseUrl}/api/auto-solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problemText: challenge.content,
        challengeInfo: challenge,
      }),
    });

    const solveResult = await solveRes.json();

    if (!solveResult.success) {
      throw new Error(`Failed to auto-solve: ${solveResult.error}`);
    }

    const { allPassed, attempts, finalCode } = solveResult.data;

    console.log(`[CRON] Solved! Passed: ${allPassed}, Attempts: ${attempts}`);

    return NextResponse.json({
      success: true,
      message: `Auto-solve completed for "${challenge.title}"`,
      allPassed,
      attempts,
      title: challenge.title,
      difficulty: challenge.difficulty,
    });

  } catch (error: any) {
    console.error('[CRON] Error:', error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
