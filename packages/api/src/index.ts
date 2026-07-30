import type {
  EditorialProjectSnapshot,
  AssetProjectSnapshot,
  ActivitySnapshot,
  AgentTaskStatus,
  IntakeProjectSnapshot,
  LedgerProjectSnapshot,
  MediaProjectSnapshot,
  OutputFormat,
  PreviewArtifactSnapshot,
  ProjectEvent,
  ProjectOperation,
  ProjectSnapshot,
  RenderJobSnapshot,
  RevisionBoundShotProposalSubmission,
  ShotPlanningRequest,
  TranscriptWord,
} from '../../model/src/index.ts';

export type MutationInput = {
  expectedRevision: number;
  operation: ProjectOperation;
  payload: Record<string, unknown>;
};

export type LedgerOperationInput =
  | { kind: 'reorder'; shotIds: string[] }
  | { kind: 'cut'; shotId: string }
  | { atWordOrdinal: number; kind: 'split'; shotId: string }
  | { kind: 'merge'; leftShotId: string; rightShotId: string }
  | {
      endWordOrdinal: number;
      kind: 'trim';
      shotId: string;
      startWordOrdinal: number;
    };

type ClientOptions = {
  baseUrl: string;
  credential?: string;
  fetch?: typeof globalThis.fetch;
};

export class RantApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RantApiError';
  }
}

