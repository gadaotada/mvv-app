import { parseExpression, type ExpressionNode } from './expression-parser.js';
import { TEMPLATE_TOKENS, type SourceLocation, type TemplateToken } from './tokenizer.js';

export const TEMPLATE_STATEMENTS = {
  IF: 'if',
  ELSE_IF: 'else-if',
  ELSE: 'else',
  END_IF: 'endif',
  FOR: 'for',
  END_FOR: 'endfor',
  CONTENT: 'content',
} as const;

const RESERVED_LOOP_VARIABLES = new Set(['loop', 'true', 'false', 'null', '__proto__', 'prototype', 'constructor']);

export interface TextNode {
  readonly kind: typeof TEMPLATE_TOKENS.TEXT;
  readonly value: string;
  readonly location: SourceLocation;
}

export interface InterpolationNode {
  readonly kind: typeof TEMPLATE_TOKENS.INTERPOLATION;
  readonly expression: string;
  readonly compiledExpression: ExpressionNode;
  readonly location: SourceLocation;
}

export interface IfBranch {
  readonly condition: string;
  readonly compiledCondition: ExpressionNode;
  readonly body: readonly TemplateNode[];
  readonly location: SourceLocation;
}

export interface IfNode {
  readonly kind: typeof TEMPLATE_STATEMENTS.IF;
  readonly branches: readonly IfBranch[];
  readonly elseBody?: readonly TemplateNode[];
  readonly location: SourceLocation;
}

export interface ForNode {
  readonly kind: typeof TEMPLATE_STATEMENTS.FOR;
  readonly itemName: string;
  readonly iterableExpression: string;
  readonly compiledIterableExpression: ExpressionNode;
  readonly body: readonly TemplateNode[];
  readonly location: SourceLocation;
}

export interface ContentNode {
  readonly kind: typeof TEMPLATE_STATEMENTS.CONTENT;
  readonly location: SourceLocation;
}

export type TemplateNode = TextNode | InterpolationNode | IfNode | ForNode | ContentNode;

export class TemplateParsingError extends SyntaxError {
  public readonly location: SourceLocation;

  public constructor(message: string, location: SourceLocation) {
    super(`${message} at line ${location.line}, column ${location.column}`);
    this.name = 'TemplateParsingError';
    this.location = location;
  }
}

export function parseTemplate(tokens: readonly TemplateToken[]): readonly TemplateNode[] {
  return new TemplateParser(tokens).parse();
}

type Statement =
  | { readonly kind: typeof TEMPLATE_STATEMENTS.IF; readonly condition: string }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.ELSE_IF; readonly condition: string }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.ELSE }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.END_IF }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.FOR; readonly itemName: string; readonly iterableExpression: string }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.END_FOR }
  | { readonly kind: typeof TEMPLATE_STATEMENTS.CONTENT };

type ClosingStatementKind = Extract<
  Statement['kind'],
  typeof TEMPLATE_STATEMENTS.ELSE_IF | typeof TEMPLATE_STATEMENTS.ELSE | typeof TEMPLATE_STATEMENTS.END_IF | typeof TEMPLATE_STATEMENTS.END_FOR
>;

class TemplateParser {
  private index = 0;

  public constructor(private readonly tokens: readonly TemplateToken[]) {}

  public parse(): readonly TemplateNode[] {
    return this.parseNodes(new Set());
  }

  private parseNodes(closingStatements: ReadonlySet<ClosingStatementKind>): readonly TemplateNode[] {
    const nodes: TemplateNode[] = [];

    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (token === undefined) break;

      if (token.kind === TEMPLATE_TOKENS.TEXT) {
        nodes.push({ kind: TEMPLATE_TOKENS.TEXT, value: token.value, location: token.location });
        this.index += 1;
        continue;
      }

      if (token.kind === TEMPLATE_TOKENS.INTERPOLATION) {
        if (token.value.length === 0) throw new TemplateParsingError('Interpolation cannot be empty', token.location);

        nodes.push({
          kind: TEMPLATE_TOKENS.INTERPOLATION,
          expression: token.value,
          compiledExpression: compileExpression(token.value, token.location),
          location: token.location,
        });
        this.index += 1;
        continue;
      }

      const statement = parseStatement(token);
      if (isClosingStatement(statement) && closingStatements.has(statement.kind)) return nodes;

      if (statement.kind === TEMPLATE_STATEMENTS.IF) {
        this.index += 1;
        nodes.push(this.parseIf(statement.condition, token.location));
        continue;
      }

      if (statement.kind === TEMPLATE_STATEMENTS.FOR) {
        this.index += 1;
        nodes.push(this.parseFor(statement, token.location));
        continue;
      }

      if (statement.kind === TEMPLATE_STATEMENTS.CONTENT) {
        nodes.push({ kind: TEMPLATE_STATEMENTS.CONTENT, location: token.location });
        this.index += 1;
        continue;
      }

      throw new TemplateParsingError(`Unexpected "${formatStatement(statement)}" statement`, token.location);
    }

