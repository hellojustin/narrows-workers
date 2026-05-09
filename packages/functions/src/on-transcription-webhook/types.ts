/**
 * AssemblyAI API response types for the transcription webhook flow.
 */

export interface AssemblyAIWord {
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
  confidence: number;
  speaker: string | null; // "A", "B", etc. — present when speaker_labels: true
}

export interface AssemblyAIUtterance {
  speaker: string; // "A", "B"
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
  words: AssemblyAIWord[];
}

export interface AssemblyAISentence {
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
  confidence: number;
  speaker: string | null;
  words: AssemblyAIWord[];
}

export interface AssemblyAITranscript {
  id: string;
  status: string;
  text: string;
  words: AssemblyAIWord[];
  utterances: AssemblyAIUtterance[] | null;
  audio_duration: number; // seconds
  error?: string;
}

export interface AssemblyAISentencesResponse {
  id: string;
  confidence: number;
  audio_duration: number;
  sentences: AssemblyAISentence[];
}

export interface WebhookPayload {
  transcript_id: string;
  status: "completed" | "error";
}
