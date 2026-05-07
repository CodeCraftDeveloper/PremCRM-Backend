import {
  asyncHandler,
  successResponse,
} from "../../utils/apiResponse.js";
import { GmailWatchService } from "../../services/gmailWatchService.js";

export const startGmailWatch = asyncHandler(async (req, res) => {
  const result = await GmailWatchService.startWatch(
    req.user.tenantId,
    req.params.id,
    {
      topicName: req.body?.topicName,
      labelIds: Array.isArray(req.body?.labelIds) ? req.body.labelIds : undefined,
      labelFilterAction: req.body?.labelFilterAction,
    },
  );
  successResponse(res, result, "Gmail watch started");
});

export const stopGmailWatch = asyncHandler(async (req, res) => {
  const result = await GmailWatchService.stopWatch(
    req.user.tenantId,
    req.params.id,
  );
  successResponse(res, result, "Gmail watch stopped");
});
