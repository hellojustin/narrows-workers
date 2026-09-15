# EventBridge leftover-rule teardown

Repeatable runbook to remove leftover MediaConvert and Transcribe completion
rules from the **default** EventBridge bus in `us-east-1`, and the Lambda
resource-based permissions that let those rules invoke:

- `narrows-production-on-mediaconvert-complete`
- `narrows-production-on-transcribe-complete`

Do not put credentials in this file. Use an IAM principal that can already
call EventBridge and Lambda in this account. Region is `us-east-1`.

The subtitle fan-in is a `HeadObject` (`tryEnqueueAfterTranscode` /
`tryEnqueueAfterTranscription`). These rules are not part of that path.

## Do not delete

`list-rules` name matches on `transcribe` will also hit
`StaleTranscriptionSchedule` (and any other name containing that substring).
That cron is live. Delete only rules whose `EventPattern` is a MediaConvert
or Transcribe **Job State Change**. Leave every rule that has a
`ScheduleExpression`.

## 1. Inventory

```bash
export AWS_REGION=us-east-1
export EVENT_BUS=default

aws events list-rules \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --output json
```

Name filter (review the result; do not delete from this list alone):

```bash
aws events list-rules \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --query 'Rules[?contains(Name, `mediaconvert`) || contains(Name, `MediaConvert`) || contains(Name, `transcribe`) || contains(Name, `Transcribe`)].[Name,State,ScheduleExpression]' \
  --output table
```

Describe each candidate. Keep a rule only if `EventPattern` is a Job State
Change. Skip any rule that prints a `ScheduleExpression`.

```bash
# Repeat per Name from the table above.
aws events describe-rule \
  --name REPLACE_WITH_RULE_NAME \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION"
```

Patterns that qualify for deletion:

```json
{"source":["aws.mediaconvert"],"detail-type":["MediaConvert Job State Change"]}
```

```json
{"source":["aws.transcribe"],"detail-type":["Transcribe Job State Change"]}
```

List targets on each qualifying rule:

```bash
aws events list-targets-by-rule \
  --rule REPLACE_WITH_RULE_NAME \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION"
```

Inspect the leftover Lambdas' resource policies (404 here means no policy):

```bash
aws lambda get-policy \
  --function-name narrows-production-on-mediaconvert-complete \
  --region "$AWS_REGION"

aws lambda get-policy \
  --function-name narrows-production-on-transcribe-complete \
  --region "$AWS_REGION"
```

## 2. Remove EventBridge invoke permissions

For each `Sid` whose `Principal.Service` is `events.amazonaws.com`:

```bash
aws lambda remove-permission \
  --function-name narrows-production-on-mediaconvert-complete \
  --statement-id REPLACE_WITH_SID \
  --region "$AWS_REGION"

aws lambda remove-permission \
  --function-name narrows-production-on-transcribe-complete \
  --statement-id REPLACE_WITH_SID \
  --region "$AWS_REGION"
```

Extract Sids without editing JSON by hand:

```bash
aws lambda get-policy \
  --function-name narrows-production-on-mediaconvert-complete \
  --region "$AWS_REGION" \
  --query Policy \
  --output text \
| python3 -c '
import json, sys
doc = json.loads(sys.stdin.read())
for stmt in doc.get("Statement", []):
    principal = stmt.get("Principal") or {}
    if principal.get("Service") == "events.amazonaws.com":
        print(stmt.get("Sid", ""))
'

aws lambda get-policy \
  --function-name narrows-production-on-transcribe-complete \
  --region "$AWS_REGION" \
  --query Policy \
  --output text \
| python3 -c '
import json, sys
doc = json.loads(sys.stdin.read())
for stmt in doc.get("Statement", []):
    principal = stmt.get("Principal") or {}
    if principal.get("Service") == "events.amazonaws.com":
        print(stmt.get("Sid", ""))
'
```

`get-policy` returning `ResourceNotFoundException` after this step is the
expected end state.

## 3. Remove targets, then delete the rules

EventBridge will not delete a rule that still has targets.

```bash
aws events list-targets-by-rule \
  --rule REPLACE_WITH_RULE_NAME \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --query 'Targets[].Id' \
  --output text
```

```bash
aws events remove-targets \
  --rule REPLACE_WITH_RULE_NAME \
  --ids REPLACE_WITH_TARGET_ID \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --force
```

If a rule has more than one target, pass every Id to `--ids`.

```bash
aws events delete-rule \
  --name REPLACE_WITH_RULE_NAME \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --force
```

## 4. Verify

```bash
aws events list-rules \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --query 'Rules[?contains(Name, `mediaconvert`) || contains(Name, `MediaConvert`) || contains(Name, `transcribe`) || contains(Name, `Transcribe`)].[Name,ScheduleExpression,EventPattern]' \
  --output table
```

Remaining rows must be scheduled crons only (`ScheduleExpression` set,
`EventPattern` empty). Confirm no leftover Job State Change pattern:

```bash
aws events list-rules \
  --event-bus-name "$EVENT_BUS" \
  --region "$AWS_REGION" \
  --output json \
| python3 -c '
import json, sys
rules = json.load(sys.stdin).get("Rules", [])
for rule in rules:
    pattern = rule.get("EventPattern") or ""
    if "MediaConvert Job State Change" in pattern or "Transcribe Job State Change" in pattern:
        print(rule["Name"])
        print(pattern)
'
```

No names printed.

```bash
aws lambda get-policy \
  --function-name narrows-production-on-mediaconvert-complete \
  --region "$AWS_REGION"

aws lambda get-policy \
  --function-name narrows-production-on-transcribe-complete \
  --region "$AWS_REGION"
```

Both calls should return `ResourceNotFoundException` (no resource policy).

This runbook does not delete the Lambda functions. That is PROD-168.
