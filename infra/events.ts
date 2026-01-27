/**
 * EventBridge rules for AWS service completion events
 */

// EventBridge rule for MediaConvert job state changes
export const mediaConvertCompleteRule = new sst.aws.Bus("MediaConvertEvents", {});

// EventBridge rule for Transcribe job state changes
export const transcribeCompleteRule = new sst.aws.Bus("TranscribeEvents", {});
