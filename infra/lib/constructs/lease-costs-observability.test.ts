import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Template, Match } from "aws-cdk-lib/assertions";
import { LeaseCostsObservability } from "./lease-costs-observability.js";

describe("LeaseCostsObservability", () => {
  const createTestStack = (alertEmail?: string) => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-west-2" },
    });

    // Create mock Lambda functions
    const costCollectorFunction = new lambda.Function(
      stack,
      "CostCollectorLambda",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = async () => {}"),
      }
    );

    const schedulerFunction = new lambda.Function(stack, "SchedulerLambda", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {}"),
    });

    // Create mock DLQs
    const costCollectorDlq = new sqs.Queue(stack, "CostCollectorDlq");
    const eventRuleDlq = new sqs.Queue(stack, "EventRuleDlq");

    const observability = new LeaseCostsObservability(stack, "Observability", {
      costCollectorFunction,
      schedulerFunction,
      costCollectorDlq,
      eventRuleDlq,
      alertEmail,
    });

    return {
      app,
      stack,
      observability,
      template: Template.fromStack(stack),
    };
  };

  describe("SNS Topic", () => {
    it("should create SNS topic with correct display name", () => {
      const { template } = createTestStack();

      template.hasResourceProperties("AWS::SNS::Topic", {
        DisplayName: "ISB Lease Costs Alerts",
      });
    });

    it("should add email subscription when alertEmail provided", () => {
      const { template } = createTestStack("test@example.com");

      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "test@example.com",
      });
    });

    it("should not add email subscription when alertEmail not provided", () => {
      const { template } = createTestStack();

      template.resourceCountIs("AWS::SNS::Subscription", 0);
    });

    it("should expose alarms topic", () => {
      const { observability } = createTestStack();
      expect(observability.alarmsTopic).toBeDefined();
    });
  });

  describe("CloudWatch Alarms", () => {
    it("should create exactly 5 alarms", () => {
      const { template } = createTestStack();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
    });

    it("should expose all alarms in array", () => {
      const { observability } = createTestStack();
      expect(observability.alarms).toHaveLength(5);
    });

    describe("Collector DLQ Alarm", () => {
      it("should create alarm with correct configuration", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-dlq",
          AlarmDescription: "Cost Collector Lambda failures detected in DLQ",
          Threshold: 1,
          EvaluationPeriods: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });
      });

      it("should monitor DLQ message visibility", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-dlq",
          MetricName: "ApproximateNumberOfMessagesVisible",
          Namespace: "AWS/SQS",
        });
      });

      it("should have SNS alarm action", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-dlq",
          AlarmActions: Match.arrayWith([
            Match.objectLike({
              Ref: Match.stringLikeRegexp("ObservabilityAlertTopic"),
            }),
          ]),
        });
      });

      it("should expose alarm", () => {
        const { observability } = createTestStack();
        expect(observability.collectorDlqAlarm).toBeDefined();
      });
    });

    describe("Rule DLQ Alarm", () => {
      it("should create alarm with correct configuration", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-rule-dlq",
          AlarmDescription:
            "EventBridge Rule delivery failures detected in DLQ",
          Threshold: 1,
          EvaluationPeriods: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });
      });

      it("should expose alarm", () => {
        const { observability } = createTestStack();
        expect(observability.ruleDlqAlarm).toBeDefined();
      });
    });

    describe("Scheduler Errors Alarm", () => {
      it("should create alarm with correct configuration", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-scheduler-errors",
          AlarmDescription: "Scheduler Lambda errors exceed threshold",
          Threshold: 3,
          EvaluationPeriods: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });
      });

      it("should monitor Lambda errors metric", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-scheduler-errors",
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 300, // 5 minutes
        });
      });

      it("should expose alarm", () => {
        const { observability } = createTestStack();
        expect(observability.schedulerErrorsAlarm).toBeDefined();
      });
    });

    describe("Collector Errors Alarm", () => {
      it("should create alarm with correct configuration", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-errors",
          AlarmDescription: "Cost Collector Lambda errors exceed threshold",
          Threshold: 3,
          EvaluationPeriods: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });
      });

      it("should monitor Lambda errors metric", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-errors",
          MetricName: "Errors",
          Namespace: "AWS/Lambda",
          Statistic: "Sum",
          Period: 300, // 5 minutes
        });
      });

      it("should expose alarm", () => {
        const { observability } = createTestStack();
        expect(observability.collectorErrorsAlarm).toBeDefined();
      });
    });

    describe("Collector Duration Alarm", () => {
      it("should create alarm with correct configuration", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-duration",
          AlarmDescription: "Cost Collector Lambda duration approaching timeout (12 min threshold for 15 min timeout)",
          Threshold: 720000, // 12 minutes in milliseconds
          EvaluationPeriods: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "notBreaching",
        });
      });

      it("should monitor Lambda duration metric", () => {
        const { template } = createTestStack();

        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          AlarmName: "isb-lease-costs-collector-duration",
          MetricName: "Duration",
          Namespace: "AWS/Lambda",
          Statistic: "Maximum",
          Period: 300, // 5 minutes
        });
      });

      it("should expose alarm", () => {
        const { observability } = createTestStack();
        expect(observability.collectorDurationAlarm).toBeDefined();
      });
    });
  });

  describe("custom configuration", () => {
    it("should use custom thresholds when provided", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack", {
        env: { account: "123456789012", region: "us-west-2" },
      });

      const costCollectorFunction = new lambda.Function(
        stack,
        "CostCollectorLambda",
        {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: lambda.Code.fromInline("exports.handler = async () => {}"),
        }
      );

      const schedulerFunction = new lambda.Function(stack, "SchedulerLambda", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromInline("exports.handler = async () => {}"),
      });

      const costCollectorDlq = new sqs.Queue(stack, "CostCollectorDlq");
      const eventRuleDlq = new sqs.Queue(stack, "EventRuleDlq");

      new LeaseCostsObservability(stack, "Observability", {
        costCollectorFunction,
        schedulerFunction,
        costCollectorDlq,
        eventRuleDlq,
        dlqThreshold: 5,
        errorThreshold: 10,
        evaluationPeriods: 2,
        durationThreshold: 600000, // 10 minutes
      });

      const template = Template.fromStack(stack);

      // Check DLQ alarm threshold
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "isb-lease-costs-collector-dlq",
        Threshold: 5,
        EvaluationPeriods: 2,
      });

      // Check error alarm threshold
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "isb-lease-costs-collector-errors",
        Threshold: 10,
        EvaluationPeriods: 2,
      });

      // Check duration alarm threshold
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "isb-lease-costs-collector-duration",
        Threshold: 600000,
        EvaluationPeriods: 2,
      });
    });
  });

  describe("outputs", () => {
    it("should create CloudFormation output for alert topic ARN", () => {
      const { template } = createTestStack();

      // CDK generates unique IDs for outputs, so we check by description
      const outputs = template.toJSON().Outputs;
      const alertTopicOutput = Object.values(outputs).find(
        (output: any) =>
          output.Description === "SNS topic for operational alerts"
      );
      expect(alertTopicOutput).toBeDefined();
    });
  });

  describe("snapshot", () => {
    it("should match snapshot", () => {
      const { template } = createTestStack("test@example.com");
      expect(template.toJSON()).toMatchSnapshot();
    });
  });
});
