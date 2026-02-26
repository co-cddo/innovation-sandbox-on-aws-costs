#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CostCollectionStack } from "../lib/cost-collection-stack.js";
import { CostExplorerRoleStack } from "../lib/cost-explorer-role-stack.js";

const app = new cdk.App();

// Account IDs
const hubAccountId = app.node.tryGetContext("hubAccountId") ?? "568672915267";
const orgMgmtAccountId = app.node.tryGetContext("orgMgmtAccountId") ?? "955063685555";

// Context values for main stack
const eventBusName = app.node.tryGetContext("eventBusName") ?? "InnovationSandboxComputeISBEventBus6697FE33";
const costExplorerRoleArn = app.node.tryGetContext("costExplorerRoleArn") ?? `arn:aws:iam::${orgMgmtAccountId}:role/isb-lease-costs-explorer-role`;
const isbApiBaseUrl = app.node.tryGetContext("isbApiBaseUrl") ?? "";
const isbJwtSecretPath = app.node.tryGetContext("isbJwtSecretPath") ?? "";
const alertEmail = app.node.tryGetContext("alertEmail") ?? "";
const isbJwtSecretKmsKeyArn = app.node.tryGetContext("isbJwtSecretKmsKeyArn") ?? "";

// Cost Collector Lambda role ARN - required for least-privilege trust policy
// This is obtained from the CostCollectionStack outputs after initial deployment
const costCollectorLambdaRoleArn = app.node.tryGetContext("costCollectorLambdaRoleArn") ?? "";

// Validate role ARN format
const ROLE_ARN_REGEX = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
if (!ROLE_ARN_REGEX.test(costExplorerRoleArn)) {
  throw new Error(
    `Invalid costExplorerRoleArn format: ${costExplorerRoleArn}. ` +
    `Expected format: arn:aws:iam::<account-id>:role/<role-name>`
  );
}

// Validate ISB API configuration
if (!isbApiBaseUrl) {
  throw new Error(
    "isbApiBaseUrl context variable is required. " +
    "Provide it via: --context isbApiBaseUrl=https://abc123.execute-api.us-west-2.amazonaws.com/prod"
  );
}
if (!isbJwtSecretPath) {
  throw new Error(
    "isbJwtSecretPath context variable is required. " +
    "Provide it via: --context isbJwtSecretPath=/InnovationSandbox/ndx/Auth/JwtSecret"
  );
}

// Validate Cost Collector Lambda role ARN for trust policy (required for role stack)
const IAM_ROLE_ARN_REGEX = /^arn:aws:iam::\d{12}:role\/[\w+=,.@\/-]+$/;
if (!costCollectorLambdaRoleArn) {
  throw new Error(
    "costCollectorLambdaRoleArn context variable is required. " +
    "After deploying IsbCostCollectionStack, get the role ARN from outputs and redeploy IsbCostExplorerRoleStack. " +
    "Provide it via: --context costCollectorLambdaRoleArn=arn:aws:iam::account:role/role-name"
  );
}
if (!IAM_ROLE_ARN_REGEX.test(costCollectorLambdaRoleArn)) {
  throw new Error(
    `Invalid costCollectorLambdaRoleArn format: ${costCollectorLambdaRoleArn}. ` +
    `Expected format: arn:aws:iam::<account>:role/<role-name>`
  );
}
// Security: Reject wildcards in role ARN to prevent overly permissive trust policies
if (costCollectorLambdaRoleArn.includes("*")) {
  throw new Error(
    `Security violation: costCollectorLambdaRoleArn must not contain wildcards (*). ` +
    `Received: ${costCollectorLambdaRoleArn}. ` +
    `Use the exact Lambda execution role ARN from IsbCostCollectionStack outputs.`
  );
}

// Stack 1: Cost Explorer Role (deploy to orgManagement account)
const roleStack = new CostExplorerRoleStack(app, "IsbCostExplorerRoleStack", {
  env: {
    account: orgMgmtAccountId,
    region: "us-east-1", // Cost Explorer is only in us-east-1
  },
  hubAccountId,
  costCollectorLambdaRoleArn,
});

// Stack 2: Main Cost Collection (deploy to hub account)
const collectionStack = new CostCollectionStack(app, "IsbCostCollectionStack", {
  env: {
    account: hubAccountId,
    region: "us-west-2",
  },
  eventBusName,
  costExplorerRoleArn,
  isbApiBaseUrl,
  isbJwtSecretPath,
  isbJwtSecretKmsKeyArn: isbJwtSecretKmsKeyArn || undefined,
  alertEmail,
});

// CRITICAL: Enforce deployment order to prevent runtime failures
// The collection stack MUST be deployed after the role stack because:
// 1. The Cost Collector Lambda needs to assume the Cost Explorer role at runtime
// 2. If the role doesn't exist, Lambda execution will fail with AssumeRole errors
// 3. CDK doesn't automatically detect cross-account dependencies
collectionStack.addDependency(roleStack);
