// Capability access for generated components. Network from generated code is
// ONLY allowed through useCapability, which routes to /api/dyn/* on the server.
const hooks = window.__SHELL_HOOKS__;
if (!hooks) throw new Error("Shell hooks not installed — shell must boot first");

export const useCapability = hooks.useCapability;
