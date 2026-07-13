// Re-exports the shell's React instance for dynamically imported generated
// components. window.__SHELL_REACT__ is installed by src/shell.ts at boot,
// which always runs before any generated module is imported.
const R = window.__SHELL_REACT__;
if (!R) throw new Error("Shell React not installed — shell must boot first");

export default R;
export const {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} = R;
