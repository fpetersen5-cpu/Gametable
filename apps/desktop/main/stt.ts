import type { CompletionClient } from '@gametable/agent';

/**
 * Speech to text through an OpenRouter audio-input model. Tried in order so a
 * model being unavailable does not break push-to-talk.
 */
const MODELS = ['qwen/qwen3.8-omni-flash', 'google/gemini-3.8-flash', 'meta/muse-spark-open'];

export async function transcribe(client: CompletionClient, wavBase64: string): Promise<string> {
  let lastError: unknown;
  for (const model of MODELS) {
    try {
      const result = await client.complete({
        model,
        temperature: 0,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Transcribe the speech verbatim. Output only the transcript, with no quotes, ' +
                  'labels or commentary.',
              },
              { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } },
            ],
          },
        ],
      });
      const text = result.text.trim();
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not transcribe the recording');
}
