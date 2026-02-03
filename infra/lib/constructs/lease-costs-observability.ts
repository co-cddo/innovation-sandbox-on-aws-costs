import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface LeaseCostsObservabilityProps {
  /**
   * Cost Collector Lambda function for error metrics
   */
  readonly costCollectorFunction: lambda.IFunction;

  /**
   * Scheduler Lambda function for error metrics
   */
  readonly schedulerFunction: lambda.IFunction;

  /**
   * Cost Collector DLQ for message visibility metrics
   */
  readonly costCollectorDlq: sqs.IQueue;

  /**
   * Event Rule DLQ for message visibility metrics
   */
  readonly eventRuleDlq: sqs.IQueue;

  /**
   * Email address for alert notifications (optional)
   */
  readonly alertEmail?: string;

  /**
   * Alarm threshold for DLQ message count
   * @default 1
   */
  readonly dlqThreshold?: number;

  /**
   * Alarm threshold for Lambda errors
   * @default 3
   */
  readonly errorThreshold?: number;

  /**
   * Alarm evaluation period
   * @default 1
   */
  readonly evaluationPeriods?: number;

  /**
   * Alarm threshold for Cost Collector Lambda duration in milliseconds
   * @default 720000 (12 minutes - 80% of 15min timeout)
   */
  readonly durationThreshold?: number;
}

/**
 * L3 Construct for ISB Lease Costs Observability
 *
 * Creates CloudWatch alarms and SNS alerting for the cost collection system:
 * - DLQ monitoring (Cost Collector + Event Rule)
 * - Lambda error monitoring (both functions)
 * - Lambda duration monitoring (Cost Collector - warns at 80% of timeout)
 * - SNS topic for centralized alerting
 * - Optional email subscription
 *
 * All alarms are configured to:
 * - Send notifications to the SNS topic
 * - Treat missing data as NOT_BREACHING
 * - Use appropriate thresholds for operational awareness
 *
 * The duration alarm triggers at 12 minutes (80% of the 15-minute timeout)
 * to alert before the Lambda times out on large accounts (200+ services).
 *
 * @example
 * ```typescript
 * const observability = new LeaseCostsObservability(this, 'Observability', {
 *   costCollectorFunction: collector.costCollectorFunction,
 *   schedulerFunction: collector.schedulerFunction,
 *   costCollectorDlq: collector.costCollectorDlq,
 *   eventRuleDlq: eventRuleDlq,
 *   alertEmail: 'team@example.com',
 * });
 *
 * // Access alarms for additional configuration
 * observability.alarms.forEach(alarm => {
 *   // Custom alarm actions
 * });
 * ```
 */
export class LeaseCostsObservability extends Construct {
  /**
   * SNS topic for operational alerts
   */
  public readonly alarmsTopic: sns.Topic;

  /**
   * Array of all CloudWatch alarms
   */
  public readonly alarms: cloudwatch.Alarm[];

  /**
   * Individual alarm references for fine-grained access
   */
  public readonly collectorDlqAlarm: cloudwatch.Alarm;
  public readonly ruleDlqAlarm: cloudwatch.Alarm;
  public readonly schedulerErrorsAlarm: cloudwatch.Alarm;
  public readonly collectorErrorsAlarm: cloudwatch.Alarm;
  public readonly collectorDurationAlarm: cloudwatch.Alarm;

  constructor(
    scope: Construct,
    id: string,
    props: LeaseCostsObservabilityProps
  ) {
    super(scope, id);

    const {
      costCollectorFunction,
      schedulerFunction,
      costCollectorDlq,
      eventRuleDlq,
      alertEmail,
      dlqThreshold = 1,
      errorThreshold = 3,
      evaluationPeriods = 1,
      durationThreshold = 720000, // 12 minutes (80% of 15min timeout)
    } = props;

    // SNS Topic for alerts
    this.alarmsTopic = new sns.Topic(this, "AlertTopic", {
      displayName: "ISB Lease Costs Alerts",
    });

    if (alertEmail) {
      this.alarmsTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alertEmail)
      );
    }

    // CloudWatch Alarms

    // 1. DLQ Alarm - Cost Collector
    this.collectorDlqAlarm = new cloudwatch.Alarm(this, "CollectorDlqAlarm", {
      alarmName: "isb-lease-costs-collector-dlq",
      alarmDescription: "Cost Collector Lambda failures detected in DLQ",
      metric: costCollectorDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: dlqThreshold,
      evaluationPeriods,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.collectorDlqAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmsTopic)
    );

    // 2. DLQ Alarm - Event Rule
    this.ruleDlqAlarm = new cloudwatch.Alarm(this, "RuleDlqAlarm", {
      alarmName: "isb-lease-costs-rule-dlq",
      alarmDescription: "EventBridge Rule delivery failures detected in DLQ",
      metric: eventRuleDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: dlqThreshold,
      evaluationPeriods,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.ruleDlqAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmsTopic)
    );

    // 3. Scheduler Lambda Errors Alarm
    this.schedulerErrorsAlarm = new cloudwatch.Alarm(
      this,
      "SchedulerErrorsAlarm",
      {
        alarmName: "isb-lease-costs-scheduler-errors",
        alarmDescription: "Scheduler Lambda errors exceed threshold",
        metric: schedulerFunction.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: errorThreshold,
        evaluationPeriods,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    this.schedulerErrorsAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmsTopic)
    );

    // 4. Cost Collector Lambda Errors Alarm
    this.collectorErrorsAlarm = new cloudwatch.Alarm(
      this,
      "CollectorErrorsAlarm",
      {
        alarmName: "isb-lease-costs-collector-errors",
        alarmDescription: "Cost Collector Lambda errors exceed threshold",
        metric: costCollectorFunction.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: errorThreshold,
        evaluationPeriods,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    this.collectorErrorsAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmsTopic)
    );

    // 5. Cost Collector Lambda Duration Alarm
    this.collectorDurationAlarm = new cloudwatch.Alarm(
      this,
      "CollectorDurationAlarm",
      {
        alarmName: "isb-lease-costs-collector-duration",
        alarmDescription: "Cost Collector Lambda duration approaching timeout (12 min threshold for 15 min timeout)",
        metric: costCollectorFunction.metricDuration({
          period: cdk.Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: durationThreshold,
        evaluationPeriods,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );
    this.collectorDurationAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmsTopic)
    );

    // Collect all alarms for easy iteration
    this.alarms = [
      this.collectorDlqAlarm,
      this.ruleDlqAlarm,
      this.schedulerErrorsAlarm,
      this.collectorErrorsAlarm,
      this.collectorDurationAlarm,
    ];

    // Output
    new cdk.CfnOutput(this, "AlertTopicArn", {
      value: this.alarmsTopic.topicArn,
      description: "SNS topic for operational alerts",
    });
  }
}
