import { formatGreeting } from "../lib/format";

type GreeterProps = {
  name: string;
};

export function Greeter({ name }: GreeterProps) {
  return <section>{formatGreeting(name)}</section>;
}
