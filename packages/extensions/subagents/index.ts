/**
 * Public package entry point for the Pi subagents extension.
 *
 * Pi discovers the compiled default export from the package manifest. The entry point registers the namespaced
 * standalone tools and the optional `singleAgent` workflow function; the manager API can also be imported directly.
 */
export * from "./src/index.js";
export { default } from "./src/index.js";
