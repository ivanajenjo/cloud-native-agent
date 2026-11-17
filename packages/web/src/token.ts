/** Minimal Storage subset, so tests can pass a fake. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TokenStores {
  session?: TokenStorage;
  local?: TokenStorage;
}

/** Key under which the token is stored, in sessionStorage or in localStorage (ADR-0010 §6). */
export const TOKEN_KEY = "cna.token";

/** Reads the token from one store. A throwing store, or an empty value, counts as empty. */
function readFrom(store: TokenStorage | undefined): string | null {
  if (store === undefined) {
    return null;
  }
  try {
    const value = store.getItem(TOKEN_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Runs one storage operation and ignores any failure. */
function attempt(operation: () => void): void {
  try {
    operation();
  } catch {
    // Storage can be blocked or full: the token simply is not kept there.
  }
}

/** sessionStorage first, then localStorage. Any throwing storage counts as empty. Empty string → null. */
export function loadToken(stores: TokenStores): string | null {
  return readFrom(stores.session) ?? readFrom(stores.local);
}

/** remember → localStorage (and removed from sessionStorage); otherwise sessionStorage (and removed from localStorage). Never throws. */
export function saveToken(token: string, remember: boolean, stores: TokenStores): void {
  const target = remember ? stores.local : stores.session;
  const other = remember ? stores.session : stores.local;
  if (target !== undefined) {
    attempt(() => target.setItem(TOKEN_KEY, token));
  }
  if (other !== undefined) {
    attempt(() => other.removeItem(TOKEN_KEY));
  }
}

/** Removes it from both. Never throws. */
export function clearToken(stores: TokenStores): void {
  for (const store of [stores.session, stores.local]) {
    if (store !== undefined) {
      attempt(() => store.removeItem(TOKEN_KEY));
    }
  }
}

/** Reads a browser storage; accessing `window.localStorage` can throw (blocked storage). */
function browserStore(name: "sessionStorage" | "localStorage"): TokenStorage | undefined {
  try {
    const storage: Storage | undefined = globalThis[name];
    return storage;
  } catch {
    return undefined;
  }
}

/** The real stores, each obtained inside try/catch (accessing window.localStorage can throw). */
export function browserStores(): TokenStores {
  return { session: browserStore("sessionStorage"), local: browserStore("localStorage") };
}
