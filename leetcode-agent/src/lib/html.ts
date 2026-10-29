/**
 * HTML -> plain text for LeetCode problem statements.
 *
 * The previous `stripHtml` decoded six entities and dropped all block structure, so the
 * model received ten literal `&rarr;` tokens with examples glued to constraints
 * (audit finding C10). Statement structure is exactly what the model needs most.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  rarr: '->', larr: '<-', harr: '<->', rArr: '=>', lArr: '<=',
  le: '<=', ge: '>=', ne: '!=', minus: '-', plus: '+', times: '*', divide: '/',
  hellip: '...', mdash: '-', ndash: '-', lsquo: "'", rsquo: "'",
  ldquo: '"', rdquo: '"', middot: '.', bull: '*', deg: ' degrees',
  infin: 'infinity', sum: 'sum', prod: 'product', radic: 'sqrt',
  equiv: '==', approx: '~=', plusmn: '+/-', sdot: '*',
  alpha: 'alpha', beta: 'beta', sup2: '^2', sup3: '^3', frac12: '1/2',
  ouml: 'o', eacute: 'e', copy: '(c)', reg: '(r)',
};

/** Decodes named and numeric HTML entities, including the ones LeetCode uses in examples. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match: string, name: string) => {
      const direct = NAMED_ENTITIES[name];
      if (direct !== undefined) return direct;
      const lower = NAMED_ENTITIES[name.toLowerCase()];
      return lower !== undefined ? lower : match;
    });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  // Zero-width and bidi control characters appear in LeetCode statements and add
  // nothing but token cost and confusing diffs.
  if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x2060) return '';
  if (code === 0xa0) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// `li` is handled separately: its opening tag already starts a new line, so closing it
// must not add a second one (that would put a blank line between every bullet).
const BLOCK_TAGS = [
  'p', 'div', 'ul', 'ol', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'table', 'tr', 'section', 'article',
];

/**
 * Converts a problem statement to text while preserving the line structure of
 * examples, bullet lists and constraint blocks.
 */
export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ');

  for (const tag of BLOCK_TAGS) {
    text = text.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '\n');
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi'), '\n');
  }

  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts the `Output: ...` values from a statement, in document order.
 *
 * These are the only expected values available without submitting to LeetCode. When the
 * count does not match the official inputs the caller must degrade to "unverified"
 * rather than invent an oracle.
 */
export function extractExampleOutputs(statementText: string): string[] {
  const outputs: string[] = [];
  const lines = statementText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*Output:?\s*(.*)$/i.exec(lines[i]);
    if (!match) continue;

    let value = match[1].trim();

    // Design problems label the block `Output` on its own line with the value underneath,
    // and matrices are sometimes wrapped across several lines. Keep consuming lines until
    // the value is non-empty and its brackets balance.
    for (let j = i + 1; j < lines.length && (!value || !isBalanced(value)); j++) {
      const next = lines[j].trim();
      if (/^(Input|Output|Explanation|Example|Constraints)\b/i.test(next)) break;
      if (!next) {
        // A blank line ends a value that is already complete; otherwise keep looking.
        if (value) break;
        i = j;
        continue;
      }
      value = value ? `${value} ${next}` : next;
      i = j;
    }

    if (value) outputs.push(value.replace(/\s+/g, ' ').trim());
  }

  return outputs;
}

/** Pulls the `Constraints:` block out of a statement, if present. */
export function extractConstraints(statementText: string): string {
  const match = /\n\s*Constraints:?\s*\n([\s\S]*?)(?:\n\s*(?:Follow[- ]?up|Note|Example)\b|$)/i.exec(
    `\n${statementText}`,
  );
  return match ? match[1].trim() : '';
}

function isBalanced(value: string): boolean {
  let square = 0;
  let curly = 0;
  for (const char of value) {
    if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
  }
  return square === 0 && curly === 0;
}
