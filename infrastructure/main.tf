terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "NDX"
      ManagedBy   = "Terraform"
      Environment = "production"
      Component   = "CostReporter"
    }
  }
}

# =============================================================================
# IAM ROLE FOR LAMBDA
# =============================================================================

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "cost_reporter_lambda" {
  name               = "${var.namespace}-cost-reporter-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "cost_reporter_lambda" {
  # CloudWatch Logs
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  # Cost Explorer - read-only access
  statement {
    effect = "Allow"
    actions = [
      "ce:GetCostAndUsage"
    ]
    resources = ["*"]
  }

  # EventBridge Scheduler - to create delayed schedules
  statement {
    effect = "Allow"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule"
    ]
    resources = [
      "arn:aws:scheduler:${var.aws_region}:*:schedule/${var.namespace}-cost-reporter/*"
    ]
  }

  # IAM PassRole for scheduler to invoke Lambda
  statement {
    effect = "Allow"
    actions = [
      "iam:PassRole"
    ]
    resources = [aws_iam_role.scheduler_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }

  # Secrets Manager - to read GOV.UK Notify API key
  statement {
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:*:secret:${var.namespace}/govuk-notify-*"
    ]
  }
}

resource "aws_iam_role_policy" "cost_reporter_lambda" {
  name   = "${var.namespace}-cost-reporter-lambda-policy"
  role   = aws_iam_role.cost_reporter_lambda.id
  policy = data.aws_iam_policy_document.cost_reporter_lambda.json
}

# =============================================================================
# IAM ROLE FOR EVENTBRIDGE SCHEDULER
# =============================================================================

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    actions = ["sts:AssumeRole"]
  }
}

resource "aws_iam_role" "scheduler_execution" {
  name               = "${var.namespace}-cost-reporter-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "scheduler_execution" {
  statement {
    effect = "Allow"
    actions = [
      "lambda:InvokeFunction"
    ]
    resources = [aws_lambda_function.cost_reporter.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_execution" {
  name   = "${var.namespace}-cost-reporter-scheduler-policy"
  role   = aws_iam_role.scheduler_execution.id
  policy = data.aws_iam_policy_document.scheduler_execution.json
}

# =============================================================================
# LAMBDA FUNCTION
# =============================================================================

data "archive_file" "lambda_package" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/../lambda.zip"
}

resource "aws_lambda_function" "cost_reporter" {
  function_name = "${var.namespace}-cost-reporter"
  description   = "Sends cost reports to users after lease ends"

  filename         = data.archive_file.lambda_package.output_path
  source_code_hash = data.archive_file.lambda_package.output_base64sha256
  handler          = "handler.handler"
  runtime          = "nodejs22.x"
  timeout          = 60
  memory_size      = 256

  role = aws_iam_role.cost_reporter_lambda.arn

  environment {
    variables = {
      GOVUK_NOTIFY_SECRET_ARN = var.govuk_notify_secret_arn
      GOVUK_NOTIFY_TEMPLATE_ID = var.govuk_notify_template_id
      SCHEDULER_ROLE_ARN      = aws_iam_role.scheduler_execution.arn
      SCHEDULER_GROUP_NAME    = aws_scheduler_schedule_group.cost_reporter.name
      COST_REPORT_DELAY_HOURS = var.cost_report_delay_hours
    }
  }

  depends_on = [aws_cloudwatch_log_group.cost_reporter]
}

resource "aws_cloudwatch_log_group" "cost_reporter" {
  name              = "/aws/lambda/${var.namespace}-cost-reporter"
  retention_in_days = 14
}

# =============================================================================
# EVENTBRIDGE SCHEDULER GROUP
# =============================================================================

resource "aws_scheduler_schedule_group" "cost_reporter" {
  name = "${var.namespace}-cost-reporter"
}

# =============================================================================
# EVENTBRIDGE RULE - LEASE ENDED EVENTS
# =============================================================================
# Listens for Innovation Sandbox lease termination/expiration events

resource "aws_cloudwatch_event_rule" "lease_ended" {
  name        = "${var.namespace}-cost-reporter-lease-ended"
  description = "Triggers cost report when a sandbox lease ends"

  event_pattern = jsonencode({
    source      = ["innovation-sandbox"]
    detail-type = ["Lease Ended", "Lease Terminated", "Lease Expired"]
  })
}

resource "aws_cloudwatch_event_target" "lease_ended" {
  rule      = aws_cloudwatch_event_rule.lease_ended.name
  target_id = "cost-reporter-lambda"
  arn       = aws_lambda_function.cost_reporter.arn

  # Transform the event to include action type
  input_transformer {
    input_paths = {
      accountId   = "$.detail.accountId"
      leaseId     = "$.detail.leaseId"
      userEmail   = "$.detail.userEmail"
      leaseStart  = "$.detail.leaseStartTime"
      leaseEnd    = "$.detail.leaseEndTime"
      detailType  = "$.detail-type"
    }
    input_template = <<EOF
{
  "action": "SCHEDULE_COST_REPORT",
  "accountId": <accountId>,
  "leaseId": <leaseId>,
  "userEmail": <userEmail>,
  "leaseStartTime": <leaseStart>,
  "leaseEndTime": <leaseEnd>,
  "eventType": <detailType>
}
EOF
  }
}

resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_reporter.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.lease_ended.arn
}
