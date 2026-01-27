import type { SQSEvent, SQSHandler } from "aws-lambda";
import {
  MediaConvertClient,
  CreateJobCommand,
  DescribeEndpointsCommand,
} from "@aws-sdk/client-mediaconvert";

let mediaConvertClient: MediaConvertClient | null = null;

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
 * Update episode with MediaConvert job ID
 */
async function updateEpisode(
  episodeId: string,
  updates: {
    mediaConvertJobId?: string;
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
 * Start MediaConvert Lambda
 *
 * Triggered by processing-queue
 * Creates AWS MediaConvert job for HLS conversion
 * Stores job ID in episode.mediaConvertJobId
 */
export const main: SQSHandler = async (event: SQSEvent) => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const bucketName = process.env.MEDIA_BUCKET_NAME;
  const roleArn = process.env.MEDIACONVERT_ROLE_ARN;

  if (!bucketName || !roleArn) {
    throw new Error("MEDIA_BUCKET_NAME and MEDIACONVERT_ROLE_ARN must be set");
  }

  const client = await getMediaConvertClient();

  for (const record of event.Records) {
    const message: ProcessingMessage = JSON.parse(record.body);
    const { episodeId, audioMediaId } = message;
    console.log(`Starting MediaConvert for episode: ${episodeId}, media: ${audioMediaId}`);

    try {
      const inputS3Uri = `s3://${bucketName}/raw/${audioMediaId}`;
      const outputS3Uri = `s3://${bucketName}/processed/${audioMediaId}/hls/`;

      // Create MediaConvert job for HLS output
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

      console.log(`Created MediaConvert job: ${jobId}`);

      // Update episode with job ID
      await updateEpisode(episodeId, {
        mediaConvertJobId: jobId,
      });
    } catch (error) {
      console.error(`Error starting MediaConvert for episode ${episodeId}:`, error);

      await updateEpisode(episodeId, {
        processingStatus: "failed",
        processingError: `MediaConvert error: ${error instanceof Error ? error.message : "Unknown error"}`,
      });

      throw error;
    }
  }
};
