import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { CostCollectionStack } from "./cost-collection-stack.js";

describe("CostCollectionStack", () => {
  const app = new cdk.App();
  const stack = new CostCollectionStack(app, "TestStack", {
    env: { account: "123456789012", region: "us-west-2" },
    eventBusName: "test-event-bus",
    costExplorerRoleArn:
      "arn:aws:iam::999999999999:role/CostExplorerReadRole",
    isbApiBaseUrl: "https://test-api.execute-api.us-west-2.amazonaws.com/prod",
    isbJwtSecretPath: "/InnovationSandbox/ndx/Auth/JwtSecret",
    alertEmail: "alerts@example.com",
  });
  const template = Template.fromStack(stack);

  describe("S3 Bucket", () => {
    it("should have S3 bucket with 3-year lifecycle rule", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: [
            {
              ExpirationInDays: 1095,
              Status: "Enabled",
            },
          ],
        },
      });
    });

    it("should block public access", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("should enable encryption at rest with SSE-S3", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
      });
    });

    it("should enforce HTTPS-only access with bucket policy", () => {
      // Verify bucket policy exists that denies non-HTTPS requests
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: [
            {
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: "s3:*",
              Condition: {
                Bool: {
                  "aws:SecureTransport": "false",
                },
              },
            },
          ],
        },
      });
    });

    it("should have versioning disabled (not required for cost reports)", () => {
      // Versioning is NOT required for this use case (transient cost data)
      // This test documents the decision to keep costs low
      const buckets = template.findResources("AWS::S3::Bucket");
      const bucketKeys = Object.keys(buckets);

      // Verify bucket exists but versioning is not explicitly enabled
      expect(bucketKeys.length).toBeGreaterThan(0);

      // If VersioningConfiguration is present, it should not be "Enabled"
      bucketKeys.forEach((key) => {
        const bucket = buckets[key];
        if (bucket.Properties.VersioningConfiguration) {
          expect(bucket.Properties.VersioningConfiguration.Status).not.toBe("Enabled");
        }
      });
    });
  });

  describe("Lambda Functions", () => {
    it("should have Scheduler Lambda with Node.js 22 and ARM64", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 15,
        MemorySize: 256,
      });
    });

    it("should have Cost Collector Lambda with Node.js 22 and ARM64", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 900, // 15 minutes for Cost Explorer pagination + throttling on large accounts (200+ services)
        MemorySize: 512,
      });
    });

    it("should have X-Ray tracing enabled on application Lambdas", () => {
      // Note: CDK may create additional Lambda functions for log retention
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        TracingConfig: {
          Mode: "Active",
        },
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        TracingConfig: {
          Mode: "Active",
        },
      });
    });

    it("should have Lambda Insights enabled on Scheduler Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-scheduler",
        Layers: [
          "arn:aws:lambda:us-west-2:580247275435:layer:LambdaInsightsExtension-Arm64:5",
        ],
      });
    });

    it("should have Lambda Insights enabled on Cost Collector Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-collector",
        Layers: [
          "arn:aws:lambda:us-west-2:580247275435:layer:LambdaInsightsExtension-Arm64:5",
        ],
      });
    });

    it("should have Lambda Insights enabled on Cleanup Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "isb-lease-costs-cleanup",
        Layers: [
          "arn:aws:lambda:us-west-2:580247275435:layer:LambdaInsightsExtension-Arm64:5",
        ],
      });
    });
  });

  describe("EventBridge Rule", () => {
    it("should trigger on LeaseTerminated events", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          source: ["isb"],
          "detail-type": ["LeaseTerminated"],
        },
      });
    });
  });

  describe("SQS Queues", () => {
    it("should have Cost Collector DLQ with 14-day retention", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "isb-lease-costs-collector-dlq",
        MessageRetentionPeriod: 1209600,
      });
    });

    it("should have Event Rule DLQ with 14-day retention", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: "isb-lease-costs-rule-dlq",
        MessageRetentionPeriod: 1209600,
      });
    });
  });

  describe("CloudWatch Alarms", () => {
    it("should have 5 CloudWatch alarms", () => {
      template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
    });

    it("should have DLQ alarm for collector", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "isb-lease-costs-collector-dlq",
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
      });
    });

    it("should have errors alarm for scheduler lambda", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmName: "isb-lease-costs-scheduler-errors",
        Threshold: 3,
      });
    });
  });

  describe("IAM", () => {
    it("should have scheduler execution role for EventBridge Scheduler", () => {
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
      });
    });

    describe("Security: Least Privilege IAM Policies", () => {
      it("should NOT grant wildcard (*) Action on any IAM policies", () => {
        // Scan all IAM policies to ensure no Action: "*" is granted
        const roles = template.findResources("AWS::IAM::Role");
        const violations: string[] = [];

        Object.entries(roles).forEach(([roleName, roleResource]: [string, any]) => {
          const policies = roleResource.Properties?.Policies || [];

          policies.forEach((policy: any) => {
            const statements = policy.PolicyDocument?.Statement || [];

            statements.forEach((statement: any) => {
              const actions = Array.isArray(statement.Action)
                ? statement.Action
                : [statement.Action];

              // Check if Action is "*"
              if (actions.includes("*")) {
                violations.push(
                  `Role ${roleName} has Action: "*" which grants all AWS actions`
                );
              }
            });
          });
        });

        // Report all violations
        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} IAM policy violations:\n` +
              violations.join("\n")
          );
        }

        expect(violations).toHaveLength(0);
      });

      it("should NOT grant Resource: * for sensitive actions (sts:AssumeRole, iam:PassRole)", () => {
        // Verify sensitive actions are scoped to specific resources
        const roles = template.findResources("AWS::IAM::Role");
        const violations: string[] = [];

        const sensitiveActions = ["sts:AssumeRole", "iam:PassRole"];

        Object.entries(roles).forEach(([roleName, roleResource]: [string, any]) => {
          const policies = roleResource.Properties?.Policies || [];

          policies.forEach((policy: any) => {
            const statements = policy.PolicyDocument?.Statement || [];

            statements.forEach((statement: any) => {
              const actions = Array.isArray(statement.Action)
                ? statement.Action
                : [statement.Action];

              // Check if statement contains sensitive actions
              const hasSensitiveAction = actions.some((action: string) =>
                sensitiveActions.includes(action)
              );

              if (hasSensitiveAction) {
                // Verify Resource is not "*"
                const resources = Array.isArray(statement.Resource)
                  ? statement.Resource
                  : [statement.Resource];

                if (resources.includes("*")) {
                  violations.push(
                    `Role ${roleName} grants ${actions.join(", ")} with Resource: "*"`
                  );
                }
              }
            });
          });
        });

        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} sensitive action violations:\n` +
              violations.join("\n")
          );
        }

        expect(violations).toHaveLength(0);
      });

      it("should scope S3 permissions to specific bucket (not arn:aws:s3:::*)", () => {
        // Verify S3 actions are not granted on all buckets
        const roles = template.findResources("AWS::IAM::Role");
        const violations: string[] = [];

        Object.entries(roles).forEach(([roleName, roleResource]: [string, any]) => {
          const policies = roleResource.Properties?.Policies || [];

          policies.forEach((policy: any) => {
            const statements = policy.PolicyDocument?.Statement || [];

            statements.forEach((statement: any) => {
              const actions = Array.isArray(statement.Action)
                ? statement.Action
                : [statement.Action];

              // Check if statement contains S3 actions
              const hasS3Action = actions.some(
                (action: string) => typeof action === "string" && action.startsWith("s3:")
              );

              if (hasS3Action) {
                // Verify Resource is not wildcard bucket
                const resources = Array.isArray(statement.Resource)
                  ? statement.Resource
                  : [statement.Resource];

                resources.forEach((resource: any) => {
                  if (typeof resource === "string") {
                    if (
                      resource === "arn:aws:s3:::*" ||
                      resource === "arn:aws:s3:::*/*"
                    ) {
                      violations.push(
                        `Role ${roleName} grants S3 permissions on all buckets: ${resource}`
                      );
                    }
                  }
                });
              }
            });
          });
        });

        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} S3 wildcard violations:\n` +
              violations.join("\n")
          );
        }

        expect(violations).toHaveLength(0);
      });

      it("should have iam:PassRole with condition to restrict service usage", () => {
        // Verify PassRole has StringEquals condition to limit which service can use the role
        const roles = template.findResources("AWS::IAM::Role");
        let hasPassRole = false;
        const violations: string[] = [];

        Object.entries(roles).forEach(([roleName, roleResource]: [string, any]) => {
          const policies = roleResource.Properties?.Policies || [];

          policies.forEach((policy: any) => {
            const statements = policy.PolicyDocument?.Statement || [];

            statements.forEach((statement: any) => {
              const actions = Array.isArray(statement.Action)
                ? statement.Action
                : [statement.Action];

              if (actions.includes("iam:PassRole")) {
                hasPassRole = true;

                // Verify condition exists to restrict PassRole
                if (!statement.Condition) {
                  violations.push(
                    `Role ${roleName} grants iam:PassRole without Condition (allows passing role to any service)`
                  );
                } else if (!statement.Condition.StringEquals) {
                  violations.push(
                    `Role ${roleName} grants iam:PassRole without StringEquals condition`
                  );
                }
              }
            });
          });
        });

        // Only check if PassRole exists (optional permission)
        if (hasPassRole && violations.length > 0) {
          expect.fail(
            `Found ${violations.length} iam:PassRole violations:\n` +
              violations.join("\n")
          );
        }
      });

      it("should NOT use AdministratorAccess or PowerUserAccess managed policies", () => {
        // Verify no Lambda role uses overly permissive managed policies
        const roles = template.findResources("AWS::IAM::Role");
        const violations: string[] = [];

        const forbiddenPolicies = [
          "arn:aws:iam::aws:policy/AdministratorAccess",
          "arn:aws:iam::aws:policy/PowerUserAccess",
        ];

        Object.entries(roles).forEach(([roleName, roleResource]: [string, any]) => {
          const managedPolicies = roleResource.Properties?.ManagedPolicyArns || [];

          managedPolicies.forEach((policyArn: string) => {
            if (forbiddenPolicies.includes(policyArn)) {
              violations.push(
                `Role ${roleName} uses overly permissive managed policy: ${policyArn}`
              );
            }
          });
        });

        if (violations.length > 0) {
          expect.fail(
            `Found ${violations.length} overly permissive managed policy violations:\n` +
              violations.join("\n")
          );
        }

        expect(violations).toHaveLength(0);
      });
    });
  });

  describe("SNS", () => {
    it("should have SNS topic for alerts", () => {
      template.hasResourceProperties("AWS::SNS::Topic", {
        DisplayName: "ISB Lease Costs Alerts",
      });
    });

    it("should have email subscription when alertEmail provided", () => {
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "alerts@example.com",
      });
    });
  });

  describe("Scheduler Group", () => {
    it("should have scheduler group with default name based on stack name", () => {
      template.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
        Name: "isb-lease-costs-TestStack",
      });
    });

    it("should use custom scheduler group name when provided", () => {
      const customApp = new cdk.App();
      const customStack = new CostCollectionStack(customApp, "CustomStack", {
        env: { account: "123456789012", region: "us-west-2" },
        eventBusName: "test-event-bus",
        costExplorerRoleArn:
          "arn:aws:iam::999999999999:role/CostExplorerReadRole",
        isbApiBaseUrl: "https://test-api.execute-api.us-west-2.amazonaws.com/prod",
        isbJwtSecretPath: "/InnovationSandbox/ndx/Auth/JwtSecret",
        schedulerGroupName: "custom-scheduler-group",
      });
      const customTemplate = Template.fromStack(customStack);

      customTemplate.hasResourceProperties("AWS::Scheduler::ScheduleGroup", {
        Name: "custom-scheduler-group",
      });
    });
  });

  it("should match snapshot", () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
