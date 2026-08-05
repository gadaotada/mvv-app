import {
  EXPRESSION_SYMBOLS,
  EXPRESSION_TOKENS,
  type ExpressionLocation,
  type ExpressionSymbol,
  type ExpressionToken,
  tokenizeExpression,
} from './expression-tokenizer.js';

export const EXPRESSION_NODES = {
  LITERAL: 'literal',
  IDENTIFIER: 'identifier',
  MEMBER: 'member',
  UNARY: 'unary',
  BINARY: 'binary',
  CONDITIONAL: 'conditional',
} as const;

export type UnaryOperator = typeof EXPRESSION_SYMBOLS.NOT | typeof EXPRESSION_SYMBOLS.PLUS | typeof EXPRESSION_SYMBOLS.MINUS;
export type BinaryOperator =
  | typeof EXPRESSION_SYMBOLS.PLUS
  | typeof EXPRESSION_SYMBOLS.MINUS
  | typeof EXPRESSION_SYMBOLS.MULTIPLY
  | typeof EXPRESSION_SYMBOLS.DIVIDE
  | typeof EXPRESSION_SYMBOLS.REMAINDER
  | typeof EXPRESSION_SYMBOLS.LESS_THAN
  | typeof EXPRESSION_SYMBOLS.LESS_THAN_OR_EQUAL
  | typeof EXPRESSION_SYMBOLS.GREATER_THAN
  | typeof EXPRESSION_SYMBOLS.GREATER_THAN_OR_EQUAL
  | typeof EXPRESSION_SYMBOLS.EQUAL
  | typeof EXPRESSION_SYMBOLS.NOT_EQUAL
  | typeof EXPRESSION_SYMBOLS.AND
  | typeof EXPRESSION_SYMBOLS.OR;

export type ExpressionNode = LiteralExpression | IdentifierExpression | MemberExpression | UnaryExpression | BinaryExpression | ConditionalExpression;

export interface LiteralExpression {
  readonly kind: typeof EXPRESSION_NODES.LITERAL;
  readonly value: string | number | boolean | null;
  readonly location: ExpressionLocation;
}

export interface IdentifierExpression {
  readonly kind: typeof EXPRESSION_NODES.IDENTIFIER;
  readonly name: string;
  readonly location: ExpressionLocation;
}

export interface MemberExpression {
  readonly kind: typeof EXPRESSION_NODES.MEMBER;
  readonly object: ExpressionNode;
  readonly property: string;
  readonly location: ExpressionLocation;
}

export interface UnaryExpression {
  readonly kind: typeof EXPRESSION_NODES.UNARY;
  readonly operator: UnaryOperator;
  readonly argument: ExpressionNode;
  readonly location: ExpressionLocation;
}

export interface BinaryExpression {
  readonly kind: typeof EXPRESSION_NODES.BINARY;
  readonly operator: BinaryOperator;
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
  readonly location: ExpressionLocation;
}

export interface ConditionalExpression {
  readonly kind: typeof EXPRESSION_NODES.CONDITIONAL;
  readonly condition: ExpressionNode;
  readonly whenTrue: ExpressionNode;
  readonly whenFalse: ExpressionNode;
  readonly location: ExpressionLocation;
}

export class ExpressionParsingError extends SyntaxError {
  public readonly location: ExpressionLocation;

  public constructor(message: string, location: ExpressionLocation) {
    super(`${message} at expression line ${location.line}, column ${location.column}`);
    this.name = 'ExpressionParsingError';
    this.location = location;
  }
}

export function parseExpression(source: string): ExpressionNode {
  return new ExpressionParser(tokenizeExpression(source)).parse();
}

class ExpressionParser {
  private index = 0;

  public constructor(private readonly tokens: readonly ExpressionToken[]) {}

  public parse(): ExpressionNode {
    const expression = this.parseConditional();
    const token = this.current();
    if (token.kind !== EXPRESSION_TOKENS.END) throw new ExpressionParsingError(`Unexpected token "${formatToken(token)}"`, token.location);
    return expression;
  }

  private parseConditional(): ExpressionNode {
    const condition = this.parseBinary(1);
    if (!this.matchSymbol(EXPRESSION_SYMBOLS.QUESTION)) return condition;

    const whenTrue = this.parseConditional();
    this.consumeSymbol(EXPRESSION_SYMBOLS.COLON);
    const whenFalse = this.parseConditional();
    return { kind: EXPRESSION_NODES.CONDITIONAL, condition, whenTrue, whenFalse, location: condition.location };
  }

