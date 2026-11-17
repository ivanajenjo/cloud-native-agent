export type Reducer<S, A> = (state: S, action: A) => S;

/** Minimal state container: a reducer, a current state and synchronous listeners. */
export class Store<S, A> {
  #state: S;
  readonly #reducer: Reducer<S, A>;
  readonly #listeners = new Set<(state: S) => void>();

  constructor(initial: S, reducer: Reducer<S, A>) {
    this.#state = initial;
    this.#reducer = reducer;
  }

  get state(): S {
    return this.#state;
  }

  /**
   * Applies the reducer. If the new state is not the old one, notifies the listeners
   * synchronously. A throwing listener does not stop the others.
   */
  dispatch(action: A): void {
    const previous = this.#state;
    const next = this.#reducer(previous, action);
    if (next === previous) {
      return;
    }
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch (error) {
        console.error(error);
      }
    }
  }

  subscribe(listener: (state: S) => void): () => void {
    // Wrap so that subscribing the same function twice yields two independent subscriptions.
    const entry = (state: S): void => listener(state);
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }
}

export interface RegionContainer {
  replaceChildren(...nodes: Node[]): void;
}

/** Schedules a callback. */
export type Scheduler = (callback: () => void) => void;

/**
 * Renders `render(select(state))` into `container` now, and again after each state change whose
 * selected slice is not Object.is-equal to the last rendered one. Re-renders are coalesced: at most
 * one pending per region, scheduled with `schedule`, rendering the latest slice. Returns an unbind function
 * (after it, nothing else renders, also not an already scheduled render).
 */
export function bindRegion<S, A, T>(
  store: Store<S, A>,
  container: RegionContainer,
  select: (state: S) => T,
  render: (slice: T) => Node,
  schedule: Scheduler = (callback) => requestAnimationFrame(() => callback()),
): () => void {
  let rendered = select(store.state);
  let latest = rendered;
  let pending = false;
  let active = true;
  container.replaceChildren(render(rendered));

  const flush = (): void => {
    pending = false;
    if (!active || Object.is(latest, rendered)) {
      return;
    }
    rendered = latest;
    container.replaceChildren(render(rendered));
  };

  const unsubscribe = store.subscribe((state) => {
    if (!active) {
      return;
    }
    latest = select(state);
    if (!pending && !Object.is(latest, rendered)) {
      pending = true;
      schedule(flush);
    }
  });

  return () => {
    active = false;
    unsubscribe();
  };
}
