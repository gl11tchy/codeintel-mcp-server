export function getUserById(id: number): string {
  return `user-${id}`;
}

export function formatUserName(first: string, last: string): string {
  return `${first} ${last}`;
}
