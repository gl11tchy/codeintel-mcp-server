import { add, Calculator } from "./math";

export function run(value: number): number {
  const calculator = new Calculator();
  return add(calculator.addToTotal(value), 1);
}
