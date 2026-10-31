import { z } from 'zod';
import {
  ToolArgsSchema,
  ToolNameSchema,
  type ToolArgsByName,
  type ToolName,
  type ToolResultByName,
} from './tools';

/** Where a tool should execute */
export const TargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cloud') }),
  z.object({
    type: z.literal('local'),
    machineId: z.string().min(1),
  }),
]);
export type Target = z.infer<typeof TargetSchema>;

/** Common error codes for tool results */
export const ToolErrorCodeSchema = z.enum([
  'MACHINE_OFFLINE',
  'RUNTIME_OFFLINE',
  'TARGET_SELECTION_REQUIRED',
  'ABORTED',
  'TIMEOUT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'NOT_IMPLEMENTED',
  'INVALID_ARGS',
  'INTERNAL',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export const ToolErrorSchema = z.object({
  code: ToolErrorCodeSchema,
  message: z.string(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

/** Call envelope: tool + args + target */
export const ToolCallSchema = z.object({
  tool: ToolNameSchema,
  args: ToolArgsSchema,
  target: TargetSchema,
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Typed call helper */
export type TypedToolCall<T extends ToolName = ToolName> = {
  tool: T;
  args: ToolArgsByName[T];
  target: Target;
};

/** Result envelope */
const JsonValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

export const ToolResultOkSchema = z.object({
  ok: z.literal(true),
  data: JsonValueSchema,
});
export const ToolResultErrSchema = z.object({
  ok: z.literal(false),
  error: ToolErrorSchema,
});
export const ToolResultSchema = z.discriminatedUnion('ok', [
  ToolResultOkSchema,
  ToolResultErrSchema,
]);
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

export type TypedToolResult<T extends ToolName = ToolName> = ToolResult<
  ToolResultByName[T]
>;

export function okResult<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

export function errResult(
  code: ToolErrorCode,
  message: string,
): ToolResult<never> {
  return { ok: false, error: { code, message } };
}
