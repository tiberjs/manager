/** Hierarchical dependency resolution and resource ownership. */

export {
  ContainerKey,
  currentContainer,
  inject,
  onDispose,
  scoped,
  withContainer,
} from "./ambient.js";
export type { ContainerObject } from "./cleanup-protocol.js";
export { Container } from "./container.js";
export {
  ContainerClosedError,
  DisposalConflictError,
  ProviderConflictError,
  ResolutionError,
} from "./errors.js";
export type { ResolutionGraph } from "./resolution-graph.js";
export { token } from "./tokens.js";
export type { Constructor, Factory, InjectionToken, Token } from "./tokens.js";
