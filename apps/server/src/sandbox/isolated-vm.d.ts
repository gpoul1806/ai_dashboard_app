/**
 * Minimal ambient types for the optional native dependency `isolated-vm`.
 * The package has no prebuilt binary for every Node version, so it may be
 * absent at build time; the runtime loads it via dynamic import and falls back
 * to worker_threads when it's missing. These declarations let the codebase
 * typecheck either way. They cover only the surface isolatedRuntime.ts uses.
 */
declare module "isolated-vm" {
  export interface Reference<T = unknown> {
    apply(thisArg: unknown, args: unknown[], opts?: unknown): Promise<unknown>;
  }
  export interface Context {
    readonly global: {
      set(name: string, value: unknown): Promise<void>;
    };
    eval(code: string): Promise<unknown>;
    evalClosure(code: string, args: unknown[], opts?: unknown): Promise<unknown>;
  }
  export class Isolate {
    constructor(opts?: { memoryLimit?: number });
    createContext(): Promise<Context>;
    dispose(): void;
  }
  const ivm: {
    Isolate: typeof Isolate;
    Reference: new <T = unknown>(value: T) => Reference<T>;
  };
  export default ivm;
}
