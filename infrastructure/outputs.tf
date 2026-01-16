output "lambda_function_arn" {
  description = "ARN of the cost reporter Lambda function"
  value       = aws_lambda_function.cost_reporter.arn
}

output "lambda_function_name" {
  description = "Name of the cost reporter Lambda function"
  value       = aws_lambda_function.cost_reporter.function_name
}

output "eventbridge_rule_arn" {
  description = "ARN of the EventBridge rule for lease ended events"
  value       = aws_cloudwatch_event_rule.lease_ended.arn
}

output "scheduler_group_name" {
  description = "Name of the EventBridge Scheduler group"
  value       = aws_scheduler_schedule_group.cost_reporter.name
}

output "lambda_role_arn" {
  description = "ARN of the Lambda execution role"
  value       = aws_iam_role.cost_reporter_lambda.arn
}
