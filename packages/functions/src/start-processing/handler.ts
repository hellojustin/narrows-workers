import type { SQSEvent, SQSHandler } from "aws-lambda";
import {
  MediaConvertClient,
  CreateJobCommand,
  DescribeEndpointsCommand,
} from "@aws-sdk/client-mediaconvert";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { fetchEpisodeOrNull, isEpisodeIngestible } from "../shared/episode-guard";
import { readRoutingConfig, routeTranscoder } from "../shared/transcoder-routing";

let mediaConvertClient: MediaConvertClient | null = null;
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

interface ProcessingMessage {
  episodeId: string;
  audioMediaId: string;
}

/**
 * Get MediaConvert client with the correct endpoint
 */
async function getMediaConvertClient(): Promise<MediaConvertClient> {
  if (mediaConvertClient) {
    return mediaConvertClient;
  }

  const endpoint = process.env.MEDIACONVERT_ENDPOINT;
  if (endpoint) {
    mediaConvertClient = new MediaConvertClient({ endpoint });
    return mediaConvertClient;
  }

  // Discover endpoint if not provided
  const tempClient = new MediaConvertClient({});
  const response = await tempClient.send(new DescribeEndpointsCommand({}));
  const discoveredEndpoint = response.Endpoints?.[0]?.Url;

  if (!discoveredEndpoint) {
    throw new Error("Could not discover MediaConvert endpoint");
  }

  mediaConvertClient = new MediaConvertClient({ endpoint: discoveredEndpoint });
  return mediaConvertClient;
}

/**
 * Update episode with job IDs and status
 */
async function updateEpisode(
  episodeId: string,
  updates: {
    mediaConvertJobId?: string;
    transcribeJobName?: string;
    processingStatus?: string;
    processingError?: string;
  }
): Promise<void> {
  const apiUrl = process.env.NARROWS_API_URL;
  const apiKey = process.env.NARROWS_API_KEY;

  await fetch(`${apiUrl}/api/v1/episodes/${episodeId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(updates),
  });
}

/**
 * Start MediaConvert job for HLS conversion
 */
async function startMediaConvertJob(
  episodeId: string,
  audioMediaId: string,
  bucketName: string,
  roleArn: string
): Promise<string> {
  const client = await getMediaConvertClient();

  const inputS3Uri = `s3://${bucketName}/raw/${audioMediaId}`;
  const outputS3Uri = `s3://${bucketName}/processed/${audioMediaId}/hls/`;

  const response = await client.send(
    new CreateJobCommand({
      Role: roleArn,
      Settings: {
        Inputs: [
          {
            FileInput: inputS3Uri,
            AudioSelectors: {
              "Audio Selector 1": {
                DefaultSelection: "DEFAULT",
              },
            },
          },
        ],
        OutputGroups: [
          {
            Name: "HLS Group",
            OutputGroupSettings: {
              Type: "HLS_GROUP_SETTINGS",
              HlsGroupSettings: {
                Destination: outputS3Uri,
                SegmentLength: 10,
                MinSegmentLength: 0,
                ManifestDurationFormat: "FLOATING_POINT",
                StreamInfResolution: "INCLUDE",
                ClientCache: "ENABLED",
                CaptionLanguageSetting: "OMIT",
                ManifestCompression: "NONE",
                CodecSpecification: "RFC_4281",
                OutputSelection: "MANIFESTS_AND_SEGMENTS",
                ProgramDateTime: "INCLUDE",
                ProgramDateTimePeriod: 600,
                SegmentControl: "SEGMENTED_FILES",
                DirectoryStructure: "SINGLE_DIRECTORY",
              },
            },
            Outputs: [
              {
                NameModifier: "_audio",
                ContainerSettings: {
                  Container: "M3U8",
                },
                AudioDescriptions: [
                  {
                    AudioSourceName: "Audio Selector 1",
                    CodecSettings: {
                      Codec: "AAC",
                      AacSettings: {
                        Bitrate: 128000,
                        CodingMode: "CODING_MODE_2_0",
                        SampleRate: 48000,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      UserMetadata: {
        episodeId,
        audioMediaId,
      },
    })
  );

  const jobId = response.Job?.Id;
  if (!jobId) {
    throw new Error("MediaConvert job created but no job ID returned");
  }

  return jobId;
}

/**
 * Submit audio to AssemblyAI for transcription with speaker diarization.
 *
 * Generates a presigned S3 URL so AssemblyAI can fetch the audio directly
 * without requiring the bucket to be public. Returns the AssemblyAI transcript
 * ID which is stored on the episode as transcribeJobName for lookup later.
 */
async function startAssemblyAITranscription(
  episodeId: string,
  audioMediaId: string,
  bucketName: string
): Promise<string> {
  const presignedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `raw/${audioMediaId}`,
    }),
    { expiresIn: 3600 }
  );

  const webhookBaseUrl = process.env.ASSEMBLYAI_WEBHOOK_URL;
  const webhookUrl = `${webhookBaseUrl}?episodeId=${encodeURIComponent(episodeId)}&audioMediaId=${encodeURIComponent(audioMediaId)}`;

  const response = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: presignedUrl,
      speech_models: ["universal-2"],
      speaker_labels: true,
      webhook_url: webhookUrl,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AssemblyAI submission failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { id: string };
  return result.id;
}

/** Enqueue the ffmpeg HLS transcode. */
async function enqueueFfmpegTranscode(episodeId: string, audioMediaId: string): Promise<void> {
  const queueUrl = process.env.AUDIO_TRANSCODE_QUEUE_URL;
  if (!queueUrl) {
    throw new Error("AUDIO_TRANSCODE_QUEUE_URL must be set to route transcoding to ffmpeg");
  }

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ episodeId, audioMediaId }),
    })
  );
}

/**
 * Enqueue waveform and per-frequency-band analysis.
 *
 * Separate from the transcode, and deliberately not fatal: waveform data is
 * additive, so failing to enqueue it must not fail an otherwise fine episode.
 */
async function enqueueAudioAnalysis(episodeId: string, audioMediaId: string): Promise<void> {
  const queueUrl = process.env.AUDIO_ANALYSIS_QUEUE_URL;
  if (!queueUrl) return;

  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ episodeId, audioMediaId }),
      })
    );
  } catch (error) {
    console.error(`Failed to enqueue audio analysis for ${audioMediaId}:`, error);
  }
}

