/**
 * A small, deterministic Java *declaration* parser.
 *
 * This exists because the agent must decide, without asking an LLM and without trusting
 * one, whether generated code implements LeetCode's official interface. A naive regex
 * cannot do that: it trips over generics (`Map<String, List<Integer>>`), C-style array
 * declarators (`int nums[]`), varargs, annotations, nested classes, strings containing
 * braces, and comments containing code.
 *
 * So the source is first masked (comments and literals replaced by spaces of equal
 * length, which keeps every index valid), then scanned structurally with brace/angle
 * depth tracking. Only declarations are parsed — method *bodies* are deliberately opaque,
 * because `javac` is the right tool for those and runs later in the pipeline.
 */

export type ParsedParam = {
  type: string;
  name: string;
  varargs: boolean;
};

export type ParsedMember = {
  kind: 'method' | 'constructor';
  name: string;
  returnType: string;
  modifiers: string[];
  typeParameters: string;
  params: ParsedParam[];
  /** True when the declaration has a `{ ... }` body (as opposed to `;`). */
  hasBody: boolean;
  /** Body source with the outer braces removed; empty string when there is no body. */
  body: string;
};

export type ParsedType = {
  kind: 'class' | 'interface' | 'enum' | 'record';
  name: string;
  modifiers: string[];
  /** Nesting level: 0 for a top-level type. */
  depth: number;
  bodyStart: number;
  bodyEnd: number;
  members: ParsedMember[];
};

const MODIFIERS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'native', 'strictfp', 'transient', 'volatile', 'default', 'sealed', 'non-sealed',
]);

/**
 * Replaces comments and string/char literal contents with spaces, preserving length so
 * that every offset computed on the masked text is valid in the original too.
 */
export function maskSource(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (two === '/*') {
      let j = i + 2;
      while (j < n && src.slice(j, j + 2) !== '*/') j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      // Text blocks ("""...""") are rare in LeetCode answers but cheap to support.
      if (quote === '"' && src.slice(i, i + 3) === '"""') {
        let j = i + 3;
        while (j < n && src.slice(j, j + 3) !== '"""') j++;
        blank(i + 3, Math.min(j, n));
        i = Math.min(j + 3, n);
        continue;
      }
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote || src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }

  return out.join('');
}

/** Index of the brace matching the `{` at `open`, or -1. */
function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the paren matching the `(` at `open`, or -1. */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function normalizeType(raw: string): string {
  let type = raw
    .replace(/\s+/g, ' ')
    .replace(/@\w+(\([^)]*\))?/g, '')
    .replace(/\bfinal\b/g, '')
    .trim();

  // `java.util.List<Integer>` and `List<Integer>` are the same contract.
  type = type.replace(/\b(?:java\.util|java\.lang|java\.math)\.(?=[A-Z])/g, '');
  // `int [ ]` -> `int[]`, `List < Integer , String >` -> `List<Integer,String>`
  type = type
    .replace(/\s*\[\s*\]\s*/g, '[]')
    .replace(/\s*<\s*/g, '<')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim();

  return type;
}

/** Splits a parameter list on commas that are not inside generics or parentheses. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthSquare = 0;
  let current = '';

  for (const char of text) {
    if (char === '<') depthAngle++;
    else if (char === '>') depthAngle--;
    else if (char === '(') depthParen++;
    else if (char === ')') depthParen--;
    else if (char === '[') depthSquare++;
    else if (char === ']') depthSquare--;

    if (char === separator && depthAngle === 0 && depthParen === 0 && depthSquare === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseParams(listText: string): ParsedParam[] {
  const trimmed = listText.trim();
  if (!trimmed) return [];

  return splitTopLevel(trimmed).map((part) => {
    let text = part.replace(/@\w+(\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim();
    const varargs = /\.\.\./.test(text);
    text = text.replace(/\.\.\./g, '');

    // The parameter name is the last identifier; everything before it is the type.
    const match = /^([\s\S]*?)([A-Za-z_$][\w$]*)\s*((?:\[\s*\])*)\s*$/.exec(text);
    if (!match) return { type: normalizeType(text), name: '', varargs };

    const [, typePart, name, trailingArrays] = match;
    // C-style declarator: `int nums[]` means the type is `int[]`.
    const type = normalizeType(`${typePart}${trailingArrays ?? ''}`) + (varargs ? '[]' : '');
    return { type: normalizeType(type), name, varargs };
  });
}

/** Parses the text before a `(` into modifiers, type parameters, return type and name. */
function parseDeclarationHead(head: string): { modifiers: string[]; typeParameters: string; returnType: string; name: string } | undefined {
  let text = head.replace(/@\w+(\([^)]*\))?/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;

  const modifiers: string[] = [];
  // Leading modifiers.
  for (;;) {
    const match = /^([A-Za-z_$][\w$-]*)\s+/.exec(text);
    if (!match || !MODIFIERS.has(match[1])) break;
    modifiers.push(match[1]);
    text = text.slice(match[0].length);
  }

  // Generic method type parameters, e.g. `<T extends Comparable<T>>`.
  let typeParameters = '';
  if (text.startsWith('<')) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '<') depth++;
      else if (text[i] === '>') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > 0) {
      typeParameters = text.slice(0, end + 1);
      text = text.slice(end + 1).trim();
    }
  }

  // Remaining modifiers can follow the type parameters in legal (if unusual) Java.
  for (;;) {
    const match = /^([A-Za-z_$][\w$-]*)\s+/.exec(text);
    if (!match || !MODIFIERS.has(match[1])) break;
    modifiers.push(match[1]);
    text = text.slice(match[0].length);
  }

  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/.exec(text);
  if (!nameMatch) return undefined;

  const name = nameMatch[1];
  const returnType = normalizeType(text.slice(0, nameMatch.index));
  return { modifiers, typeParameters, returnType, name };
}

