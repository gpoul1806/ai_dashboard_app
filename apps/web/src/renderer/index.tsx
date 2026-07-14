import type { UINode, WidgetDefinition } from "@myday/schema";
import React, { createContext, useCallback, useContext } from "react";
import type { DataRow } from "../api/client";

/**
 * The renderer is pure: (definition, data, registry) → JSX.
 * All state (rows, form values) and effects (CRUD calls) are owned by the
 * WidgetHost that provides WidgetContext; the renderer only resolves binding
 * expressions and maps UINodes onto DOM elements / registry components.
 *
 * A UINode is one of:
 *   {"kind":"text","value": ...}                          → text leaf
 *   {"kind":"element","tag","attrs","style","action",...} → free-form HTML/SVG
 *   {"kind":"component","component","props",...}          → registry component
 *
 * Binding expressions resolvable in text values / element attrs / props:
 *   {"$data": "rows"}          → the widget's data rows
 *   {"$row": "<field>"}        → field of the current row (inside List itemTemplate)
 *   {"$form": "<name>"}        → current value of the named Input/Select
 *   {"$count": "rows"}         → number of rows
 *   {"$countWhere": "<field>"} → number of rows where <field> is truthy
 *   {"$percentWhere": "<f>"}   → 0-100 percentage of rows where <f> is truthy
 *
 * Action strings (element "action" / Button.action / Checkbox.action):
 *   "addRow" | "deleteRow" | "toggleRow:<field>" | "clearForm"
 *
 * SECURITY: element trees are strip-sanitized by the WidgetHost before they
 * reach RenderNode; this module additionally refuses event-handler ("on…"),
 * class, and string-style attrs defensively when mapping to React props.
 */

export interface Scope {
  row?: DataRow;
}

export interface WidgetCtxValue {
  definition: WidgetDefinition;
  rows: DataRow[];
  form: Record<string, string>;
  /** App-wide shared state — readable from ANY widget via {"$global": key}. */
  globals: Record<string, unknown>;
  setFormField(name: string, value: string): void;
  runAction(action: string, scope: Scope): void;
}

export interface RegistryLike {
  get(type: string): React.ComponentType<Record<string, unknown>> | undefined;
}

export const WidgetContext = createContext<WidgetCtxValue | null>(null);
export const ScopeContext = createContext<Scope>({});
export const RegistryContext = createContext<RegistryLike | null>(null);

/** App-level actions + shared state any widget may use: "setView:<name>"
 *  switches the active view/tab; "toggleGlobal:<key>" / "setGlobal:<key>=<v>"
 *  mutate app-wide state that other widgets read via {"$global": key} — this
 *  is how widgets affect each other (e.g. a switch disabling an input).
 *  Provided by App, consumed by WidgetHost. */
export interface AppActions {
  globals: Record<string, unknown>;
  setView(view: string): void;
  setGlobal(key: string, value: unknown): void;
  toggleGlobal(key: string): void;
}
export const AppActionsContext = createContext<AppActions | null>(null);

export function useWidget(): WidgetCtxValue {
  const ctx = useContext(WidgetContext);
  if (!ctx) throw new Error("useWidget must be used inside a widget tree");
  return ctx;
}

export function useScope(): Scope {
  return useContext(ScopeContext);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function resolveValue(
  value: unknown,
  ctx: WidgetCtxValue,
  scope: Scope,
): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx, scope));
  if (!isPlainObject(value)) return value;

  if ("$data" in value) {
    return value.$data === "rows" ? ctx.rows : undefined;
  }
  if ("$row" in value) {
    return scope.row?.row?.[String(value.$row)];
  }
  if ("$form" in value) {
    return ctx.form[String(value.$form)] ?? "";
  }
  if ("$count" in value) {
    return ctx.rows.length;
  }
  if ("$countWhere" in value) {
    const field = String(value.$countWhere);
    return ctx.rows.filter((r) => Boolean(r.row[field])).length;
  }
  if ("$percentWhere" in value) {
    const field = String(value.$percentWhere);
    if (ctx.rows.length === 0) return 0;
    const done = ctx.rows.filter((r) => Boolean(r.row[field])).length;
    return Math.round((100 * done) / ctx.rows.length);
  }
  if ("$global" in value) {
    return ctx.globals[String(value.$global)];
  }
  if ("$globalNot" in value) {
    return !ctx.globals[String(value.$globalNot)];
  }
  if ("$if" in value) {
    // Conditional literal on an app-wide key; "!" prefix negates.
    const expr = String(value.$if);
    const negated = expr.startsWith("!");
    const truthy = Boolean(ctx.globals[negated ? expr.slice(1) : expr]);
    return (negated ? !truthy : truthy)
      ? (value as { then?: unknown }).then
      : (value as { else?: unknown }).else;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx, scope);
  return out;
}

