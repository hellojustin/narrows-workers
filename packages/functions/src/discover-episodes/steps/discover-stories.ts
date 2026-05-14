import type OpenAI from 'openai';
import type { Story } from './types';

const storiesSchema = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'Short news headline (one sentence)' },
          summary: { type: 'string', description: '2-3 sentence summary of the story' },
        },
        required: ['headline', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
} as const;

export async function discoverStories(prompt: string, openai: OpenAI): Promise<Story[]> {
  console.log('Step 1: Discovering stories via web search…');

  const response = await openai.responses.create({
    model: 'gpt-5.4',
    input: prompt,
    tools: [{ type: 'web_search_preview', search_context_size: 'medium' }],
    text: {
      format: {
        type: 'json_schema' as const,
        name: 'stories_result',
        schema: storiesSchema,
        strict: true,
      },
    },
  });

  const textOutput = response.output_text || '';
  if (!textOutput) {
    throw new Error('Step 1: LLM returned empty output');
  }

  const { stories } = JSON.parse(textOutput) as { stories: Story[] };
  console.log(`Step 1: Found ${stories.length} stories`);
  return stories;
}
