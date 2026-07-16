import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  handleGoogleOAuthCallback,
  refreshGoogleToken,
  startGoogleOAuth,
} from "../../controllers/integrations/googleOAuthController.js";
import {
  startGmailWatch,
  stopGmailWatch,
} from "../../controllers/integrations/gmailWatchController.js";

const router = express.Router();

router.use(protect);

router.get(
  "/oauth/start",
  authorize("admin", "superadmin"),
  startGoogleOAuth,
);
router.get(
  "/oauth/callback",
  authorize("admin", "superadmin"),
  handleGoogleOAuthCallback,
);
router.post(
  "/accounts/:id/refresh-token",
  authorize("admin", "superadmin"),
  validateMongoId(),
  refreshGoogleToken,
);
router.post(
  "/accounts/:id/watch/start",
  authorize("admin", "superadmin"),
  validateMongoId(),
  requirePlanFeature("gmailIntegration"),
  startGmailWatch,
);
router.post(
  "/accounts/:id/watch/stop",
  authorize("admin", "superadmin"),
  validateMongoId(),
  requirePlanFeature("gmailIntegration"),
  stopGmailWatch,
);

export default router;
