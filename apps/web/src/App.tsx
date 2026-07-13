import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  type CapabilityRecord,
  type FeatureRecord,
} from "./api/client";
import { WidgetHost } from "./WidgetHost";

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
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    setDeclined(null);
    setStatus("Thinking… the orchestrator is planning and generating (this can take a minute).");
    try {
      const result = await api.requestFeature(request);
      if (result.declined) {
        // Not an error — a graceful, explained decline.
        setStatus(null);
        setToast("That one can’t be built here — try something else.");
        setDeclined({ request, reason: result.reason });
        return;
      }
      setText("");
      await refresh();
      if (result.pendingApprovals.length > 0) {
        setStatus(
          `Built "${result.feature.name}". New capabilities need approval in the dev panel: ${result.pendingApprovals.join(", ")}`,
        );
      } else {
        setStatus(
          result.cached
            ? `Served "${result.feature.name}" instantly from cache.`
            : `Built "${result.feature.name}".`,
        );
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [text, busy, refresh]);

  const approve = useCallback(
    async (key: string) => {
      await api.approveCapability(key);
      await refresh();
    },
    [refresh],
  );

  const flowFeatures = features.filter((f) => f.definition.placement !== "pinned");
  const pinnedFeatures = features.filter((f) => f.definition.placement === "pinned");

  return (
    <div className="app">
      <header className="app-header">
        <h1>My Day</h1>
        <div className="ask">
          <input
            value={text}
            placeholder="Ask for any feature… e.g. “a todo list” or “a cat gif top-right”"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
          />
          <button onClick={submit} disabled={busy || !text.trim()}>
            {busy ? "Generating…" : "Add"}
          </button>
        </div>
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
        {flowFeatures.map((f) => (
          <div className="widget-slot" key={f.id}>
            <WidgetHost feature={f} />
          </div>
        ))}
      </main>

      {/* Pinned widgets render in the overlay layer (their roots use Overlay). */}
      <div className="overlay-layer">
        {pinnedFeatures.map((f) => (
          <WidgetHost key={f.id} feature={f} />
        ))}
      </div>

      <DevPanel capabilities={capabilities} onApprove={approve} />
    </div>
  );
}
