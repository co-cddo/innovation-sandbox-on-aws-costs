import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Template, Match } from "aws-cdk-lib/assertions";
import { CostCollectorFunction } from "./cost-collector-function.js";

describe("CostCollectorFunction", () => {
  const createTestStack = () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-west-2" },
    });
    const bucket = new s3.Bucket(stack, "TestBucket");

    const collector = new CostCollectorFunction(stack, "Collector", {
      region: "us-west-2",
      accountId: "123456789012",
      costExplorerRoleArn:
        "arn:aws:iam::999999999999:role/CostExplorerReadRole",
      costsBucket: bucket,
      eventBusName: "test-event-bus",
      schedulerGroupName: "test-scheduler-group",
      isbApiBaseUrl: "https://test-api.execute-api.us-west-2.amazonaws.com/prod",
      isbJwtSecretPath: "/InnovationSandbox/ndx/Auth/JwtSecret",
    });

    return { app, stack, bucket, collector, template: Template.fromStack(stack) };
  };

  describe("Cost Collector Lambda", () => {
    it("should create Lambda with correct configuration", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 900, // 15 minutes (for large accounts with 200+ services)
        MemorySize: 512,
        TracingConfig: {
          Mode: "Active",
        },
      });
    });

    it("should have correct environment variables", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        Environment: {
          Variables: {
            COST_EXPLORER_ROLE_ARN:
              "arn:aws:iam::999999999999:role/CostExplorerReadRole",
            S3_BUCKET_NAME: Match.anyValue(),
            BILLING_PADDING_HOURS: "8",
            PRESIGNED_URL_EXPIRY_DAYS: "7",
            EVENT_BUS_NAME: "test-event-bus",
            SCHEDULER_GROUP: "test-scheduler-group",
            ISB_API_BASE_URL: "https://test-api.execute-api.us-west-2.amazonaws.com/prod",
            ISB_JWT_SECRET_PATH: "/InnovationSandbox/ndx/Auth/JwtSecret",
          },
        },
      });
    });

    it("should have DLQ configured", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        DeadLetterConfig: {
          TargetArn: Match.objectLike({
            "Fn::GetAtt": Match.arrayWith([
              Match.stringLikeRegexp("CollectorCostCollectorDlq"),
              "Arn",
            ]),
          }),
        },
      });
    });

    it("should have IAM permissions for Cost Explorer role", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Resource: "arn:aws:iam::999999999999:role/CostExplorerReadRole",
              Sid: "AssumeRoleForCostExplorer",
            },
          ]),
        },
      });
    });

    it("should have IAM permissions to read ISB JWT secret", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "secretsmanager:GetSecretValue",
              Effect: "Allow",
              Resource:
                "arn:aws:secretsmanager:us-west-2:123456789012:secret:/InnovationSandbox/ndx/Auth/JwtSecret*",
              Sid: "GetIsbJwtSecret",
            },
          ]),
        },
      });
    });

    it("should have IAM permissions for EventBridge", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "events:PutEvents",
              Effect: "Allow",
              Resource:
                "arn:aws:events:us-west-2:123456789012:event-bus/test-event-bus",
              Sid: "PublishEvents",
            },
          ]),
        },
      });
    });

    it("should have IAM permissions for schedule deletion", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "scheduler:DeleteSchedule",
              Effect: "Allow",
              Resource:
                "arn:aws:scheduler:us-west-2:123456789012:schedule/test-scheduler-group/lease-costs-*",
              Sid: "DeleteOwnSchedule",
            },
          ]),
        },
      });
    });

    it("should expose cost collector function", () => {
      const { collector } = createTestStack();
      expect(collector.costCollectorFunction).toBeDefined();
    });

    it("should have resource-based policy restricting invocations to EventBridge Scheduler", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Permission", {
        Action: "lambda:InvokeFunction",
        FunctionName: {
          "Fn::GetAtt": Match.arrayWith([
            Match.stringLikeRegexp("CollectorCostCollectorLambda"),
            "Arn",
          ]),
        },
        Principal: "scheduler.amazonaws.com",
        SourceArn:
          "arn:aws:scheduler:us-west-2:123456789012:schedule/test-scheduler-group/*",
        SourceAccount: "123456789012",
      });
    });
  });

  describe("Scheduler Lambda", () => {
    it("should create Lambda with correct configuration", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 15,
        MemorySize: 256,
        TracingConfig: {
          Mode: "Active",
        },
      });
    });

    it("should have correct environment variables", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        Environment: {
          Variables: {
            DELAY_HOURS: "24",
            SCHEDULER_GROUP: "test-scheduler-group",
            SCHEDULER_ROLE_ARN: Match.anyValue(),
            COST_COLLECTOR_LAMBDA_ARN: Match.anyValue(),
          },
        },
      });
    });

    it("should have IAM permissions to create schedules", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "scheduler:CreateSchedule",
              Effect: "Allow",
              Resource:
                "arn:aws:scheduler:us-west-2:123456789012:schedule/test-scheduler-group/*",
              Sid: "CreateSchedule",
            },
          ]),
        },
      });
    });

    it("should have IAM permissions to pass role", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "iam:PassRole",
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "scheduler.amazonaws.com",
                },
              },
              Effect: "Allow",
              Resource: Match.anyValue(),
              Sid: "PassRoleToScheduler",
            },
          ]),
        },
      });
    });

    it("should expose scheduler function", () => {
      const { collector } = createTestStack();
      expect(collector.schedulerFunction).toBeDefined();
    });
  });

  describe("Scheduler Execution Role", () => {
    it("should create role with correct trust policy", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: {
                Service: "scheduler.amazonaws.com",
              },
            },
          ],
        },
        Description:
          "Role for EventBridge Scheduler to invoke Cost Collector Lambda",
      });
    });

    it("should have permissions to invoke Cost Collector Lambda", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "lambda:InvokeFunction",
              Effect: "Allow",
              Resource: Match.arrayWith([
                Match.objectLike({
                  "Fn::GetAtt": Match.arrayWith([
                    Match.stringLikeRegexp("CollectorCostCollectorLambda"),
                    "Arn",
                  ]),
                }),
              ]),
            },
          ]),
        },
      });
    });

    it("should expose scheduler execution role", () => {
      const { collector } = createTestStack();
      expect(collector.schedulerExecutionRole).toBeDefined();
    });
  });

  describe("Dead Letter Queue", () => {
    it("should create DLQ with 14-day retention", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "isb-lease-costs-collector-dlq",
        MessageRetentionPeriod: 1209600, // 14 days in seconds
      });
    });

    it("should expose DLQ", () => {
      const { collector } = createTestStack();
      expect(collector.costCollectorDlq).toBeDefined();
    });
  });

  describe("custom configuration", () => {
    it("should use custom configuration values", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack", {
        env: { account: "123456789012", region: "us-west-2" },
      });
      const bucket = new s3.Bucket(stack, "TestBucket");

      new CostCollectorFunction(stack, "Collector", {
        region: "us-west-2",
        accountId: "123456789012",
        costExplorerRoleArn:
          "arn:aws:iam::999999999999:role/CostExplorerReadRole",
        costsBucket: bucket,
        eventBusName: "test-event-bus",
        schedulerGroupName: "test-scheduler-group",
        isbApiBaseUrl: "https://test-api.execute-api.us-west-2.amazonaws.com/prod",
        isbJwtSecretPath: "/InnovationSandbox/ndx/Auth/JwtSecret",
        billingPaddingHours: "12",
        presignedUrlExpiryDays: "14",
        schedulerDelayHours: "48",
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        Environment: {
          Variables: Match.objectLike({
            BILLING_PADDING_HOURS: "12",
            PRESIGNED_URL_EXPIRY_DAYS: "14",
          }),
        },
      });

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        Environment: {
          Variables: Match.objectLike({
            DELAY_HOURS: "48",
          }),
        },
      });
    });
  });

  describe("Cleanup Lambda", () => {
    it("should create Lambda with correct configuration", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-cleanup",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 300, // 5 minutes
        MemorySize: 256,
        TracingConfig: {
          Mode: "Active",
        },
      });
    });

    it("should have correct environment variables", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-cleanup",
        Environment: {
          Variables: {
            SCHEDULER_GROUP: "test-scheduler-group",
          },
        },
      });
    });

    it("should have IAM permissions to list schedules", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "scheduler:ListSchedules",
              Effect: "Allow",
              Resource: "*",
              Sid: "ListSchedules",
            },
          ]),
        },
      });
    });

    it("should have IAM permissions to delete schedules", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            {
              Action: "scheduler:DeleteSchedule",
              Effect: "Allow",
              Resource:
                "arn:aws:scheduler:us-west-2:123456789012:schedule/test-scheduler-group/lease-costs-*",
              Sid: "DeleteStaleSchedules",
            },
          ]),
        },
      });
    });

    it("should expose cleanup function", () => {
      const { collector } = createTestStack();
      expect(collector.cleanupFunction).toBeDefined();
    });
  });

  describe("Cleanup Schedule Rule", () => {
    it("should create EventBridge rule for daily cleanup at 2 AM UTC", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "isb-lease-costs-cleanup-daily",
        Description: "Trigger daily cleanup of stale lease cost schedules at 2 AM UTC",
        ScheduleExpression: "cron(0 2 * * ? *)",
        State: "ENABLED",
      });
    });

    it("should target cleanup Lambda", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::Events::Rule", {
        Name: "isb-lease-costs-cleanup-daily",
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.objectLike({
              "Fn::GetAtt": Match.arrayWith([
                Match.stringLikeRegexp("CollectorCleanupLambda"),
                "Arn",
              ]),
            }),
            RetryPolicy: {
              MaximumRetryAttempts: 2,
            },
          }),
        ]),
      });
    });
  });

  describe("outputs", () => {
    it("should create CloudFormation outputs", () => {
      const { template } = createTestStack();

      // CDK generates unique IDs for outputs, so we check by description
      const outputs = template.toJSON().Outputs;
      const outputValues = Object.values(outputs);

      const schedulerOutput = outputValues.find(
        (output: any) => output.Description === "Scheduler Lambda ARN"
      );
      expect(schedulerOutput).toBeDefined();

      const collectorOutput = outputValues.find(
        (output: any) => output.Description === "Cost Collector Lambda ARN"
      );
      expect(collectorOutput).toBeDefined();

      const cleanupOutput = outputValues.find(
        (output: any) => output.Description === "Cleanup Lambda ARN (runs daily at 2 AM UTC)"
      );
      expect(cleanupOutput).toBeDefined();
    });
  });

  describe("snapshot", () => {
    it("should match snapshot", () => {
      const { template } = createTestStack();
      expect(template.toJSON()).toMatchSnapshot();
    });
  });
});
