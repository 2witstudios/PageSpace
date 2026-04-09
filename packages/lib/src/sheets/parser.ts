/**
 * @module @pagespace/lib/sheets/parser
 * @description Formula tokenizer and parser
 */

import type {
  Token,
  TokenType,
  OperatorToken,
  ASTNode,
  SheetExternalReferenceToken,
} from './types';
import { cellRegex, numberRegex } from './address';

/**
 * Tokenize a formula string into tokens
 */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < formula.length) {
    const char = formula[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    // Handle page references @[PageName]:A1
    if (char === '@' && formula[index + 1] === '[') {
      let end = index + 2;
      let label = '';
      while (end < formula.length && formula[end] !== ']') {
        label += formula[end];
        end += 1;
      }
      if (end >= formula.length) {
        throw new Error('Unterminated page reference');
      }

      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        throw new Error('Page reference label cannot be empty');
      }

      let cursor = end + 1;
      let identifier: string | undefined;
      let mentionType: string | undefined;
      let rawSuffix = '';

      if (formula[cursor] === '(') {
        cursor += 1;
        let metaEnd = cursor;
        while (metaEnd < formula.length && formula[metaEnd] !== ')') {
          metaEnd += 1;
        }
        if (metaEnd >= formula.length) {
          throw new Error('Unterminated page reference identifier');
        }
        const metaContent = formula.slice(cursor, metaEnd).trim();
        rawSuffix = metaContent ? `(${metaContent})` : '';
        if (metaContent) {
          const colonIndex = metaContent.indexOf(':');
          if (colonIndex === -1) {
            identifier = metaContent.trim();
          } else {
            identifier = metaContent.slice(0, colonIndex).trim();
            const typePart = metaContent.slice(colonIndex + 1).trim();
            if (typePart) {
              mentionType = typePart;
            }
          }
        }
        cursor = metaEnd + 1;
      }

      const rawMention = `@[${trimmedLabel}]${rawSuffix}`;
      const pageMeta: SheetExternalReferenceToken = {
        raw: rawMention,
        label: trimmedLabel,
        normalizedLabel: trimmedLabel.toLowerCase(),
        identifier: identifier && identifier.length > 0 ? identifier : undefined,
        mentionType: mentionType,
      };
      tokens.push({ type: 'page', value: rawMention, meta: { page: pageMeta } });
      index = cursor;
      continue;
    }

    // Handle string literals
    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < formula.length && formula[end] !== '"') {
        value += formula[end];
        end += 1;
      }
      if (end >= formula.length) {
        throw new Error('Unterminated string literal');
      }
      tokens.push({ type: 'string', value });
      index = end + 1;
      continue;
    }

    // Handle numbers
    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[0-9.]/.test(formula[end])) {
        end += 1;
      }
      const value = formula.slice(index, end);
      if (!numberRegex.test(value)) {
        throw new Error(`Invalid number literal: ${value}`);
      }
      tokens.push({ type: 'number', value });
      index = end;
      continue;
    }

    // Handle absolute references starting with $
    if (char === '$') {
      let end = index + 1;
      while (end < formula.length && /[A-Za-z]/.test(formula[end])) {
        end += 1;
      }
      if (end > index + 1) {
        if (end < formula.length && formula[end] === '$') {
          end += 1;
        }
        const digitStart = end;
        while (end < formula.length && /[0-9]/.test(formula[end])) {
          end += 1;
        }
        if (end > digitStart) {
          const stripped = formula.slice(index, end).replace(/\$/g, '').toUpperCase();
          if (cellRegex.test(stripped)) {
            tokens.push({ type: 'cell', value: stripped });
            index = end;
            continue;
          }
        }
      }
      throw new Error(`Unexpected character '${char}' in formula`);
    }

    // Handle identifiers and cell references
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < formula.length && /[A-Za-z0-9_]/.test(formula[end])) {
        end += 1;
      }
      const raw = formula.slice(index, end);
      const upper = raw.toUpperCase();

      // Check for cell reference with absolute row (e.g., A$1)
      if (!cellRegex.test(upper) && /^[A-Z]+$/.test(upper) && end < formula.length && formula[end] === '$') {
        let absEnd = end + 1;
        while (absEnd < formula.length && /[0-9]/.test(formula[absEnd])) {
          absEnd += 1;
        }
        if (absEnd > end + 1) {
          const stripped = upper + formula.slice(end + 1, absEnd);
          if (cellRegex.test(stripped)) {
            tokens.push({ type: 'cell', value: stripped });
            index = absEnd;
            continue;
          }
        }
      }

      if (cellRegex.test(upper)) {
        tokens.push({ type: 'cell', value: upper });
      } else if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'boolean', value: upper });
      } else {
        tokens.push({ type: 'identifier', value: upper });
      }
      index = end;
      continue;
    }

    // Handle parentheses
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    // Handle commas
    if (char === ',') {
      tokens.push({ type: 'comma', value: char });
      index += 1;
      continue;
    }

    // Handle colons
    if (char === ':') {
      tokens.push({ type: 'colon', value: char });
      index += 1;
      continue;
    }

    // Handle comparison operators
    if (char === '<' || char === '>' || char === '=') {
      const next = formula[index + 1];
      if (char === '<' && next === '=') {
        tokens.push({ type: 'operator', value: '<=' });
        index += 2;
        continue;
      }
      if (char === '>' && next === '=') {
        tokens.push({ type: 'operator', value: '>=' });
        index += 2;
        continue;
      }
      if (char === '<' && next === '>') {
        tokens.push({ type: 'operator', value: '<>' });
        index += 2;
        continue;
      }
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    // Handle arithmetic operators and concatenation
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^' || char === '&') {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unexpected character '${char}' in formula`);
  }

  return tokens;
}

