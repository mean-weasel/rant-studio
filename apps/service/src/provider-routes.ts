import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  ActorKind,
  ProjectOperation,
} from '../../../packages/model/src/index.ts';
import { AuthorityError } from '../../../packages/model/src/index.ts';
import type { TranscriptionProviderName } from '../../../packages/transcription/src/index.ts';
import type { TranscriptionCredentialRegistry } from './credential-store.ts';
import { StoreError } from './store.ts';

type ProviderIdentity = {
  actor: { kind: ActorKind };
  scopes: string[];
};

type ProviderRouteInput = {
  approvedAppOrigin: string;
  credentialRegistry?: TranscriptionCredentialRegistry;
  identity: ProviderIdentity;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
};

export const operationScopes: Record<ProjectOperation, string> = {
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

export function errorCode(error: unknown): string {
  if (error instanceof AuthorityError || error instanceof StoreError) {
    return error.code;
  }
  return 'INTERNAL_ERROR';
}

export function errorStatus(error: unknown): number {
  if (error instanceof AuthorityError) return 403;
  if (!(error instanceof StoreError)) return 500;
  if (error.code === 'UNAUTHORIZED') return 401;
  if (error.code === 'FORBIDDEN') return 403;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'REVISION_CONFLICT') return 409;
  if (
    [
      'INVALID_INPUT',
      'INVALID_PROPOSAL',
      'INVALID_TRANSCRIPT',
      'PREFLIGHT_BLOCKED',
      'SECRET_MATERIAL',
      'UNSAFE_PATH',
      'UNSUPPORTED_MEDIA',
    ].includes(error.code)
  )
    return 400;
  if (error.code === 'PROVIDER_FAILED') return 502;
  if (
    [
      'DETACHED_AGENT',
      'INVALID_TASK_TRANSITION',
      'PLACEHOLDER_APPROVAL_REQUIRED',
      'STALE_PROPOSAL',
      'STALE_TASK',
      'TASK_UNAVAILABLE',
    ].includes(error.code)
  )
    return 409;
  return 500;
}

export function assertScope(scopes: string[], required: string): void {
  if (scopes.includes('project:*') || scopes.includes(required)) return;
  throw new StoreError(
    'FORBIDDEN',
    `Credential requires the ${required} scope`,
  );
}

function assertMutationAuthority(input: {
  approvedOrigin: string;
  origin?: string;
  role: ActorKind;
  scopes: string[];
}): void {
  if (input.role !== 'human') {
    throw new StoreError(
      'FORBIDDEN',
      'Only the local owner may change provider credentials',
    );
  }
  assertScope(input.scopes, 'provider:write');
  if (input.origin && input.origin !== input.approvedOrigin) {
    throw new StoreError(
      'FORBIDDEN',
      `Provider credential changes require origin ${input.approvedOrigin}`,
    );
  }
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

function providerFailure(error: unknown): StoreError {
  return new StoreError(
    'PROVIDER_FAILED',
    error instanceof Error ? error.message : 'Provider operation failed',
  );
}

function registryFor(
  registry: TranscriptionCredentialRegistry | undefined,
): TranscriptionCredentialRegistry {
  if (registry) return registry;
  throw new StoreError(
    'NOT_FOUND',
    'Persistent provider configuration is unavailable',
  );
}

function isProviderMutation(pathname: string, method?: string): boolean {
  return (
    /^\/v1\/transcription-providers\/(openai|groq)\/(credential|select|test)$/.test(
      pathname,
    ) && method !== 'GET'
  );
}

export function providerOriginAllowed(input: {
  approvedAppOrigin: string;
  method?: string;
  pathname: string;
  requestOrigin: string;
}): boolean {
  if (isProviderMutation(input.pathname, input.method)) {
    return input.requestOrigin === input.approvedAppOrigin;
  }
  const origin = new URL(input.requestOrigin);
  return (
    origin.hostname === '127.0.0.1' ||
    origin.hostname === 'localhost' ||
    origin.hostname.endsWith('.localhost')
  );
}

export function handleProviderPreflight(input: {
  approvedAppOrigin: string;
  pathname: string;
  requestOrigin?: string;
  response: ServerResponse;
}): boolean {
  if (
    isProviderMutation(input.pathname, 'POST') &&
    input.requestOrigin !== input.approvedAppOrigin
  ) {
    json(input.response, 403, {
      error: {
        code: 'FORBIDDEN',
        message: `Provider credential changes require origin ${input.approvedAppOrigin}`,
      },
    });
    return true;
  }
  return false;
}

export async function handleProviderRoute(
  input: ProviderRouteInput,
): Promise<boolean> {
  if (
    input.url.pathname === '/v1/transcription-providers' &&
    input.request.method === 'GET'
  ) {
    assertScope(input.identity.scopes, 'provider:read');
    json(
      input.response,
      200,
      await registryFor(input.credentialRegistry).snapshot(),
    );
    return true;
  }

  const match = input.url.pathname.match(
    /^\/v1\/transcription-providers\/(openai|groq)\/(credential|select|test)$/,
  );
  if (!match || input.request.method === 'GET') return false;

  const registry = registryFor(input.credentialRegistry);
  assertMutationAuthority({
    approvedOrigin: input.approvedAppOrigin,
    origin: input.request.headers.origin,
    role: input.identity.actor.kind,
    scopes: input.identity.scopes,
  });
  const provider = match[1] as TranscriptionProviderName;

  try {
    if (match[2] === 'credential' && input.request.method === 'PUT') {
      const body = await readJson(input.request);
      const credential =
        typeof body.credential === 'string' ? body.credential : '';
      if (!credential.trim()) {
        throw new StoreError(
          'INVALID_INPUT',
          'Provider credential is required',
        );
      }
      json(
        input.response,
        200,
        await registry.configure({
          credential,
          provider,
          select: body.select !== false,
        }),
      );
      return true;
    }
    if (match[2] === 'credential' && input.request.method === 'DELETE') {
      json(input.response, 200, await registry.remove(provider));
      return true;
    }
    if (match[2] === 'select' && input.request.method === 'POST') {
      json(input.response, 200, await registry.select(provider));
      return true;
    }
    if (match[2] === 'test' && input.request.method === 'POST') {
      json(input.response, 200, await registry.test(provider));
      return true;
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw providerFailure(error);
  }

  return false;
}
