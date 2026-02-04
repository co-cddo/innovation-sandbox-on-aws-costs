import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface CostExplorerRoleStackProps extends cdk.StackProps {
  hubAccountId: string;
  /**
   * Exact ARN of the Cost Collector Lambda execution role.
   * This is used to create a least-privilege trust policy that only allows
   * the specific Lambda role to assume the Cost Explorer role.
   *
   * @example "arn:aws:iam::568672915267:role/IsbCostCollectionStack-CollectorCostCollectorLambdaServiceRole"
   */
  costCollectorLambdaRoleArn: string;
}

/**
 * Creates a cross-account role in orgManagement that allows the hub account
 * Lambda to query Cost Explorer.
 *
 * Deploy this stack to the orgManagement account.
 */
export class CostExplorerRoleStack extends cdk.Stack {
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: CostExplorerRoleStackProps) {
    super(scope, id, props);

    const { hubAccountId, costCollectorLambdaRoleArn } = props;

    // Create the role that can be assumed by the hub account Lambda
    // Security: Use exact ARN matching instead of wildcards to prevent privilege escalation
    // Defense-in-depth: Restrict to specific source account and principal
    const costExplorerRole = new iam.Role(this, "CostExplorerReadRole", {
      roleName: "isb-lease-costs-explorer-role",
      assumedBy: new iam.AccountPrincipal(hubAccountId).withConditions({
        // Combined conditions using StringEquals
        StringEquals: {
          // Exact ARN match - no wildcards
          // This ensures ONLY the specific Cost Collector Lambda execution role can assume this role
          "aws:PrincipalArn": costCollectorLambdaRoleArn,
          // Defense-in-depth: Verify the source account matches the hub account
          // This prevents cross-account attacks where an attacker might try to use
          // a role with the same name in a different account
          "aws:SourceAccount": hubAccountId,
        },
      }),
      description:
        "Allows ISB Lease Cost Collection Lambda to query Cost Explorer (least-privilege trust policy)",
    });

    // Add Cost Explorer read permissions
    // GetCostAndUsage: service-level cost aggregation
    // GetCostAndUsageWithResources: resource-level cost breakdown (requires org-level opt-in)
    costExplorerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CostExplorerRead",
        effect: iam.Effect.ALLOW,
        actions: ["ce:GetCostAndUsage", "ce:GetCostAndUsageWithResources"],
        resources: ["*"],
      })
    );

    this.roleArn = costExplorerRole.roleArn;

    // Output the role ARN
    new cdk.CfnOutput(this, "CostExplorerRoleArn", {
      value: costExplorerRole.roleArn,
      description: "ARN of the Cost Explorer role for cross-account access",
      exportName: "IsbLeaseCostsExplorerRoleArn",
    });
  }
}