/**
 * Formula parser - converts tokens to AST
 */
export class FormulaParser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode {
    const expression = this.parseComparison();
    if (!this.isAtEnd()) {
      throw new Error('Unexpected tokens after end of formula');
    }
    return expression;
  }

  private parseComparison(): ASTNode {
    let node = this.parseConcatenation();

    while (this.matchOperator('=', '>', '<', '>=', '<=', '<>')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseConcatenation();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseConcatenation(): ASTNode {
    let node = this.parseAddition();

    while (this.matchOperator('&')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseAddition();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseAddition(): ASTNode {
    let node = this.parseMultiplication();

    while (this.matchOperator('+', '-')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseMultiplication();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseMultiplication(): ASTNode {
    let node = this.parseExponent();

    while (this.matchOperator('*', '/')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseExponent();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseExponent(): ASTNode {
    let node = this.parseUnary();

    while (this.matchOperator('^')) {
      const operator = this.previous().value as OperatorToken;
      const right = this.parseUnary();
      node = {
        type: 'BinaryExpression',
        operator,
        left: node,
        right,
      };
    }

    return node;
  }

  private parseUnary(): ASTNode {
    if (this.matchOperator('+', '-')) {
      const operator = this.previous().value as '+' | '-';
      const argument = this.parseUnary();
      return {
        type: 'UnaryExpression',
        operator,
        argument,
      };
    }

    return this.parseRange();
  }

  private parseRange(): ASTNode {
    const left = this.parsePrimary();

    if (this.match('colon')) {
      const right = this.parsePrimary();
      if (left.type !== 'CellReference' || right.type !== 'CellReference') {
        throw new Error('Range references must use cell addresses');
      }
      return {
        type: 'Range',
        start: left,
        end: right,
      };
    }

    return left;
  }

  private parsePrimary(): ASTNode {
    if (this.match('number')) {
      return {
        type: 'NumberLiteral',
        value: Number(this.previous().value),
      };
    }

    if (this.match('string')) {
      return {
        type: 'StringLiteral',
        value: this.previous().value,
      };
    }

    if (this.match('boolean')) {
      return {
        type: 'BooleanLiteral',
        value: this.previous().value === 'TRUE',
      };
    }

    if (this.match('page')) {
      const token = this.previous();
      const meta = token.meta?.page as SheetExternalReferenceToken | undefined;
      if (!meta) {
        throw new Error('Invalid page reference');
      }
      this.consume('colon', ':', 'Expected ":" after page reference');
      const start = this.parseCellReference();
      if (this.match('colon')) {
        const end = this.parseCellReference();
        return {
          type: 'ExternalRange',
          page: meta,
          start,
          end,
        };
      }
      return {
        type: 'ExternalCellReference',
        page: meta,
        reference: start.reference,
      };
    }

    if (this.match('cell')) {
      return {
        type: 'CellReference',
        reference: this.previous().value,
      };
    }

    if (this.match('identifier')) {
      const name = this.previous().value;
      if (!this.matchSpecific('paren', '(')) {
        throw new Error(`Unexpected identifier '${name}'`);
      }
      const args: ASTNode[] = [];
      if (!this.check('paren', ')')) {
        do {
          args.push(this.parseComparison());
        } while (this.match('comma'));
      }
      this.consume('paren', ')', `Expected closing parenthesis for ${name}()`);
      return {
        type: 'FunctionCall',
        name,
        args,
      };
    }

    if (this.matchSpecific('paren', '(')) {
      const expr = this.parseComparison();
      this.consume('paren', ')', 'Expected closing parenthesis');
      return expr;
    }

    throw new Error('Unexpected end of formula');
  }

  private parseCellReference(): { type: 'CellReference'; reference: string } {
    if (this.match('cell')) {
      return {
        type: 'CellReference',
        reference: this.previous().value,
      };
    }
    throw new Error('Expected cell reference after page reference');
  }

  private match(...types: TokenType[]): boolean {
    for (const type of types) {
      if (this.check(type)) {
        this.advance();
        return true;
      }
    }
    return false;
  }

  private matchSpecific(type: TokenType, value: string): boolean {
    if (this.check(type, value)) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchOperator(...operators: OperatorToken[]): boolean {
    if (!this.check('operator')) {
      return false;
    }
    const token = this.peek();
    if (operators.includes(token.value as OperatorToken)) {
      this.advance();
      return true;
    }
    return false;
  }

  private consume(type: TokenType, value: string, message: string): Token {
    if (this.check(type, value)) {
      return this.advance();
    }
    throw new Error(message);
  }

  private check(type: TokenType, value?: string): boolean {
    if (this.isAtEnd()) {
      return false;
    }
    const token = this.peek();
    if (token.type !== type) {
      return false;
    }
    if (value !== undefined) {
      return token.value === value;
    }
    return true;
  }

  private advance(): Token {
    if (!this.isAtEnd()) {
      this.position += 1;
    }
    return this.previous();
  }

  private isAtEnd(): boolean {
    return this.position >= this.tokens.length;
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private previous(): Token {
    return this.tokens[this.position - 1];
  }
}
