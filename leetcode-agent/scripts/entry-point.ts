import { pathToFileURL } from 'node:url';

/**
 * True when `moduleUrl` belongs to the file Node was asked to run, rather than one that
 * was imported.
 *
 * Comparing `import.meta.url` against a raw `process.argv[1]` looks equivalent but is not:
 * argv holds a filesystem path while import.meta.url is a percent-encoded URL, so any
 * path containing a space (`C:\Users\...\Leetcode AI\...`) never matches and the script
 * exits without doing anything. Converting the path to a URL first makes the comparison
 * exact on every platform.
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
