/**
 * EventBridge configuration
 *
 * Note: MediaConvert and Transcribe emit events to the DEFAULT EventBridge bus.
 * We create EventBridge rules via AWS CLI after deployment to trigger our Lambda functions.
 *
 * Rules needed:
 * 1. MediaConvert Job State Change -> onMediaConvertComplete Lambda
 * 2. Transcribe Job State Change -> onTranscribeComplete Lambda
 *
 * These are set up in the deployment step, not via SST, because SST v3
 * doesn't have native support for EventBridge rule subscriptions to the default bus.
 */

// Placeholder export to satisfy the import in sst.config.ts
export const eventBridgeConfig = {
  mediaConvertPattern: {
    source: ["aws.mediaconvert"],
    "detail-type": ["MediaConvert Job State Change"],
    detail: {
      status: ["COMPLETE", "ERROR"],
    },
  },
  transcribePattern: {
    source: ["aws.transcribe"],
    "detail-type": ["Transcribe Job State Change"],
    detail: {
      TranscriptionJobStatus: ["COMPLETED", "FAILED"],
    },
  },
};
