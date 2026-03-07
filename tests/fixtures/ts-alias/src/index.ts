import { renderUserCard } from "~components/UserCard";

export function main(): void {
  const card = renderUserCard(42);
  console.log(card);
}
