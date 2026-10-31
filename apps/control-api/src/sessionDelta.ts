/** Structured session.delta payloads pushed over WSS to desktop clients. */

export type SessionDeltaKind =
  | 'run.status'
  | 'message.created'
  | 'assistant.delta'
  | 'routine.fired';

export interface SessionDeltaPayload {
  kind: SessionDeltaKind;
  runId?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  message?: {
    id: string;
    sequence: number;
    role: 'user' | 'assistant' | 'tool';
    text: string;
    createdAt: string;
  };
  /** Incremental assistant text fragment (optional streaming). */
  text?: string;
  routineId?: string;
  routineName?: string;
  at?: string;
}

export type SessionDeltaPublisher = (
  userId: string,
  sessionId: string,
  delta: SessionDeltaPayload,
) => void;