  private parseBinary(minimumPrecedence: number): ExpressionNode {
    let left = this.parseUnary();

    while (true) {
      const token = this.current();
      if (token.kind !== EXPRESSION_TOKENS.SYMBOL || !isBinaryOperator(token.value)) return left;

      const precedence = getBinaryPrecedence(token.value);
      if (precedence < minimumPrecedence) return left;

      this.index += 1;
      const right = this.parseBinary(precedence + 1);
      left = { kind: EXPRESSION_NODES.BINARY, operator: token.value, left, right, location: token.location };
    }
  }

  private parseUnary(): ExpressionNode {
    const token = this.current();
    if (token.kind === EXPRESSION_TOKENS.SYMBOL && isUnaryOperator(token.value)) {
      this.index += 1;
      return { kind: EXPRESSION_NODES.UNARY, operator: token.value, argument: this.parseUnary(), location: token.location };
    }

    return this.parseMember();
  }

  private parseMember(): ExpressionNode {
    let expression = this.parsePrimary();

    while (this.matchSymbol(EXPRESSION_SYMBOLS.DOT)) {
      const property = this.current();
      if (property.kind !== EXPRESSION_TOKENS.IDENTIFIER) throw new ExpressionParsingError('Expected a property name after "."', property.location);
      this.index += 1;
      expression = { kind: EXPRESSION_NODES.MEMBER, object: expression, property: property.value, location: expression.location };
    }

    return expression;
  }

  private parsePrimary(): ExpressionNode {
    const token = this.current();

    if (token.kind === EXPRESSION_TOKENS.NUMBER || token.kind === EXPRESSION_TOKENS.STRING || token.kind === EXPRESSION_TOKENS.LITERAL) {
      this.index += 1;
      return { kind: EXPRESSION_NODES.LITERAL, value: token.value, location: token.location };
    }

    if (token.kind === EXPRESSION_TOKENS.IDENTIFIER) {
      this.index += 1;
      return { kind: EXPRESSION_NODES.IDENTIFIER, name: token.value, location: token.location };
    }

    if (this.matchSymbol(EXPRESSION_SYMBOLS.LEFT_PARENTHESIS)) {
      const expression = this.parseConditional();
      this.consumeSymbol(EXPRESSION_SYMBOLS.RIGHT_PARENTHESIS);
      return expression;
    }

    throw new ExpressionParsingError(`Expected an expression but found "${formatToken(token)}"`, token.location);
  }

  private current(): ExpressionToken {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('Expression token stream must end with an end token');
    return token;
  }

  private matchSymbol(symbol: ExpressionSymbol): boolean {
    const token = this.current();
    if (token.kind !== EXPRESSION_TOKENS.SYMBOL || token.value !== symbol) return false;
    this.index += 1;
    return true;
  }

  private consumeSymbol(symbol: ExpressionSymbol): void {
    const token = this.current();
    if (token.kind !== EXPRESSION_TOKENS.SYMBOL || token.value !== symbol) {
      throw new ExpressionParsingError(`Expected "${symbol}" but found "${formatToken(token)}"`, token.location);
    }
    this.index += 1;
  }
}

function isUnaryOperator(symbol: ExpressionSymbol): symbol is UnaryOperator {
  return symbol === EXPRESSION_SYMBOLS.NOT || symbol === EXPRESSION_SYMBOLS.PLUS || symbol === EXPRESSION_SYMBOLS.MINUS;
}

function isBinaryOperator(symbol: ExpressionSymbol): symbol is BinaryOperator {
  return getBinaryPrecedence(symbol) > 0;
}

function getBinaryPrecedence(symbol: ExpressionSymbol): number {
  if (symbol === EXPRESSION_SYMBOLS.OR) return 1;
  if (symbol === EXPRESSION_SYMBOLS.AND) return 2;
  if (symbol === EXPRESSION_SYMBOLS.EQUAL || symbol === EXPRESSION_SYMBOLS.NOT_EQUAL) return 3;
  if (
    symbol === EXPRESSION_SYMBOLS.LESS_THAN ||
    symbol === EXPRESSION_SYMBOLS.LESS_THAN_OR_EQUAL ||
    symbol === EXPRESSION_SYMBOLS.GREATER_THAN ||
    symbol === EXPRESSION_SYMBOLS.GREATER_THAN_OR_EQUAL
  ) {
    return 4;
  }
  if (symbol === EXPRESSION_SYMBOLS.PLUS || symbol === EXPRESSION_SYMBOLS.MINUS) return 5;
  if (symbol === EXPRESSION_SYMBOLS.MULTIPLY || symbol === EXPRESSION_SYMBOLS.DIVIDE || symbol === EXPRESSION_SYMBOLS.REMAINDER) return 6;
  return 0;
}

function formatToken(token: ExpressionToken): string {
  if (token.kind === EXPRESSION_TOKENS.END) return 'end of expression';
  return String(token.value);
}
