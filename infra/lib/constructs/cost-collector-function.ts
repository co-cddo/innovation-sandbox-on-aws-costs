import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import { fileURLToPath } from "url";
import * as path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CostCollectorFunctionProps {
  /**
   * AWS region for resource ARN construction
   */
  readonly region: string;

  /**
   * AWS account ID for resource ARN construction
   */
  readonly accountId: string;

  /**
   * ARN of the Cost Explorer role to assume
   */
  readonly costExplorerRoleArn: string;

  /**
   * S3 bucket for storing cost CSV files
   */
  readonly costsBucket: s3.IBucket;

  /**
   * EventBridge event bus name for publishing events
   */
  readonly eventBusName: string;

  /**
   * EventBridge Scheduler group name
   */
  readonly schedulerGroupName: string;

  /**
   * Base URL of the ISB API Gateway
   */
  readonly isbApiBaseUrl: string;

  /**
   * Secrets Manager path for the JWT signing secret
   */
  readonly isbJwtSecretPath: string;

  /**
   * Billing data padding in hours
   * @default "8"
   */
  readonly billingPaddingHours?: string;

  /**
   * Pre-signed URL expiry in days
   * @default "7"
   */
  readonly presignedUrlExpiryDays?: string;

  /**
   * Scheduler delay in hours (for cost collection after lease termination)
   * @default "24"
   */
  readonly schedulerDelayHours?: string;
}

/**
 * L3 Construct for ISB Lease Cost Collector Functions
 *
 * Creates three Lambda functions with their supporting resources:
 * 1. **Scheduler Lambda**: Creates EventBridge schedules for delayed cost collection
 * 2. **Cost Collector Lambda**: Fetches cost data from Cost Explorer and stores in S3
 * 3. **Cleanup Lambda**: Removes orphaned schedules daily (runs at 2 AM UTC)
 *
 * Schedule Cleanup Strategy:
 * - Primary: Schedules auto-delete via ActionAfterCompletion=DELETE
 * - Fallback: Cost Collector Lambda attempts manual deletion
 * - Safety Net: Daily cleanup Lambda removes schedules older than 72 hours
 *
 * Features:
 * - Dead Letter Queues for both functions
 * - IAM roles with least-privilege permissions
 * - X-Ray tracing enabled
 * - CloudWatch Logs with 30-day retention
 * - ESM bundling for Node.js 22
 *
 * @example
 * ```typescript
 * const collector = new CostCollectorFunction(this, 'Collector', {
 *   region: this.region,
 *   accountId: this.account,
 *   costExplorerRoleArn: 'arn:aws:iam::999999999999:role/CostExplorerReadRole',
 *   costsBucket: storage.bucket,
 *   eventBusName: 'isb-events',
 *   schedulerGroupName: 'isb-lease-costs',
 *   isbApiBaseUrl: 'https://api.example.com',
 *   isbJwtSecretPath: '/isb/jwt-secret',
 * });
 *
 * // Access functions
 * const { costCollectorFunction, schedulerFunction, cleanupFunction } = collector;
 * ```
 */
export class CostCollectorFunction extends Construct {
  /**
   * The Cost Collector Lambda function
   */
  public readonly costCollectorFunction: lambdaNodejs.NodejsFunction;

  /**
   * The Scheduler Lambda function
   */
  public readonly schedulerFunction: lambdaNodejs.NodejsFunction;

  /**
   * The Cleanup Lambda function (removes stale schedules daily)
   */
  public readonly cleanupFunction: lambdaNodejs.NodejsFunction;

  /**
   * Dead Letter Queue for Cost Collector Lambda
   */
  public readonly costCollectorDlq: sqs.Queue;

  /**
   * IAM role for EventBridge Scheduler to invoke Cost Collector
   */
  public readonly schedulerExecutionRole: iam.Role;

  /**
   * IAM execution role for the Cost Collector Lambda.
   * This ARN must be used in the Cost Explorer role trust policy for least-privilege access.
   */
  public readonly costCollectorLambdaRole: iam.IRole;

