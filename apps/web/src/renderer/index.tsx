import type { ComponentNode, WidgetDefinition } from "@myday/schema";
import React, { createContext, useContext } from "react";
import type { DataRow } from "../api/client";

/**
 * The renderer is pure: (definition, data, registry) → JSX.
 * All state (rows, form values) and effects (CRUD calls) are owned by the
 * WidgetHost that provides WidgetContext; the renderer only resolves binding
 * expressions and maps ComponentNodes onto registry components.
 *
 * Binding expressions resolvable in props:
 *   {"$data": "rows"}          → the widget's data rows
 *   {"$row": "<field>"}        → field of the current row (inside List itemTemplate)
 *   {"$form": "<name>"}        → current value of the named Input/Select
 *   {"$count": "rows"}         → number of rows
 *   {"$countWhere": "<field>"} → number of rows where <field> is truthy
 *   {"$percentWhere": "<f>"}   → 0-100 percentage of rows where <f> is truthy
 *
 * Action strings (Button.action / Checkbox.action):
 *   "addRow" | "deleteRow" | "toggleRow:<field>" | "clearForm"
 */

export interface Scope {
  row?: DataRow;
}

export interface WidgetCtxValue {
  definition: WidgetDefinition;
  rows: DataRow[];
  form: Record<string, string>;
  setFormField(name: string, value: string): void;
  runAction(action: string, scope: Scope): void;
}

export interface RegistryLike {
  get(type: string): React.ComponentType<Record<string, unknown>> | undefined;
}

export const WidgetContext = createContext<WidgetCtxValue | null>(null);
export const ScopeContext = createContext<Scope>({});
export const RegistryContext = createContext<RegistryLike | null>(null);

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

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx, scope);
  return out;
}

export function RenderNode({ node }: { node: ComponentNode }): React.ReactElement {
  const registry = useContext(RegistryContext);
  const ctx = useWidget();
  const scope = useScope();

  const Comp = registry?.get(node.type);
  if (!Comp) {
    return <div className="ui-missing">Unknown component: {node.type}</div>;
  }

  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.props ?? {})) {
    // itemTemplate is a ComponentNode rendered per-row by List — leave it raw.
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
