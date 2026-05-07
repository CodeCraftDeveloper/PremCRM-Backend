import {
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import {
  getQueueCounts,
  getRecentFailedJobs,
} from "../queue/queueStatusService.js";
import { isKnownQueueName } from "../queue/queueNames.js";

/**
 * GET /api/v1/queues/status
 *
 * Auth: protect + superadmin (mounted at the route layer).
 * Returns per-queue job-state counts plus the resolved retry policy.
 */
const getQueuesStatus = asyncHandler(async (req, res) => {
  const result = await getQueueCounts();
  return successResponse(res, result);
});

/**
 * GET /api/v1/queues/failed-jobs
 *
 * Auth: protect + adminOnly. Tenant admins see only their own tenant's
 * failed jobs; superadmins can pass `?tenantId=` to scope to any tenant
 * or omit it to read across the whole system.
 *
 * Optional filters: `?queueName=`, `?status=failed|replayed|discarded`,
 * `?limit=` (max 200).
 */
const getFailedJobs = asyncHandler(async (req, res) => {
  const isSuperAdmin = req.user?.role === "superadmin";

  let tenantId;
  if (isSuperAdmin) {
    tenantId = req.query.tenantId ? String(req.query.tenantId) : null;
  } else {
    // Non-superadmin admins are forced to their own tenant scope, regardless
    // of any query param they pass. This is the tenant-isolation contract.
    tenantId = String(req.user.tenantId);
  }

  const queueName = req.query.queueName ? String(req.query.queueName) : null;
  if (queueName && !isKnownQueueName(queueName)) {
    return res.status(400).json({
      success: false,
      message: `Unknown queueName "${queueName}"`,
    });
  }

  const status = req.query.status ? String(req.query.status) : null;
  if (status && !["failed", "replayed", "discarded"].includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status filter "${status}"`,
    });
  }

  const limit = req.query.limit ? Number(req.query.limit) : 50;

  const items = await getRecentFailedJobs({
    tenantId,
    queueName,
    status,
    limit,
  });

  return successResponse(res, {
    count: items.length,
    items,
    scope: isSuperAdmin
      ? tenantId
        ? { type: "tenant", tenantId }
        : { type: "system" }
      : { type: "tenant", tenantId },
  });
});

export { getQueuesStatus, getFailedJobs };
