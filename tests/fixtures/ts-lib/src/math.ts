export function add(left: number, right: number): number {
  return left + right;
}

export function multiply(left: number, right: number): number {
  return left * right;
}

export class Calculator {
  total = 0;

  addToTotal(value: number): number {
    this.total = add(this.total, value);
    return this.total;
  }
}

export const VERSION = "1.0.0";
