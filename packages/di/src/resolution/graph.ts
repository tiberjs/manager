import { describeToken, type InjectionToken } from "../tokens.js";
import type { ResolutionFrame } from "./path.js";

/** The root container's resolution attempts: `from` resolves `to`. */
export interface ResolutionGraph {
  readonly nodes: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly edges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

/**
 * Root-local resolution diagnostics. Node identity is per container, and both
 * edge directions are indexed so removing a disposed container costs its own
 * nodes rather than a full scan.
 */
export class ResolutionTracker {
  #nextId = 0;
  readonly #idsByOwner = new WeakMap<object, Map<InjectionToken<unknown>, number>>();
  readonly #nodes = new Map<number, string>();
  readonly #outgoing = new Map<number, Set<number>>();
  readonly #incoming = new Map<number, Set<number>>();

  /** Records a resolution as a dependency of the construction that requested it. */
  record(owner: object, token: InjectionToken<unknown>, parent?: ResolutionFrame): void {
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

    // A node never depends on itself, and a removed owner's frame links nothing.
    if (parent && (parent.owner !== owner || parent.token !== token)) {
      const from = this.#idsByOwner.get(parent.owner)?.get(parent.token);
      if (from !== undefined) {
        this.#link(from, id);
      }
    }
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
