import type {
  AdvanceWorldInput,
  DebugModeInput,
  DebugNextInput,
  ControlTransferInput,
  ControlOptions,
  CreateInstanceInput,
  PublicInstanceDetail,
  RequestSuggestionsInput,
  PublicInstanceSummary,
  SubmitExternalActionInput,
  SubmitExternalReactionInput,
  WorldStartOptions,
  WorldSummary,
  WorldRunControlInput,
} from "../../shared/world-api";
import type { WorldObserverDetail } from "../../shared/world-observer-api";
import { requestJson } from "./api-client";

export { WorldApiError } from "./api-client";

function body(method: "POST" | "PUT" | "PATCH", value: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export const worldApi = {
  worlds: () => requestJson<{ worlds: WorldSummary[] }>("/api/worlds"),
  instances: () => requestJson<{ instances: PublicInstanceSummary[] }>("/api/instances"),
  worldStartOptions: (worldId: string) =>
    requestJson<WorldStartOptions>(`/api/worlds/${encodeURIComponent(worldId)}/start-options`),
  createInstance: (input: CreateInstanceInput) =>
    requestJson<PublicInstanceDetail>("/api/instances", body("POST", input)),
  instance: (id: string) => requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}`),
  observer: (id: string, agentId?: string) => requestJson<WorldObserverDetail>(
    `/api/instances/${encodeURIComponent(id)}/observer${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
  ),
  instanceEventsUrl: (id: string) => `/api/instances/${encodeURIComponent(id)}/events`,
  renameInstance: (id: string, title: string) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}`, body("PATCH", { title })),
  deleteInstance: (id: string) =>
    requestJson<void>(`/api/instances/${encodeURIComponent(id)}`, { method: "DELETE" }),
  advance: (id: string, input: AdvanceWorldInput) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}/advance`, body("POST", input)),
  setDebugMode: (id: string, input: DebugModeInput) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}/debug`, body("PUT", input)),
  realtime: (id: string, enabled: boolean) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}/realtime`, body("PUT", { enabled })),
  transferControl: (id: string, input: ControlTransferInput) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}/control`, body("PUT", input)),
  controlOptions: (id: string) =>
    requestJson<ControlOptions>(`/api/instances/${encodeURIComponent(id)}/control`),
  requestSuggestions: (id: string, participantId: string, input: RequestSuggestionsInput) =>
    requestJson<PublicInstanceDetail>(
      `/api/instances/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}/suggestions`,
      body("POST", input),
    ),
  submitAction: (id: string, participantId: string, input: SubmitExternalActionInput) =>
    requestJson<PublicInstanceDetail>(
      `/api/instances/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}/actions`,
      body("POST", input),
    ),
  submitReaction: (id: string, participantId: string, input: SubmitExternalReactionInput) =>
    requestJson<PublicInstanceDetail>(
      `/api/instances/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}/reactions`,
      body("POST", input),
    ),
  pauseRun: (id: string, input: WorldRunControlInput) =>
    requestJson<PublicInstanceDetail>(
      `/api/instances/${encodeURIComponent(id)}/run/pause`,
      body("POST", input),
    ),
  resumeRun: (id: string, input: WorldRunControlInput) =>
    requestJson<PublicInstanceDetail>(
      `/api/instances/${encodeURIComponent(id)}/run/resume`,
      body("POST", input),
    ),
  nextDebugStep: (id: string, input: DebugNextInput) =>
    requestJson<PublicInstanceDetail>(`/api/instances/${encodeURIComponent(id)}/run/next`, body("POST", input)),
  importWorld: (file: File, options: { replace?: boolean; expectedWorldId?: string } = {}) => {
    const form = new FormData();
    form.set("file", file);
    form.set("replace", String(options.replace === true));
    if (options.expectedWorldId) form.set("expectedWorldId", options.expectedWorldId);
    return requestJson<{ id: string; name: string; description: string; replaced: boolean }>(
      "/api/worlds/import",
      { method: "POST", body: form },
    );
  },
  deleteWorld: (worldId: string) =>
    requestJson<void>(`/api/worlds/${encodeURIComponent(worldId)}`, { method: "DELETE" }),
};
