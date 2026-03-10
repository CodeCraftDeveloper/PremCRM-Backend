import logger from "./logger.js";

const DEFAULT_TIMEOUT_MS = 5000;

const normalizeBaseUrl = (value = "") => String(value).replace(/\/+$/, "");

const buildResetUrl = (resetToken) => {
  const encodedToken = encodeURIComponent(resetToken);
  const template = process.env.PASSWORD_RESET_URL_TEMPLATE;

  if (template && template.includes("{token}")) {
    return template.replace("{token}", encodedToken);
  }

  if (process.env.FRONTEND_URL) {
    return `${normalizeBaseUrl(process.env.FRONTEND_URL)}/reset-password/${encodedToken}`;
  }

  return null;
};

export const sendPasswordResetNotification = async ({
  email,
  resetToken,
  tenantId,
  userId,
}) => {
  const webhookUrl = process.env.PASSWORD_RESET_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn(
      `Password reset notification not sent for ${email}: PASSWORD_RESET_WEBHOOK_URL is not configured`,
      { tenantId, userId },
    );
    return { delivered: false, reason: "webhook_not_configured" };
  }

  const resetUrl = buildResetUrl(resetToken);
  if (!resetUrl) {
    logger.warn(
      `Password reset notification not sent for ${email}: reset URL could not be built`,
      { tenantId, userId },
    );
    return { delivered: false, reason: "reset_url_unavailable" };
  }

  const controller = new AbortController();
  const timeoutMs = Number(process.env.PASSWORD_RESET_NOTIFY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "password_reset",
        email,
        resetUrl,
        tenantId,
        userId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Webhook responded with status ${response.status}`);
    }

    logger.info(`Password reset notification dispatched for ${email}`, {
      tenantId,
      userId,
    });
    return { delivered: true };
  } finally {
    clearTimeout(timeout);
  }
};
