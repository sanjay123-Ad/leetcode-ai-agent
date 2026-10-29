/**
 * Vitest configuration.
 *
 * Written with CommonJS `module.exports` on purpose: this package has no `"type":
 * "module"`, so Vite loads the config as CommonJS and an ESM `export default` here makes
 * it warn. The tested modules all use relative imports, so no path alias is needed.
 */

module.exports = {
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
};
