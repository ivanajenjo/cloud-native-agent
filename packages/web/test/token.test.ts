import { describe, expect, it } from "vitest";
import {
  clearToken,
  loadToken,
  saveToken,
  TOKEN_KEY,
  type TokenStorage,
  type TokenStores,
} from "../src/token.js";

/** A Map-backed storage. With `broken`, every method throws (blocked or full storage). */
function fakeStorage(
  initial: Record<string, string> = {},
  broken = false,
): TokenStorage & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  const fail = (): never => {
    throw new Error("storage blocked");
  };
  return {
    map,
    getItem: (key) => (broken ? fail() : (map.get(key) ?? null)),
    setItem: (key, value) => {
      if (broken) fail();
      map.set(key, value);
    },
    removeItem: (key) => {
      if (broken) fail();
      map.delete(key);
    },
  };
}

describe("loadToken", () => {
  it("prefers sessionStorage over localStorage", () => {
    const stores: TokenStores = {
      session: fakeStorage({ [TOKEN_KEY]: "from-session" }),
      local: fakeStorage({ [TOKEN_KEY]: "from-local" }),
    };
    expect(loadToken(stores)).toBe("from-session");
  });

  it("falls back to localStorage when sessionStorage has no token", () => {
    const stores: TokenStores = {
      session: fakeStorage(),
      local: fakeStorage({ [TOKEN_KEY]: "from-local" }),
    };
    expect(loadToken(stores)).toBe("from-local");
  });

  it("treats an empty string as no token and keeps looking", () => {
    const stores: TokenStores = {
      session: fakeStorage({ [TOKEN_KEY]: "" }),
      local: fakeStorage({ [TOKEN_KEY]: "from-local" }),
    };
    expect(loadToken(stores)).toBe("from-local");
  });

  it("returns null when both stores are empty", () => {
    expect(loadToken({ session: fakeStorage(), local: fakeStorage() })).toBeNull();
  });

  it("returns null for an empty string in every store", () => {
    const stores: TokenStores = {
      session: fakeStorage({ [TOKEN_KEY]: "" }),
      local: fakeStorage({ [TOKEN_KEY]: "" }),
    };
    expect(loadToken(stores)).toBeNull();
  });

  it("counts a throwing store as empty and still reads the other one", () => {
    const stores: TokenStores = {
      session: fakeStorage({ [TOKEN_KEY]: "from-session" }, true),
      local: fakeStorage({ [TOKEN_KEY]: "from-local" }),
    };
    expect(loadToken(stores)).toBe("from-local");
  });

  it("returns null when every store throws", () => {
    const stores: TokenStores = {
      session: fakeStorage({}, true),
      local: fakeStorage({}, true),
    };
    expect(loadToken(stores)).toBeNull();
  });

  it("does not break when a store is absent", () => {
    expect(loadToken({})).toBeNull();
    expect(loadToken({ local: fakeStorage({ [TOKEN_KEY]: "t" }) })).toBe("t");
    expect(loadToken({ session: fakeStorage({ [TOKEN_KEY]: "t" }) })).toBe("t");
  });
});

describe("saveToken", () => {
  it("with remember, stores in localStorage and removes it from sessionStorage", () => {
    const session = fakeStorage({ [TOKEN_KEY]: "old" });
    const local = fakeStorage();
    saveToken("new", true, { session, local });
    expect(local.map.get(TOKEN_KEY)).toBe("new");
    expect(session.map.has(TOKEN_KEY)).toBe(false);
  });

  it("without remember, stores in sessionStorage and removes it from localStorage", () => {
    const session = fakeStorage();
    const local = fakeStorage({ [TOKEN_KEY]: "old" });
    saveToken("new", false, { session, local });
    expect(session.map.get(TOKEN_KEY)).toBe("new");
    expect(local.map.has(TOKEN_KEY)).toBe(false);
  });

  it("moves the token from one store to the other when remember changes", () => {
    const session = fakeStorage();
    const local = fakeStorage();
    saveToken("t", false, { session, local });
    expect(loadToken({ session, local })).toBe("t");
    saveToken("t", true, { session, local });
    expect(session.map.has(TOKEN_KEY)).toBe(false);
    expect(local.map.get(TOKEN_KEY)).toBe("t");
  });

  it("never throws, even if the stores throw", () => {
    const stores: TokenStores = {
      session: fakeStorage({}, true),
      local: fakeStorage({}, true),
    };
    expect(() => saveToken("t", true, stores)).not.toThrow();
    expect(() => saveToken("t", false, stores)).not.toThrow();
  });

  it("never throws when a store is absent", () => {
    expect(() => saveToken("t", true, {})).not.toThrow();
    expect(() => saveToken("t", false, {})).not.toThrow();
  });
});

describe("clearToken", () => {
  it("removes the token from both stores", () => {
    const session = fakeStorage({ [TOKEN_KEY]: "a" });
    const local = fakeStorage({ [TOKEN_KEY]: "b" });
    clearToken({ session, local });
    expect(session.map.has(TOKEN_KEY)).toBe(false);
    expect(local.map.has(TOKEN_KEY)).toBe(false);
  });

  it("never throws, even if the stores throw", () => {
    const stores: TokenStores = {
      session: fakeStorage({}, true),
      local: fakeStorage({}, true),
    };
    expect(() => clearToken(stores)).not.toThrow();
  });

  it("never throws when a store is absent", () => {
    expect(() => clearToken({})).not.toThrow();
    const local = fakeStorage({ [TOKEN_KEY]: "b" });
    clearToken({ local });
    expect(local.map.has(TOKEN_KEY)).toBe(false);
  });
});
