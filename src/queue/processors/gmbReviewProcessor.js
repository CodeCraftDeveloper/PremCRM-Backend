import {
  GmbReviewPermanentError,
  GmbReviewReplyService,
} from "../../services/gmbReviewReplyService.js";
import { NonRetryableError } from "../errors.js";

export async function processGmbReviews(job) {
  const { tenantId, replyDraftId, approvalRequestId } = job.data || {};
  if (!tenantId || !replyDraftId) {
    throw new NonRetryableError(
      `gmb.reviews job ${job.id}: payload.tenantId and payload.replyDraftId are required.`,
    );
  }
  if (job.name !== GmbReviewReplyService.REVIEW_PUBLISH_JOB) {
    throw new NonRetryableError(
      `gmb.reviews processor: unknown job name "${job.name}"`,
    );
  }
  try {
    return await GmbReviewReplyService.publishApprovedReply({
      tenantId,
      replyDraftId,
      approvalRequestId: approvalRequestId || null,
    });
  } catch (err) {
    if (err instanceof GmbReviewPermanentError) {
      throw new NonRetryableError(err.message);
    }
    throw err;
  }
}
