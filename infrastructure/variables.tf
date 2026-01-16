variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "eu-west-2"
}

variable "namespace" {
  description = "Namespace prefix for resources"
  type        = string
  default     = "ndx"
}

variable "govuk_notify_template_id" {
  description = "GOV.UK Notify template ID for cost report emails"
  type        = string
}

variable "cost_report_delay_hours" {
  description = "Hours to wait after lease ends before sending cost report (AWS billing reconciliation time)"
  type        = number
  default     = 24
}
