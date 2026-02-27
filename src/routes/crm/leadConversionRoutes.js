import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import { convertLead } from "../../controllers/crm/leadConversionController.js";

const router = express.Router();

router.use(protect);

// Lead conversion — admin or marketing
router.post("/:id/convert", authorize("admin", "marketing"), convertLead);

export default router;
