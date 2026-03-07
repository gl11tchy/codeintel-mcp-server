export function add(left, right) {
  return left + right;
}

export function multiply(left, right) {
  return left * right;
}

export class Calculator {
  constructor() {
    this.total = 0;
  }

  addToTotal(value) {
    this.total = add(this.total, value);
    return this.total;
  }
}