    return nodes;
  }

  private parseIf(condition: string, location: SourceLocation): IfNode {
    const branches: IfBranch[] = [];
    let branchCondition = condition;
    let branchLocation = location;

    while (true) {
      const body = this.parseNodes(new Set([TEMPLATE_STATEMENTS.ELSE_IF, TEMPLATE_STATEMENTS.ELSE, TEMPLATE_STATEMENTS.END_IF]));
      branches.push({ condition: branchCondition, compiledCondition: compileExpression(branchCondition, branchLocation), body, location: branchLocation });

      const closingToken = this.tokens[this.index];
      if (closingToken === undefined) throw new TemplateParsingError('Unclosed "if" statement; expected "endif"', location);
      if (closingToken.kind !== TEMPLATE_TOKENS.STATEMENT) throw new TemplateParsingError('Unclosed "if" statement; expected "endif"', location);

      const closingStatement = parseStatement(closingToken);
      if (closingStatement.kind === TEMPLATE_STATEMENTS.ELSE_IF) {
        branchCondition = closingStatement.condition;
        branchLocation = closingToken.location;
        this.index += 1;
        continue;
      }

      if (closingStatement.kind === TEMPLATE_STATEMENTS.ELSE) {
        this.index += 1;
        const elseBody = this.parseNodes(new Set([TEMPLATE_STATEMENTS.END_IF]));
        this.consumeClosingStatement(TEMPLATE_STATEMENTS.END_IF, location, TEMPLATE_STATEMENTS.IF);
        return { kind: TEMPLATE_STATEMENTS.IF, branches, elseBody, location };
      }

      if (closingStatement.kind === TEMPLATE_STATEMENTS.END_IF) {
        this.index += 1;
        return { kind: TEMPLATE_STATEMENTS.IF, branches, location };
      }

      throw new TemplateParsingError('Unclosed "if" statement; expected "endif"', location);
    }
  }

  private parseFor(statement: Extract<Statement, { readonly kind: typeof TEMPLATE_STATEMENTS.FOR }>, location: SourceLocation): ForNode {
    const body = this.parseNodes(new Set([TEMPLATE_STATEMENTS.END_FOR]));
    this.consumeClosingStatement(TEMPLATE_STATEMENTS.END_FOR, location, TEMPLATE_STATEMENTS.FOR);

    return {
      kind: TEMPLATE_STATEMENTS.FOR,
      itemName: statement.itemName,
      iterableExpression: statement.iterableExpression,
      compiledIterableExpression: compileExpression(statement.iterableExpression, location),
      body,
      location,
    };
  }

  private consumeClosingStatement(
    expectedKind: Extract<ClosingStatementKind, typeof TEMPLATE_STATEMENTS.END_IF | typeof TEMPLATE_STATEMENTS.END_FOR>,
    openingLocation: SourceLocation,
    openingKind: typeof TEMPLATE_STATEMENTS.IF | typeof TEMPLATE_STATEMENTS.FOR,
  ): void {
    const token = this.tokens[this.index];
    if (token === undefined || token.kind !== TEMPLATE_TOKENS.STATEMENT) {
      throw new TemplateParsingError(`Unclosed "${openingKind}" statement; expected "${expectedKind}"`, openingLocation);
    }

    const statement = parseStatement(token);
    if (statement.kind !== expectedKind) {
      throw new TemplateParsingError(`Expected "${expectedKind}" but found "${formatStatement(statement)}"`, token.location);
    }

    this.index += 1;
  }
}

function parseStatement(token: Extract<TemplateToken, { readonly kind: typeof TEMPLATE_TOKENS.STATEMENT }>): Statement {
  const value = token.value;

  if (value === TEMPLATE_STATEMENTS.ELSE) return { kind: TEMPLATE_STATEMENTS.ELSE };
  if (value === TEMPLATE_STATEMENTS.END_IF) return { kind: TEMPLATE_STATEMENTS.END_IF };
  if (value === TEMPLATE_STATEMENTS.END_FOR) return { kind: TEMPLATE_STATEMENTS.END_FOR };
  if (value === TEMPLATE_STATEMENTS.CONTENT) return { kind: TEMPLATE_STATEMENTS.CONTENT };

  const elseIfMatch = /^else\s+if(?:\s+([\s\S]+))?$/.exec(value);
  if (elseIfMatch !== null) {
    const condition = elseIfMatch[1]?.trim();
    if (condition === undefined || condition.length === 0) throw new TemplateParsingError('"else if" requires a condition', token.location);
    return { kind: TEMPLATE_STATEMENTS.ELSE_IF, condition };
  }

  const ifMatch = /^if(?:\s+([\s\S]+))?$/.exec(value);
  if (ifMatch !== null) {
    const condition = ifMatch[1]?.trim();
    if (condition === undefined || condition.length === 0) throw new TemplateParsingError('"if" requires a condition', token.location);
    return { kind: TEMPLATE_STATEMENTS.IF, condition };
  }

  if (/^for(?:\s|$)/.test(value)) {
    const forMatch = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/.exec(value);
    const itemName = forMatch?.[1];
    const iterableExpression = forMatch?.[2]?.trim();
    if (itemName === undefined || iterableExpression === undefined || iterableExpression.length === 0) {
      throw new TemplateParsingError('Expected "for <item> in <iterable>"', token.location);
    }
    if (RESERVED_LOOP_VARIABLES.has(itemName)) throw new TemplateParsingError(`Loop variable "${itemName}" is reserved`, token.location);

    return { kind: TEMPLATE_STATEMENTS.FOR, itemName, iterableExpression };
  }

  throw new TemplateParsingError(`Unknown statement "${value}"`, token.location);
}

function isClosingStatement(statement: Statement): statement is Extract<Statement, { readonly kind: ClosingStatementKind }> {
  return (
    statement.kind === TEMPLATE_STATEMENTS.ELSE_IF ||
    statement.kind === TEMPLATE_STATEMENTS.ELSE ||
    statement.kind === TEMPLATE_STATEMENTS.END_IF ||
    statement.kind === TEMPLATE_STATEMENTS.END_FOR
  );
}

function formatStatement(statement: Statement): string {
  if (statement.kind === TEMPLATE_STATEMENTS.ELSE_IF) return 'else if';
  return statement.kind;
}

function compileExpression(source: string, location: SourceLocation): ExpressionNode {
  try {
    return parseExpression(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new TemplateParsingError(`Invalid expression "${source}": ${error.message}`, location);
  }
}
