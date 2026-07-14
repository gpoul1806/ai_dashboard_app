import type { Presentation } from "@myday/schema";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type CapabilityRecord,
  type FeatureRecord,
} from "./api/client";
import { AppActionsContext } from "./renderer";
import { WidgetHost } from "./WidgetHost";

/**
 * Maps a pinned widget's presentation onto a fixed-position container.
 * "The screen" for widgets is the area BELOW the app header (title + request
 * bar) — exactly like the background layer reads visually. --header-h is kept
 * up to date by a ResizeObserver in App. zIndex is clamped below the header's
 * (50) so no widget can ever cover the input row.
 */
function pinnedStyle(pres: Presentation | undefined): React.CSSProperties {
  const anchor = pres?.anchor ?? "top-right";
  const style: React.CSSProperties = {
    position: "fixed",
    zIndex: Math.min(pres?.zIndex ?? 30, 40),
    width: pres?.size?.width,
    height: pres?.size?.height,
    maxWidth: "min(92vw, 480px)",
  };
  const transforms: string[] = [];
  if (anchor.startsWith("top")) style.top = "calc(var(--header-h, 0px) + 16px)";
  else if (anchor.startsWith("bottom")) style.bottom = 48; // clears the dev-panel bar
  else {
    // Vertical middle of the area below the header.
    style.top = "calc(50% + var(--header-h, 0px) / 2)";
    transforms.push("translateY(-50%)");
  }
  if (anchor.endsWith("left")) style.left = 16;
  else if (anchor.endsWith("right")) style.right = 16;
  else {
    style.left = "50%";
    transforms.push("translateX(-50%)");
  }
  if (transforms.length > 0) style.transform = transforms.join(" ");
  return style;
}

/** Opt-in neutral chrome: only when the definition asks for surface "card". */
function Surfaced({ feature }: { feature: FeatureRecord }) {
  const host = <WidgetHost feature={feature} />;
  return feature.definition.presentation?.surface === "card" ? (
    <div className="widget-surface">{host}</div>
  ) : (
    host
  );
}

