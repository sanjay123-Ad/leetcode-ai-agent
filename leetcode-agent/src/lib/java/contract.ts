/**
 * The interface contract gate.
 *
 * LeetCode rejects a perfectly correct algorithm if the method name, parameter types,
 * order, return type or class shape differ from its template by one character. The
 * official Java snippet is therefore treated as immutable: it defines the contract, the
 * model only fills in the body, and this module decides — deterministically, with no LLM
 * involved — whether what came back still satisfies it.
 *
 * Violations are specific enough to drive a repair prompt ("you wrote `findTwoSum`,
 * the contract requires `twoSum`") instead of a vague "try again".
 */

import { parseJava, formatSignature, isEmptyBody, normalizeType, maskSource, type ParsedMember } from './parse.ts';
import {
  isDesignMetaData,
  type JavaContract,
  type JavaMethodContract,
  type ProblemMetaData,
  type SignatureValidation,
  type SignatureViolation,
} from '../types.ts';

/** Types the JDK provides; anything else referenced by a signature is a LeetCode helper class. */
const KNOWN_TYPES = new Set([
  'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
  'Boolean', 'Byte', 'Character', 'Short', 'Integer', 'Long', 'Float', 'Double',
  'String', 'StringBuilder', 'StringBuffer', 'Object', 'Number', 'CharSequence',
  'List', 'ArrayList', 'LinkedList', 'Map', 'HashMap', 'TreeMap', 'LinkedHashMap',
  'Set', 'HashSet', 'TreeSet', 'LinkedHashSet', 'Collection', 'Iterable', 'Iterator',
  'Queue', 'Deque', 'ArrayDeque', 'PriorityQueue', 'Stack', 'Optional', 'Comparable',
  'Comparator', 'BigInteger', 'BigDecimal', 'Entry', 'Random', 'T', 'E', 'K', 'V',
]);

/** Collects the non-JDK types a contract references, i.e. the helper classes a harness must define. */
function collectHelpers(methods: JavaMethodContract[]): string[] {
  const helpers = new Set<string>();
  for (const method of methods) {
    for (const type of [method.returnType, ...method.paramTypes]) {
      // Every identifier in the type matters, including nested generic arguments:
      // `List<List<TreeNode>>` needs TreeNode.
      for (const name of normalizeType(type).match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (!KNOWN_TYPES.has(name) && /^[A-Z]/.test(name)) helpers.add(name);
      }
    }
  }
  return [...helpers];
}

export class ContractError extends Error {}

/**
 * Builds the contract from LeetCode's official Java snippet.
 * `metaData` is used only to cross-check what the snippet says — the snippet wins.
 */
export function buildContract(javaSnippet: string, metaData?: ProblemMetaData): JavaContract {
  const types = parseJava(javaSnippet).filter((t) => t.depth === 0 && t.kind === 'class');
  if (types.length === 0) {
    throw new ContractError('The official Java snippet contains no top-level class declaration.');
  }

  const expectedName = metaData
    ? isDesignMetaData(metaData)
      ? metaData.classname
      : 'Solution'
    : undefined;

  const named = expectedName ? types.find((t) => t.name === expectedName) : undefined;
  const primary = named ?? types[0];

  const methods: JavaMethodContract[] = primary.members
    .filter((member) => member.kind === 'method' || member.kind === 'constructor')
    .map((member) => toMethodContract(member, primary.name));

  const hasConstructor = methods.some((m) => m.isConstructor);
  const kind: JavaContract['kind'] =
    metaData && isDesignMetaData(metaData) ? 'design' : hasConstructor ? 'design' : 'algorithm';

  return {
    className: primary.name,
    kind,
    methods,
    requiredHelpers: collectHelpers(methods),
    source: javaSnippet.trim(),
  };
}

