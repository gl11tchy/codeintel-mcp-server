import { getUserById, formatUserName } from "@/lib/helpers";

export function renderUserCard(id: number): string {
  const name = getUserById(id);
  const formatted = formatUserName("John", "Doe");
  return `<div>${name} - ${formatted}</div>`;
}
