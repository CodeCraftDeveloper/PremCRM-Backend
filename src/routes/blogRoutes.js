import express from "express";
import { body, param } from "express-validator";
import {
  getBlogs,
  getPublishedBlogs,
  getPublishedBlogCategories,
  getBlog,
  getPublishedBlogBySlug,
  createBlog,
  updateBlog,
  deleteBlog,
  getBlogCategories,
  getBlogStats,
} from "../controllers/blogController.js";
import { protect, adminOnly } from "../middlewares/auth.js";
import { validate, commonValidations } from "../utils/validators.js";

const router = express.Router();

// ==================== PUBLIC ROUTES (No Auth Required) ====================

/**
 * @route   GET /api/blogs/public/categories/:websiteId
 * @desc    Get published blog categories for a website (public)
 * @access  Public
 */
router.get(
  "/public/categories/:websiteId",
  [commonValidations.mongoId("websiteId"), validate],
  getPublishedBlogCategories,
);

/**
 * @route   GET /api/blogs/public/:websiteId
 * @desc    Get published blogs for a website (public)
 * @access  Public
 */
router.get(
  "/public/:websiteId",
  [commonValidations.mongoId("websiteId"), validate],
  getPublishedBlogs,
);

/**
 * @route   GET /api/blogs/public/:websiteId/:slug
 * @desc    Get single published blog by slug (public)
 * @access  Public
 */
router.get(
  "/public/:websiteId/:slug",
  [commonValidations.mongoId("websiteId"), validate],
  getPublishedBlogBySlug,
);

// ==================== PRIVATE ROUTES ====================
router.use(protect);

/**
 * @route   GET /api/blogs
 * @desc    Get all blogs for a tenant
 * @access  Private
 */
router.get("/", [...commonValidations.pagination(), validate], getBlogs);

/**
 * @route   GET /api/blogs/:id
 * @desc    Get single blog
 * @access  Private
 */
router.get("/:id", [commonValidations.mongoId("id"), validate], getBlog);

/**
 * @route   GET /api/blogs/:id/stats
 * @desc    Get blog statistics
 * @access  Private
 */
router.get(
  "/:id/stats",
  [commonValidations.mongoId("id"), validate],
  getBlogStats,
);

/**
 * @route   POST /api/blogs
 * @desc    Create new blog
 * @access  Private/Admin
 */
router.post(
  "/",
  adminOnly,
  [
    body("websiteId")
      .notEmpty()
      .withMessage("Website ID is required")
      .isMongoId()
      .withMessage("Invalid website ID"),
    body("title")
      .trim()
      .notEmpty()
      .withMessage("Blog title is required")
      .isLength({ min: 3, max: 200 })
      .withMessage("Title must be between 3-200 characters"),
    body("content")
      .trim()
      .notEmpty()
      .withMessage("Blog content is required")
      .isLength({ min: 50 })
      .withMessage("Content must be at least 50 characters"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Description cannot exceed 500 characters"),
    body("category")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Category cannot exceed 50 characters"),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    body("tags.*")
      .optional()
      .trim()
      .isString()
      .withMessage("Each tag must be a string"),
    body("featuredImage")
      .optional()
      .trim()
      .isURL()
      .withMessage("Featured image must be a valid URL"),
    body("featuredImageAlt")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Alt text cannot exceed 200 characters"),
    body("seoTitle")
      .optional()
      .trim()
      .isLength({ max: 60 })
      .withMessage("SEO title cannot exceed 60 characters"),
    body("seoDescription")
      .optional()
      .trim()
      .isLength({ max: 160 })
      .withMessage("SEO description cannot exceed 160 characters"),
    body("seoKeywords")
      .optional()
      .isArray()
      .withMessage("SEO keywords must be an array"),
    body("seoKeywords.*")
      .optional()
      .trim()
      .isString()
      .withMessage("Each keyword must be a string"),
    body("status")
      .optional()
      .isIn(["draft", "published", "archived"])
      .withMessage("Invalid status"),
    body("isPublished")
      .optional()
      .isBoolean()
      .withMessage("isPublished must be a boolean"),
    validate,
  ],
  createBlog,
);

/**
 * @route   PUT /api/blogs/:id
 * @desc    Update blog
 * @access  Private/Admin
 */
router.put(
  "/:id",
  adminOnly,
  [
    commonValidations.mongoId("id"),
    body("title")
      .optional()
      .trim()
      .isLength({ min: 3, max: 200 })
      .withMessage("Title must be between 3-200 characters"),
    body("content")
      .optional()
      .trim()
      .isLength({ min: 50 })
      .withMessage("Content must be at least 50 characters"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Description cannot exceed 500 characters"),
    body("category")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Category cannot exceed 50 characters"),
    body("tags").optional().isArray().withMessage("Tags must be an array"),
    body("featuredImage")
      .optional()
      .trim()
      .isURL()
      .withMessage("Featured image must be a valid URL"),
    body("featuredImageAlt")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Alt text cannot exceed 200 characters"),
    body("seoTitle")
      .optional()
      .trim()
      .isLength({ max: 60 })
      .withMessage("SEO title cannot exceed 60 characters"),
    body("seoDescription")
      .optional()
      .trim()
      .isLength({ max: 160 })
      .withMessage("SEO description cannot exceed 160 characters"),
    body("seoKeywords")
      .optional()
      .isArray()
      .withMessage("SEO keywords must be an array"),
    body("status")
      .optional()
      .isIn(["draft", "published", "archived"])
      .withMessage("Invalid status"),
    body("isPublished")
      .optional()
      .isBoolean()
      .withMessage("isPublished must be a boolean"),
    validate,
  ],
  updateBlog,
);

/**
 * @route   DELETE /api/blogs/:id
 * @desc    Delete blog
 * @access  Private/Admin
 */
router.delete(
  "/:id",
  adminOnly,
  [commonValidations.mongoId("id"), validate],
  deleteBlog,
);

/**
 * @route   GET /api/blogs/categories/:websiteId
 * @desc    Get all categories for a website
 * @access  Private
 */
router.get(
  "/categories/:websiteId",
  [commonValidations.mongoId("websiteId"), validate],
  getBlogCategories,
);

export default router;
