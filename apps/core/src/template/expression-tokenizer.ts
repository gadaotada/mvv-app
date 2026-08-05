export const EXPRESSION_TOKENS = {
  IDENTIFIER: 'identifier',
  NUMBER: 'number',
  STRING: 'string',
  LITERAL: 'literal',
  SYMBOL: 'symbol',
  END: 'end',
} as const;

export const EXPRESSION_SYMBOLS = {
  DOT: '.',
  LEFT_PARENTHESIS: '(',
  RIGHT_PARENTHESIS: ')',
  QUESTION: '?',
  COLON: ':',
  NOT: '!',
  PLUS: '+',
  MINUS: '-',
  MULTIPLY: '*',
  DIVIDE: '/',
  REMAINDER: '%',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  EQUAL: '===',
  NOT_EQUAL: '!==',
  AND: '&&',
  OR: '||',
} as const;

export interface ExpressionLocation {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export type ExpressionSymbol = (typeof EXPRESSION_SYMBOLS)[keyof typeof EXPRESSION_SYMBOLS];

export type ExpressionToken =
  | { readonly kind: typeof EXPRESSION_TOKENS.IDENTIFIER; readonly value: string; readonly location: ExpressionLocation }
  | { readonly kind: typeof EXPRESSION_TOKENS.NUMBER; readonly value: number; readonly location: ExpressionLocation }
  | { readonly kind: typeof EXPRESSION_TOKENS.STRING; readonly value: string; readonly location: ExpressionLocation }
  | { readonly kind: typeof EXPRESSION_TOKENS.LITERAL; readonly value: boolean | null; readonly location: ExpressionLocation }
  | { readonly kind: typeof EXPRESSION_TOKENS.SYMBOL; readonly value: ExpressionSymbol; readonly location: ExpressionLocation }
  | { readonly kind: typeof EXPRESSION_TOKENS.END; readonly location: ExpressionLocation };

export class ExpressionTokenizationError extends SyntaxError {
  public readonly location: ExpressionLocation;

  public constructor(message: string, location: ExpressionLocation) {
    super(`${message} at expression line ${location.line}, column ${location.column}`);
    this.name = 'ExpressionTokenizationError';
    this.location = location;
  }
}

const SYMBOLS_BY_LENGTH = Object.values(EXPRESSION_SYMBOLS).sort((left, right) => right.length - left.length);

export function tokenizeExpression(source: string): readonly ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const getLocation = (): ExpressionLocation => ({ offset, line, column });
  const advance = (): string | undefined => {
    const character = source[offset];
    if (character === undefined) return undefined;

    offset += 1;
    if (character === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }

    return character;
  };

  while (offset < source.length) {
    const character = source[offset];
    if (character === undefined) break;

    if (/\s/u.test(character)) {
      advance();
      continue;
    }

    const location = getLocation();

    if (isIdentifierStart(character)) {
      const startOffset = offset;
      advance();
      while (isIdentifierPart(source[offset])) advance();

      const value = source.slice(startOffset, offset);
      if (value === 'true') tokens.push({ kind: EXPRESSION_TOKENS.LITERAL, value: true, location });
      else if (value === 'false') tokens.push({ kind: EXPRESSION_TOKENS.LITERAL, value: false, location });
      else if (value === 'null') tokens.push({ kind: EXPRESSION_TOKENS.LITERAL, value: null, location });
      else tokens.push({ kind: EXPRESSION_TOKENS.IDENTIFIER, value, location });
      continue;
    }

    if (isDecimalDigit(character) || (character === EXPRESSION_SYMBOLS.DOT && isDecimalDigit(source[offset + 1]))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
      if (match === null) throw new ExpressionTokenizationError('Invalid number', location);

      const rawValue = match[0];
      for (let index = 0; index < rawValue.length; index += 1) advance();

      const value = Number(rawValue);
      if (!Number.isFinite(value)) throw new ExpressionTokenizationError(`Number is outside the supported range: ${rawValue}`, location);
      tokens.push({ kind: EXPRESSION_TOKENS.NUMBER, value, location });
      continue;
    }

    if (character === "'" || character === '"') {
      tokens.push({ kind: EXPRESSION_TOKENS.STRING, value: readString(character, source, getLocation, advance), location });
      continue;
    }

    const symbol = SYMBOLS_BY_LENGTH.find((candidate) => source.startsWith(candidate, offset));
    if (symbol !== undefined) {
      for (let index = 0; index < symbol.length; index += 1) advance();
      tokens.push({ kind: EXPRESSION_TOKENS.SYMBOL, value: symbol, location });
      continue;
    }

    if (character === '=') throw new ExpressionTokenizationError('Only strict equality operators "===" and "!==" are supported', location);
    throw new ExpressionTokenizationError(`Unexpected character "${character}"`, location);
  }

  tokens.push({ kind: EXPRESSION_TOKENS.END, location: getLocation() });
  return tokens;
}

function readString(
  quote: "'" | '"',
  source: string,
  getLocation: () => ExpressionLocation,
  advance: () => string | undefined,
): string {
  const openingLocation = getLocation();
  let value = '';
  advance();

  while (true) {
    const character = advance();
    if (character === undefined) throw new ExpressionTokenizationError('Unclosed string literal', openingLocation);
    if (character === quote) return value;
    if (character === '\n' || character === '\r') throw new ExpressionTokenizationError('String literals cannot contain unescaped newlines', openingLocation);

    if (character !== '\\') {
      value += character;
      continue;
    }

    const escapeLocation = getLocation();
    const escaped = advance();
    if (escaped === undefined) throw new ExpressionTokenizationError('Unclosed string literal', openingLocation);

    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === 'v') value += '\v';
    else if (escaped === '0') value += '\0';
    else if (escaped === '\\' || escaped === "'" || escaped === '"') value += escaped;
    else if (escaped === 'u') value += readUnicodeEscape(source, getLocation, advance, escapeLocation);
    else throw new ExpressionTokenizationError(`Unsupported escape sequence "\\${escaped}"`, escapeLocation);
  }
}

function readUnicodeEscape(
  source: string,
  getLocation: () => ExpressionLocation,
  advance: () => string | undefined,
  escapeLocation: ExpressionLocation,
): string {
  const startOffset = getLocation().offset;
  for (let index = 0; index < 4; index += 1) advance();

  const hexadecimal = source.slice(startOffset, startOffset + 4);
  if (!/^[0-9A-Fa-f]{4}$/.test(hexadecimal)) throw new ExpressionTokenizationError('Unicode escapes require exactly four hexadecimal digits', escapeLocation);
  return String.fromCharCode(Number.parseInt(hexadecimal, 16));
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isDecimalDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}
