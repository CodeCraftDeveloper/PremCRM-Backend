import Blog from "../models/Blog.js";
import Website from "../models/Website.js";
import User from "../models/User.js";
import {
  ApiError,
  asyncHandler,
  successResponse,
  paginatedResponse,
} from "../utils/apiResponse.js";
import { getCache, setCache, deleteCachePattern } from "../config/redis.js";
import logger from "../utils/logger.js";

const CACHE_TTL = 3600; // 1 hour

const stripContent = (content = "") =>
  String(content || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

// Generate slug from title
const generateSlug = (title) => {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

// Calculate reading time (assuming 200 words per minute)
const calculateReadingTime = (content) => {
  if (!content) return 1;
  const wordCount = stripContent(content).split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(wordCount / 200);
  return Math.max(1, minutes);
};

/**
 * @desc    Get all blogs for a website
 * @route   GET /api/blogs
 * @access  Private
 */
const getBlogs = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const {
    page = 1,
    limit = 10,
    sortBy = "createdAt",
    sortOrder = "desc",
    status,
    category,
    search,
    websiteId,
  } = req.query;
  const pageNumber = parseInt(page, 10) || 1;
  const limitNumber = parseInt(limit, 10) || 10;

  // Verify website access
  if (websiteId) {
    const website = await Website.findOne({
      _id: websiteId,
      tenantId,
    });
    if (!website) {
      throw new ApiError(404, "Website not found");
    }
  }

  const useCache = process.env.NODE_ENV === "production";
  const blogsCacheKey = [
    "blogs",
    tenantId,
    websiteId || "all",
    pageNumber,
    limitNumber,
    sortBy,
    sortOrder,
    status || "all",
    category || "all",
  ].join(":");

  // Try cache first
  if (useCache && !search && pageNumber === 1) {
    const cached = await getCache(blogsCacheKey);
    if (cached) {
      return paginatedResponse(
        res,
        cached.data || [],
        cached.pagination || {
          page: pageNumber,
          limit: limitNumber,
          totalPages: 1,
          totalDocs: Array.isArray(cached.data) ? cached.data.length : 0,
        },
        "Blogs retrieved from cache",
      );
    }
  }

  // Build query
  const query = { tenantId };

  if (websiteId) {
    query.websiteId = websiteId;
  }

  if (status) {
    query.status = status;
  }

  if (category) {
    query.category = category;
  }

  if (search) {
    query.$text = { $search: search };
  }

  // Pagination
  const skip = (pageNumber - 1) * limitNumber;
  const sortOptions = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

  // Execute query
  const [blogs, totalDocs] = await Promise.all([
    Blog.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNumber)
      .populate("author", "name email")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("websiteId", "name domain"),
    Blog.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / limitNumber) || 1;
  const payload = {
    data: blogs,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalPages,
      totalDocs,
    },
  };

  // Cache the response
  if (useCache && !search && pageNumber === 1) {
    await setCache(blogsCacheKey, payload, CACHE_TTL);
  }

  return paginatedResponse(
    res,
    payload.data,
    payload.pagination,
    "Blogs retrieved successfully",
  );
});

/**
 * @desc    Get published blogs (public endpoint)
 * @route   GET /api/blogs/public/:websiteId
 * @access  Public
 */
const getPublishedBlogs = asyncHandler(async (req, res, next) => {
  const { websiteId } = req.params;
  const {
    page = 1,
    limit = 10,
    sortBy = "publishedAt",
    sortOrder = "desc",
    category,
    search,
  } = req.query;
  const pageNumber = parseInt(page, 10) || 1;
  const limitNumber = parseInt(limit, 10) || 10;

  // Verify website exists
  const website = await Website.findById(websiteId);
  if (!website) {
    throw new ApiError(404, "Website not found");
  }

  const useCache = process.env.NODE_ENV === "production";
  const cacheKey = [
    "public-blogs",
    websiteId,
    pageNumber,
    limitNumber,
    sortBy,
    sortOrder,
    category || "all",
  ].join(":");

  // Try cache
  if (useCache && !search && pageNumber === 1) {
    const cached = await getCache(cacheKey);
    if (cached) {
      return paginatedResponse(
        res,
        cached.data || [],
        cached.pagination || {
          page: pageNumber,
          limit: limitNumber,
          totalPages: 1,
          totalDocs: Array.isArray(cached.data) ? cached.data.length : 0,
        },
        "Blogs retrieved from cache",
      );
    }
  }

  // Build query for published blogs
  const query = {
    websiteId: websiteId,
    status: "published",
    isPublished: true,
  };

  if (category) {
    query.category = category;
  }

  if (search) {
    query.$text = { $search: search };
  }

  // Pagination
  const skip = (pageNumber - 1) * limitNumber;
  const sortOptions = { [sortBy]: sortOrder === "desc" ? -1 : 1 };

  // Execute query
  const [blogs, totalDocs] = await Promise.all([
    Blog.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNumber)
      .populate("author", "name email"),
    Blog.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / limitNumber) || 1;
  const payload = {
    data: blogs,
    pagination: {
      page: pageNumber,
      limit: limitNumber,
      totalPages,
      totalDocs,
    },
  };

  // Cache response
  if (useCache && !search && pageNumber === 1) {
    await setCache(cacheKey, payload, CACHE_TTL);
  }

  return paginatedResponse(
    res,
    payload.data,
    payload.pagination,
    "Published blogs retrieved successfully",
  );
});