export class RantClient {
  readonly #authorization: Record<string, string>;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.#authorization = options.credential
      ? { authorization: `Bearer ${options.credential}` }
      : {};
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createProject(name: string): Promise<ProjectSnapshot> {
    return this.#request('/v1/projects', {
      body: JSON.stringify({ name }),
      method: 'POST',
    });
  }

  async getProject(projectId: string): Promise<ProjectSnapshot> {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}`);
  }

  async getIntake(projectId: string): Promise<IntakeProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/intake`,
    );
  }

  async uploadNarration(
    projectId: string,
    input: {
      bytesBase64: string;
      expectedRevision: number;
      mimeType: string;
      originalName: string;
    },
  ): Promise<IntakeProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/audio`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
  }

  async importNarrationPath(
    projectId: string,
    input: { expectedRevision: number; path: string },
  ): Promise<IntakeProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/audio-path`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
  }

  async importTranscript(
    projectId: string,
    input: {
      expectedRevision: number;
      raw: unknown;
      words: Array<Pick<TranscriptWord, 'text' | 'startMs' | 'endMs'>>;
    },
  ): Promise<IntakeProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/transcript-import`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
  }

  async runTranscription(
    projectId: string,
    input: { expectedRevision: number },
  ): Promise<IntakeProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/transcriptions`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
  }

  async getEditorial(projectId: string): Promise<EditorialProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/editorial`,
    );
  }

  async correctTranscript(
    projectId: string,
    input: {
      expectedRevision: number;
      replacementText: string;
      wordId: string;
    },
  ): Promise<EditorialProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/corrections`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
  }

  async createProposalTask(
    projectId: string,
    input: {
      constraints: Record<string, unknown> & {
        planning?: ShotPlanningRequest;
      };
      expectedRevision: number;
      instruction: string;
      pacing: string;
    },
  ): Promise<{ id: string; status: string }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposal-tasks`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async attachAgent(
    projectId: string,
  ): Promise<{ id: string; status: string }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/agent-sessions`,
      { body: '{}', method: 'POST' },
    );
  }

  async claimProposalTask(
    projectId: string,
    taskId: string,
    sessionId: string,
  ): Promise<{ id: string; status: string }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposal-tasks/${encodeURIComponent(taskId)}/claim`,
      { body: JSON.stringify({ sessionId }), method: 'POST' },
    );
  }

  async submitShotProposal(
    projectId: string,
    taskId: string,
    input: RevisionBoundShotProposalSubmission,
  ): Promise<{ id: string; status: string }> {
    const shots = structuredClone(input.shots);
    Object.assign(shots[0] ?? {}, {
      proposalSummary: input.summary,
      shotCountRationale: input.shotCountRationale,
    });
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposal-tasks/${encodeURIComponent(taskId)}/proposals`,
      { body: JSON.stringify({ ...input, shots }), method: 'POST' },
    );
  }

  async acceptShotProposal(
    projectId: string,
    proposalId: string,
    input: { expectedRevision: number },
  ): Promise<EditorialProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/accept`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async adjustShotProposal(
    projectId: string,
    proposalId: string,
    input: { shots: EditorialProjectSnapshot['proposals'][number]['shots'] },
  ): Promise<EditorialProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/adjust`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async rejectShotProposal(
    projectId: string,
    proposalId: string,
  ): Promise<EditorialProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}/reject`,
      { body: '{}', method: 'POST' },
    );
  }

  async getLedger(projectId: string): Promise<LedgerProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/ledger`,
    );
  }

  async editLedger(
    projectId: string,
    input: { expectedRevision: number; operation: LedgerOperationInput },
  ): Promise<LedgerProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/ledger-edits`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async createLedgerCheckpoint(
    projectId: string,
    input: { expectedRevision: number; name: string },
  ): Promise<{ id: string; name: string; revision: number }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/ledger-checkpoints`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async restoreLedgerCheckpoint(
    projectId: string,
    checkpointId: string,
    input: { expectedRevision: number },
  ): Promise<LedgerProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/ledger-checkpoints/${encodeURIComponent(checkpointId)}/restore`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async undoLedger(
    projectId: string,
    input: { expectedRevision: number },
  ): Promise<LedgerProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/ledger-undo`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async getAssets(projectId: string): Promise<AssetProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/assets`,
    );
  }

  async uploadVisualCandidate(
    projectId: string,
    input: {
      bytesBase64: string;
      expectedRevision: number;
      mimeType: string;
      originalName: string;
      shotIds: string[];
      taskId?: string;
    },
  ): Promise<AssetProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/asset-candidates`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async selectVisual(
    projectId: string,
    input: {
      assetId: string;
      expectedRevision: number;
      shotId: string;
    },
  ): Promise<AssetProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(input.shotId)}/selection`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async clearVisual(
    projectId: string,
    input: { expectedRevision: number; shotId: string },
  ): Promise<AssetProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(input.shotId)}/selection`,
      { body: JSON.stringify(input), method: 'DELETE' },
    );
  }

  async recommendVisual(
    projectId: string,
    input: {
      assetId: string;
      expectedRevision: number;
      reason: string;
      shotId: string;
    },
  ): Promise<AssetProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(input.shotId)}/recommendations`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async createAssetTask(
    projectId: string,
    input: {
      expectedRevision: number;
      instruction: string;
      shotIds: string[];
    },
  ): Promise<ActivitySnapshot['tasks'][number]> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/asset-tasks`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async claimTask(
    projectId: string,
    taskId: string,
    input: { leaseMs?: number; sessionId: string },
  ): Promise<ActivitySnapshot['tasks'][number]> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/claim`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async transitionTask(
    projectId: string,
    taskId: string,
    input: {
      expectedProjectRevision: number;
      idempotencyKey: string;
      status: AgentTaskStatus;
      summary?: string;
    },
  ): Promise<{
    id: string;
    receipt: ActivitySnapshot['receipts'][number] | null;
    status: AgentTaskStatus;
  }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/transitions`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async getActivity(
    projectId: string,
    filter: { status?: AgentTaskStatus } = {},
  ): Promise<ActivitySnapshot> {
    const query = filter.status
      ? `?status=${encodeURIComponent(filter.status)}`
      : '';
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/activity${query}`,
    );
  }

  async heartbeatTask(
    projectId: string,
    taskId: string,
    input: { leaseMs?: number } = {},
  ): Promise<{ expiresAt: string; status: AgentTaskStatus }> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/heartbeat`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async retryTask(
    projectId: string,
    taskId: string,
    input: { expectedProjectRevision: number },
  ): Promise<ActivitySnapshot['tasks'][number]> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async getMedia(projectId: string): Promise<MediaProjectSnapshot> {
    return this.#request(`/v1/projects/${encodeURIComponent(projectId)}/media`);
  }

  async createPreview(
    projectId: string,
    input: {
      expectedRevision: number;
      format: OutputFormat;
      shotId?: string;
    },
  ): Promise<PreviewArtifactSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/previews`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async getPreviewArtifact(
    projectId: string,
    previewId: string,
  ): Promise<Blob> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(projectId)}/previews/${encodeURIComponent(previewId)}`,
      { headers: this.#authorization },
    );
    if (!response.ok) {
      throw new RantApiError(
        'PREVIEW_FETCH_FAILED',
        `Preview request failed with ${response.status}`,
        response.status,
      );
    }
    return response.blob();
  }

  subscribeEvents(
    listener: (event: ProjectEvent) => void,
    options: { onError?: (error: unknown) => void } = {},
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await this.#fetch(`${this.#baseUrl}/v1/events`, {
          headers: {
            accept: 'text/event-stream',
            ...this.#authorization,
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new RantApiError(
            'EVENT_STREAM_FAILED',
            `Event stream failed with ${response.status}`,
            response.status,
          );
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replaceAll('\r\n', '\n');
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) listener(JSON.parse(data) as ProjectEvent);
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) options.onError?.(error);
      }
    })();
    return () => controller.abort();
  }

  async getPreflight(
    projectId: string,
  ): Promise<MediaProjectSnapshot['preflight']> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/preflight`,
    );
  }

  async setFormatOverride(
    projectId: string,
    shotId: string,
    input: {
      captionsEnabled: boolean;
      expectedRevision: number;
      fit: 'cover' | 'contain';
      format: OutputFormat;
    },
  ): Promise<MediaProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}/format-overrides`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async createRenderJob(
    projectId: string,
    input: {
      allowPlaceholders: boolean;
      expectedRevision: number;
      formats: OutputFormat[];
    },
  ): Promise<RenderJobSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/render-jobs`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async runRenderJob(
    projectId: string,
    jobId: string,
  ): Promise<RenderJobSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/render-jobs/${encodeURIComponent(jobId)}/run`,
      { body: '{}', method: 'POST' },
    );
  }

  async cancelRenderJob(
    projectId: string,
    jobId: string,
  ): Promise<RenderJobSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/render-jobs/${encodeURIComponent(jobId)}/cancel`,
      { body: '{}', method: 'POST' },
    );
  }

  async retryRenderJob(
    projectId: string,
    jobId: string,
    input: { expectedProjectRevision: number },
  ): Promise<RenderJobSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/render-jobs/${encodeURIComponent(jobId)}/retry`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  }

  async getRenderArtifact(
    projectId: string,
    artifactId: string,
  ): Promise<Blob> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        headers: this.#authorization,
      },
    );
    if (!response.ok) {
      throw new RantApiError(
        'ARTIFACT_FETCH_FAILED',
        `Artifact request failed with ${response.status}`,
        response.status,
      );
    }
    return response.blob();
  }

  async mutateProject(
    projectId: string,
    mutation: MutationInput,
  ): Promise<ProjectSnapshot> {
    return this.#request(
      `/v1/projects/${encodeURIComponent(projectId)}/mutations`,
      {
        body: JSON.stringify(mutation),
        method: 'POST',
      },
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.#authorization,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    const payload = (await response.json()) as
      T | { error: { code: string; message: string } };
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } })
        .error;
      throw new RantApiError(
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `Request failed with ${response.status}`,
        response.status,
      );
    }
    return payload as T;
  }
}
