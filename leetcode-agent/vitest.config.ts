/**
 * Vitest configuration.
 *
 * Written with CommonJS `module.exports` on purpose: this package has no `"type":
 * "module"`, so Vite loads the config as CommonJS and an ESM `export default` here makes
 * it warn.
 *
 * The `@` alias mirrors tsconfig's `paths`, so tests can import route handlers that use
 * it (`@/lib/...`) the same way Next resolves them.
 */

module.exports = {
  resolve: {
    // Built from __dirname rather than node:path so the file needs no import at all:
    // a `require()` would trip the lint rule, and an `import` would reintroduce the
    // ESM-in-CommonJS warning this file exists to avoid.
    alias: { '@': `${__dirname.replace(/\\/g, '/')}/src` },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
};
