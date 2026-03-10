import multer from "multer";
import path from "path";
import { ApiError } from "../utils/apiResponse.js";

// Allowed file types
const ALLOWED_FILE_TYPES = {
  image: ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
  ],
  all: [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
  ],
};

const ALLOWED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".pdf",
  ".doc",
  ".docx",
  ".xlsx",
  ".xls",
  ".csv",
]);

// Max file size (10MB by default to limit in-memory upload pressure)
const MAX_FILE_SIZE =
  parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 5;
const MAX_FORM_FIELDS = 30;
const MAX_FORM_FIELD_SIZE = 256 * 1024; // 256KB per text field

/**
 * File filter function
 * @param {Array} allowedTypes - Array of allowed MIME types
 */
const createFileFilter = (allowedTypes) => (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (!allowedTypes.includes(file.mimetype)) {
    return cb(
      new ApiError(
        400,
        `Invalid file type. Allowed types: ${allowedTypes.map((t) => t.split("/")[1]).join(", ")}`,
      ),
      false,
    );
  }

  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    cb(
      new ApiError(
        400,
        `Invalid file extension. Allowed extensions: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
      ),
      false,
    );
    return;
  }

  cb(null, true);
};

/**
 * Memory storage for S3 uploads
 */
const memoryStorage = multer.memoryStorage();

/**
 * Upload middleware for visiting cards (images only)
 */
const uploadVisitingCard = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.image),
}).single("visitingCard");

/**
 * Upload middleware for general file uploads
 */
const uploadFile = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.all),
}).single("file");

/**
 * Upload middleware for multiple files
 */
const uploadMultipleFiles = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.all),
}).array("files", MAX_FILES_PER_UPLOAD);

/**
 * Upload middleware for lead attachments (multiple files, up to 5)
 */
const uploadLeadAttachments = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_UPLOAD,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.all),
}).array("attachments", MAX_FILES_PER_UPLOAD);

/**
 * Upload middleware for avatar
 */
const uploadAvatar = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB for avatars
    files: 1,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.image),
}).single("avatar");

/**
 * Upload middleware for company logo
 */
const uploadCompanyLogo = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB for company logos
    files: 1,
    fields: MAX_FORM_FIELDS,
    fieldSize: MAX_FORM_FIELD_SIZE,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.image),
}).single("logo");

/**
 * Handle multer errors
 */
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return next(
        ApiError.badRequest(
          `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        ),
      );
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return next(
        ApiError.badRequest(
          `Too many files. Maximum is ${MAX_FILES_PER_UPLOAD} files.`,
        ),
      );
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return next(ApiError.badRequest(`Unexpected field: ${err.field}`));
    }
    return next(ApiError.badRequest(err.message));
  }
  next(err);
};

export {
  uploadVisitingCard,
  uploadFile,
  uploadMultipleFiles,
  uploadLeadAttachments,
  uploadAvatar,
  uploadCompanyLogo,
  handleUploadError,
  ALLOWED_FILE_TYPES,
  MAX_FILE_SIZE,
};
