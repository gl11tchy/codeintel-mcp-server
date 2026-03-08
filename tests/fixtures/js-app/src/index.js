import { add, Calculator } from "./math.js";

export function run() {
  const calculator = new Calculator();
  calculator.addToTotal(2);
  return add(1, 2);
}
