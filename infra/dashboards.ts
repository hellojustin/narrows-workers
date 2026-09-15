/**
 * CloudWatch dashboards for transcode-audio and analyze-audio.
 * Replaces the hand-built Production-Waveform-Backfill / SQS-Queue-Depths boards.
 */

const stage = $app.stage;
const region = "us-east-1";

function lambdaWidgets(functionName: string, y: number) {
  return [
    {
      type: "metric",
      x: 0,
      y,
      width: 8,
      height: 6,
      properties: {
        title: `${functionName} invocations / errors`,
        region,
        stat: "Sum",
        period: 60,
        metrics: [
          ["AWS/Lambda", "Invocations", "FunctionName", functionName],
          [".", "Errors", "FunctionName", functionName],
          [".", "Throttles", "FunctionName", functionName],
        ],
      },
    },
    {
      type: "metric",
      x: 8,
      y,
      width: 8,
      height: 6,
      properties: {
        title: `${functionName} duration`,
        region,
        stat: "p99",
        period: 60,
        metrics: [
          ["AWS/Lambda", "Duration", "FunctionName", functionName, { stat: "p50" }],
          ["...", { stat: "p99" }],
          ["...", { stat: "Maximum" }],
        ],
        annotations: {
          horizontal: [{ label: "timeout 900s", value: 900_000 }],
        },
      },
    },
    {
      type: "metric",
      x: 16,
      y,
      width: 8,
      height: 6,
      properties: {
        title: `${functionName} concurrent executions`,
        region,
        stat: "Maximum",
        period: 60,
        metrics: [["AWS/Lambda", "ConcurrentExecutions", "FunctionName", functionName]],
      },
    },
  ];
}

function queueWidgets(queueName: string, y: number) {
  const dims = ["QueueName", queueName];
  return [
    {
      type: "metric",
      x: 0,
      y,
      width: 12,
      height: 6,
      properties: {
        title: `${queueName} depth`,
        region,
        stat: "Maximum",
        period: 60,
        metrics: [
          ["AWS/SQS", "ApproximateNumberOfMessagesVisible", ...dims],
          [".", "ApproximateNumberOfMessagesNotVisible", ...dims],
        ],
      },
    },
    {
      type: "metric",
      x: 12,
      y,
      width: 12,
      height: 6,
      properties: {
        title: `${queueName} oldest message (s)`,
        region,
        stat: "Maximum",
        period: 60,
        metrics: [["AWS/SQS", "ApproximateAgeOfOldestMessage", ...dims]],
      },
    },
  ];
}

new aws.cloudwatch.Dashboard("AudioPipelineDashboard", {
  dashboardName: `narrows-${stage}-audio-pipeline`,
  dashboardBody: JSON.stringify({
    widgets: [
      ...lambdaWidgets(`narrows-${stage}-transcode-audio`, 0),
      ...lambdaWidgets(`narrows-${stage}-analyze-audio`, 6),
      ...queueWidgets(`narrows-${stage}-audio-transcode`, 12),
      ...queueWidgets(`narrows-${stage}-audio-transcode-dlq`, 18),
      ...queueWidgets(`narrows-${stage}-audio-analysis`, 24),
      ...queueWidgets(`narrows-${stage}-audio-analysis-dlq`, 30),
      ...queueWidgets(`narrows-${stage}-subtitle-generation`, 36),
    ],
  }),
});
