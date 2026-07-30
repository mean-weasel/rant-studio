import { lstat, readFile } from 'node:fs/promises';

import type {
  ActivitySnapshot,
  EditorialProjectSnapshot,
  ShotProposalDraft,
  ShotProposalSubmission,
} from '../../../packages/model/src/index.ts';

export function planningContext(input: {
  activity: ActivitySnapshot;
  editorial: EditorialProjectSnapshot;
  projectId: string;
  taskId: string;
}): {
  baseProjectRevision: number;
  baseTranscriptRevisionId: string;
  projectId: string;
  task: ActivitySnapshot['tasks'][number];
  transcript: EditorialProjectSnapshot['effectiveTranscript'];
} {
  const task = input.activity.tasks.find(
    (candidate) => candidate.id === input.taskId,
  );
  if (!task || task.kind !== 'proposal') {
    throw new Error('Proposal task was not found in shared project activity');
  }
  if (!task.planning) {
    throw new Error(
      'Proposal task has no semantic planning context; queue it again from the browser',
    );
  }
  if (task.baseRevision !== input.editorial.revision) {
    throw new Error(
      `Proposal task targets revision ${task.baseRevision}; current revision is ${input.editorial.revision}`,
    );
  }
  return {
    baseProjectRevision: task.baseRevision,
    baseTranscriptRevisionId: input.editorial.effectiveTranscript.id,
    projectId: input.projectId,
    task,
    transcript: input.editorial.effectiveTranscript,
  };
}

function proposalSubmission(value: unknown): ShotProposalSubmission {
  if (Array.isArray(value)) return { shots: value as ShotProposalDraft[] };
  if (!value || typeof value !== 'object') {
    throw new Error('Proposal file must contain an object or shot array');
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.shots)) {
    throw new Error('Proposal file must contain a shots array');
  }
  return {
    ...(typeof input.shotCountRationale === 'string'
      ? { shotCountRationale: input.shotCountRationale }
      : {}),
    shots: input.shots as ShotProposalDraft[],
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
  };
}

export async function readProposalSubmission(
  filePath: string,
): Promise<ShotProposalSubmission> {
  const file = await lstat(filePath);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error('proposal --shots-file must be a regular file');
  }
  if (file.size > 4 * 1024 * 1024) {
    throw new Error('proposal --shots-file must be 4 MB or smaller');
  }
  return proposalSubmission(JSON.parse(await readFile(filePath, 'utf8')));
}

export function parseProposalJson(value: string): ShotProposalSubmission {
  return proposalSubmission(JSON.parse(value));
}