  constructor(scope: Construct, id: string, props: CostCollectorFunctionProps) {
    super(scope, id);

    const {
      region,
      accountId,
      costExplorerRoleArn,
      costsBucket,
      eventBusName,
      schedulerGroupName,
      isbApiBaseUrl,
      isbJwtSecretPath,
      billingPaddingHours = "8",
      presignedUrlExpiryDays = "7",
      schedulerDelayHours = "24",
    } = props;

    // DLQ for Cost Collector Lambda failures
    this.costCollectorDlq = new sqs.Queue(this, "CostCollectorDlq", {
      queueName: "isb-lease-costs-collector-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // Cost Collector Lambda
    this.costCollectorFunction = new lambdaNodejs.NodejsFunction(
      this,
      "CostCollectorLambda",
      {
        functionName: "isb-lease-costs-collector",
        entry: path.join(
          __dirname,
          "../../../src/lambdas/cost-collector-handler.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.minutes(15), // Extended for Cost Explorer pagination + throttling on large accounts (200+ services)
        memorySize: 512,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enhanced monitoring: memory, cold starts, network, CPU metrics
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: {
          COST_EXPLORER_ROLE_ARN: costExplorerRoleArn,
          S3_BUCKET_NAME: costsBucket.bucketName,
          BILLING_PADDING_HOURS: billingPaddingHours,
          PRESIGNED_URL_EXPIRY_DAYS: presignedUrlExpiryDays,
          EVENT_BUS_NAME: eventBusName,
          SCHEDULER_GROUP: schedulerGroupName,
          ISB_API_BASE_URL: isbApiBaseUrl,
          ISB_JWT_SECRET_PATH: isbJwtSecretPath,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
          format: lambdaNodejs.OutputFormat.ESM,
          mainFields: ["module", "main"],
          target: "node22",
          minify: true, // Enable minification for smaller bundle size
          treeShaking: true, // Remove unused code
          sourceMap: false, // Disable source maps in production for smaller size
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);", // Fix dynamic requires in ESM
        },
        deadLetterQueue: this.costCollectorDlq,
      }
    );

    // Cost Collector Lambda IAM permissions
    this.costCollectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AssumeRoleForCostExplorer",
        actions: ["sts:AssumeRole"],
        resources: [costExplorerRoleArn],
      })
    );

