import { EXPRESSION_NODES, type BinaryOperator, type ExpressionNode, type UnaryOperator } from './expression-parser.js';
import { EXPRESSION_SYMBOLS, type ExpressionLocation } from './expression-tokenizer.js';

export interface ExpressionScope {
  readonly values: object;
  readonly parent?: ExpressionScope;
}

export class ExpressionEvaluationError extends Error {
  public readonly location: ExpressionLocation;

  public constructor(message: string, location: ExpressionLocation) {
    super(message);
    this.name = 'ExpressionEvaluationError';
    this.location = location;
  }
}

const BLOCKED_PROPERTIES = new Set(['__proto__', 'prototype', 'constructor']);

export function evaluateExpression(expression: ExpressionNode, scope: ExpressionScope): unknown {
  if (expression.kind === EXPRESSION_NODES.LITERAL) return expression.value;
  if (expression.kind === EXPRESSION_NODES.IDENTIFIER) return resolveIdentifier(expression.name, scope, expression.location);

  if (expression.kind === EXPRESSION_NODES.MEMBER) {
    const object = evaluateExpression(expression.object, scope);
    return resolveProperty(object, expression.property, expression.location);
  }

  if (expression.kind === EXPRESSION_NODES.UNARY) {
    return evaluateUnary(expression.operator, evaluateExpression(expression.argument, scope), expression.location);
  }

  if (expression.kind === EXPRESSION_NODES.BINARY) {
    if (expression.operator === EXPRESSION_SYMBOLS.AND) {
      const left = evaluateExpression(expression.left, scope);
      return isTruthy(left) ? evaluateExpression(expression.right, scope) : left;
    }
    if (expression.operator === EXPRESSION_SYMBOLS.OR) {
      const left = evaluateExpression(expression.left, scope);
      return isTruthy(left) ? left : evaluateExpression(expression.right, scope);
    }

    return evaluateBinary(expression.operator, evaluateExpression(expression.left, scope), evaluateExpression(expression.right, scope), expression.location);
  }

  return isTruthy(evaluateExpression(expression.condition, scope))
    ? evaluateExpression(expression.whenTrue, scope)
    : evaluateExpression(expression.whenFalse, scope);
}

export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

function resolveIdentifier(name: string, scope: ExpressionScope, location: ExpressionLocation): unknown {
  assertSafeProperty(name, location);

  let currentScope: ExpressionScope | undefined = scope;
  while (currentScope !== undefined) {
    if (Object.hasOwn(currentScope.values, name)) return Reflect.get(currentScope.values, name);
    currentScope = currentScope.parent;
  }

  throw new ExpressionEvaluationError(`Unknown template value "${name}"`, location);
}

function resolveProperty(value: unknown, property: string, location: ExpressionLocation): unknown {
  assertSafeProperty(property, location);

  if ((typeof value !== 'object' || value === null) && typeof value !== 'string') {
    throw new ExpressionEvaluationError(`Cannot read property "${property}" from ${describeValue(value)}`, location);
  }

  if (typeof value === 'string') {
    if (property === 'length') return value.length;
    throw new ExpressionEvaluationError(`String property "${property}" is not available`, location);
  }

  if (!Object.hasOwn(value, property)) throw new ExpressionEvaluationError(`Unknown property "${property}"`, location);
  return Reflect.get(value, property);
}

function assertSafeProperty(property: string, location: ExpressionLocation): void {
  if (BLOCKED_PROPERTIES.has(property)) throw new ExpressionEvaluationError(`Property "${property}" is not available in templates`, location);
}

function evaluateUnary(operator: UnaryOperator, value: unknown, location: ExpressionLocation): unknown {
  if (operator === EXPRESSION_SYMBOLS.NOT) return !isTruthy(value);

  const number = requireNumber(value, location, `Unary "${operator}"`);
  return operator === EXPRESSION_SYMBOLS.MINUS ? -number : number;
}

function evaluateBinary(operator: BinaryOperator, left: unknown, right: unknown, location: ExpressionLocation): unknown {
  if (operator === EXPRESSION_SYMBOLS.EQUAL) return left === right;
  if (operator === EXPRESSION_SYMBOLS.NOT_EQUAL) return left !== right;

  if (operator === EXPRESSION_SYMBOLS.PLUS) {
    if (typeof left === 'number' && typeof right === 'number') return left + right;
    if (typeof left === 'string' && typeof right === 'string') return left + right;
    throw new ExpressionEvaluationError('Operator "+" requires two numbers or two strings', location);
  }

  if (operator === EXPRESSION_SYMBOLS.MINUS) return requireNumber(left, location, 'Left operand') - requireNumber(right, location, 'Right operand');
  if (operator === EXPRESSION_SYMBOLS.MULTIPLY) return requireNumber(left, location, 'Left operand') * requireNumber(right, location, 'Right operand');
  if (operator === EXPRESSION_SYMBOLS.DIVIDE) return requireNumber(left, location, 'Left operand') / requireNumber(right, location, 'Right operand');
  if (operator === EXPRESSION_SYMBOLS.REMAINDER) return requireNumber(left, location, 'Left operand') % requireNumber(right, location, 'Right operand');

  if (typeof left === 'number' && typeof right === 'number') return compare(operator, left, right);
  if (typeof left === 'string' && typeof right === 'string') return compare(operator, left, right);
  throw new ExpressionEvaluationError(`Operator "${operator}" requires two numbers or two strings of the same type`, location);
}

function compare(operator: BinaryOperator, left: number | string, right: number | string): boolean {
  if (operator === EXPRESSION_SYMBOLS.LESS_THAN) return left < right;
  if (operator === EXPRESSION_SYMBOLS.LESS_THAN_OR_EQUAL) return left <= right;
  if (operator === EXPRESSION_SYMBOLS.GREATER_THAN) return left > right;
  return left >= right;
}

function requireNumber(value: unknown, location: ExpressionLocation, label: string): number {
  if (typeof value === 'number') return value;
  throw new ExpressionEvaluationError(`${label} must be a number`, location);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}
