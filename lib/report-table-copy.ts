export function listOverflowCopy(total: number, shown: number, where?: string): string | null {
  if (total <= shown) return null;
  const remaining = (total - shown).toLocaleString("en-US");
  return where
    ? `+${remaining} more in ${where}.`
    : `+${remaining} more observations not shown in this list.`;
}
