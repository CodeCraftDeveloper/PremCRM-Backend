import express from "express";
import { authorize, protect } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import { GmbReviewReplyService } from "../../services/gmbReviewReplyService.js";
import {
  asyncHandler,
  paginatedResponse,
  successResponse,
} from "../../utils/apiResponse.js";

const router = express.Router();

router.use(protect);
router.use(requirePlanFeature("gmbIntegration"));
router.use(requirePlanFeature("reviewManagement"));

router.get("/locations", authorize("admin", "superadmin", "marketing"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.listLocations({ tenantId: req.user.tenantId, ...req.query });
  paginatedResponse(res, result.docs, result, "GMB locations retrieved");
}));
router.post("/locations", authorize("admin", "superadmin"), asyncHandler(async (req, res) => {
  const location = await GmbReviewReplyService.upsertLocation({ tenantId: req.user.tenantId, payload: req.body || {}, userId: req.user._id });
  successResponse(res, { location }, "GMB location saved", 201);
}));
router.post("/locations/:locationId/reviews/sync", authorize("admin", "superadmin"), validateMongoId("locationId"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.syncReviews({ tenantId: req.user.tenantId, locationId: req.params.locationId, reviews: req.body?.reviews || [], syncCursor: req.body?.syncCursor || null, userId: req.user._id });
  successResponse(res, result, "GMB reviews synced");
}));
router.get("/reviews", authorize("admin", "superadmin", "marketing"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.listReviews({ tenantId: req.user.tenantId, ...req.query });
  paginatedResponse(res, result.docs, result, "GMB reviews retrieved");
}));
router.post("/reviews/:reviewId/ai-draft", authorize("admin", "superadmin", "marketing"), validateMongoId("reviewId"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.generateReplyDraft({ tenantId: req.user.tenantId, reviewId: req.params.reviewId, triggeredBy: req.user._id, idempotencyKey: req.body?.idempotencyKey || null });
  successResponse(res, result, "GMB review reply draft generated", 201);
}));
router.get("/approvals", authorize("admin", "superadmin", "marketing"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.listApprovals({ tenantId: req.user.tenantId, ...req.query });
  paginatedResponse(res, result.docs, result, "GMB approvals retrieved");
}));
router.post("/approvals/:approvalId/approve", authorize("admin", "superadmin"), validateMongoId("approvalId"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.approveReply({ tenantId: req.user.tenantId, approvalRequestId: req.params.approvalId, decidedBy: req.user._id, decisionReason: req.body?.decisionReason || null });
  successResponse(res, result, "GMB reply approved");
}));
router.post("/approvals/:approvalId/reject", authorize("admin", "superadmin"), validateMongoId("approvalId"), asyncHandler(async (req, res) => {
  const result = await GmbReviewReplyService.rejectReply({ tenantId: req.user.tenantId, approvalRequestId: req.params.approvalId, decidedBy: req.user._id, decisionReason: req.body?.decisionReason || "" });
  successResponse(res, result, "GMB reply rejected");
}));

export default router;
