/**
 * Speaker Identification Module
 *
 * Uses LLM to identify speakers in the transcript based on:
 * - Series description
 * - Episode description
 * - Audio segments from the transcript
 */

import OpenAI from 'openai';
import type {
  TranscriptSegment,
  SeriesData,
  EpisodeData,
  SpeakerData,
  SpeakerInfo,
} from './types';

interface SpeakerIdentificationResult {
  speakers: {
    id: string;
    name: string;
    role: 'host' | 'guest' | 'unknown';
    reasoning?: string;
  }[];
}

/**
 * Identify speakers in the transcript using LLM
 *
 * @param openai - OpenAI client instance
 * @param series - Series metadata
 * @param episode - Episode metadata
 * @param segments - Transcript segments from AWS Transcribe
 * @returns Speaker data mapping speaker IDs to names and roles
 */
export async function identifySpeakers(
  openai: OpenAI,
  series: SeriesData,
  episode: EpisodeData,
  segments: TranscriptSegment[]
): Promise<SpeakerData> {
  // Extract unique speaker labels
  const speakerLabels = [...new Set(segments.map((s) => s.speaker_label))];

  if (speakerLabels.length === 0) {
    return {};
  }

  // Build a sample of transcript content for each speaker
  const speakerSamples: Record<string, string[]> = {};
  for (const segment of segments) {
    if (!speakerSamples[segment.speaker_label]) {
      speakerSamples[segment.speaker_label] = [];
    }
    // Collect up to 5 samples per speaker
    if (speakerSamples[segment.speaker_label].length < 5) {
      speakerSamples[segment.speaker_label].push(segment.transcript);
    }
  }

  const speakerSamplesText = Object.entries(speakerSamples)
    .map(
      ([label, samples]) =>
        `${label}:\n${samples.map((s, i) => `  ${i + 1}. "${s.slice(0, 200)}${s.length > 200 ? '...' : ''}"`).join('\n')}`
    )
    .join('\n\n');

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an expert at identifying podcast speakers. Given metadata about a podcast series and episode, along with transcript samples, identify who each speaker is.

Your task:
1. Analyze the series description, episode description, and transcript samples
2. For each speaker label (e.g., spk_0, spk_1), determine:
   - Their likely name (or a descriptive placeholder if unknown)
   - Their role: "host", "guest", or "unknown"

Output JSON in this format:
{
  "speakers": [
    {
      "id": "spk_0",
      "name": "John Smith",
      "role": "host",
      "reasoning": "Brief explanation of how you identified this speaker"
    }
  ]
}

Guidelines:
- Hosts typically introduce the show, guide conversation, and appear in most episodes
- Guests are usually introduced by the host and may be topic experts
- If you can't determine a name, use a descriptive placeholder like "Host 1" or "Guest"
- Be conservative - only assign a name if you're reasonably confident`,
        },
        {
          role: 'user',
          content: `Series: "${series.title}"
Series Description: ${series.description || 'No description available'}

Episode: "${episode.title}"
Episode Description: ${episode.description || 'No description available'}

Speaker Labels Found: ${speakerLabels.join(', ')}

Transcript Samples by Speaker:
${speakerSamplesText}

Please identify each speaker.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('No response from speaker identification');
      return createDefaultSpeakerData(speakerLabels);
    }

    const result: SpeakerIdentificationResult = JSON.parse(content);

    // Convert to SpeakerData format
    const speakerData: SpeakerData = {};
    for (const speaker of result.speakers) {
      speakerData[speaker.id] = {
        name: speaker.name,
        role: speaker.role,
      };
    }

    // Ensure all speaker labels are represented
    for (const label of speakerLabels) {
      if (!speakerData[label]) {
        speakerData[label] = {
          name: `Speaker ${label.replace('spk_', '')}`,
          role: 'unknown',
        };
      }
    }

    return speakerData;
  } catch (error) {
    console.error('Error identifying speakers:', error);
    return createDefaultSpeakerData(speakerLabels);
  }
}

/**
 * Create default speaker data when identification fails
 */
function createDefaultSpeakerData(speakerLabels: string[]): SpeakerData {
  const speakerData: SpeakerData = {};
  for (const label of speakerLabels) {
    const speakerNum = label.replace('spk_', '');
    speakerData[label] = {
      name: speakerNum === '0' ? 'Host' : `Speaker ${speakerNum}`,
      role: speakerNum === '0' ? 'host' : 'unknown',
    };
  }
  return speakerData;
}