const TYPE_KEYWORDS = ['class', 'interface', 'enum', 'record'] as const;

/**
 * Finds every type declaration (including nested ones) and the members declared directly
 * in each body.
 */
export function parseJava(source: string): ParsedType[] {
  const masked = maskSource(source);
  const types: ParsedType[] = [];

  const walk = (from: number, to: number, depth: number) => {
    let i = from;

    while (i < to) {
      const char = masked[i];

      // Skip whole method/initializer bodies that are not type declarations.
      if (char === '{') {
        const close = matchBrace(masked, i);
        i = close < 0 ? to : close + 1;
        continue;
      }

      const keyword = TYPE_KEYWORDS.find(
        (kw) =>
          masked.startsWith(kw, i) &&
          /[\s{]/.test(masked[i + kw.length] ?? ' ') &&
          !/[\w$.]/.test(masked[i - 1] ?? ' '),
      );

      if (!keyword) { i++; continue; }

      const nameMatch = /^\s+([A-Za-z_$][\w$]*)/.exec(masked.slice(i + keyword.length));
      if (!nameMatch) { i += keyword.length; continue; }

      const bodyStart = masked.indexOf('{', i + keyword.length);
      if (bodyStart < 0) break;
      const bodyEnd = matchBrace(masked, bodyStart);
      if (bodyEnd < 0) break;

      // Modifiers precede the keyword, after the previous statement boundary.
      const headStart = Math.max(
        masked.lastIndexOf(';', i), masked.lastIndexOf('{', i), masked.lastIndexOf('}', i), from - 1,
      ) + 1;
      const modifiers = masked
        .slice(headStart, i)
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => MODIFIERS.has(token));

      const type: ParsedType = {
        kind: keyword,
        name: nameMatch[1],
        modifiers,
        depth,
        bodyStart: bodyStart + 1,
        bodyEnd,
        members: parseMembers(source, masked, bodyStart + 1, bodyEnd),
      };
      types.push(type);

      // Recurse into the body for nested types.
      walk(bodyStart + 1, bodyEnd, depth + 1);
      i = bodyEnd + 1;
    }
  };

  walk(0, masked.length, 0);
  return types;
}

function parseMembers(source: string, masked: string, from: number, to: number): ParsedMember[] {
  const members: ParsedMember[] = [];
  let i = from;
  let segmentStart = from;

  while (i < to) {
    const char = masked[i];

    // A nested type declaration: skip its body so its members are not attributed here.
    const keyword = TYPE_KEYWORDS.find(
      (kw) =>
        masked.startsWith(kw, i) &&
        /[\s{]/.test(masked[i + kw.length] ?? ' ') &&
        !/[\w$.]/.test(masked[i - 1] ?? ' '),
    );
    if (keyword) {
      const bodyStart = masked.indexOf('{', i + keyword.length);
      const bodyEnd = bodyStart >= 0 ? matchBrace(masked, bodyStart) : -1;
      if (bodyEnd < 0 || bodyEnd > to) break;
      i = bodyEnd + 1;
      segmentStart = i;
      continue;
    }

    if (char === ';' || char === '}') {
      i++;
      segmentStart = i;
      continue;
    }

    if (char === '=') {
      // Field initialiser: skip to the end of the statement so `new HashMap<>()` is not
      // mistaken for a declaration.
      while (i < to && masked[i] !== ';') {
        if (masked[i] === '{') {
          const close = matchBrace(masked, i);
          i = close < 0 ? to : close + 1;
          continue;
        }
        i++;
      }
      segmentStart = i + 1;
      i++;
      continue;
    }

    if (char === '{') {
      // Static/instance initialiser block.
      const close = matchBrace(masked, i);
      i = close < 0 ? to : close + 1;
      segmentStart = i;
      continue;
    }

    if (char !== '(') { i++; continue; }

    const closeParen = matchParen(masked, i);
    if (closeParen < 0 || closeParen > to) break;

    const head = masked.slice(segmentStart, i);
    const parsedHead = parseDeclarationHead(head);
    if (!parsedHead) { i = closeParen + 1; segmentStart = i; continue; }

    const paramsText = source.slice(i + 1, closeParen);
    let cursor = closeParen + 1;
    // Skip `throws ...` before the body or semicolon.
    while (cursor < to && masked[cursor] !== '{' && masked[cursor] !== ';') cursor++;

    const hasBody = masked[cursor] === '{';
    let body = '';
    let next = cursor + 1;
    if (hasBody) {
      const bodyEnd = matchBrace(masked, cursor);
      if (bodyEnd < 0) break;
      body = source.slice(cursor + 1, bodyEnd);
      next = bodyEnd + 1;
    }

    const isConstructor = parsedHead.returnType === '';
    members.push({
      kind: isConstructor ? 'constructor' : 'method',
      name: parsedHead.name,
      returnType: parsedHead.returnType,
      modifiers: parsedHead.modifiers,
      typeParameters: parsedHead.typeParameters,
      params: parseParams(paramsText),
      hasBody,
      body,
    });

    i = next;
    segmentStart = next;
  }

  return members;
}

/** Convenience: renders a member as a canonical signature string for messages. */
export function formatSignature(member: { name: string; returnType?: string; params: { type: string }[] }): string {
  const params = member.params.map((p) => p.type).join(', ');
  return member.returnType ? `${member.returnType} ${member.name}(${params})` : `${member.name}(${params})`;
}

/** True when a method body contains no statements. */
export function isEmptyBody(body: string): boolean {
  return maskSource(body).replace(/[\s;]/g, '').length === 0;
}
