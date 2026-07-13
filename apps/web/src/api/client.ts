import type { Attachment, WidgetDefinition } from "@myday/schema";

export type { Attachment } from "@myday/schema";

export interface DataRow {
  id: string;
  row: Record<string, unknown>;
}

export interface FeatureRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  definition: WidgetDefinition;
  createdAt?: string;
}

export interface ComponentRecord {
  key: string;
  name: string;
  version: number;
  description: string;
}

export interface CapabilityRecord {
  key: string;
  name: string;
  description: string;
  domainAllowlist: string[];
  reviewRequired: boolean;
  approved: boolean;
}

export type RequestFeatureResult =
  | {
      declined: false;
      feature: FeatureRecord;
      cached: boolean;
      pendingApprovals: string[];
    }
  | {
      declined: true;
      /** LLM-authored explanation of exactly why the request couldn't be built. */
      reason: string;
    }
  | {
      /** Widgets removed from the dashboard by this request. */
      removed: Array<{ id: string; name: string }>;
    };

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

/** Reads a File as base64 (strips the data: URL prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export const api = {
  async uploadFile(file: File, signal?: AbortSignal): Promise<Attachment> {
    const dataBase64 = await fileToBase64(file);
    return http<Attachment>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name || "file",
        mimeType: file.type || "application/octet-stream",
        dataBase64,
      }),
      signal,
    });
  },
  requestFeature(
    text: string,
    attachments: Attachment[] = [],
    signal?: AbortSignal,
  ): Promise<RequestFeatureResult> {
    return http("/api/features/request", {
      method: "POST",
      body: JSON.stringify({ text, attachments }),
      signal,
    });
  },
  listFeatures(): Promise<FeatureRecord[]> {
    return http("/api/features");
  },
  listComponents(): Promise<ComponentRecord[]> {
    return http("/api/components");
  },
  listCapabilities(): Promise<CapabilityRecord[]> {
    return http("/api/capabilities");
  },
  approveCapability(key: string): Promise<CapabilityRecord> {
    return http(`/api/capabilities/${encodeURIComponent(key)}/approve`, {
      method: "POST",
    });
  },
  dataList(featureId: string): Promise<DataRow[]> {
    return http(`/api/data/${encodeURIComponent(featureId)}`);
  },
  dataAdd(featureId: string, row: Record<string, unknown>): Promise<DataRow> {
    return http(`/api/data/${encodeURIComponent(featureId)}`, {
      method: "POST",
      body: JSON.stringify({ row }),
    });
  },
  dataPatch(
    featureId: string,
    rowId: string,
    patch: Record<string, unknown>,
  ): Promise<DataRow> {
    return http(
      `/api/data/${encodeURIComponent(featureId)}/${encodeURIComponent(rowId)}`,
      { method: "PATCH", body: JSON.stringify({ patch }) },
    );
  },
  dataDelete(featureId: string, rowId: string): Promise<void> {
    return http(
      `/api/data/${encodeURIComponent(featureId)}/${encodeURIComponent(rowId)}`,
      { method: "DELETE" },
    );
  },
};
