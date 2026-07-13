// Minimal react/jsx-runtime backed by the shell's React, in case a generated
// module was built with the automatic JSX transform.
import React from "/react-shim.js";

export const Fragment = React.Fragment;

function toElement(type, props, key) {
  const { children, ...rest } = props ?? {};
  if (key !== undefined) rest.key = key;
  const childArray =
    children === undefined ? [] : Array.isArray(children) ? children : [children];
  return React.createElement(type, rest, ...childArray);
}

export function jsx(type, props, key) {
  return toElement(type, props, key);
}
export function jsxs(type, props, key) {
  return toElement(type, props, key);
}
