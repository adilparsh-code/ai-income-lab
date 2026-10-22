// ============================================================================
// PRISMA SCHEMA PARSER (small, offline, no Prisma engine)
// ============================================================================
// A deliberately tiny structural reader for Prisma schema files.
//
// It understands exactly what the durable contract checkers need — model
// names, field names, scalar types, nullability, list-ness, ids, uniques,
// indexes and relations — and ignores everything else. It is NOT a Prisma
// parser and does not pretend to be one: it never loads the Prisma engine,
// never touches a database, and never needs the network.
//
// It exists so that a REVIEWED PROPOSAL can be checked against the contract
// the runtime code depends on, offline, in a unit test.
// ============================================================================

export interface FieldContract {
  name: string;
  /** The Prisma scalar/enum type as written in the schema. */
  type: string;
  /** True when the field is nullable (`Type?`) in the proposal. */
  optional: boolean;
}

export interface RelationContract {
  /** The field that holds the relation. */
  name: string;
  /** The model it points at. */
  model: string;
  /** True for a list relation (`Model[]`). */
  isList: boolean;
  /** True when the relation field itself is optional. */
  optional: boolean;
}

export interface ModelContract {
  name: string;
  fields: FieldContract[];
  relations: RelationContract[];
  /** Compound unique constraints, each as an ordered list of field names. */
  uniques: string[][];
}

export interface ParsedField {
  name: string;
  type: string;
  optional: boolean;
  isList: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefault: boolean;
  relation?: { model: string; fields: string[]; references: string[]; onDelete?: string };
}

export interface ParsedModel {
  name: string;
  fields: Map<string, ParsedField>;
  uniques: string[][];
  indexes: string[][];
}

export interface ParsedEnum {
  name: string;
  values: string[];
}

/**
 * Whether a model carries a uniqueness constraint over exactly these columns.
 *
 * A single-column unique may be written either as the field attribute
 * (`@unique`) or as a one-element block (`@@unique([col])`); both mean the
 * same thing to the database, so both satisfy the contract.
 */
export function hasUnique(model: ParsedModel, columns: string[]): boolean {
  const asBlock = model.uniques.some(
    (candidate) =>
      candidate.length === columns.length && candidate.every((col, index) => col === columns[index]),
  );
  if (asBlock) return true;
  if (columns.length !== 1) return false;
  return model.fields.get(columns[0])?.isUnique === true;
}

/**
 * Parse the `enum` blocks of a Prisma schema.
 *
 * Same scope as the model parser: structural only, no Prisma engine.
 */
export function parsePrismaEnums(schemaText: string): Map<string, ParsedEnum> {
  const enums = new Map<string, ParsedEnum>();
  const lines = schemaText.split(/\r?\n/).map(stripComment);

  let current: ParsedEnum | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!current) {
      const match = /^enum\s+(\w+)\s*\{/.exec(line);
      if (match) current = { name: match[1], values: [] };
      continue;
    }
    if (line === '}') {
      enums.set(current.name, current);
      current = null;
      continue;
    }
    if (!line) continue;
    const value = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (value) current.values.push(value[1]);
  }

  return enums;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function bracketList(text: string | null): string[] {
  if (!text) return [];
  const match = /\[([^\]]*)\]/.exec(text);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function attributeArgs(statement: string, name: string): string | null {
  const index = statement.indexOf(`@${name}(`);
  if (index < 0) return null;
  let depth = 0;
  const start = index + name.length + 2;
  for (let i = start; i < statement.length; i += 1) {
    if (statement[i] === '(') depth += 1;
    else if (statement[i] === ')') {
      if (depth === 0) return statement.slice(start, i);
      depth -= 1;
    }
  }
  return null;
}

/**
 * Parse the `model` blocks of a Prisma schema into a structural summary.
 *
 * Deliberately small: it understands exactly what the contract needs (field
 * names, types, nullability, list-ness, ids, uniques, relations) and ignores
 * everything else. It is not a Prisma parser and does not pretend to be one.
 */
export function parsePrismaModels(schemaText: string): Map<string, ParsedModel> {
  const models = new Map<string, ParsedModel>();
  const lines = schemaText.split(/\r?\n/).map(stripComment);

  let current: ParsedModel | null = null;
  let buffer = '';
  let depth = 0;

  const flush = (): void => {
    const statement = buffer.replace(/\s+/g, ' ').trim();
    buffer = '';
    if (!statement || !current) return;

    if (statement.startsWith('@@')) {
      const uniqueArgs = statement.startsWith('@@unique') ? attributeArgs(statement, 'unique') : null;
      const indexArgs = statement.startsWith('@@index') ? attributeArgs(statement, 'index') : null;
      const args = uniqueArgs ?? indexArgs;
      if (!args) return;
      const columns = bracketList(args);
      if (uniqueArgs) current.uniques.push(columns);
      else current.indexes.push(columns);
      return;
    }

    const match = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(statement);
    if (!match) return;
    const [, name, type, list, optional, attributes = ''] = match;

    const relationArgs = attributeArgs(attributes, 'relation');
    if (relationArgs) {
      const modelName = type;
      current.fields.set(name, {
        name,
        type: modelName,
        optional: Boolean(optional),
        isList: Boolean(list),
        isId: false,
        isUnique: false,
        hasDefault: false,
        relation: {
          model: modelName,
          fields: bracketList(/fields\s*:\s*\[[^\]]*\]/.exec(relationArgs)?.[0] ?? null),
          references: bracketList(/references\s*:\s*\[[^\]]*\]/.exec(relationArgs)?.[0] ?? null),
          onDelete: /onDelete\s*:\s*(\w+)/.exec(relationArgs)?.[1],
        },
      });
      return;
    }

    current.fields.set(name, {
      name,
      type,
      optional: Boolean(optional),
      isList: Boolean(list),
      isId: /(^|\s)@id(\s|\(|$)/.test(attributes),
      isUnique: /(^|\s)@unique(\s|\(|$)/.test(attributes),
      hasDefault: /(^|\s)@default(\s|\(|$)/.test(attributes),
    });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!current) {
      const match = /^model\s+(\w+)\s*\{/.exec(line);
      if (match) {
        current = {
          name: match[1],
          fields: new Map<string, ParsedField>(),
          uniques: [],
          indexes: [],
        };
        buffer = '';
        depth = 0;
      }
      continue;
    }
    if (line === '}') {
      flush();
      models.set(current.name, current);
      current = null;
      continue;
    }
    buffer += (buffer ? ' ' : '') + line;
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (depth <= 0) flush();
  }

  return models;
}