/**
 * Start Processing Lambda
 *
 * Triggered by processing-queue.
 * Starts transcription and HLS transcoding in parallel. The transcoder is either
 * MediaConvert or the ffmpeg Lambda, chosen per series by shared/transcoder-routing.
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const roleArn = process.env.MEDIACONVERT_ROLE_ARN;
  const routing = readRoutingConfig();

  // The MediaConvert role is only needed if MediaConvert might still be used.
  const mayUseMediaConvert = routing.defaultTranscoder !== "ffmpeg";
  if (!bucketName || (mayUseMediaConvert && !roleArn)) {
    throw new Error("MEDIA_BUCKET_NAME and MEDIACONVERT_ROLE_ARN must be set");
  }

  for (const record of event.Records) {
    const message: ProcessingMessage = JSON.parse(record.body);
    const { episodeId, audioMediaId } = message;
    console.log(`Starting processing for episode: ${episodeId}, media: ${audioMediaId}`);

    try {
      if (!(await isEpisodeIngestible(episodeId))) {
        console.log(
          `Skipping processing for episode ${episodeId}: not found or series opted out`
        );
        continue;
      }

      const episode = await fetchEpisodeOrNull(episodeId);
      const seriesId = (episode?.series_id ?? episode?.seriesId) as string | undefined;
      const decision = routeTranscoder({ seriesId }, routing);
      console.log(
        `Transcoder for episode ${episodeId} (series ${seriesId ?? "unknown"}): ` +
          `${decision.transcoder} — ${decision.reason}`
      );

      // Transcode and transcription run in parallel; neither depends on the other.
      const transcode =
        decision.transcoder === "ffmpeg"
          ? enqueueFfmpegTranscode(episodeId, audioMediaId).then(() => null)
          : startMediaConvertJob(episodeId, audioMediaId, bucketName, roleArn!);

      const [mediaConvertJobId, transcribeJobName] = await Promise.all([
        transcode,
        startAssemblyAITranscription(episodeId, audioMediaId, bucketName),
      ]);

      if (mediaConvertJobId) {
        console.log(`Started MediaConvert job: ${mediaConvertJobId}`);
      } else {
        console.log(`Enqueued ffmpeg transcode for media ${audioMediaId}`);
      }
      console.log(`Started AssemblyAI transcription: ${transcribeJobName}`);

      await enqueueAudioAnalysis(episodeId, audioMediaId);

      // transcribeJobName holds the AssemblyAI transcript ID.
      await updateEpisode(episodeId, {
        ...(mediaConvertJobId ? { mediaConvertJobId } : {}),
        transcribeJobName,
        processingStatus: "processing",
      });
    } catch (error) {
      console.error(`Error starting processing for episode ${episodeId}:`, error);

      await updateEpisode(episodeId, {
        processingStatus: "failed",
        processingError: `Processing error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });

      throw error;
    }
  }
};
