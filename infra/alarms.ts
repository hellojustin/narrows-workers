/**
 * CloudWatch alarms for the ffmpeg audio path.
 * Email subscription is optional (ALARM_EMAIL). The alarms still exist without it.
 */

const stage = $app.stage;
const alarmEmail = (process.env.ALARM_EMAIL ?? "").trim();

const topic = new sst.aws.SnsTopic("AudioPipelineAlarms", {
  transform: {
    topic: { name: `narrows-${stage}-audio-pipeline-alarms` },
  },
});

if (alarmEmail) {
  new aws.sns.TopicSubscription("AudioPipelineAlarmEmail", {
    topic: topic.arn,
    protocol: "email",
    endpoint: alarmEmail,
  });
}

function queueDepthAlarm(name: string, queueName: string) {
  return new aws.cloudwatch.MetricAlarm(name, {
    name: `narrows-${stage}-${name.toLowerCase()}`,
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: "ApproximateNumberOfMessagesVisible",
    namespace: "AWS/SQS",
    period: 60,
    statistic: "Maximum",
    threshold: 0,
    treatMissingData: "notBreaching",
    dimensions: { QueueName: queueName },
    alarmActions: [topic.arn],
    okActions: [topic.arn],
  });
}

queueDepthAlarm("AudioTranscodeDlqAlarm", `narrows-${stage}-audio-transcode-dlq`);
queueDepthAlarm("AudioAnalysisDlqAlarm", `narrows-${stage}-audio-analysis-dlq`);

new aws.cloudwatch.MetricAlarm("TranscodeAudioErrors", {
  name: `narrows-${stage}-transcode-audio-errors`,
  comparisonOperator: "GreaterThanThreshold",
  evaluationPeriods: 1,
  metricName: "Errors",
  namespace: "AWS/Lambda",
  period: 300,
  statistic: "Sum",
  threshold: 0,
  treatMissingData: "notBreaching",
  dimensions: { FunctionName: `narrows-${stage}-transcode-audio` },
  alarmActions: [topic.arn],
});

// 14 minutes. Function timeout is 15 minutes; fire before an episode hits it.
new aws.cloudwatch.MetricAlarm("TranscodeAudioDurationP99", {
  name: `narrows-${stage}-transcode-audio-duration-p99`,
  comparisonOperator: "GreaterThanThreshold",
  evaluationPeriods: 2,
  metricName: "Duration",
  namespace: "AWS/Lambda",
  period: 300,
  extendedStatistic: "p99",
  threshold: 840_000,
  treatMissingData: "notBreaching",
  dimensions: { FunctionName: `narrows-${stage}-transcode-audio` },
  alarmActions: [topic.arn],
});