    this.costCollectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "GetIsbJwtSecret",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${region}:${accountId}:secret:${isbJwtSecretPath}*`,
        ],
      })
    );

    costsBucket.grantReadWrite(this.costCollectorFunction);

    this.costCollectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "PublishEvents",
        actions: ["events:PutEvents"],
        resources: [
          `arn:aws:events:${region}:${accountId}:event-bus/${eventBusName}`,
        ],
      })
    );

    // Restrict schedule deletion to only lease-costs-* schedules in this group
    this.costCollectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeleteOwnSchedule",
        actions: ["scheduler:DeleteSchedule"],
        resources: [
          `arn:aws:scheduler:${region}:${accountId}:schedule/${schedulerGroupName}/lease-costs-*`,
        ],
      })
    );

    // CloudWatch custom metrics for business observability
    // Allows Lambda to emit TotalCost, ServiceCount, and ProcessingDuration metrics
    this.costCollectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "PutCustomMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"], // PutMetricData doesn't support resource-level permissions
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "ISBLeaseCosts", // Restrict to specific namespace
          },
        },
      })
    );

    // Scheduler execution role (for Scheduler to invoke Cost Collector)
    this.schedulerExecutionRole = new iam.Role(
      this,
      "SchedulerExecutionRole",
      {
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
        description:
          "Role for EventBridge Scheduler to invoke Cost Collector Lambda",
      }
    );

    this.costCollectorFunction.grantInvoke(this.schedulerExecutionRole);

    // Add resource-based policy to Cost Collector Lambda to restrict invocations to EventBridge Scheduler
    // Defense-in-depth: Only allow scheduler.amazonaws.com to invoke with specific execution role
    this.costCollectorFunction.addPermission("AllowSchedulerInvoke", {
      principal: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceArn: `arn:aws:scheduler:${region}:${accountId}:schedule/${schedulerGroupName}/*`,
      sourceAccount: accountId,
    });

    // Scheduler Lambda
    this.schedulerFunction = new lambdaNodejs.NodejsFunction(
      this,
      "SchedulerLambda",
      {
        functionName: "isb-lease-costs-scheduler",
        entry: path.join(
          __dirname,
          "../../../src/lambdas/scheduler-handler.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enhanced monitoring: memory, cold starts, network, CPU metrics
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: {
          DELAY_HOURS: schedulerDelayHours,
          SCHEDULER_GROUP: schedulerGroupName,
          SCHEDULER_ROLE_ARN: this.schedulerExecutionRole.roleArn,
          COST_COLLECTOR_LAMBDA_ARN: this.costCollectorFunction.functionArn,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
          format: lambdaNodejs.OutputFormat.ESM,
          mainFields: ["module", "main"],
          target: "node22",
          minify: true, // Enable minification for smaller bundle size
          treeShaking: true, // Remove unused code
          sourceMap: false, // Disable source maps in production for smaller size
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);", // Fix dynamic requires in ESM
        },
      }
    );

    // Scheduler Lambda IAM permissions
    this.schedulerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CreateSchedule",
        actions: ["scheduler:CreateSchedule"],
        resources: [
          `arn:aws:scheduler:${region}:${accountId}:schedule/${schedulerGroupName}/*`,
        ],
      })
    );

    this.schedulerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "PassRoleToScheduler",
        actions: ["iam:PassRole"],
        resources: [this.schedulerExecutionRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "scheduler.amazonaws.com",
          },
        },
      })
    );

    // Cleanup Lambda (runs daily to remove orphaned schedules)
    this.cleanupFunction = new lambdaNodejs.NodejsFunction(
      this,
      "CleanupLambda",
      {
        functionName: "isb-lease-costs-cleanup",
        entry: path.join(
          __dirname,
          "../../../src/lambdas/cleanup-handler.ts"
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.minutes(5), // Adequate for listing + deleting hundreds of schedules
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0, // Enhanced monitoring: memory, cold starts, network, CPU metrics
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: {
          SCHEDULER_GROUP: schedulerGroupName,
        },
        bundling: {
          externalModules: ["@aws-sdk/*"],
          format: lambdaNodejs.OutputFormat.ESM,
          mainFields: ["module", "main"],
          target: "node22",
          minify: true, // Enable minification for smaller bundle size
          treeShaking: true, // Remove unused code
          sourceMap: false, // Disable source maps in production for smaller size
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);", // Fix dynamic requires in ESM
        },
      }
    );

    // Cleanup Lambda IAM permissions
    this.cleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ListSchedules",
        actions: ["scheduler:ListSchedules"],
        resources: ["*"], // ListSchedules doesn't support resource-level permissions
      })
    );

    this.cleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "DeleteStaleSchedules",
        actions: ["scheduler:DeleteSchedule"],
        resources: [
          `arn:aws:scheduler:${region}:${accountId}:schedule/${schedulerGroupName}/lease-costs-*`,
        ],
      })
    );

    // EventBridge Rule to trigger cleanup daily at 2 AM UTC
    const cleanupRule = new events.Rule(this, "CleanupScheduleRule", {
      ruleName: "isb-lease-costs-cleanup-daily",
      description: "Trigger daily cleanup of stale lease cost schedules at 2 AM UTC",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "2",
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    cleanupRule.addTarget(new targets.LambdaFunction(this.cleanupFunction, {
      retryAttempts: 2,
    }));

    // Store the Lambda execution role for cross-account trust policy configuration
    this.costCollectorLambdaRole = this.costCollectorFunction.role!;

    // Outputs
    new cdk.CfnOutput(this, "SchedulerLambdaArn", {
      value: this.schedulerFunction.functionArn,
      description: "Scheduler Lambda ARN",
    });

    new cdk.CfnOutput(this, "CostCollectorLambdaArn", {
      value: this.costCollectorFunction.functionArn,
      description: "Cost Collector Lambda ARN",
    });

    new cdk.CfnOutput(this, "CostCollectorLambdaRoleArn", {
      value: this.costCollectorLambdaRole.roleArn,
      description: "Cost Collector Lambda execution role ARN (required for Cost Explorer trust policy)",
      exportName: "IsbLeaseCostsCostCollectorLambdaRoleArn",
    });

    new cdk.CfnOutput(this, "CleanupLambdaArn", {
      value: this.cleanupFunction.functionArn,
      description: "Cleanup Lambda ARN (runs daily at 2 AM UTC)",
    });
  }
}