/**
 * @desc    Get published blog categories for a website (public endpoint)
 * @route   GET /api/blogs/public/categories/:websiteId
 * @access  Public
 */
const getPublishedBlogCategories = asyncHandler(async (req, res, next) => {
  const { websiteId } = req.params;

  const website = await Website.findById(websiteId);
  if (!website) {
    throw new ApiError(404, "Website not found");
  }

  const categories = await Blog.distinct("category", {
    websiteId,
    status: "published",
    isPublished: true,
  });

  return successResponse(
    res,
    categories.filter(Boolean),
    "Published blog categories retrieved successfully",
  );
});

/**
 * @desc    Get single blog
 * @route   GET /api/blogs/:id
 * @access  Private
 */
const getBlog = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.user.tenantId;

  const blog = await Blog.findOne({
    _id: id,
    tenantId,
  })
    .populate("author", "name email")
    .populate("websiteId", "name domain")
    .populate("createdBy", "name email")
    .populate("updatedBy", "name email");

  if (!blog) {
    throw new ApiError(404, "Blog not found");
  }

  return successResponse(res, blog, "Blog retrieved successfully");
});

/**
 * @desc    Get single published blog by slug (public endpoint)
 * @route   GET /api/blogs/public/:websiteId/:slug
 * @access  Public
 */
const getPublishedBlogBySlug = asyncHandler(async (req, res, next) => {
  const { websiteId, slug } = req.params;

  // Verify website exists
  const website = await Website.findById(websiteId);
  if (!website) {
    throw new ApiError(404, "Website not found");
  }

  const blog = await Blog.findOne({
    websiteId,
    slug,
    status: "published",
    isPublished: true,
  }).populate("author", "name email");

  if (!blog) {
    throw new ApiError(404, "Blog not found");
  }

  // Increment views
  blog.views = (blog.views || 0) + 1;
  await blog.save();

  // Clear cache
  await deleteCachePattern(`public-blogs:${websiteId}:*`);

  return successResponse(res, blog, "Blog retrieved successfully");
});

/**
 * @desc    Create blog
 * @route   POST /api/blogs
 * @access  Private
 */
const createBlog = asyncHandler(async (req, res, next) => {
  const tenantId = req.user.tenantId;
  const userId = req.user._id;
  const {
    websiteId,
    title,
    description,
    content,
    category,
    tags = [],
    featuredImage,
    featuredImageAlt,
    seoTitle,
    seoDescription,
    seoKeywords = [],
    status = "draft",
    isPublished = false,
  } = req.body;

  // Verify website access
  const website = await Website.findOne({
    _id: websiteId,
    tenantId,
  });

  if (!website) {
    throw new ApiError(404, "Website not found");
  }

  // Generate slug
  let slug = generateSlug(title);

  // Check for slug uniqueness
  let existingBlog = await Blog.findOne({ slug });
  if (existingBlog) {
    slug = `${slug}-${Date.now()}`;
  }

  // Calculate reading time
  const readingTime = calculateReadingTime(content);

  const blog = new Blog({
    websiteId,
    tenantId,
    title,
    slug,
    description,
    content,
    category,
    tags: tags.filter((tag) => tag.trim()),
    featuredImage,
    featuredImageAlt,
    author: userId,
    status,
    isPublished: isPublished && status === "published" ? true : false,
    publishedAt: isPublished && status === "published" ? new Date() : null,
    seoTitle,
    seoDescription,
    seoKeywords: seoKeywords.filter((kw) => kw.trim()),
    readingTime,
    createdBy: userId,
  });

  await blog.save();
  await blog.populate("author", "name email");
  await blog.populate("createdBy", "name email");

  // Clear cache
  await deleteCachePattern(`blogs:${tenantId}:*`);
  await deleteCachePattern(`public-blogs:${websiteId}:*`);

  logger.info(`Blog created: ${blog._id} by user ${userId}`);

  return successResponse(res, blog, "Blog created successfully", 201);
});

