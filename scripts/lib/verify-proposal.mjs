// Shared offline verification of an ISOLATED Prisma proposal.
//
// Nothing here touches a database, a credential or the active application
// schema. It proves three things for the proposal it is given:
//
//   1. The proposal is valid for the ACTUALLY INSTALLED Prisma CLI.
//   2. The client it generates exposes the delegate surface the durable
//      contract depends on (models, fields, nullability, uniqueness inputs,
//      enum values).
//   3. Generating it does NOT touch the active schema or the active generated
//      client — the client is generated into a temporary directory that is
//      removed afterwards.
//
// The caller supplies the expectations; this module owns the mechanics.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Stable hash of a file or directory tree (path + content), for tamper detection. */
export function hashTree(target) {
  const hash = createHash('sha256');
  if (!existsSync(target)) return 'missing';
  if (!statSync(target).isDirectory()) {
    hash.update(readFileSync(target));
    return hash.digest('hex');
  }
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${entry.name}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`f:${entry.name}:${statSync(full).size}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(target);
  return hash.digest('hex');
}

/**
 * Verify one isolated proposal.
 *
 * @param {object} options
 * @param {string} options.root            The repository root.
 * @param {string} options.proposalDir     The proposal directory (relative to root).
 * @param {string} options.activeSchema    The active schema path (relative to root).
 * @param {string} options.activeClientDir The active generated client (relative to root).
 * @param {string[]} options.delegates     Delegate accessors the client must expose.
 * @param {Record<string, string[]>} options.fields   Fields each generated model must have.
 * @param {Record<string, string[]>} options.nullable Fields that must be nullable.
 * @param {Record<string, string[]>} options.uniques  Compound unique where-inputs per model.
 * @param {string[]} options.enumValues    Enum values the generated client must contain.
 * @param {string[]} options.isolationModels Models that must NOT exist in the active schema.
 * @param {string} options.label           A human label for the report.
 */
export function verifyProposal(options) {
  const {
    root,
    proposalDir,
    activeSchema,
    activeClientDir,
    delegates,
    fields,
    nullable = {},
    uniques = {},
    enumValues = [],
    isolationModels,
    label,
  } = options;

  const proposalSchema = join(root, proposalDir, 'schema.prisma');
  const activeSchemaPath = join(root, activeSchema);
  const activeClientPath = join(root, activeClientDir);
  const prismaBin = join(root, 'node_modules', '.bin', 'prisma7');

  const problems = [];
  const notes = [];

  function fail(message) {
    problems.push(message);
  }

  function runPrisma(args) {
    return execFileSync(prismaBin, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (!existsSync(proposalSchema)) {
    return { notes, problems: [`Proposal schema not found: ${proposalSchema}`] };
  }
  if (!existsSync(prismaBin)) {
    return { notes, problems: [`Prisma CLI not found at ${prismaBin}. Run "npm ci" first.`] };
  }

  const clientHashBefore = hashTree(activeClientPath);
  const activeSchemaHashBefore = hashTree(activeSchemaPath);

  // 1. The proposal must validate with the installed Prisma CLI.
  try {
    runPrisma(['validate', '--schema', proposalSchema]);
    notes.push('prisma validate: OK');
  } catch (error) {
    fail(`prisma validate failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }

  // 2. Generate the client into a TEMPORARY isolated directory.
  const tempRoot = mkdtempSync(join(tmpdir(), `${label}-proposal-`));
  const tempProposal = join(tempRoot, label);
  const generatedDir = join(tempProposal, 'generated');

  try {
    cpSync(join(root, proposalDir), tempProposal, { recursive: true });
    try {
      runPrisma(['generate', '--schema', join(tempProposal, 'schema.prisma')]);
      notes.push('prisma generate (temporary output): OK');
    } catch (error) {
      fail(`prisma generate failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
    }

    // 3. The generated delegate surface must match the durable contract.
    if (!existsSync(generatedDir)) {
      fail('the generated client directory is missing — generation did not run');
    } else {
      const classFile = join(generatedDir, 'internal', 'class.ts');
      const classText = existsSync(classFile) ? readFileSync(classFile, 'utf8') : '';
      for (const delegate of delegates) {
        if (!classText.includes(`get ${delegate}(`)) {
          fail(`generated client has no delegate accessor for "${delegate}"`);
        }
      }

      const enumsFile = join(generatedDir, 'enums.ts');
      const enumsText = existsSync(enumsFile) ? readFileSync(enumsFile, 'utf8') : '';
      for (const value of enumValues) {
        if (!enumsText.includes(`${value}: '${value}'`)) {
          fail(`generated enums are missing the value ${value}`);
        }
      }

      for (const [model, modelFields] of Object.entries(fields)) {
        const modelFile = join(generatedDir, 'models', `${model}.ts`);
        if (!existsSync(modelFile)) {
          fail(`generated client is missing the model file for ${model}`);
          continue;
        }
        const modelText = readFileSync(modelFile, 'utf8');
        for (const field of modelFields) {
          if (!new RegExp(`\\b${field}[?]?:`).test(modelText)) {
            fail(`generated model ${model} has no field "${field}"`);
          }
        }
        for (const field of nullable[model] ?? []) {
          if (!new RegExp(`\\b${field}: [^;\\n]*\\| null`).test(modelText)) {
            fail(`generated model ${model}.${field} is not nullable, but the contract requires null`);
          }
        }
      }

      for (const [model, whereKeys] of Object.entries(uniques)) {
        const modelFile = join(generatedDir, 'models', `${model}.ts`);
        if (!existsSync(modelFile)) continue;
        const modelText = readFileSync(modelFile, 'utf8');
        for (const whereKey of whereKeys) {
          if (!modelText.includes(`${whereKey}?:`)) {
            fail(`generated model ${model} has no compound unique where-input "${whereKey}"`);
          }
        }
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }

  // 4. The active schema and the active client must be untouched.
  if (hashTree(activeClientPath) !== clientHashBefore) {
    fail('the ACTIVE generated client changed while verifying the proposal');
  } else {
    notes.push('active generated client: unchanged');
  }

  if (hashTree(activeSchemaPath) !== activeSchemaHashBefore) {
    fail('the ACTIVE schema changed while verifying the proposal');
  } else {
    notes.push('active schema: unchanged');
  }

  const activeSchemaText = readFileSync(activeSchemaPath, 'utf8');
  for (const model of isolationModels) {
    if (new RegExp(`^model ${model}\\b`, 'm').test(activeSchemaText)) {
      fail(`the active schema already contains model ${model} — the proposal is no longer isolated`);
    }
  }
  notes.push('proposal isolation: confirmed (no proposal model in the active schema)');

  return { notes, problems };
}