function DevPanel({
  capabilities,
  onApprove,
}: {
  capabilities: CapabilityRecord[];
  onApprove: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pending = capabilities.filter((c) => c.reviewRequired && !c.approved);

  useEffect(() => {
    if (pending.length > 0) setOpen(true);
  }, [pending.length]);

  return (
    <div className={`dev-panel ${open ? "open" : ""}`}>
      <button className="dev-panel-toggle" onClick={() => setOpen((o) => !o)}>
        Dev panel {pending.length > 0 ? `(${pending.length} pending approval)` : ""}
      </button>
      {open && (
        <div className="dev-panel-body">
          <h4>Capabilities</h4>
          {capabilities.length === 0 && <p className="muted">None generated yet.</p>}
          <ul>
            {capabilities.map((c) => (
              <li key={c.key} className="dev-cap">
                <div>
                  <code>{c.key}</code> — {c.description}
                  <div className="muted">
                    allowlist: {c.domainAllowlist.join(", ") || "(none)"}
                  </div>
                </div>
                {c.reviewRequired && !c.approved ? (
                  <button className="approve" onClick={() => onApprove(c.key)}>
                    Approve
                  </button>
                ) : (
                  <span className="ok">live</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Upper bound on a single request. Generous headroom for multi-tier generation
// (planner → Tier 3 → Tier 2 → Tier 1, each with a retry), but never infinite.
const REQUEST_TIMEOUT_MS = 180_000;

interface Declined {
  request: string;
  reason: string;
}

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="toast-close" onClick={onDone} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export default function App() {
  const [features, setFeatures] = useState<FeatureRecord[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityRecord[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [declined, setDeclined] = useState<Declined | null>(null);
  // Files attached to the request, kept locally until submit (previewUrl is an
  // object URL for thumbnails; the real upload happens on submit).
  const [pending, setPending] = useState<{ file: File; previewUrl: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Controls the in-flight request so it can be cancelled mid-generation.
  const abortRef = useRef<AbortController | null>(null);
  // Pinned widgets anchor to the area below the header — track its height
  // (it grows with status lines / attachments) as a CSS variable.
  const headerRef = useRef<HTMLElement>(null);
  // The active view/tab (null until a widget switches it — the shell then
  // falls back to "home" or the first declared view).
  const [activeView, setActiveView] = useState<string | null>(null);
  // App-wide shared state: any widget writes via setGlobal/toggleGlobal
  // actions, any widget reads via {"$global"} bindings — cross-widget wiring.
  const [globals, setGlobals] = useState<Record<string, unknown>>({});
  const appActions = useMemo(
    () => ({
      globals,
      setView: setActiveView,
      setGlobal: (key: string, value: unknown) =>
        setGlobals((g) => ({ ...g, [key]: value })),
      toggleGlobal: (key: string) => setGlobals((g) => ({ ...g, [key]: !g[key] })),
    }),
    [globals],
  );

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () =>
      document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files).slice(0, 10);
    if (arr.length === 0) return;
    setPending((prev) =>
      [...prev, ...arr.map((file) => ({ file, previewUrl: URL.createObjectURL(file) }))].slice(
        0,
        10,
      ),
    );
  }, []);

  const removePending = useCallback((index: number) => {
    setPending((prev) => {
      const target = prev[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const refresh = useCallback(async () => {
    const [f, c] = await Promise.all([api.listFeatures(), api.listCapabilities()]);
    setFeatures(f);
    setCapabilities(c);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e?.message ?? e)));
  }, [refresh]);

  const submit = useCallback(async () => {
    const request = text.trim();
    if ((!request && pending.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    setDeclined(null);
    setStatus(
      pending.length > 0
        ? "Uploading attachments and generating…"
        : "Thinking… the orchestrator is planning and generating (this can take a minute).",
    );
    const controller = new AbortController();
    abortRef.current = controller;
    // Never hang forever: if the request stalls (server restart, proxy hiccup,
    // network stall), abort it and surface a timeout error.
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
      // Upload any attached files first, then send their metadata with the request.
      const attachments = await Promise.all(
        pending.map((p) => api.uploadFile(p.file, controller.signal)),
      );
      const result = await api.requestFeature(request, attachments, controller.signal);
      if (result.outcome === "removed") {
        // A management action, not a build — refresh so the removed widgets go.
        setText("");
        await refresh();
        const removedNames = result.removedWidgets.map((r) => r.name).join(", ");
        setStatus(
          result.removedWidgets.length > 0
            ? `Removed: ${removedNames}.`
            : "Nothing matched to remove.",
        );
        return;
      }
      if (result.outcome === "declined") {
        // Not an error — a graceful, explained decline.
        setStatus(null);
        setToast("That one can’t be built here — try something else.");
        setDeclined({ request, reason: result.userFacingReason });
        return;
      }
      const { feature } = result.artifact;
      setText("");
      pending.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPending([]);
      await refresh();
      if (result.pendingCapabilityApprovals.length > 0) {
        setStatus(
          `Built "${feature.name}". New capabilities need approval in the dev panel: ${result.pendingCapabilityApprovals.join(", ")}`,
        );
      } else {
        setStatus(
          result.servedFromCache
            ? `Served "${feature.name}" instantly from cache.`
            : `Built "${feature.name}".`,
        );
      }
    } catch (e) {
      if (timedOut) {
        setStatus(null);
        setError(
          `Request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s — the server didn't respond. Please try again.`,
        );
      } else if (controller.signal.aborted || (e as Error)?.name === "AbortError") {
        setStatus("Request cancelled.");
      } else {
        setError(String((e as Error)?.message ?? e));
        setStatus(null);
      }
    } finally {
      clearTimeout(timeoutId);
      abortRef.current = null;
      setBusy(false);
    }
  }, [text, pending, busy, refresh]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const approve = useCallback(
    async (key: string) => {
      await api.approveCapability(key);
      await refresh();
    },
    [refresh],
  );

  const clearAll = useCallback(async () => {
    if (
      !window.confirm(
        "Remove all widgets from the dashboard? They stay cached — asking for one again brings it back instantly.",
      )
    ) {
      return;
    }
    try {
      const { cleared } = await api.clearDashboard();
      await refresh();
      setStatus(
        cleared > 0
          ? `Cleared ${cleared} widget${cleared === 1 ? "" : "s"} — all of them stay cached for instant reuse.`
          : "Dashboard is already empty.",
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, [refresh]);

  // ---- views (tabs/pages) -------------------------------------------------
  // Widgets may declare presentation.view: they render only while that view is
  // active. Widgets WITHOUT a view (menus, backgrounds) render in every view.
  // Views are switched by widgets via the "setView:<name>" action.
  const viewOf = (f: FeatureRecord) => f.definition.presentation?.view;
  const views = useMemo(
    () => [...new Set(features.map(viewOf).filter((v): v is string => Boolean(v)))],
    [features],
  );
  // Landing view: "home" by convention, else the first declared view.
  const effectiveView =
    activeView && views.includes(activeView)
      ? activeView
      : views.includes("home")
        ? "home"
        : (views[0] ?? null);
  const inView = (f: FeatureRecord) => {
    const v = viewOf(f);
    return !v || v === effectiveView;
  };

  const placementOf = (f: FeatureRecord) => f.definition.presentation?.placement ?? "flow";
  const backgroundFeatures = features.filter(
    (f) => placementOf(f) === "background" && inView(f),
  );
  const pinnedFeatures = features.filter((f) => placementOf(f) === "pinned" && inView(f));
  // Flow widgets honor presentation.order (0 = first); unordered ones keep
  // their creation order after the ordered ones (stable sort).
  const flowFeatures = features
    .filter((f) => placementOf(f) === "flow" && inView(f))
    .sort(
      (a, b) =>
        (a.definition.presentation?.order ?? Number.MAX_SAFE_INTEGER) -
        (b.definition.presentation?.order ?? Number.MAX_SAFE_INTEGER),
    );

  return (
    <AppActionsContext.Provider value={appActions}>
      {/* Full-viewport layer behind the app for "background" widgets. */}
      {backgroundFeatures.length > 0 && (
        <div className="background-layer">
          {backgroundFeatures.map((f) => (
            <WidgetHost key={f.id} feature={f} />
          ))}
        </div>
      )}
      <div className="app">
      <header className="app-header" ref={headerRef}>
        <h1>Add a feature</h1>
        <div
          className={`ask ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <input
            type="file"
            multiple
            accept="*/*"
            ref={fileInputRef}
            style={{ display: "none" }}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            className="attach-btn"
            title="Attach images, screenshots, audio, or any file"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            📎
          </button>
          <textarea
            className="ask-text"
            rows={2}
            value={text}
            placeholder="Ask for any feature… e.g. “a todo list”, “a cat gif top-right”, or attach a file"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits; Shift+Enter inserts a newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            disabled={busy}
          />
          <button onClick={submit} disabled={busy || (!text.trim() && pending.length === 0)}>
            {busy ? "Generating…" : "Add"}
          </button>
          {busy && (
            <button className="cancel-btn" onClick={cancel} title="Cancel this request">
              Cancel
            </button>
          )}
          <button
            className="clear-all-btn"
            onClick={clearAll}
            disabled={busy || features.length === 0}
            title="Remove every widget from the dashboard (they stay cached for instant reuse)"
          >
            Clear all
          </button>
        </div>

        {pending.length > 0 && (
          <div className="attachments">
            {pending.map((p, i) => (
              <div className="attach-chip" key={i}>
                {p.file.type.startsWith("image/") ? (
                  <img src={p.previewUrl} alt={p.file.name} className="attach-thumb" />
                ) : (
                  <span className="attach-icon">
                    {p.file.type.startsWith("audio/")
                      ? "🎵"
                      : p.file.type.startsWith("video/")
                        ? "🎬"
                        : "📄"}
                  </span>
                )}
                <span className="attach-name">{p.file.name}</span>
                <button
                  className="attach-remove"
                  onClick={() => removePending(i)}
                  aria-label={`Remove ${p.file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {status && <p className="status">{status}</p>}
        {error && <p className="error">{error}</p>}

        {declined && (
          <div className="declined-notice">
            <div className="declined-head">
              <span>Couldn’t build “{declined.request}”.</span>
              <button
                className="declined-dismiss"
                onClick={() => setDeclined(null)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <details className="declined-details">
              <summary>Why? (from the assistant)</summary>
              <p className="declined-reason">{declined.reason}</p>
            </details>
          </div>
        )}
      </header>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <main className="dashboard">
        {flowFeatures.length === 0 && (
          <p className="muted empty-dash">No widgets yet — ask for one above.</p>
        )}
        {flowFeatures.map((f) => {
          const size = f.definition.presentation?.size;
          const span = size?.gridColumnSpan;
          // Content-sized by default (CSS fit-content); explicit size wins.
          const style: React.CSSProperties = {};
          if (span) style.gridColumn = `span ${span}`;
          if (size?.width) style.width = size.width;
          if (size?.height) style.height = size.height;
          return (
            <div
              className="widget-slot"
              key={f.id}
              style={Object.keys(style).length ? style : undefined}
            >
              <Surfaced feature={f} />
            </div>
          );
        })}
      </main>

      {/* Pinned widgets float above the app — the shell positions each one
          from presentation.anchor / size / zIndex. */}
      {pinnedFeatures.map((f) => (
        <div key={f.id} style={pinnedStyle(f.definition.presentation)}>
          <Surfaced feature={f} />
        </div>
      ))}

      <DevPanel capabilities={capabilities} onApprove={approve} />
      </div>
    </AppActionsContext.Provider>
  );
}
