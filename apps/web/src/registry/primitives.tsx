import type { UINode } from "@myday/schema";
import React from "react";
import type { DataRow } from "../api/client";
import { RenderNode, ScopeContext, useScope, useWidget } from "../renderer";

/**
 * The 11 built-in seed components. Since the free-form node language landed
 * they are OPTIONAL vocabulary: the interactive ones (Input/Select/Button/
 * Checkbox/List) matter because they carry form state, rows and actions; the
 * rest are neutral containers kept for backward compatibility. None of them
 * imposes a visual identity — every one accepts a `style` passthrough so the
 * LLM owns the look.
 */

type Props = Record<string, unknown> & { children?: React.ReactNode };

const asStyle = (style: unknown): React.CSSProperties | undefined =>
  style && typeof style === "object" && !Array.isArray(style)
    ? (style as React.CSSProperties)
    : undefined;

const Card: React.FC<Props> = ({ title, style, children }) => (
  <section style={asStyle(style)}>
    {title != null && <h3 style={{ margin: "0 0 8px" }}>{String(title)}</h3>}
    <div>{children}</div>
  </section>
);

const Stack: React.FC<Props> = ({ direction = "column", gap = 8, style, children }) => (
  <div
    style={{
      display: "flex",
      flexDirection: direction === "row" ? "row" : "column",
      gap: Number(gap) || 8,
      alignItems: direction === "row" ? "center" : "stretch",
      ...asStyle(style),
    }}
  >
    {children}
  </div>
);

const Text: React.FC<Props> = ({ text, style, children }) => (
  <span style={asStyle(style)}>{text != null ? String(text) : children}</span>
);

const Input: React.FC<Props> = ({ name, placeholder, type = "text", style, disabled }) => {
  const ctx = useWidget();
  const field = String(name ?? "value");
  const isDisabled = Boolean(disabled);
  return (
    <input
      type={String(type)}
      // Cursor is state-derived and placed AFTER the widget style so a static
      // LLM-authored cursor can never contradict the actual enabled state.
      style={{ opacity: isDisabled ? 0.5 : 1, ...asStyle(style), cursor: isDisabled ? "not-allowed" : "text" }}
      placeholder={placeholder != null ? String(placeholder) : undefined}
      value={ctx.form[field] ?? ""}
      disabled={isDisabled}
      onChange={(e) => ctx.setFormField(field, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") ctx.runAction("addRow", {});
      }}
    />
  );
};

const Button: React.FC<Props> = ({ label, action, style, children, disabled }) => {
  const ctx = useWidget();
  const scope = useScope();
  const isDisabled = Boolean(disabled);
  return (
    <button
      style={{ opacity: isDisabled ? 0.5 : 1, ...asStyle(style), cursor: isDisabled ? "not-allowed" : "pointer" }}
      disabled={isDisabled}
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

function isUINode(v: unknown): v is UINode {
  return Boolean(v && typeof v === "object" && "kind" in (v as object));
}

const List: React.FC<Props> = ({ items, itemTemplate, empty, style }) => {
  const rows = Array.isArray(items) ? items.map(asDataRow) : [];
  if (rows.length === 0) {
    return (
      <div style={{ opacity: 0.6, ...asStyle(style) }}>
        {empty != null ? String(empty) : "Nothing here yet"}
      </div>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, ...asStyle(style) }}>
      {rows.map((row) => (
        <li key={row.id}>
          <ScopeContext.Provider value={{ row }}>
            {isUINode(itemTemplate) ? (
              <RenderNode node={itemTemplate} />
            ) : (
              <span>{JSON.stringify(row.row)}</span>
            )}
          </ScopeContext.Provider>
        </li>
      ))}
    </ul>
  );
};

const Checkbox: React.FC<Props> = ({ checked, label, action, style }) => {
  const ctx = useWidget();
  const scope = useScope();
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, ...asStyle(style) }}>
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

const Select: React.FC<Props> = ({ name, options, placeholder, style, disabled }) => {
  const ctx = useWidget();
  const field = String(name ?? "value");
  const opts = Array.isArray(options) ? options.map(String) : [];
  return (
    <select
      style={{ ...asStyle(style), cursor: Boolean(disabled) ? "not-allowed" : "pointer" }}
      value={ctx.form[field] ?? ""}
      disabled={Boolean(disabled)}
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

const Counter: React.FC<Props> = ({ value, label, style }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 6, ...asStyle(style) }}>
    <span style={{ fontSize: "1.6rem", fontWeight: 700 }}>{Number(value ?? 0)}</span>
    {label != null && <span style={{ opacity: 0.7 }}>{String(label)}</span>}
  </div>
);

const ProgressBar: React.FC<Props> = ({ value, label, style }) => {
  const pct = Math.max(0, Math.min(100, Number(value ?? 0)));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...asStyle(style) }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: "rgba(128,128,128,0.25)" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 3,
            background: "currentColor",
          }}
        />
      </div>
      <span style={{ fontSize: "0.8rem", opacity: 0.75 }}>
        {label != null ? String(label) : `${pct}%`}
      </span>
    </div>
  );
};

/** Kept for backward compatibility: pinned positioning now comes from
 *  presentation.anchor (the shell positions the widget), so Overlay is just a
 *  styleable box. */
const Overlay: React.FC<Props> = ({ style, children }) => (
  <div style={asStyle(style)}>{children}</div>
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
