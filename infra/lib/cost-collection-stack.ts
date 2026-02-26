import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { LeaseCostsStorage } from "./constructs/lease-costs-storage.js";
import { CostCollectorFunction } from "./constructs/cost-collector-function.js";
import { LeaseCostsObservability } from "./constructs/lease-costs-observability.js";

/**
 * Configuration properties for the ISB Lease Cost Collection Stack.
 *
 * This stack orchestrates automated cost collection for Innovation Sandbox leases by:
 * 1. Listening for LeaseTerminated events on the ISB event bus
 * 2. Triggering Lambda to collect costs from AWS Cost Explorer
 * 3. Generating CSV reports and storing them in S3
 * 4. Emitting LeaseCostsGenerated events for downstream processing
 *
 * **Cross-Account Architecture:**
 * - This stack runs in the Hub account (innovation-sandbox-on-aws)
 * - Cost Explorer queries run against Org Management account (cross-account role assumption)
 * - ISB Leases API is invoked in Hub account for lease metadata
 */
export interface CostCollectionStackProps extends cdk.StackProps {
  /**
   * Name of the EventBridge event bus to listen for LeaseTerminated events.
   *
   * **Required**: This must match the ISB event bus name where lease lifecycle events are published.
   *
   * **Usage**: The Cost Collector Lambda subscribes to this bus via an EventBridge Rule
   * that filters for LeaseTerminated events. When a lease ends, the rule triggers
   * the Lambda to initiate cost collection.
   *
   * **Source**: From ISB infrastructure stack (typically "innovation-sandbox-events")
   * **Format**: Valid EventBridge bus name (alphanumeric, hyphens, underscores)
   *
   * @example "innovation-sandbox-events"
   */
  eventBusName: string;

  /**
   * ARN of the IAM role in Org Management account for Cost Explorer access.
   *
   * **Required**: This role grants cross-account read-only access to AWS Cost Explorer
   * for querying lease-specific costs.
   *
   * **Why Cross-Account**: Cost Explorer data lives in the Org Management account
   * (where billing is consolidated), not in the Hub account where leases run.
   *
   * **Trust Relationship**: This role must trust the Cost Collector Lambda's execution role
   * to allow AssumeRole operations. Deploy the CostExplorerRoleStack first to create this role.
   *
   * **Permissions**: ce:GetCostAndUsage (read-only Cost Explorer access)
   *
   * **Source**: Output from IsbCostExplorerRoleStack (deployed in Org Management account)
   * **Format**: arn:aws:iam::123456789012:role/IsbCostExplorerAccess
   *
   * @see IsbCostExplorerRoleStack for role creation and trust policy configuration
   * @example "arn:aws:iam::123456789012:role/IsbCostExplorerAccess"
   */
  costExplorerRoleArn: string;

  /**
   * ISB API Gateway base URL for fetching lease metadata.
   *
   * @example "https://abc123.execute-api.us-west-2.amazonaws.com/prod"
   */
  isbApiBaseUrl: string;

  /**
   * Secrets Manager path for ISB JWT signing secret.
   *
   * @example "/InnovationSandbox/ndx/Auth/JwtSecret"
   */
  isbJwtSecretPath: string;

  /**
   * Email address for CloudWatch alarm notifications (optional).
   *
   * **Optional**: If provided, creates an SNS topic and CloudWatch alarms for:
   * - Lambda errors (Cost Collector, Scheduler, Cleanup functions)
   * - EventBridge Rule DLQ messages (delivery failures)
   * - High Lambda duration (performance degradation)
   *
   * **Alarm Actions**: Sends email notifications via SNS when alarms trigger
   *
   * **Recommendation**: Always provide in production for operational visibility
   *
   * **Format**: Valid email address (will receive SNS subscription confirmation)
   *
   * @default undefined (no alarms or notifications)
   * @example "ops-team@example.com"
   */
  alertEmail?: string;

  /**
   * Name for the EventBridge Scheduler group (optional).
   *
   * **Optional**: The Scheduler group organizes one-time schedules created for each lease.
   * When a LeaseTerminated event arrives, the Scheduler Lambda creates a one-time schedule
   * in this group to trigger the Cost Collector after the billing data delay (8 hours).
   *
   * **Why Separate Group**: Allows easy cleanup of all lease-related schedules and
   * provides isolation from other scheduled tasks.
   *
   * **Format**: Valid Scheduler group name (alphanumeric, hyphens, underscores)
   *
   * @default `isb-lease-costs-${Stack.of(this).stackName}`
   * @example "isb-lease-costs-production"
   */
  schedulerGroupName?: string;
}

export class CostCollectionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CostCollectionStackProps) {
    super(scope, id, {
      ...props,
      terminationProtection: true, // Prevent accidental stack deletion
    });

    const { eventBusName, costExplorerRoleArn, isbApiBaseUrl, isbJwtSecretPath, alertEmail } =
      props;

    // Resolve scheduler group name with default
    const schedulerGroupName =
      props.schedulerGroupName ?? `isb-lease-costs-${this.stackName}`;

    // EventBridge Scheduler Group
    const schedulerGroup = new scheduler.CfnScheduleGroup(
      this,
      "SchedulerGroup",
      {
        name: schedulerGroupName,
      }
    );

    // DLQ for EventBridge Rule delivery failures
    const eventRuleDlq = new sqs.Queue(this, "EventRuleDlq", {
      queueName: "isb-lease-costs-rule-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // L3 Construct: Storage
    const storage = new LeaseCostsStorage(this, "Storage", {
      accountId: this.account,
      region: this.region,
    });

    // L3 Construct: Cost Collector Functions
    const collector = new CostCollectorFunction(this, "Collector", {
      region: this.region,
      accountId: this.account,
      costExplorerRoleArn,
      costsBucket: storage.bucket,
      eventBusName,
      schedulerGroupName,
      isbApiBaseUrl,
      isbJwtSecretPath,
    });

    // EventBridge Rule to trigger Scheduler Lambda on LeaseTerminated
    const eventBus = events.EventBus.fromEventBusName(
      this,
      "IsbEventBus",
      eventBusName
    );

    new events.Rule(this, "LeaseTerminatedRule", {
      eventBus,
      ruleName: "isb-lease-costs-trigger",
      description: "Triggers lease cost collection when a lease terminates",
      eventPattern: {
        source: ["isb"],
        detailType: ["LeaseTerminated"],
      },
      targets: [
        new eventsTargets.LambdaFunction(collector.schedulerFunction, {
          deadLetterQueue: eventRuleDlq,
          retryAttempts: 3,
        }),
      ],
    });

    // L3 Construct: Observability
    new LeaseCostsObservability(this, "Observability", {
      costCollectorFunction: collector.costCollectorFunction,
      schedulerFunction: collector.schedulerFunction,
      costCollectorDlq: collector.costCollectorDlq,
      eventRuleDlq,
      alertEmail,
    });
  }
}
