const SESSION_KEY = "ek_api_key";

let memoryKey: string | null = null;
let organizationScope: string | null = null;

export function getApiKey(): string | null {
  if (memoryKey) return memoryKey;
  if (typeof window === "undefined") return null;
  memoryKey = window.sessionStorage.getItem(SESSION_KEY);
  return memoryKey;
}

export function setApiKey(key: string, keepOnThisTab: boolean): void {
  memoryKey = key;
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(SESSION_KEY);
  if (keepOnThisTab) window.sessionStorage.setItem(SESSION_KEY, key);
}

export function clearApiKey(): void {
  memoryKey = null;
  if (typeof window !== "undefined") window.sessionStorage.removeItem(SESSION_KEY);
}

export function hasApiKey(): boolean {
  return getApiKey() !== null;
}

export function setOrganizationScope(slug: string | null): void {
  organizationScope = slug;
}

export function getOrganizationScope(): string | null {
  return organizationScope;
}
