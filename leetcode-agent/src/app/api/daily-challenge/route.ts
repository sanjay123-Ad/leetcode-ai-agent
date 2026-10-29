import { NextResponse } from 'next/server';
import { fetchDailyChallenge, LeetCodeUnavailableError, toLegacyChallengeShape } from '@/lib/leetcode.ts';

export const maxDuration = 60;

/**
 * Today's official LeetCode daily challenge.
 *
 * The response keeps every field the previous version returned and adds the official
 * interface contract (`javaSnippet`, `metaData`), the parsed constraints, the example
 * outputs and a `provenance` block saying where each piece came from.
 */
export async function GET() {
  try {
    const problem = await fetchDailyChallenge();
    return NextResponse.json({ success: true, data: toLegacyChallengeShape(problem) });
  } catch (error) {
    const unavailable = error instanceof LeetCodeUnavailableError;
    const message = error instanceof Error ? error.message : 'Failed to fetch the daily challenge';
    console.error('[daily-challenge]', message);
    return NextResponse.json({ success: false, error: message }, { status: unavailable ? 503 : 500 });
  }
}
