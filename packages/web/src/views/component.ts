/** A piece of UI that owns its element and is updated with a slice of the state. */
export interface Component<T> {
  readonly element: HTMLElement;
  update(value: T): void;
}
