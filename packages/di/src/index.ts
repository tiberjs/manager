/** Hierarchical dependency resolution and resource ownership. */

export {
  ContainerKey,
  currentContainer,
  executionScope,
  inject,
  onDispose,
  scoped,
  scopeRoot,
  withContainer,
} from "./ambient.js";
export type { ScopeHost } from "./ambient.js";
export type { ContainerObject } from "./resources/cleanup.js";
export { Container } from "./container.js";
export {
  ContainerClosedError,
  DisposalConflictError,
  ProviderConflictError,
  ResolutionError,
} from "./errors.js";
export type { ResolutionGraph } from "./resolution/graph.js";
export { token } from "./tokens.js";
export type { Constructor, Factory, InjectionToken, Token } from "./tokens.js";