/**
 * @desc    Update blog
 * @route   PUT /api/blogs/:id
 * @access  Private
 */
const updateBlog = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.user.tenantId;
  const userId = req.user._id;

  const blog = await Blog.findOne({
    _id: id,
    tenantId,
  });

  if (!blog) {
    throw new ApiError(404, "Blog not found");
  }

  const {
    title,
    description,
    content,
    category,
    tags,
    featuredImage,
    featuredImageAlt,
    seoTitle,
    seoDescription,
    seoKeywords,
    status,
    isPublished,
  } = req.body;

  // Update fields
  if (title) {
    blog.title = title;
    blog.slug = generateSlug(title);
  }

  if (description !== undefined) blog.description = description;
  if (content) {
    blog.content = content;
    blog.readingTime = calculateReadingTime(content);
  }
  if (category !== undefined) blog.category = category;
  if (tags) blog.tags = tags.filter((tag) => tag.trim());
  if (featuredImage !== undefined) blog.featuredImage = featuredImage;
  if (featuredImageAlt !== undefined) blog.featuredImageAlt = featuredImageAlt;
  if (seoTitle !== undefined) blog.seoTitle = seoTitle;
  if (seoDescription !== undefined) blog.seoDescription = seoDescription;
  if (seoKeywords) blog.seoKeywords = seoKeywords.filter((kw) => kw.trim());

  if (status) blog.status = status;

  // Handle publishing
  if (isPublished !== undefined) {
    blog.isPublished = isPublished && status === "published" ? true : false;
    if (blog.isPublished && !blog.publishedAt) {
      blog.publishedAt = new Date();
    }
  }

  blog.updatedBy = userId;

  await blog.save();
  await blog.populate("author", "name email");
  await blog.populate("createdBy", "name email");
  await blog.populate("updatedBy", "name email");

  // Clear cache
  await deleteCachePattern(`blogs:${tenantId}:*`);
  await deleteCachePattern(`public-blogs:${blog.websiteId}:*`);

  logger.info(`Blog updated: ${blog._id} by user ${userId}`);

  return successResponse(res, blog, "Blog updated successfully");
});

/**
 * @desc    Delete blog
 * @route   DELETE /api/blogs/:id
 * @access  Private
 */
const deleteBlog = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.user.tenantId;

  const blog = await Blog.findOne({
    _id: id,
    tenantId,
  });

  if (!blog) {
    throw new ApiError(404, "Blog not found");
  }

  const websiteId = blog.websiteId;
  await Blog.deleteOne({ _id: id });

  // Clear cache
  await deleteCachePattern(`blogs:${tenantId}:*`);
  await deleteCachePattern(`public-blogs:${websiteId}:*`);

  logger.info(`Blog deleted: ${id}`);

  return successResponse(res, null, "Blog deleted successfully");
});

/**
 * @desc    Get blog categories
 * @route   GET /api/blogs/categories/:websiteId
 * @access  Private
 */
const getBlogCategories = asyncHandler(async (req, res, next) => {
  const { websiteId } = req.params;
  const tenantId = req.user.tenantId;

  // Verify website access
  const website = await Website.findOne({
    _id: websiteId,
    tenantId,
  });

  if (!website) {
    throw new ApiError(404, "Website not found");
  }

  const categories = await Blog.distinct("category", {
    websiteId,
    tenantId,
    status: { $ne: "archived" },
  });

  return successResponse(
    res,
    categories.filter(Boolean),
    "Categories retrieved successfully",
  );
});

/**
 * @desc    Get blog statistics
 * @route   GET /api/blogs/:id/stats
 * @access  Private
 */
const getBlogStats = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const tenantId = req.user.tenantId;

  const blog = await Blog.findOne({
    _id: id,
    tenantId,
  });

  if (!blog) {
    throw new ApiError(404, "Blog not found");
  }

  const stats = {
    views: blog.views,
    wordCount: blog.wordCount,
    readingTime: blog.readingTime,
    status: blog.status,
    isPublished: blog.isPublished,
    publishedAt: blog.publishedAt,
    createdAt: blog.createdAt,
    updatedAt: blog.updatedAt,
  };

  return successResponse(res, stats, "Blog statistics retrieved successfully");
});

export {
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
};
