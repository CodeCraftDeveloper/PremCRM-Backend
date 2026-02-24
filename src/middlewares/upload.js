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
  ],
  all: [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
  ],
};

// Max file size (5MB)
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024;

/**
 * File filter function
 * @param {Array} allowedTypes - Array of allowed MIME types
 */
const createFileFilter = (allowedTypes) => (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        400,
        `Invalid file type. Allowed types: ${allowedTypes.map((t) => t.split("/")[1]).join(", ")}`,
      ),
      false,
    );
  }
};

/**
 * Memory storage for S3 uploads
 */
const memoryStorage = multer.memoryStorage();

/**
 * Local disk storage (for development/fallback)
 */
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});

/**
 * Upload middleware for visiting cards (images only)
 */
const uploadVisitingCard = multer({
  storage: memoryStorage,
  limits: {
    fileSize: MAX_FILE_SIZE,
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
    files: 5,
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.all),
}).array("files", 5);

/**
 * Upload middleware for avatar
 */
const uploadAvatar = multer({
  storage: memoryStorage,
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB for avatars
  },
  fileFilter: createFileFilter(ALLOWED_FILE_TYPES.image),
}).single("avatar");

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
      return next(ApiError.badRequest("Too many files. Maximum is 5 files."));
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
  uploadAvatar,
  handleUploadError,
  ALLOWED_FILE_TYPES,
  MAX_FILE_SIZE,
};
