import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRegion, type Reducer, type Scheduler, Store } from "../src/store.js";

interface State {
  count: number;
  label: string;
}

type Action = { type: "inc" } | { type: "label"; value: string } | { type: "same" };

const reducer: Reducer<State, Action> = (state, action) => {
  switch (action.type) {
    case "inc":
      return { ...state, count: state.count + 1 };
    case "label":
      return { ...state, label: action.value };
    case "same":
      return state;
  }
};

const initial: State = { count: 0, label: "" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Store", () => {
  it("applies the reducer on dispatch", () => {
    const store = new Store(initial, reducer);
    store.dispatch({ type: "inc" });
    store.dispatch({ type: "label", value: "hola" });
    expect(store.state).toEqual({ count: 1, label: "hola" });
  });

  it("does not notify when the reducer returns the same object", () => {
    const store = new Store(initial, reducer);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "same" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies listeners synchronously with the new state", () => {
    const store = new Store(initial, reducer);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "inc" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 1, label: "" });
  });

  it("stops notifying after unsubscribe", () => {
    const store = new Store(initial, reducer);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: "inc" });
    unsubscribe();
    store.dispatch({ type: "inc" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying the other listeners when one throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new Store(initial, reducer);
    const failing = new Error("boom");
    const healthy = vi.fn();
    store.subscribe(() => {
      throw failing;
    });
    store.subscribe(healthy);
    store.dispatch({ type: "inc" });
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(failing);
  });
});

describe("bindRegion", () => {
  /** Scheduler that stores callbacks until the test runs them. */
  function manualScheduler() {
    const callbacks: Array<() => void> = [];
    const schedule: Scheduler = (callback) => {
      callbacks.push(callback);
    };
    const runPending = () => {
      for (const callback of callbacks.splice(0)) {
        callback();
      }
    };
    return { schedule, runPending, callbacks };
  }

  /** Fake container; `render` returns a plain object cast to Node. */
  function setup() {
    const container = { replaceChildren: vi.fn() };
    const render = vi.fn((slice: string) => ({ slice }) as unknown as Node);
    const store = new Store<State, Action>(initial, reducer);
    const scheduler = manualScheduler();
    return { container, render, store, ...scheduler };
  }

  it("renders the initial slice immediately", () => {
    const { container, render, store, schedule } = setup();
    bindRegion(store, container, (state) => state.label, render, schedule);
    expect(render).toHaveBeenCalledWith("");
    expect(container.replaceChildren).toHaveBeenCalledTimes(1);
  });

  it("does not re-render when another part of the state changes", () => {
    const { container, render, store, schedule, runPending, callbacks } = setup();
    bindRegion(store, container, (state) => state.label, render, schedule);
    store.dispatch({ type: "inc" });
    runPending();
    expect(callbacks).toHaveLength(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("coalesces two changes into one render with the latest slice", () => {
    const { container, render, store, schedule, runPending, callbacks } = setup();
    bindRegion(store, container, (state) => state.label, render, schedule);
    store.dispatch({ type: "label", value: "a" });
    store.dispatch({ type: "label", value: "b" });
    expect(callbacks).toHaveLength(1);
    runPending();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith("b");
  });

  it("cancels a pending render when unbound", () => {
    const { container, render, store, schedule, runPending } = setup();
    const unbind = bindRegion(store, container, (state) => state.label, render, schedule);
    store.dispatch({ type: "label", value: "x" });
    unbind();
    runPending();
    expect(render).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "label", value: "y" });
    runPending();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
