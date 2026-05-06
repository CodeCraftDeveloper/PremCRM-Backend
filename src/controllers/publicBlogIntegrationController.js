import Blog from "../models/Blog.js";
import { asyncHandler, successResponse } from "../utils/apiResponse.js";

const DEFAULT_BLOG_CONFIG = {
  listing: {
    visibleFields: {
      title: true,
      description: true,
      category: true,
      author: true,
      publishedAt: true,
      readingTime: true,
      featuredImage: true,
      tags: true,
    },
    elements: {
      containerTag: "article",
      titleTag: "h3",
      descriptionTag: "p",
      categoryTag: "span",
      metaTag: "div",
      imageTag: "img",
    },
    styles: {
      backgroundColor: "#ffffff",
      textColor: "#111827",
      accentColor: "#4f46e5",
      backgroundImage: "",
      textAlign: "left",
    },
  },
  detail: {
    visibleFields: {
      title: true,
      content: true,
      category: true,
      author: true,
      publishedAt: true,
      featuredImage: true,
      tags: true,
    },
    elements: {
      containerTag: "article",
      titleTag: "h1",
      contentTag: "div",
      categoryTag: "span",
      metaTag: "div",
      imageTag: "img",
    },
    styles: {
      backgroundColor: "#ffffff",
      textColor: "#111827",
      accentColor: "#4f46e5",
      backgroundImage: "",
      textAlign: "left",
    },
  },
};

const normalizePaging = (page, limit) => {
  const pageNumber = Number.parseInt(page, 10) || 1;
  const limitNumber = Number.parseInt(limit, 10) || 10;

  return {
    page: pageNumber,
    limit: limitNumber,
    skip: (pageNumber - 1) * limitNumber,
  };
};

const mergeBlogConfig = (incoming = {}) => ({
  listing: {
    visibleFields: {
      ...DEFAULT_BLOG_CONFIG.listing.visibleFields,
      ...(incoming.listing?.visibleFields || {}),
    },
    elements: {
      ...DEFAULT_BLOG_CONFIG.listing.elements,
      ...(incoming.listing?.elements || {}),
    },
    styles: {
      ...DEFAULT_BLOG_CONFIG.listing.styles,
      ...(incoming.listing?.styles || {}),
    },
  },
  detail: {
    visibleFields: {
      ...DEFAULT_BLOG_CONFIG.detail.visibleFields,
      ...(incoming.detail?.visibleFields || {}),
    },
    elements: {
      ...DEFAULT_BLOG_CONFIG.detail.elements,
      ...(incoming.detail?.elements || {}),
    },
    styles: {
      ...DEFAULT_BLOG_CONFIG.detail.styles,
      ...(incoming.detail?.styles || {}),
    },
  },
});

const buildPublishedBlogQuery = (websiteId, { category, search } = {}) => {
  const query = {
    websiteId,
    status: "published",
    isPublished: true,
  };

  if (category) {
    query.category = category;
  }

  if (search) {
    query.$text = { $search: search };
  }

  return query;
};

const shapeAuthor = (author) => {
  if (!author) return undefined;

  return {
    name: author.name,
    email: author.email,
  };
};

const shapeBlogForListing = (blog, config) => {
  const visible = config.listing.visibleFields;
  const shaped = {
    _id: blog._id,
    slug: blog.slug,
  };

  if (visible.title) shaped.title = blog.title;
  if (visible.description) shaped.description = blog.description;
  if (visible.category) shaped.category = blog.category;
  if (visible.author) shaped.author = shapeAuthor(blog.author);
  if (visible.publishedAt) shaped.publishedAt = blog.publishedAt;
  if (visible.readingTime) shaped.readingTime = blog.readingTime;
  if (visible.featuredImage) shaped.featuredImage = blog.featuredImage;
  if (visible.tags) shaped.tags = blog.tags || [];

  return shaped;
};

const shapeBlogForDetail = (blog, config) => {
  const visible = config.detail.visibleFields;
  const shaped = {
    _id: blog._id,
    slug: blog.slug,
  };

  if (visible.title) shaped.title = blog.title;
  if (visible.content) shaped.content = blog.content;
  if (visible.category) shaped.category = blog.category;
  if (visible.author) shaped.author = shapeAuthor(blog.author);
  if (visible.publishedAt) shaped.publishedAt = blog.publishedAt;
  if (visible.featuredImage) {
    shaped.featuredImage = blog.featuredImage;
    shaped.featuredImageAlt = blog.featuredImageAlt;
  }
  if (visible.tags) shaped.tags = blog.tags || [];

  shaped.description = blog.description;
  shaped.readingTime = blog.readingTime;
  shaped.views = blog.views;

  return shaped;
};

const getPublicBlogsByApiKey = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, sortBy = "publishedAt", sortOrder = "desc" } =
    req.query;
  const { page: pageNumber, limit: limitNumber, skip } = normalizePaging(
    page,
    limit,
  );

  const query = buildPublishedBlogQuery(req.website._id, req.query);
  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1 };
  const displayConfig = mergeBlogConfig(req.website?.blogConfig);

  const [blogs, totalDocs] = await Promise.all([
    Blog.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limitNumber)
      .populate("author", "name email")
      .lean(),
    Blog.countDocuments(query),
  ]);

  const totalPages = Math.ceil(totalDocs / limitNumber) || 1;

  return successResponse(
    res,
    {
      websiteName: req.website.name,
      blogs: blogs.map((blog) => shapeBlogForListing(blog, displayConfig)),
      config: displayConfig,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        totalPages,
        totalDocs,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
      },
    },
    "Published blogs retrieved successfully",
  );
});

const getPublicBlogCategoriesByApiKey = asyncHandler(async (req, res) => {
  const categories = await Blog.distinct("category", {
    websiteId: req.website._id,
    status: "published",
    isPublished: true,
  });

  return successResponse(
    res,
    {
      websiteName: req.website.name,
      categories: categories.filter(Boolean),
      config: mergeBlogConfig(req.website?.blogConfig),
    },
    "Blog categories retrieved successfully",
  );
});

const getPublicBlogBySlugUsingApiKey = asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const displayConfig = mergeBlogConfig(req.website?.blogConfig);

  const blog = await Blog.findOne({
    websiteId: req.website._id,
    slug,
    status: "published",
    isPublished: true,
  })
    .populate("author", "name email")
    .lean();

  if (!blog) {
    return res.status(404).json({
      success: false,
      message: "Blog not found",
    });
  }

  await Blog.updateOne({ _id: blog._id }, { $inc: { views: 1 } });
  blog.views = (blog.views || 0) + 1;

  return successResponse(
    res,
    {
      websiteName: req.website.name,
      blog: shapeBlogForDetail(blog, displayConfig),
      config: displayConfig,
    },
    "Published blog retrieved successfully",
  );
});

export {
  getPublicBlogsByApiKey,
  getPublicBlogCategoriesByApiKey,
  getPublicBlogBySlugUsingApiKey,
};
