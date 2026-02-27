import path from "path";
import fs from "fs";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import Lead from "../models/Lead.js";
import Client from "../models/Client.js";
import logger from "../utils/logger.js";

/**
 * Allowed file types and their base directories (relative to project root).
 * Only these paths are servable — anything else is rejected.
 */
const FILE_TYPE_CONFIG = {
  "lead-attachments": {
    model: Lead,
    baseDir: path.join(process.cwd(), "private", "uploads", "lead-attachments"),
    /** Given the entity, check the requesting user's tenant matches */
    verifyOwnership: (entity, tenantId) =>
      String(entity.tenantId) === String(tenantId),
  },
  "visiting-cards": {
    model: Client,
    baseDir: path.join(process.cwd(), "private", "uploads", "visiting-cards"),
    verifyOwnership: (entity, tenantId) =>
      String(entity.tenantId) === String(tenantId),
  },
};

/**
 * @desc    Serve a protected file with tenant ownership verification
 * @route   GET /api/v1/files/:fileType/:entityId/:filename
 * @access  Private (authenticated, tenant-scoped)
 */
export const downloadFile = asyncHandler(async (req, res, next) => {
  const { fileType, entityId, filename } = req.params;

  // 1. Validate fileType
  const config = FILE_TYPE_CONFIG[fileType];
  if (!config) {
    return next(ApiError.badRequest("Invalid file type"));
  }

  // 2. Look up the owning entity with tenant constraint
  const entity = await config.model.findOne({
    _id: entityId,
    tenantId: req.user.tenantId,
  });

  if (!entity) {
    return next(ApiError.notFound("Resource not found"));
  }

  // 3. Verify tenant ownership (defence-in-depth)
  if (!config.verifyOwnership(entity, req.user.tenantId)) {
    logger.warn(
      `File access denied: User ${req.user._id} attempted cross-tenant file access for ${fileType}/${entityId}/${filename}`,
    );
    return next(ApiError.notFound("Resource not found"));
  }

  // 4. Construct the safe file path and validate against directory traversal
  const sanitizedFilename = path.basename(filename); // strips any ../
  const filePath = path.join(config.baseDir, entityId, sanitizedFilename);

  // Ensure resolved path is still within allowed base directory
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(config.baseDir);
  if (!resolvedPath.startsWith(resolvedBase)) {
    logger.warn(`Directory traversal attempt: ${req.user._id} → ${filename}`);
    return next(ApiError.forbidden("Access denied"));
  }

  // 5. Check file exists
  if (!fs.existsSync(resolvedPath)) {
    return next(ApiError.notFound("File not found"));
  }

  // 6. Set security headers and send
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${sanitizedFilename}"`,
  );
  res.setHeader("Cache-Control", "private, max-age=3600");

  return res.sendFile(resolvedPath);
});
