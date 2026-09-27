export interface AIRequest {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface AIResponse {
  summary: string;
  confidence: number;
}

export async function generateAISummary(_input: AIRequest): Promise<AIResponse> {
  return {
    summary: 'AI summary is available in the configured provider layer and requires explicit opt-in.',
    confidence: 0.87,
  };
}
