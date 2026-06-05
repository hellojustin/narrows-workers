import type OpenAI from 'openai';
import type { Story } from './types';

export interface TopicSeed {
  name: string;
  description: string;
}

const DEVELOPER_PROMPT = [
  'You are a news reporter, tasked with finding the most common',
  'stories that are trending in the area of news that the users asks',
  'you to search for. Each of the stories you find will be structured in',
  'two parts: a headline and a summary. A headline is one or two',
  'words: a proper noun around which the story centers.',
  'Prefer a single word, but use two words when it will clarify the story.',
  'Readers already familiar with the story should be able to reconize',
  'the headline, and immediately identify the story it refers to.',
  'A summary is a one or two sentence recap of the facts of the story.',
  'it should read like a short, breaking news story, in the present',
  'tense, answering: who, what, when, where, and why. Downstream',
  'consumers of your response may only see one result at a time,',
  'so do not make cross-references or sequential references between',
  'stories in your summaries.',
].join(' ');

const storiesSchema = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'Short news headline (two words max)' },
          summary: { type: 'string', description: 'One or two sentence summary of the story' },
          citation: { type: 'string', description: 'URL of the source citation for the story' },
        },
        required: ['headline', 'summary', 'citation'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
} as const;

function buildExclusionMessage(seeds: TopicSeed[]): string {
  const lines = [
    'The following events have ALREADY been covered in the last 24 hours.',
    'Avoid covering the same underlying event as any of these.',
    'These are internal descriptions only — do NOT use them as examples of good headline format.',
    'Your headlines should still follow the rules above (proper nouns, 1-2 words).',
    'Find genuinely new stories instead.',
    '',
    'Already covered events:',
    ...seeds.map((s) => `- ${s.description}`),
  ];
  return lines.join('\n');
}

export async function discoverStories(
  prompt: string,
  openai: OpenAI,
  existingSeeds: TopicSeed[] = [],
): Promise<Story[]> {
  console.log('Step 1: Discovering stories via web search…');
  if (existingSeeds.length > 0) {
    console.log(`Step 1: Excluding ${existingSeeds.length} existing topic seeds`);
  }

  const input: Array<{ role: 'developer' | 'system' | 'user'; content: string }> = [
    { role: 'system', content: DEVELOPER_PROMPT },
  ];

  if (existingSeeds.length > 0) {
    input.push({ role: 'system', content: buildExclusionMessage(existingSeeds) });
  }

  input.push({ role: 'user', content: prompt });

  const response = await openai.responses.create({
    model: 'gpt-5.4',
    input,
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
