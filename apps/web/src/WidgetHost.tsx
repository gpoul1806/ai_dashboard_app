import { sanitizeTree } from "@myday/schema";
import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type DataRow, type FeatureRecord } from "./api/client";
import { ensureComponents } from "./loader";
import { useRegistry } from "./registry";
import {
  AppActionsContext,
  RegistryContext,
  RenderNode,
  type Scope,
  WidgetContext,
  type WidgetCtxValue,
} from "./renderer";

/**
 * Stateful host around the pure renderer: loads required generated components,
 * owns widget data rows + form state, and implements the action vocabulary
 * (addRow / deleteRow / toggleRow:<field> / clearForm).
 */
export function WidgetHost({ feature }: { feature: FeatureRecord }) {
  const registry = useRegistry();
  const appActions = useContext(AppActionsContext);
  const def = feature.definition;
  const [ready, setReady] = useState((def.requiresComponents ?? []).length === 0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<DataRow[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const required = def.requiresComponents ?? [];
    if (required.length === 0) {
      setReady(true);
      return;
    }
    ensureComponents(required)
      .then(() => !cancelled && setReady(true))
      .catch((err) => !cancelled && setLoadError(String(err?.message ?? err)));
    return () => {
      cancelled = true;
    };
  }, [def]);

  useEffect(() => {
    if (!def.dataSchema) return;
    let cancelled = false;
    api
      .dataList(feature.id)
      .then((r) => !cancelled && setRows(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [feature.id, def.dataSchema]);

  const setFormField = useCallback((name: string, value: string) => {
    setForm((f) => ({ ...f, [name]: value }));
  }, []);

  const runAction = useCallback(
    async (action: string, scope: Scope) => {
      try {
        if (action.startsWith("setView:")) {
          // App-level: switches the active view/tab for the whole dashboard.
          appActions?.setView(action.slice("setView:".length));
        } else if (action.startsWith("toggleGlobal:")) {
          appActions?.toggleGlobal(action.slice("toggleGlobal:".length));
        } else if (action.startsWith("setGlobal:")) {
          const expr = action.slice("setGlobal:".length);
          const eq = expr.indexOf("=");
          if (eq > 0) {
            const key = expr.slice(0, eq);
            const raw = expr.slice(eq + 1);
            const value =
              raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
            appActions?.setGlobal(key, value);
          }
        } else if (action === "clearForm") {
          setForm({});
        } else if (action === "addRow") {
          if (!def.dataSchema) return;
          const row: Record<string, unknown> = {};
          let hasInput = false;
          for (const [field, spec] of Object.entries(def.dataSchema)) {
            const raw = form[field];
            if (raw !== undefined && raw !== "") {
              hasInput = true;
              row[field] =
                spec.type === "number"
                  ? Number(raw)
                  : spec.type === "boolean"
                    ? raw === "true"
                    : raw;
            } else {
              row[field] =
                spec.default ??
                (spec.type === "boolean" ? false : spec.type === "number" ? 0 : "");
            }
          }
          if (!hasInput) return;
          const created = await api.dataAdd(feature.id, row);
          setRows((r) => [...r, created]);
          setForm({});
        } else if (action === "deleteRow") {
          const id = scope.row?.id;
          if (!id) return;
          await api.dataDelete(feature.id, id);
          setRows((r) => r.filter((x) => x.id !== id));
        } else if (action.startsWith("toggleRow:")) {
          const field = action.slice("toggleRow:".length);
          const row = scope.row;
          if (!row) return;
          const updated = await api.dataPatch(feature.id, row.id, {
            [field]: !row.row[field],
          });
          setRows((rs) => rs.map((x) => (x.id === row.id ? updated : x)));
        }
      } catch (err) {
        console.error(`widget action "${action}" failed`, err);
      }
    },
    [def.dataSchema, feature.id, form, appActions],
  );

  const globals = appActions?.globals ?? {};
  const ctx: WidgetCtxValue = useMemo(
    () => ({ definition: def, rows, form, globals, setFormField, runAction }),
    [def, rows, form, globals, setFormField, runAction],
  );

  // Defense in depth: trees are strict-validated at generation time, but every
  // replay from the DB passes through the strip sanitizer before rendering.
  const safeRoot = useMemo(() => sanitizeTree(def.root, "strip").node, [def.root]);

  if (loadError) {
    return <div className="widget-error">Failed to load "{feature.name}": {loadError}</div>;
  }
  if (!ready) {
    return <div className="widget-loading">Loading {feature.name}…</div>;
  }

  return (
    <RegistryContext.Provider value={registry}>
      <WidgetContext.Provider value={ctx}>
        <RenderNode node={safeRoot} />
      </WidgetContext.Provider>
    </RegistryContext.Provider>
  );
}
