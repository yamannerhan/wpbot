/**
 * Store rule for selected groups/channels.
 * User wants ALL messages in the pool — only skip empty noise.
 */
export function shouldStorePoolMessage(raw: string): boolean {
  const text = raw?.trim() ?? "";
  return text.length >= 1;
}

/** @deprecated use shouldStorePoolMessage — kept for archive restore compat */
export function isPrivateSecurityJobListing(raw: string): boolean {
  return shouldStorePoolMessage(raw);
}