/** HTML attribute names whose React prop spelling differs. */
const ATTR_TO_PROP: Record<string, string> = {
  for: "htmlFor",
  tabindex: "tabIndex",
  crossorigin: "crossOrigin",
  playsinline: "playsInline",
  autoplay: "autoPlay",
  srcset: "srcSet",
  srclang: "srcLang",
  datetime: "dateTime",
  readonly: "readOnly",
  maxlength: "maxLength",
};

/** Free-form element node → DOM element. */
function RenderElement({
  node,
}: {
  node: Extract<UINode, { kind: "element" }>;
}): React.ReactElement {
  const ctx = useWidget();
  const scope = useScope();

  const props: Record<string, unknown> = {};
  let volume: number | null = null;

  for (const [rawName, rawValue] of Object.entries(node.attrs ?? {})) {
    const lower = rawName.toLowerCase();
    // Defense in depth — the sanitizer already strips these.
    if (lower.startsWith("on") || lower === "class" || lower === "style") continue;
    const value = resolveValue(rawValue, ctx, scope);
    if (lower === "volume" && (node.tag === "audio" || node.tag === "video")) {
      volume = Number(value);
      continue;
    }
    props[ATTR_TO_PROP[lower] ?? rawName] = value;
  }

  if (node.style) {
    // Style values may be $if bindings — resolve them to plain CSS values.
    const style: Record<string, unknown> = {};
    for (const [prop, raw] of Object.entries(node.style)) {
      style[prop] = resolveValue(raw, ctx, scope);
    }
    props.style = style;
  }

  const action = node.action;
  if (action) {
    props.onClick = () => ctx.runAction(action, scope);
  }

  // volume is a DOM property, not an attribute — set it via ref.
  const ref = useCallback(
    (el: HTMLMediaElement | null) => {
      if (el && volume !== null && Number.isFinite(volume)) {
        el.volume = Math.min(1, Math.max(0, volume));
      }
    },
    [volume],
  );
  if (volume !== null) props.ref = ref;

  const children = (node.children ?? []).map((child, i) => (
    <RenderNode key={i} node={child} />
  ));

  // Void elements (img, br, hr, source, track…) must not receive children.
  return children.length > 0
    ? React.createElement(node.tag, props, children)
    : React.createElement(node.tag, props);
}

export function RenderNode({ node }: { node: UINode }): React.ReactElement | null {
  const registry = useContext(RegistryContext);
  const ctx = useWidget();
  const scope = useScope();

  if (node.kind === "text") {
    const value = resolveValue(node.value, ctx, scope);
    return <>{value === undefined || value === null ? "" : String(value)}</>;
  }

  if (node.kind === "element") {
    return <RenderElement node={node} />;
  }

  const Comp = registry?.get(node.component);
  if (!Comp) {
    return <div className="ui-missing">Unknown component: {node.component}</div>;
  }

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.props ?? {})) {
    // itemTemplate is a UINode rendered per-row by List — leave it raw.
    props[k] = k === "itemTemplate" ? v : resolveValue(v, ctx, scope);
  }

  return (
    <Comp {...props}>
      {(node.children ?? []).map((child, i) => (
        <RenderNode key={i} node={child} />
      ))}
    </Comp>
  );
}
