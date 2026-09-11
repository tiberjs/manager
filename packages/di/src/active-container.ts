import { AsyncLocalStorage } from "node:async_hooks";
import type { Container } from "./container.js";

/**
 * The container bound as ambient while one of its resources is constructed or
 * torn down. Nested construction overrides it for the inner call only.
 */
export const activeContainer = new AsyncLocalStorage<Container>();
