import express from "express";
import { param } from "express-validator";
import { downloadFile } from "../controllers/fileController.js";
import { protect } from "../middlewares/auth.js";
import { validate } from "../utils/validators.js";

const router = express.Router();

// All file routes require authentication
router.use(protect);

/**
 * @route   GET /api/v1/files/:fileType/:entityId/:filename
 * @desc    Download a protected file (tenant-scoped)
 * @access  Private (authenticated)
 */
router.get(
  "/:fileType/:entityId/:filename",
  [
    param("fileType")
      .isIn(["lead-attachments", "visiting-cards"])
      .withMessage("Invalid file type"),
    param("entityId").isMongoId().withMessage("Invalid entity ID"),
    param("filename")
      .notEmpty()
      .withMessage("Filename is required")
      .matches(/^[a-zA-Z0-9._-]+$/)
      .withMessage("Invalid filename format"),
    validate,
  ],
  downloadFile,
);

export default router;
