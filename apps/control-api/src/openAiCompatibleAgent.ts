import type { AgentEngine } from './agentWorker';
import type { AgentPromptMessage } from './conversationStore';

interface OpenAiCompatibleAgentOptions {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: string;
  };
}

const SYSTEM_PROMPT =
  'You are a helpful assistant. Respond concisely and accurately.';

export class OpenAiCompatibleAgent implements AgentEngine {
  constructor(private readonly options: OpenAiCompatibleAgentOptions) {}

  async generate(messages: AgentPromptMessage[]): Promise<string> {
    const endpoint = `${this.options.apiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages.map(({ role, text }) => ({ role, content: text })),
        ],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    let result: unknown;
    try {
      result = await response.json() as unknown;
    } catch (error) {
      throw new Error(`Agent provider returned invalid JSON (${response.status})`, {
        cause: error,
      });
    }
    const payload = result as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(
        payload.error?.message ??
          `Agent provider request failed with status ${response.status}`,
      );
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Agent provider response contains no assistant content');
    }
    return content;
  }
}
