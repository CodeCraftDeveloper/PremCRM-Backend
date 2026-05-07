import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { requirePlanFeature } from "../../middlewares/planGate.js";
import { validateMongoId } from "../../middlewares/requestValidators.js";
import {
  connectWhatsappAccount,
  disconnectWhatsappAccount,
  getWhatsappAccount,
  handleWhatsappWebhook,
  listWhatsappAccounts,
  verifyWhatsappWebhook,
} from "../../controllers/integrations/whatsappController.js";

const router = express.Router();

router.get("/webhook", verifyWhatsappWebhook);
router.post("/webhook", handleWhatsappWebhook);

router.use(protect);
router.use(requirePlanFeature("whatsappIntegration"));
router.use(authorize("admin", "superadmin"));

router.get("/accounts", listWhatsappAccounts);
router.post("/accounts", connectWhatsappAccount);
router.get("/accounts/:id", validateMongoId(), getWhatsappAccount);
router.delete("/accounts/:id", validateMongoId(), disconnectWhatsappAccount);

export default router;
