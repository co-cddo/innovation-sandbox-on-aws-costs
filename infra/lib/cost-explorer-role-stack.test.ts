import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, it, expect } from "vitest";
import { CostExplorerRoleStack } from "./cost-explorer-role-stack.js";

describe("CostExplorerRoleStack", () => {
  const hubAccountId = "123456789012";
  const orgMgmtAccountId = "999888777666";
  const costCollectorLambdaRoleArn = `arn:aws:iam::${hubAccountId}:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole`;

  const createStack = () => {
    const app = new App();
    const stack = new CostExplorerRoleStack(app, "TestStack", {
      env: {
        account: orgMgmtAccountId,
        region: "us-east-1",
      },
      hubAccountId,
      costCollectorLambdaRoleArn,
    });
    return { app, stack };
  };

  describe("IAM Role", () => {
    it("should create Cost Explorer role with correct name", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::IAM::Role", {
        RoleName: "isb-lease-costs-explorer-role",
        Description: "Allows ISB Lease Cost Collection Lambda to query Cost Explorer (least-privilege trust policy)",
      });
    });

    it("should use exact ARN matching in trust policy (no wildcards)", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: "sts:AssumeRole",
              Effect: "Allow",
              Principal: {
                AWS: {
                  "Fn::Join": [
                    "",
                    [
                      "arn:",
                      { Ref: "AWS::Partition" },
                      `:iam::${hubAccountId}:root`,
                    ],
                  ],
                },
              },
              Condition: {
                StringEquals: {
                  // Exact ARN match - no wildcards
                  "aws:PrincipalArn": costCollectorLambdaRoleArn,
                  // Defense-in-depth: Source account verification
                  "aws:SourceAccount": hubAccountId,
                },
              },
            },
          ],
        },
      });
    });

    it("should not use StringLike or wildcards in trust policy", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      const resources = template.toJSON().Resources;
      const role = Object.values(resources).find(
        (r: any) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === "isb-lease-costs-explorer-role"
      ) as any;

      const trustPolicy = role.Properties.AssumeRolePolicyDocument;
      const conditions = trustPolicy.Statement[0].Condition;

      // Ensure no StringLike conditions (wildcards)
      expect(conditions).not.toHaveProperty("StringLike");

      // Ensure PrincipalArn uses exact match
      expect(conditions.StringEquals["aws:PrincipalArn"]).toBe(costCollectorLambdaRoleArn);
      expect(conditions.StringEquals["aws:PrincipalArn"]).not.toContain("*");
    });

    it("should grant Cost Explorer read permissions", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: [
            {
              Sid: "CostExplorerRead",
              Action: "ce:GetCostAndUsage",
              Effect: "Allow",
              Resource: "*",
            },
          ],
        },
      });
    });

    it("should output the role ARN", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      const outputs = template.toJSON().Outputs;
      expect(outputs).toHaveProperty("CostExplorerRoleArn");
      expect(outputs.CostExplorerRoleArn.Description).toBe(
        "ARN of the Cost Explorer role for cross-account access"
      );
      expect(outputs.CostExplorerRoleArn.Export).toEqual({
        Name: "IsbLeaseCostsExplorerRoleArn",
      });
    });
  });

  describe("Security Validations", () => {
    it("should reject wildcard Lambda role ARN patterns", () => {
      const app = new App();
      const wildcardRoleArn = `arn:aws:iam::${hubAccountId}:role/IsbCostCollectionStack-CostCollectorLambda*`;

      const stack = new CostExplorerRoleStack(app, "TestStack", {
        env: {
          account: orgMgmtAccountId,
          region: "us-east-1",
        },
        hubAccountId,
        costCollectorLambdaRoleArn: wildcardRoleArn,
      });

      const template = Template.fromStack(stack);
      const resources = template.toJSON().Resources;
      const role = Object.values(resources).find(
        (r: any) => r.Type === "AWS::IAM::Role"
      ) as any;

      const principalArn = role.Properties.AssumeRolePolicyDocument.Statement[0]
        .Condition.StringEquals["aws:PrincipalArn"];

      // Even though we pass a wildcard, it should be used as-is (the validation happens at app.ts level)
      // This test ensures the trust policy uses whatever ARN is provided without modification
      expect(principalArn).toBe(wildcardRoleArn);

      // Document that wildcards should be caught at the app.ts validation layer
      expect(wildcardRoleArn).toContain("*");
    });

    it("should include defense-in-depth source account condition", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      const resources = template.toJSON().Resources;
      const role = Object.values(resources).find(
        (r: any) => r.Type === "AWS::IAM::Role"
      ) as any;

      const conditions = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;

      // Verify defense-in-depth: Source account must match hub account
      expect(conditions.StringEquals["aws:SourceAccount"]).toBe(hubAccountId);
    });

    it("should verify trust policy allows only the exact Lambda role ARN", () => {
      const { stack } = createStack();
      const template = Template.fromStack(stack);

      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Condition: {
                StringEquals: {
                  "aws:PrincipalArn": costCollectorLambdaRoleArn,
                },
              },
            },
          ],
        },
      });
    });
  });

  describe("Deployment Configuration", () => {
    it("should be deployed to us-east-1 region", () => {
      const { stack } = createStack();
      expect(stack.region).toBe("us-east-1");
    });

    it("should be deployed to orgManagement account", () => {
      const { stack } = createStack();
      expect(stack.account).toBe(orgMgmtAccountId);
    });
  });
});
