import type { ComponentNode } from "@myday/schema";
import React from "react";
import type { DataRow } from "../api/client";
import { RenderNode, ScopeContext, useScope, useWidget } from "../renderer";

/**
 * The 11 built-in seed primitives. They exist so Tier 1 has a day-one
 * vocabulary; the registry is OPEN and grows via Tier 2 without redeploying.
 */

type Props = Record<string, unknown> & { children?: React.ReactNode };

const Card: React.FC<Props> = ({ title, children }) => (
  <section className="ui-card">
    {title != null && <h3 className="ui-card-title">{String(title)}</h3>}
    <div className="ui-card-body">{children}</div>
  </section>
);

const Stack: React.FC<Props> = ({ direction = "column", gap = 8, children }) => (
  <div
    className="ui-stack"
    style={{
      display: "flex",
      flexDirection: direction === "row" ? "row" : "column",
      gap: Number(gap) || 8,
      alignItems: direction === "row" ? "center" : "stretch",
    }}
  >
    {children}
  </div>
);

const Text: React.FC<Props> = ({ text, variant = "body", children }) => (
  <span className={`ui-text ui-text-${String(variant)}`}>
    {text != null ? String(text) : children}
  </span>
);

const Input: React.FC<Props> = ({ name, placeholder, type = "text" }) => {
  const ctx = useWidget();
  const field = String(name ?? "value");
  return (
    <input
      className="ui-input"
      type={String(type)}
      placeholder={placeholder != null ? String(placeholder) : undefined}
      value={ctx.form[field] ?? ""}
      onChange={(e) => ctx.setFormField(field, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") ctx.runAction("addRow", {});
      }}
    />
  );
};

const Button: React.FC<Props> = ({ label, action, variant = "primary", children }) => {
  const ctx = useWidget();
  const scope = useScope();
  return (
    <button
      className={`ui-button ui-button-${String(variant)}`}
      onClick={() => {
        if (typeof action === "string" && action) ctx.runAction(action, scope);
      }}
    >
      {label != null ? String(label) : children}
    </button>
  );
};

/** Normalizes list items into DataRow shape so {"$row": f} works uniformly. */
function asDataRow(item: unknown, index: number): DataRow {
  if (
    item &&
    typeof item === "object" &&
    "id" in item &&
    "row" in item &&
    typeof (item as DataRow).row === "object"
  ) {
    return item as DataRow;
  }
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    return { id: String(obj.id ?? index), row: obj };
  }
  return { id: String(index), row: { value: item } };
}

const List: React.FC<Props> = ({ items, itemTemplate, empty }) => {
  const rows = Array.isArray(items) ? items.map(asDataRow) : [];
  if (rows.length === 0) {
    return <div className="ui-empty">{empty != null ? String(empty) : "Nothing here yet"}</div>;
  }
  return (
    <ul className="ui-list">
      {rows.map((row) => (
        <li key={row.id} className="ui-list-item">
          <ScopeContext.Provider value={{ row }}>
            {itemTemplate ? (
              <RenderNode node={itemTemplate as ComponentNode} />
            ) : (
              <span className="ui-text">{JSON.stringify(row.row)}</span>
            )}
          </ScopeContext.Provider>
        </li>
      ))}
    </ul>
  );
};

const Checkbox: React.FC<Props> = ({ checked, label, action }) => {
  const ctx = useWidget();
  const scope = useScope();
  return (
    <label className="ui-checkbox">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={() => {
          if (typeof action === "string" && action) ctx.runAction(action, scope);
        }}
      />
      {label != null && <span>{String(label)}</span>}
    </label>
  );
};

const Select: React.FC<Props> = ({ name, options, placeholder }) => {
  const ctx = useWidget();
  const field = String(name ?? "value");
  const opts = Array.isArray(options) ? options.map(String) : [];
  return (
    <select
      className="ui-select"
      value={ctx.form[field] ?? ""}
      onChange={(e) => ctx.setFormField(field, e.target.value)}
    >
      <option value="">{placeholder != null ? String(placeholder) : "—"}</option>
      {opts.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
};

const Counter: React.FC<Props> = ({ value, label }) => (
  <div className="ui-counter">
    <span className="ui-counter-value">{Number(value ?? 0)}</span>
    {label != null && <span className="ui-counter-label">{String(label)}</span>}
  </div>
);

const ProgressBar: React.FC<Props> = ({ value, label }) => {
  const pct = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div className="ui-progress-wrap">
      <div className="ui-progress">
        <div className="ui-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ui-progress-label">{label != null ? String(label) : `${pct}%`}</span>
    </div>
  );
};

const Overlay: React.FC<Props> = ({ position = "top-right", children }) => (
  <div className={`ui-overlay ui-overlay-${String(position)}`}>{children}</div>
);

export const primitives: Record<
  string,
  React.ComponentType<Record<string, unknown>>
> = {
  Card,
  Stack,
  Text,
  Input,
  Button,
  List,
  Checkbox,
  Select,
  Counter,
  ProgressBar,
  Overlay,
};
