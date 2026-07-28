import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { renderProject } from '../../media-worker/src/index.ts';
import {
  AuthorityError,
  type OutputFormat,
  type ProjectEvent,
  type ProjectOperation,
} from '../../../packages/model/src/index.ts';
import {
  DeterministicTranscriptProvider,
  type TranscriptProvider,
} from '../../../packages/transcription/src/index.ts';
import { ProjectStore, StoreError } from './store.ts';

const operationScopes: Record<ProjectOperation, string> = {
  accept_proposal: 'proposal:accept',
  adjust_proposal: 'proposal:adjust',
  add_note: 'note:add',
  attach_candidate: 'asset:add',
  change_output_settings: 'output:write',
  change_shots: 'shot:write',
  correct_transcript: 'transcript:write',
  create_proposal_task: 'task:create',
  create_project: 'project:create',
  export_incomplete: 'export:incomplete',
  import_transcript: 'transcript:write',
  ingest_narration: 'audio:write',
  recommend_candidate: 'asset:recommend',
  reject_proposal: 'proposal:reject',
  run_transcription: 'transcript:write',
  select_visual: 'visual:select',
  submit_proposal: 'proposal:write',
};

function assertScope(scopes: string[], required: string): void {
  if (scopes.includes('project:*') || scopes.includes(required)) return;
  throw new StoreError(
    'FORBIDDEN',
    `Credential requires the ${required} scope`,
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readJson(
  request: AsyncIterable<Buffer>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

function statusFor(error: unknown): number {
  if (error instanceof AuthorityError) return 403;
  if (error instanceof StoreError) {
    if (error.code === 'UNAUTHORIZED') return 401;
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'NOT_FOUND') return 404;
    if (error.code === 'REVISION_CONFLICT') return 409;
    if (
      error.code === 'INVALID_INPUT' ||
      error.code === 'INVALID_TRANSCRIPT' ||
      error.code === 'INVALID_PROPOSAL' ||
      error.code === 'SECRET_MATERIAL' ||
      error.code === 'UNSAFE_PATH' ||
      error.code === 'UNSUPPORTED_MEDIA' ||
      error.code === 'PREFLIGHT_BLOCKED'
    )
      return 400;
    if (error.code === 'PROVIDER_FAILED') return 502;
    if (
      error.code === 'DETACHED_AGENT' ||
      error.code === 'INVALID_TASK_TRANSITION' ||
      error.code === 'STALE_PROPOSAL' ||
      error.code === 'STALE_TASK' ||
      error.code === 'TASK_UNAVAILABLE' ||
      error.code === 'PLACEHOLDER_APPROVAL_REQUIRED'
    )
      return 409;
  }
  return 500;
}

function codeFor(error: unknown): string {
  if (error instanceof AuthorityError) return error.code;
  if (error instanceof StoreError) return error.code;
  return 'INTERNAL_ERROR';
}

export async function startLocalService(options: {
  port?: number;
  provider?: TranscriptProvider;
  store: ProjectStore;
}): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const requestOrigin = request.headers.origin;
      if (requestOrigin) {
        const origin = new URL(requestOrigin);
        if (
          origin.hostname === '127.0.0.1' ||
          origin.hostname === 'localhost' ||
          origin.hostname.endsWith('.localhost')
        ) {
          response.setHeader('access-control-allow-origin', requestOrigin);
          response.setHeader('vary', 'origin');
        }
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'DELETE, GET, POST, OPTIONS',
        });
        response.end();
        return;
      }
      if (url.pathname === '/v1/health' && request.method === 'GET') {
        json(response, 200, { ok: true });
        return;
      }
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) {
        throw new StoreError('UNAUTHORIZED', 'Bearer credential required');
      }
      const identity = options.store.authenticate(authorization.slice(7));

      if (url.pathname === '/v1/events' && request.method === 'GET') {
        assertScope(identity.scopes, 'project:read');
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
        });
        response.flushHeaders();
        response.write(': connected\n\n');
        const send = (event: ProjectEvent) => {
          response.write(`event: project\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const unsubscribe = options.store.subscribe(send);
        request.once('close', unsubscribe);
        return;
      }

      if (url.pathname === '/v1/projects' && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.create_project);
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.createProject({
            actor: identity.actor,
            name: typeof body.name === 'string' ? body.name : '',
          }),
        );
        return;
      }

      const projectMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)(?:\/(mutations|intake|audio|audio-path|transcript-import|transcriptions|editorial|corrections|proposal-tasks|agent-sessions|ledger|ledger-edits|ledger-checkpoints|ledger-undo|assets|asset-candidates|asset-tasks|activity|media|preflight|previews|render-jobs))?$/,
      );
      if (projectMatch && request.method === 'GET' && !projectMatch[2]) {
        assertScope(identity.scopes, 'project:read');
        json(
          response,
          200,
          options.store.getProject(decodeURIComponent(projectMatch[1])),
        );
        return;
      }
      if (projectMatch?.[2] === 'mutations' && request.method === 'POST') {
        const body = await readJson(request);
        const operation = body.operation as ProjectOperation;
        const requiredScope = operationScopes[operation];
        if (!requiredScope) {
          throw new StoreError(
            'FORBIDDEN',
            `Unknown project operation: ${String(operation)}`,
          );
        }
        assertScope(identity.scopes, requiredScope);
        json(
          response,
          200,
          options.store.applyMutation({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            operation,
            payload:
              body.payload && typeof body.payload === 'object'
                ? (body.payload as Record<string, unknown>)
                : {},
            projectId: decodeURIComponent(projectMatch[1]),
          }),
        );
        return;
      }
      if (projectMatch?.[2] === 'previews' && request.method === 'POST') {
        assertScope(identity.scopes, 'project:read');
        const projectId = decodeURIComponent(projectMatch[1]);
        const body = await readJson(request);
        const format = String(body.format ?? '') as OutputFormat;
        const shotId =
          typeof body.shotId === 'string' ? body.shotId : undefined;
        const plan = options.store.getPreviewPlan({
          expectedRevision: Number(body.expectedRevision),
          format,
          projectId,
          shotId,
        });
        const id = randomUUID();
        const [artifact] = renderProject(plan, {
          formats: [format],
          jobId: `preview-${id}`,
          managedRoot: options.store.managedRoot,
        });
        json(response, 201, {
          baseRevision: plan.baseRevision,
          durationMs: artifact!.durationMs,
          format,
          id,
          shotId: shotId ?? null,
        });
        return;
      }
      const projectId = projectMatch?.[1]
        ? decodeURIComponent(projectMatch[1])
        : undefined;
      if (
        projectId &&
        projectMatch?.[2] === 'intake' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getIntakeProject(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'audio' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.ingest_narration);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.ingestNarration({
            actor: identity.actor,
            bytes: Buffer.from(String(body.bytesBase64 ?? ''), 'base64'),
            expectedRevision: Number(body.expectedRevision),
            mimeType: String(body.mimeType ?? ''),
            originalName: String(body.originalName ?? ''),
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'audio-path' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.ingest_narration);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.ingestNarrationPath({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            path: String(body.path ?? ''),
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'transcript-import' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.import_transcript);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.importTranscript({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId,
            raw: body.raw,
            words: Array.isArray(body.words) ? (body.words as never) : [],
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'ledger' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getLedgerProject(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'assets' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getAssetProject(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'media' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getMediaProject(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'preflight' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getPreflight(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'render-jobs' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, 'output:write');
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.createRenderJob({
            actor: identity.actor,
            allowPlaceholders: body.allowPlaceholders === true,
            expectedRevision: Number(body.expectedRevision),
            formats: Array.isArray(body.formats)
              ? (body.formats.map(String) as OutputFormat[])
              : [],
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'asset-tasks' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, 'task:create');
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.createAssetTask({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            instruction: String(body.instruction ?? ''),
            projectId,
            shotIds: Array.isArray(body.shotIds)
              ? body.shotIds.map(String)
              : [],
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'activity' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(
          response,
          200,
          options.store.getActivity(projectId, {
            status: (url.searchParams.get('status') ?? undefined) as never,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'asset-candidates' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.attach_candidate);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.uploadVisualCandidate({
            actor: identity.actor,
            bytes: Buffer.from(String(body.bytesBase64 ?? ''), 'base64'),
            expectedRevision: Number(body.expectedRevision),
            mimeType: String(body.mimeType ?? ''),
            originalName: String(body.originalName ?? ''),
            projectId,
            shotIds: Array.isArray(body.shotIds)
              ? body.shotIds.map(String)
              : [],
            taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
            credentialHash: identity.credentialHash,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'ledger-edits' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.change_shots);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.editLedger({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            operation: body.operation as never,
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'ledger-checkpoints' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.change_shots);
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.createLedgerCheckpoint({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            name: String(body.name ?? ''),
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'ledger-undo' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.change_shots);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.undoLedger({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId,
          }),
        );
        return;
      }

      const restoreMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/ledger-checkpoints\/([^/]+)\/restore$/,
      );
      if (restoreMatch && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.change_shots);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.restoreLedgerCheckpoint({
            actor: identity.actor,
            checkpointId: decodeURIComponent(restoreMatch[2]),
            expectedRevision: Number(body.expectedRevision),
            projectId: decodeURIComponent(restoreMatch[1]),
          }),
        );
        return;
      }
      const selectionMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/shots\/([^/]+)\/selection$/,
      );
      if (selectionMatch && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.select_visual);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.selectVisual({
            actor: identity.actor,
            assetId: String(body.assetId ?? ''),
            expectedRevision: Number(body.expectedRevision),
            projectId: decodeURIComponent(selectionMatch[1]),
            shotId: decodeURIComponent(selectionMatch[2]),
          }),
        );
        return;
      }
      if (selectionMatch && request.method === 'DELETE') {
        assertScope(identity.scopes, operationScopes.select_visual);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.clearVisual({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId: decodeURIComponent(selectionMatch[1]),
            shotId: decodeURIComponent(selectionMatch[2]),
          }),
        );
        return;
      }
      const recommendationMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/shots\/([^/]+)\/recommendations$/,
      );
      if (recommendationMatch && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.recommend_candidate);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.recommendVisual({
            actor: identity.actor,
            assetId: String(body.assetId ?? ''),
            expectedRevision: Number(body.expectedRevision),
            projectId: decodeURIComponent(recommendationMatch[1]),
            reason: String(body.reason ?? ''),
            shotId: decodeURIComponent(recommendationMatch[2]),
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'editorial' &&
        request.method === 'GET'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(response, 200, options.store.getEditorialProject(projectId));
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'corrections' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.correct_transcript);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.correctTranscript({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId,
            replacementText: String(body.replacementText ?? ''),
            wordId: String(body.wordId ?? ''),
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'proposal-tasks' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.create_proposal_task);
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.createProposalTask({
            actor: identity.actor,
            constraints:
              body.constraints && typeof body.constraints === 'object'
                ? (body.constraints as Record<string, unknown>)
                : {},
            expectedRevision: Number(body.expectedRevision),
            instruction: String(body.instruction ?? ''),
            pacing: String(body.pacing ?? 'Standard'),
            projectId,
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'agent-sessions' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, 'project:read');
        json(
          response,
          201,
          options.store.attachAgent({
            actor: identity.actor,
            credentialHash: identity.credentialHash,
            projectId,
          }),
        );
        return;
      }

      const claimMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/proposal-tasks\/([^/]+)\/claim$/,
      );
      if (claimMatch && request.method === 'POST') {
        assertScope(identity.scopes, 'task:claim');
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.claimProposalTask({
            actor: identity.actor,
            projectId: decodeURIComponent(claimMatch[1]),
            sessionId: String(body.sessionId ?? ''),
            taskId: decodeURIComponent(claimMatch[2]),
          }),
        );
        return;
      }
      const taskClaimMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/claim$/,
      );
      if (taskClaimMatch && request.method === 'POST') {
        assertScope(identity.scopes, 'task:claim');
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.claimTask({
            actor: identity.actor,
            credentialHash: identity.credentialHash,
            leaseMs:
              typeof body.leaseMs === 'number' ? body.leaseMs : undefined,
            projectId: decodeURIComponent(taskClaimMatch[1]),
            sessionId: String(body.sessionId ?? ''),
            taskId: decodeURIComponent(taskClaimMatch[2]),
          }),
        );
        return;
      }
      const taskTransitionMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/transitions$/,
      );
      if (taskTransitionMatch && request.method === 'POST') {
        assertScope(
          identity.scopes,
          identity.actor.kind === 'human' ? 'task:create' : 'task:claim',
        );
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.transitionTask({
            actor: identity.actor,
            credentialHash: identity.credentialHash,
            expectedProjectRevision: Number(body.expectedProjectRevision),
            idempotencyKey: String(body.idempotencyKey ?? ''),
            projectId: decodeURIComponent(taskTransitionMatch[1]),
            status: String(body.status ?? '') as never,
            summary:
              typeof body.summary === 'string' ? body.summary : undefined,
            taskId: decodeURIComponent(taskTransitionMatch[2]),
          }),
        );
        return;
      }
      const taskHeartbeatMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/heartbeat$/,
      );
      if (taskHeartbeatMatch && request.method === 'POST') {
        assertScope(identity.scopes, 'task:claim');
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.heartbeatTask({
            actor: identity.actor,
            credentialHash: identity.credentialHash,
            leaseMs:
              typeof body.leaseMs === 'number' ? body.leaseMs : undefined,
            projectId: decodeURIComponent(taskHeartbeatMatch[1]),
            taskId: decodeURIComponent(taskHeartbeatMatch[2]),
          }),
        );
        return;
      }
      const taskRetryMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/retry$/,
      );
      if (taskRetryMatch && request.method === 'POST') {
        assertScope(identity.scopes, 'task:create');
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.retryTask({
            actor: identity.actor,
            expectedProjectRevision: Number(body.expectedProjectRevision),
            projectId: decodeURIComponent(taskRetryMatch[1]),
            taskId: decodeURIComponent(taskRetryMatch[2]),
          }),
        );
        return;
      }
      const formatOverrideMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/shots\/([^/]+)\/format-overrides$/,
      );
      if (formatOverrideMatch && request.method === 'POST') {
        assertScope(identity.scopes, 'output:write');
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.setFormatOverride({
            actor: identity.actor,
            captionsEnabled: body.captionsEnabled === true,
            expectedRevision: Number(body.expectedRevision),
            fit: String(body.fit ?? '') as never,
            format: String(body.format ?? '') as OutputFormat,
            projectId: decodeURIComponent(formatOverrideMatch[1]),
            shotId: decodeURIComponent(formatOverrideMatch[2]),
          }),
        );
        return;
      }
      const renderActionMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/render-jobs\/([^/]+)\/(run|cancel|retry)$/,
      );
      if (renderActionMatch?.[3] === 'run' && request.method === 'POST') {
        assertScope(identity.scopes, 'output:write');
        const actionProjectId = decodeURIComponent(renderActionMatch[1]);
        const jobId = decodeURIComponent(renderActionMatch[2]);
        const runnable = options.store.beginRenderJob(actionProjectId, jobId);
        try {
          const artifacts = renderProject(runnable.plan, {
            formats: runnable.formats,
            jobId,
            managedRoot: options.store.managedRoot,
          });
          json(
            response,
            200,
            options.store.completeRenderJob(actionProjectId, jobId, artifacts),
          );
        } catch (error) {
          json(
            response,
            200,
            options.store.failRenderJob(
              actionProjectId,
              jobId,
              error instanceof Error ? error.message : 'Render failed',
            ),
          );
        }
        return;
      }
      const artifactMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/artifacts\/([^/]+)$/,
      );
      if (artifactMatch && request.method === 'GET') {
        assertScope(identity.scopes, 'project:read');
        const artifact = options.store.getRenderArtifact(
          decodeURIComponent(artifactMatch[1]),
          decodeURIComponent(artifactMatch[2]),
        );
        response.writeHead(200, {
          'content-type': 'video/mp4',
          etag: `"${artifact.checksum}"`,
        });
        response.end(readFileSync(artifact.path));
        return;
      }
      const previewMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/previews\/([0-9a-f-]{36})$/,
      );
      if (previewMatch && request.method === 'GET') {
        assertScope(identity.scopes, 'project:read');
        const projectId = decodeURIComponent(previewMatch[1]);
        const previewId = previewMatch[2];
        const landscapePath = join(
          options.store.managedRoot,
          projectId,
          'renders',
          `preview-${previewId}`,
          'landscape.mp4',
        );
        const verticalPath = join(
          options.store.managedRoot,
          projectId,
          'renders',
          `preview-${previewId}`,
          'vertical.mp4',
        );
        let bytes: Buffer;
        try {
          bytes = readFileSync(landscapePath);
        } catch {
          try {
            bytes = readFileSync(verticalPath);
          } catch {
            throw new StoreError('NOT_FOUND', 'Preview artifact was not found');
          }
        }
        response.writeHead(200, {
          'cache-control': 'private, immutable',
          'content-type': 'video/mp4',
        });
        response.end(bytes);
        return;
      }
      if (renderActionMatch?.[3] === 'cancel' && request.method === 'POST') {
        assertScope(identity.scopes, 'output:write');
        json(
          response,
          200,
          options.store.cancelRenderJob({
            actor: identity.actor,
            jobId: decodeURIComponent(renderActionMatch[2]),
            projectId: decodeURIComponent(renderActionMatch[1]),
          }),
        );
        return;
      }
      if (renderActionMatch?.[3] === 'retry' && request.method === 'POST') {
        assertScope(identity.scopes, 'output:write');
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.retryRenderJob({
            actor: identity.actor,
            expectedProjectRevision: Number(body.expectedProjectRevision),
            jobId: decodeURIComponent(renderActionMatch[2]),
            projectId: decodeURIComponent(renderActionMatch[1]),
          }),
        );
        return;
      }
      const submitMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/proposal-tasks\/([^/]+)\/proposals$/,
      );
      if (submitMatch && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.submit_proposal);
        const body = await readJson(request);
        json(
          response,
          201,
          options.store.submitShotProposal({
            actor: identity.actor,
            baseProjectRevision: Number(body.baseProjectRevision),
            baseTranscriptRevisionId: String(
              body.baseTranscriptRevisionId ?? '',
            ),
            credentialHash: identity.credentialHash,
            projectId: decodeURIComponent(submitMatch[1]),
            shots: Array.isArray(body.shots) ? (body.shots as never) : [],
            taskId: decodeURIComponent(submitMatch[2]),
          }),
        );
        return;
      }
      const proposalActionMatch = url.pathname.match(
        /^\/v1\/projects\/([^/]+)\/proposals\/([^/]+)\/(accept|adjust|reject)$/,
      );
      if (proposalActionMatch?.[3] === 'accept' && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.accept_proposal);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.acceptShotProposal({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId: decodeURIComponent(proposalActionMatch[1]),
            proposalId: decodeURIComponent(proposalActionMatch[2]),
          }),
        );
        return;
      }
      if (proposalActionMatch?.[3] === 'adjust' && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.adjust_proposal);
        const body = await readJson(request);
        json(
          response,
          200,
          options.store.adjustShotProposal({
            actor: identity.actor,
            projectId: decodeURIComponent(proposalActionMatch[1]),
            proposalId: decodeURIComponent(proposalActionMatch[2]),
            shots: Array.isArray(body.shots) ? (body.shots as never) : [],
          }),
        );
        return;
      }
      if (proposalActionMatch?.[3] === 'reject' && request.method === 'POST') {
        assertScope(identity.scopes, operationScopes.reject_proposal);
        json(
          response,
          200,
          options.store.rejectShotProposal({
            actor: identity.actor,
            projectId: decodeURIComponent(proposalActionMatch[1]),
            proposalId: decodeURIComponent(proposalActionMatch[2]),
          }),
        );
        return;
      }
      if (
        projectId &&
        projectMatch?.[2] === 'transcriptions' &&
        request.method === 'POST'
      ) {
        assertScope(identity.scopes, operationScopes.run_transcription);
        const body = await readJson(request);
        json(
          response,
          200,
          await options.store.runTranscription({
            actor: identity.actor,
            expectedRevision: Number(body.expectedRevision),
            projectId,
            provider: options.provider ?? new DeterministicTranscriptProvider(),
          }),
        );
        return;
      }
      json(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
    } catch (error) {
      json(response, statusFor(error), {
        error: {
          code: codeFor(error),
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}
