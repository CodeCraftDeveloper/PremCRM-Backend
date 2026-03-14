import express from "express";
import { body } from "express-validator";
import {
  submitPublicLead,
  publicApiHealth,
  getPublicApiDocs,
  getPublicProducts,
  getPublicFormSchema,
} from "../controllers/publicLeadController.js";
import {
  validateApiKey,
  leadRateLimit,
  validateIpWhitelist,
  logPublicApiRequest,
} from "../middlewares/apiKeyMiddleware.js";
import {
  uploadLeadAttachments,
  handleUploadError,
} from "../middlewares/upload.js";
import { validate } from "../utils/validators.js";
import { publicLeadLimiter } from "../middlewares/rateLimiter.js";

const router = express.Router();

// Apply per-IP rate limit to all public-lead routes
router.use(publicLeadLimiter);

/**
 * Public routes (no authentication required, API key based)
 */

/**
 * @route   POST /api/public/lead
 * @desc    Submit a lead from external website
 * @access  Public (API key required)
 */
router.post(
  "/lead",
  validateApiKey,
  leadRateLimit,
  validateIpWhitelist,
  logPublicApiRequest,
  uploadLeadAttachments,
  handleUploadError,
  [
    body("firstName")
      .trim()
      .notEmpty()
      .withMessage("First name is required")
      .isLength({ min: 1, max: 50 })
      .withMessage("First name must be 1-50 characters"),
    body("lastName")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Last name must not exceed 50 characters"),
    body("email")
      .trim()
      .notEmpty()
      .withMessage("Email is required")
      .isEmail()
      .withMessage("Please provide a valid email")
      .normalizeEmail(),
    body("phone")
      .optional()
      .trim()
      .matches(
        /^[+]?[(]?[0-9]{1,}[)]?[-\s.]?[(]?[0-9]{1,}[)]?[-\s.]?[0-9]{1,}[-\s.0-9]{0,}$/,
      )
      .withMessage("Please provide a valid phone number"),
    body("message")
      .optional()
      .trim()
      .isLength({ max: 5000 })
      .withMessage("Message must not exceed 5000 characters"),
    body("country")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Country must not exceed 100 characters"),
    body("city")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("City must not exceed 100 characters"),
    body("state")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("State must not exceed 100 characters"),
    body("zipCode")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Zip code must not exceed 20 characters"),
    body("company")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Company must not exceed 100 characters"),
    body("productInterest")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Product interest must not exceed 100 characters"),
    body("ticketTypeId")
      .optional()
      .isMongoId()
      .withMessage("ticketTypeId must be a valid ID"),
    body("quantity")
      .optional()
      .isInt({ min: 1, max: 20 })
      .withMessage("Quantity must be between 1 and 20"),
    body("customFields")
      .optional()
      .custom((value) => {
        if (value == null || value === "") return true;
        if (typeof value === "object" && !Array.isArray(value)) return true;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            return (
              !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
            );
          } catch {
            return false;
          }
        }
        return false;
      })
      .withMessage(
        "Custom fields must be an object or valid JSON object string",
      ),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    validate,
  ],
  submitPublicLead,
);

/**
 * @route   GET /api/public/health
 * @desc    Check API health
 * @access  Public (API key required)
 */
router.get("/health", validateApiKey, logPublicApiRequest, publicApiHealth);

/**
 * @route   GET /api/public/products
 * @desc    Get product/service list for this website (for form dropdowns)
 * @access  Public (API key required)
 */
router.get("/products", validateApiKey, logPublicApiRequest, getPublicProducts);

/**
 * @route   GET /api/public/form-schema
 * @desc    Get full form schema (products + custom fields) for this website
 * @access  Public (API key required)
 */
router.get(
  "/form-schema",
  validateApiKey,
  logPublicApiRequest,
  getPublicFormSchema,
);

/**
 * @route   GET /api/public/docs
 * @desc    Get API documentation
 * @access  Public
 */
router.get("/docs", getPublicApiDocs);

export default router;
