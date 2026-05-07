import { asyncHandler } from "../../utils/apiResponse.js";
import { PubsubVerification } from "../../services/pubsubVerificationService.js";
import {
  decodePubsubEnvelope,
  ingestGmailPubsubEvent,
} from "../../services/gmailPubsubIngestService.js";
import logger from "../../utils/logger.js";

/**
 * Public Gmail Pub/Sub push endpoint.
 *
 *   POST /api/v1/integrations/google/pubsub/push?token=<verification-token>
 *
 * Always responds quickly:
 *   - 204 on success or duplicate (Pub/Sub deletes the message on 2xx).
 *   - 401 on verification failure (Pub/Sub will retry — operator must
 *     fix the token configuration).
 *   - 400 on malformed envelope (unrecoverable, drop).
 *
 * Heavy lifting is offloaded to the `inbound.webhooks` queue.
 */
export const handleGmailPubsubPush = asyncHandler(async (req, res) => {
  const verification = PubsubVerification.verifyPubsubPush(req);
  if (!verification.verified) {
    logger.warn(
      `Pub/Sub push rejected: ${verification.reason} (bearer=${verification.hasBearer})`,
    );
    return res.status(401).json({
      success: false,
      message: "Pub/Sub verification failed",
    });
  }

  const envelope = decodePubsubEnvelope(req.body);
  if (!envelope) {
    return res.status(400).json({
      success: false,
      message: "Invalid Pub/Sub envelope",
    });
  }

  try {
    const { event, deduplicated } = await ingestGmailPubsubEvent({
      envelope,
      signatureVerified: true,
    });

    if (deduplicated) {
      logger.info(
        `Pub/Sub Gmail event ${envelope.messageId} duplicate; skipped (existing event ${event._id})`,
      );
    } else {
      logger.info(
        `Pub/Sub Gmail event ${envelope.messageId} ingested as ${event._id} (status=${event.status})`,
      );
    }
    return res.status(204).end();
  } catch (err) {
    logger.error(
      `Pub/Sub Gmail ingest error for ${envelope.messageId}: ${
        err?.message || err
      }`,
    );
    // Returning 500 lets Pub/Sub retry, which is the right behaviour for
    // transient DB / Redis failures.
    return res.status(500).json({
      success: false,
      message: "Pub/Sub ingest failed",
    });
  }
});
