import { NextResponse } from 'next/server';
import { readHistory } from '@/lib/persistence.ts';

export const maxDuration = 30;

/**
 * Recent runs, from Supabase when it is reachable and from the local history file
 * otherwise. Previously these records were written and never read back.
 */
export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 20);
  const history = await readHistory(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20);
  return NextResponse.json({ success: true, data: history });
}
