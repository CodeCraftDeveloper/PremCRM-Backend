/**
 * BullMQ processor for the `ai.draft` queue (P7-002).
 *
 * Job names:
 *   - `social.content.generate` — produce a social ContentDraft from
 *     BrandProfile + optional campaign / trend / product / location
 *     context, persist as `pending_approval`, create paired
 *     `ApprovalRequest` of type `ai.action`.
 *
 * Permanent service errors → `NonRetryableError` so BullMQ stops
 * retrying and the DLQ recorder picks them up.
 *
 * Transient errors bubble for retry under the existing 3-attempt
 * `ai.draft` policy from `retryPolicies.js` (every retry costs tokens).
 *
 * Tenant isolation contract: payload.tenantId is enforced at the
 * `enqueue()` boundary; the processor re-validates by passing it
 * straight into the service, which scopes every query.
 */

import {
  AISocialContentService,
  AISocialPermanentError,
} from "../../services/ai/aiSocialContentService.js";
import { NonRetryableError } from "../errors.js";
import logger from "../../utils/logger.js";

const SOCIAL_GENERATE_JOB = "social.content.generate";

export async function processAiDraft(job) {
  const { tenantId, jobName } = job.data || {};
  const name = job.name || jobName;

  if (!tenantId) {
    throw new NonRetryableError(
      `ai.draft job ${job.id}: payload.tenantId is required.`,
    );
  }

  logger.info(
    `[AiDraft] Job ${job.id} name=${name} tenant=${tenantId} attempt=${job.attemptsMade + 1}`,
  );

  if (name === SOCIAL_GENERATE_JOB) {
    try {
      const result = await AISocialContentService.generateSocialContent({
        tenantId,
        channel: job.data.channel,
        postFormat: job.data.postFormat || null,
        campaignGoal: job.data.campaignGoal || null,
        audienceHint: job.data.audienceHint || null,
        productName: job.data.productName || null,
        locationName: job.data.locationName || null,
        trendInputs: Array.isArray(job.data.trendInputs)
          ? job.data.trendInputs
          : [],
        agent: job.data.agent || undefined,
        triggeredBy: job.data.triggeredBy || null,
        workflowRunId: job.data.workflowRunId || null,
        workflowNodeId: job.data.workflowNodeId || null,
        idempotencyKey: job.data.idempotencyKey || job.id || null,
        providerName: job.data.providerName || null,
        modelOverride: job.data.modelOverride || null,
        approvalRequest: job.data.approvalRequest !== false,
        relatedEntityType: job.data.relatedEntityType || null,
        relatedEntityId: job.data.relatedEntityId || null,
        correlationId: job.data.correlationId || null,
      });
      return {
        aiRunId: result.aiRun?._id?.toString() || null,
        draftId: result.draft?._id?.toString() || null,
        approvalRequestId:
          result.approvalRequest?._id?.toString() || null,
        tokens: result.usage?.totalTokens ?? 0,
      };
    } catch (err) {
      if (err instanceof AISocialPermanentError) {
        throw new NonRetryableError(err.message);
      }
      throw err;
    }
  }

  throw new NonRetryableError(
    `ai.draft processor: unknown job name "${name}"`,
  );
}