function toMethodContract(member: ParsedMember, className: string): JavaMethodContract {
  const isConstructor = member.kind === 'constructor' && member.name === className;
  return {
    name: member.name,
    returnType: isConstructor ? '' : member.returnType,
    paramTypes: member.params.map((p) => p.type),
    paramNames: member.params.map((p) => p.name),
    modifiers: member.modifiers,
    isConstructor,
  };
}

function sameParams(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((type, i) => type === actual[i]);
}

/**
 * Compares generated Java against the official contract.
 *
 * This never executes anything and never consults a model, so it is free and can run
 * before spending Judge0 quota (and before anything is labelled submission-ready).
 */
export function validateSignature(generatedCode: string, contract: JavaContract): SignatureValidation {
  const violations: SignatureViolation[] = [];
  const code = generatedCode.trim();

  if (!code) {
    return { valid: false, violations: [{ code: 'unparseable', message: 'No code was produced.' }], observed: { methods: [] } };
  }

  if (/^\s*package\s+[\w.]+\s*;/m.test(maskSource(code))) {
    violations.push({
      code: 'package_declaration',
      message: 'The solution declares a package. LeetCode submissions must not have a package declaration.',
    });
  }

  const allTypes = parseJava(code);
  if (allTypes.length === 0) {
    return {
      valid: false,
      violations: [{ code: 'unparseable', message: 'No Java type declaration could be parsed from the generated output.' }],
      observed: { methods: [] },
    };
  }

  const topLevel = allTypes.filter((t) => t.depth === 0);
  const target = topLevel.find((t) => t.name === contract.className) ?? allTypes.find((t) => t.name === contract.className);

  if (!target) {
    const names = topLevel.map((t) => t.name);
    violations.push({
      code: names.length > 0 ? 'wrong_class_name' : 'missing_class',
      message:
        names.length > 0
          ? `The contract requires class "${contract.className}" but the solution declares ${names.map((n) => `"${n}"`).join(', ')}.`
          : `The contract requires class "${contract.className}", which is missing.`,
      expected: contract.className,
      actual: names.join(', '),
    });
    return { valid: false, violations, observed: { className: names[0], methods: [] } };
  }

  const observedMethods = target.members.map((member) => toMethodContract(member, target.name));

  // More than one *public* top-level class cannot compile in a single file.
  const publicTopLevel = topLevel.filter((t) => t.modifiers.includes('public'));
  if (publicTopLevel.length > 1) {
    violations.push({
      code: 'extra_public_class',
      message: `Only one public top-level class is allowed per file, found: ${publicTopLevel.map((t) => t.name).join(', ')}.`,
    });
  }

  // Redefining a LeetCode helper type collides with the definition the judge (and our
  // harness) already provides.
  for (const helper of contract.requiredHelpers) {
    if (topLevel.some((t) => t.name === helper)) {
      violations.push({
        code: 'redefines_helper',
        message: `The solution redefines the helper class "${helper}". LeetCode already defines it; remove the duplicate definition.`,
        actual: helper,
      });
    }
  }

  if (target.members.some((m) => m.name === 'main' && m.modifiers.includes('static'))) {
    violations.push({
      code: 'unexpected_main',
      message: 'The solution declares a main() method. LeetCode solutions must not include one.',
    });
  }

  for (const required of contract.methods) {
    const label = required.isConstructor
      ? `${contract.className}(${required.paramTypes.join(', ')})`
      : formatSignature({ name: required.name, returnType: required.returnType, params: required.paramTypes.map((t) => ({ type: t })) });

    const sameName = observedMethods.filter((m) =>
      required.isConstructor ? m.isConstructor : !m.isConstructor && m.name === required.name,
    );

    if (sameName.length === 0) {
      if (required.isConstructor) {
        // A zero-argument constructor may legitimately be left implicit.
        if (required.paramTypes.length > 0) {
          violations.push({
            code: 'missing_constructor',
            message: `Missing required constructor ${label}.`,
            expected: label,
          });
        }
        continue;
      }

      // The headline failure mode: right algorithm, renamed method.
      const renamed = observedMethods.find(
        (m) => !m.isConstructor && m.returnType === required.returnType && sameParams(required.paramTypes, m.paramTypes),
      );
      if (renamed) {
        violations.push({
          code: 'wrong_method_name',
          message: `Method must be named "${required.name}", but the solution defines "${renamed.name}" with the same signature.`,
          expected: required.name,
          actual: renamed.name,
        });
      } else {
        violations.push({
          code: 'missing_method',
          message: `Missing required method ${label}. Methods found: ${
            observedMethods.filter((m) => !m.isConstructor).map((m) => formatSignature({ name: m.name, returnType: m.returnType, params: m.paramTypes.map((t) => ({ type: t })) })).join('; ') || 'none'
          }.`,
          expected: label,
        });
      }
      continue;
    }

    // With overloads, an exact match on parameter types is what counts.
    const exact = sameName.find((m) => sameParams(required.paramTypes, m.paramTypes));
    if (!exact) {
      const byCount = sameName.find((m) => m.paramTypes.length === required.paramTypes.length);
      if (byCount) {
        violations.push({
          code: 'wrong_param_types',
          message: `${label} has the wrong parameter types or order: expected (${required.paramTypes.join(', ')}), found (${byCount.paramTypes.join(', ')}).`,
          expected: required.paramTypes.join(', '),
          actual: byCount.paramTypes.join(', '),
        });
      } else {
        violations.push({
          code: 'wrong_param_count',
          message: `${label} expects ${required.paramTypes.length} parameter(s), found ${sameName[0].paramTypes.length}.`,
          expected: String(required.paramTypes.length),
          actual: String(sameName[0].paramTypes.length),
        });
      }
      continue;
    }

    if (!required.isConstructor && exact.returnType !== required.returnType) {
      violations.push({
        code: 'wrong_return_type',
        message: `Method "${required.name}" must return ${required.returnType}, but returns ${exact.returnType || '(nothing)'}.`,
        expected: required.returnType,
        actual: exact.returnType,
      });
    }

    if (required.modifiers.includes('public') && !exact.modifiers.includes('public')) {
      violations.push({
        code: 'not_public',
        message: `${required.isConstructor ? 'Constructor' : `Method "${required.name}"`} must be declared public.`,
        expected: 'public',
        actual: exact.modifiers.join(' ') || '(package-private)',
      });
    }

    const member = target.members.find(
      (m) =>
        m.name === exact.name &&
        sameParams(exact.paramTypes, m.params.map((p) => p.type)),
    );
    // An empty constructor body can be legitimate; an empty method body means the
    // template came back unimplemented.
    if (!required.isConstructor && member && member.hasBody && isEmptyBody(member.body)) {
      violations.push({
        code: 'empty_body',
        message: `${required.isConstructor ? 'Constructor' : `Method "${required.name}"`} has an empty body — the template was returned unimplemented.`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    observed: { className: target.name, methods: observedMethods },
  };
}

/** A precise, contract-preserving instruction block for the repair prompt. */
export function describeViolationsForRepair(validation: SignatureValidation, contract: JavaContract): string {
  const lines = validation.violations.map((v, i) => `${i + 1}. [${v.code}] ${v.message}`);
  return [
    'The generated code does not satisfy the official LeetCode Java interface.',
    '',
    'Required interface (copy these declarations exactly, do not rename or re-type anything):',
    '```java',
    contract.source,
    '```',
    '',
    'Problems to fix:',
    ...lines,
  ].join('\n');
}

/** Short, user-facing summary of a contract. */
export function describeContract(contract: JavaContract): string {
  const parts = contract.methods.map((m) =>
    m.isConstructor
      ? `${contract.className}(${m.paramTypes.join(', ')})`
      : `${m.returnType} ${m.name}(${m.paramTypes.join(', ')})`,
  );
  return `${contract.kind === 'design' ? 'design' : 'algorithm'} class ${contract.className}: ${parts.join('; ')}`;
}
