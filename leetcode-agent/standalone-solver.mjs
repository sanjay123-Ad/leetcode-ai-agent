// standalone-solver.mjs
//
// Kept as the stable entry point for GitHub Actions and the Windows scheduler, so the
// workflow command does not change.
//
// The implementation moved to scripts/daily-solve.ts so that CI and the web app run the
// *same* pipeline: previously this file carried its own copy of every prompt and its own
// Judge0 call, and the two drifted apart.
//
// Requires Node 22.18+ or 24+ (native TypeScript support, no build step).

const { run } = await import('./scripts/daily-solve.ts');
await run();
