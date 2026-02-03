import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { LeaseCostsStorage } from "./lease-costs-storage.js";

describe("LeaseCostsStorage", () => {
  describe("default configuration", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: { account: "123456789012", region: "us-west-2" },
    });
    const storage = new LeaseCostsStorage(stack, "Storage", {
      accountId: "123456789012",
      region: "us-west-2",
    });
    const template = Template.fromStack(stack);

    it("should create bucket with correct naming pattern", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "isb-lease-costs-123456789012-us-west-2",
      });
      // Bucket name is exposed through the construct
      expect(storage.bucket).toBeDefined();
    });

    it("should have S3 managed encryption", () => {
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

    it("should block all public access", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it("should have 3-year lifecycle expiration by default", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: [
            {
              ExpirationInDays: 1095, // 3 years
              Status: "Enabled",
            },
          ],
        },
      });
    });

    it("should have RETAIN removal policy by default", () => {
      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    it("should expose bucket object", () => {
      expect(storage.bucket).toBeDefined();
      expect(storage.bucketName).toBeDefined();
    });
  });

  describe("custom configuration", () => {
    it("should use custom bucket name when provided", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      new LeaseCostsStorage(stack, "Storage", {
        accountId: "123456789012",
        region: "us-west-2",
        bucketName: "my-custom-bucket",
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::S3::Bucket", {
        BucketName: "my-custom-bucket",
      });
    });

    it("should use custom expiration days when provided", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      new LeaseCostsStorage(stack, "Storage", {
        accountId: "123456789012",
        region: "us-west-2",
        expirationDays: 365, // 1 year
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: [
            {
              ExpirationInDays: 365,
              Status: "Enabled",
            },
          ],
        },
      });
    });

    it("should use custom removal policy when provided", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      new LeaseCostsStorage(stack, "Storage", {
        accountId: "123456789012",
        region: "us-west-2",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      const template = Template.fromStack(stack);

      template.hasResource("AWS::S3::Bucket", {
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
    });
  });

  describe("outputs", () => {
    it("should create CloudFormation output for bucket name", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");
      new LeaseCostsStorage(stack, "Storage", {
        accountId: "123456789012",
        region: "us-west-2",
      });
      const template = Template.fromStack(stack);

      // CDK generates unique IDs for outputs, so we check by description
      const outputs = template.toJSON().Outputs;
      const bucketOutput = Object.values(outputs).find(
        (output: any) =>
          output.Description === "S3 bucket for cost CSV files"
      );
      expect(bucketOutput).toBeDefined();
    });
  });

  describe("snapshot", () => {
    it("should match snapshot", () => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack", {
        env: { account: "123456789012", region: "us-west-2" },
      });
      new LeaseCostsStorage(stack, "Storage", {
        accountId: "123456789012",
        region: "us-west-2",
      });
      const template = Template.fromStack(stack);

      expect(template.toJSON()).toMatchSnapshot();
    });
  });
});
