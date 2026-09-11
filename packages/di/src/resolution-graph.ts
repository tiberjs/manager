import { describeToken, type InjectionToken } from "./tokens.js";

/** The root container's resolution attempts: `from` resolves `to`. */
export interface ResolutionGraph {
  readonly nodes: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly edges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

/**
 * Root-local diagnostics, with node identity tied to the owning container.
 *
 * Both directions of every edge are indexed so removing a disposed container
 * costs its own nodes, not a scan of the whole graph.
 */
export class ResolutionTracker {
  #nextId = 0;
  readonly #idsByOwner = new WeakMap<object, Map<InjectionToken<unknown>, number>>();
  readonly #nodes = new Map<number, string>();
  readonly #outgoing = new Map<number, Set<number>>();
  readonly #incoming = new Map<number, Set<number>>();
  readonly #frames: number[] = [];

  /** Attributes a resolution to the open frame without opening one itself. */
  record(owner: object, token: InjectionToken<unknown>): number {
    let ids = this.#idsByOwner.get(owner);
    if (!ids) {
      this.#idsByOwner.set(owner, (ids = new Map()));
    }

    let id = ids.get(token);
    if (id === undefined) {
      id = this.#nextId++;
      ids.set(token, id);
      this.#nodes.set(id, describeToken(token));
    }

    const parent = this.#frames[this.#frames.length - 1];
    if (parent !== undefined && parent !== id) {
      this.#link(parent, id);
    }

    return id;
  }

  /** Nested resolutions become dependencies of `token` until the matching `exit()`. */
  enter(owner: object, token: InjectionToken<unknown>): void {
    this.#frames.push(this.record(owner, token));
  }

  exit(): void {
    this.#frames.pop();
  }

  snapshot(): ResolutionGraph {
    const edges: Array<{ from: number; to: number }> = [];
    for (const [from, targets] of this.#outgoing) {
      for (const to of targets) {
        edges.push({ from, to });
      }
    }

    return { nodes: Array.from(this.#nodes, ([id, name]) => ({ id, name })), edges };
  }

  /** Drops a disposed owner's nodes and every edge that touched them. */
  remove(owner: object): void {
    const ids = this.#idsByOwner.get(owner);
    if (!ids) {
      return;
    }

    for (const id of ids.values()) {
      this.#nodes.delete(id);
      this.#unlink(id);
    }

    this.#idsByOwner.delete(owner);
  }

  #link(from: number, to: number): void {
    let targets = this.#outgoing.get(from);
    if (!targets) {
      this.#outgoing.set(from, (targets = new Set()));
    }
    targets.add(to);

    let sources = this.#incoming.get(to);
    if (!sources) {
      this.#incoming.set(to, (sources = new Set()));
    }
    sources.add(from);
  }

  #unlink(id: number): void {
    const targets = this.#outgoing.get(id);
    if (targets) {
      for (const to of targets) {
        this.#detach(this.#incoming, to, id);
      }
      this.#outgoing.delete(id);
    }

    const sources = this.#incoming.get(id);
    if (sources) {
      for (const from of sources) {
        this.#detach(this.#outgoing, from, id);
      }
      this.#incoming.delete(id);
    }
  }

  #detach(index: Map<number, Set<number>>, node: number, peer: number): void {
    const peers = index.get(node);
    if (peers?.delete(peer) && peers.size === 0) {
      index.delete(node);
    }
  }
}
