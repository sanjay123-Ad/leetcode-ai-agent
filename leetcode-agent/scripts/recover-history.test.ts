/**
 * Recovery parsers for the 2026-10-15..28 gap.
 *
 * The rule under test: recovered rows must claim only what their source actually proves.
 * A log has no solution text, and the old pipeline's self-certified "PASSED" is not a
 * verification result.
 */

import { describe, expect, it } from 'vitest';
import { parseLegacyEmail, parseLegacyLog, toRecoveredRecord } from './recover-history.ts';

const LEGACY_LOG = `2026-10-20T07:50:01.1234567Z ##[group]Run node standalone-solver.mjs
2026-10-20T07:50:02.0000000Z 🤖 AI LeetCode Agent starting...
2026-10-20T07:50:03.0000000Z 📥 Fetching daily challenge...
2026-10-20T07:50:04.0000000Z 📌 Today's problem: Sum of Sortable Integers (Hard)
2026-10-20T07:50:40.0000000Z ✅ ALL TESTS PASSED on attempt 1!
2026-10-20T07:50:41.0000000Z ⚠️  Supabase error: TypeError: fetch failed
2026-10-20T07:50:41.1000000Z 📊 FINAL RESULT
2026-10-20T07:50:41.2000000Z Problem  : Sum of Sortable Integers
2026-10-20T07:50:41.3000000Z Difficulty: Hard
2026-10-20T07:50:41.4000000Z Status   : ✅ PASSED
2026-10-20T07:50:41.5000000Z Attempts : 1
`;

const LEGACY_EMAIL = `<div style="font-family: sans-serif;">
  <h2 style="color: #059669;">✅ LeetCode Daily Solved!</h2>
  <p><strong>Problem:</strong> Sum of Sortable Integers (Hard)</p>
  <p><strong>Time Complexity:</strong> <span>O(n log n)</span></p>
  <h3>Java Solution:</h3>
  <pre style="background:#1f2937;">
class Solution {
    public int sumOfSortable(int[] nums) {
        return nums.length &gt; 0 ? nums[0] : 0;
    }
}
  </pre>
</div>`;

describe('parseLegacyLog', () => {
  it('extracts what a log actually preserves', () => {
    const run = parseLegacyLog(LEGACY_LOG, 'oct20.log');
    expect(run).toMatchObject({
      date: '2026-10-20',
      title: 'Sum of Sortable Integers',
      difficulty: 'Hard',
      attempts: 1,
      legacyClaimedPass: true,
      sourceLabel: 'recovered-from-logs',
    });
  });

  it('does not invent a solution that the log never contained', () => {
    expect(parseLegacyLog(LEGACY_LOG)?.solutionCode).toBeUndefined();
  });

  it('records a failed legacy run as failed', () => {
    const run = parseLegacyLog(LEGACY_LOG.replace('✅ PASSED', '❌ FAILED after 3 attempts'));
    expect(run?.legacyClaimedPass).toBe(false);
  });

  it('returns undefined for an unrelated log', () => {
    expect(parseLegacyLog('just some build output')).toBeUndefined();
  });
});

describe('parseLegacyEmail', () => {
  it('extracts the problem and the emailed solution', () => {
    const run = parseLegacyEmail(LEGACY_EMAIL, 'oct20.html');
    expect(run).toMatchObject({ title: 'Sum of Sortable Integers', difficulty: 'Hard', sourceLabel: 'recovered-from-email' });
    expect(run?.solutionCode).toContain('class Solution');
    // Entities in the stored HTML must come back as real Java.
    expect(run?.solutionCode).toContain('nums.length > 0');
    expect(run?.solutionCode).not.toContain('&gt;');
  });

  it('ignores a pre block that is not code', () => {
    const run = parseLegacyEmail(LEGACY_EMAIL.replace(/<pre[\s\S]*?<\/pre>/, '<pre>no code here</pre>'));
    expect(run?.solutionCode).toBeUndefined();
  });

  it('returns undefined for an unrelated email', () => {
    expect(parseLegacyEmail('<p>your package has shipped</p>')).toBeUndefined();
  });
});

describe('toRecoveredRecord', () => {
  it('marks the row as recovered and unverified, never accepted', () => {
    const record = toRecoveredRecord(parseLegacyEmail(LEGACY_EMAIL, 'oct20.html')!);

    expect(record.source).toBe('recovered-from-email');
    expect(record.verification_status).toBe('legacy_unverified');
    expect(record.title_slug).toBe('sum-of-sortable-integers');
    expect(record.recovery_note).toMatch(/success email/);
    expect(JSON.stringify(record)).not.toContain('leetcode_accepted');
  });

  it('says plainly when no solution text was available', () => {
    const record = toRecoveredRecord(parseLegacyLog(LEGACY_LOG, 'oct20.log')!);
    expect(record.solution_code).toBeUndefined();
    expect(record.recovery_note).toMatch(/No solution text was available/);
    expect(record.recovery_note).toMatch(/self-certified/);
  });

  it('derives a stable execution id so re-running recovery cannot duplicate rows', () => {
    const run = parseLegacyLog(LEGACY_LOG, 'oct20.log')!;
    expect(toRecoveredRecord(run).execution_id).toBe(toRecoveredRecord(run).execution_id);
    expect(toRecoveredRecord(run).execution_id).toBe('recovered-2026-10-20-sum-of-sortable-integers');
  });
});
