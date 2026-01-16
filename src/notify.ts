/**
 * GOV.UK Notify integration for sending cost report emails
 *
 * GOV.UK Notify is the UK government's email/SMS notification service.
 * API Documentation: https://docs.notifications.service.gov.uk/
 */

interface SendEmailParams {
  apiKey: string;
  templateId: string;
  emailAddress: string;
  personalisation: Record<string, string>;
}

interface NotifyResponse {
  id: string;
  reference?: string;
  content: {
    subject: string;
    body: string;
    from_email: string;
  };
}

const NOTIFY_API_BASE = "https://api.notifications.service.gov.uk";

/**
 * Sends a cost report email via GOV.UK Notify
 */
export async function sendCostReportEmail(
  params: SendEmailParams
): Promise<NotifyResponse> {
  const { apiKey, templateId, emailAddress, personalisation } = params;

  const response = await fetch(`${NOTIFY_API_BASE}/v2/notifications/email`, {
    method: "POST",
    headers: {
      Authorization: `ApiKey-v1 ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: emailAddress,
      template_id: templateId,
      personalisation,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("GOV.UK Notify API error:", {
      status: response.status,
      body: errorBody,
    });
    throw new Error(
      `GOV.UK Notify API error: ${response.status} - ${errorBody}`
    );
  }

  const result = (await response.json()) as NotifyResponse;
  console.log("Email sent successfully:", {
    notificationId: result.id,
    emailAddress,
  });

  return result;
}
