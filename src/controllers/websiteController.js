import crypto from "crypto";
import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import { Website } from "../models/index.js";
import logger from "../utils/logger.js";
import redis from "../config/redis.js";

/**
 * @desc    Get all websites for tenant
 * @route   GET /api/websites
 * @access  Private
 */
const getWebsites = asyncHandler(async (req, res, next) => {
  try {
    const { isActive, page = 1, limit = 20 } = req.query;

    const query = { tenantId: req.user.tenantId };
    if (isActive !== undefined) {
      query.isActive = isActive === "true";
    }

    const [websites, total] = await Promise.all([
      Website.find(query)
        .publicData()
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Website.countDocuments(query),
    ]);

    successResponse(
      res,
      {
        websites,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit),
        },
      },
      "Websites retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get website details
 * @route   GET /api/websites/:id
 * @access  Private
 */
const getWebsiteDetail = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    }).select("+apiKey");

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    // Get recent lead stats
    const recentStats = await Website.aggregate([
      { $match: { _id: website._id } },
      {
        $lookup: {
          from: "leads",
          localField: "_id",
          foreignField: "websiteId",
          as: "leads",
        },
      },
      {
        $addFields: {
          leadsLast7Days: {
            $size: {
              $filter: {
                input: "$leads",
                cond: {
                  $gte: [
                    "$$this.createdAt",
                    {
                      $dateSubtract: {
                        startDate: new Date(),
                        unit: "day",
                        amount: 7,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const result = {
      ...website.toObject(),
      leadsLast7Days: recentStats[0]?.leadsLast7Days || 0,
    };

    successResponse(res, result, "Website details retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Create new website
 * @route   POST /api/websites
 * @access  Private (admin)
 */
const createWebsite = asyncHandler(async (req, res, next) => {
  try {
    const {
      name,
      domain,
      category,
      description,
      webhookUrl,
      duplicateSettings,
      rateLimit,
      products,
      formFields,
      formConfig,
    } = req.body;

    if (!name || !domain) {
      return next(ApiError.badRequest("Name and domain are required"));
    }

    // Check if domain already exists in tenant
    const existingWebsite = await Website.findOne({
      tenantId: req.user.tenantId,
      domain: domain.toLowerCase(),
    });

    if (existingWebsite) {
      return next(
        ApiError.conflict(
          "A website with this domain already exists in your account",
        ),
      );
    }

    // Generate unique API key
    const apiKey = `pk_${crypto.randomBytes(24).toString("hex")}`;
    const apiKeyPrefix = apiKey.substring(0, 8);

    const website = await Website.create({
      tenantId: req.user.tenantId,
      name,
      domain: domain.toLowerCase(),
      apiKey,
      apiKeyPrefix,
      category: category || "contact_form",
      description,
      webhookUrl,
      duplicateSettings: duplicateSettings || {
        checkEmail: true,
        checkPhone: true,
        checkNameEmail: false,
      },
      rateLimit: rateLimit || {
        requestsPerMinute: 60,
        requestsPerDay: 5000,
      },
      products: Array.isArray(products)
        ? products.filter(Boolean).slice(0, 50)
        : [],
      formFields: Array.isArray(formFields)
        ? formFields
            .filter((f) => f && f.fieldName && f.label && f.type)
            .slice(0, 30)
        : [],
      formConfig:
        formConfig && typeof formConfig === "object" ? formConfig : {},
      createdBy: req.user._id,
    });

    // Log creation (use standard logger instead of LeadActivity for non-lead actions)
    logger.info(
      `Website created: ${website._id} (${domain}) by ${req.user.name}`,
    );

    successResponse(res, website, "Website created successfully", 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Update website
 * @route   PUT /api/websites/:id
 * @access  Private (admin)
 */
const updateWebsite = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    }).select("+apiKey");

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    // Allowed fields
    const allowedFields = [
      "name",
      "category",
      "description",
      "webhookUrl",
      "isActive",
      "duplicateSettings",
      "rateLimit",
      "ipWhitelist",
      "products",
      "formFields",
      "formConfig",
    ];

    // Sanitize products array if present
    if (Array.isArray(req.body.products)) {
      req.body.products = req.body.products.filter(Boolean).slice(0, 50);
    }

    // Sanitize formFields array if present
    if (Array.isArray(req.body.formFields)) {
      req.body.formFields = req.body.formFields
        .filter((f) => f && f.fieldName && f.label && f.type)
        .slice(0, 30);
    }

    const updates = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const updatedWebsite = await Website.findOneAndUpdate(
      { _id: req.params.id, tenantId: req.user.tenantId },
      updates,
      { new: true },
    );

    // Clear cached API key data
    if (website.apiKey) {
      await redis.del(`api_key:${website.apiKey}`);
    }

    successResponse(res, updatedWebsite, "Website updated");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Regenerate API key
 * @route   POST /api/websites/:id/regenerate-key
 * @access  Private (admin)
 */
const regenerateApiKey = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    }).select("+apiKey");

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    // Generate new API key
    const oldApiKey = website.apiKey;
    const newApiKey = `pk_${crypto.randomBytes(24).toString("hex")}`;
    const newApiKeyPrefix = newApiKey.substring(0, 8);

    website.apiKey = newApiKey;
    website.apiKeyPrefix = newApiKeyPrefix;
    await website.save();

    // Clear old cache
    await redis.del(`api_key:${oldApiKey}`);

    logger.info(
      `API key regenerated for website ${website._id} by ${req.user.name}`,
    );

    // Re-fetch without the +apiKey select to return a clean website object
    const updatedWebsite = await Website.findById(website._id).lean();

    successResponse(
      res,
      {
        website: updatedWebsite,
        apiKey: newApiKey,
        apiKeyPrefix: newApiKeyPrefix,
      },
      "API key regenerated successfully",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get website statistics
 * @route   GET /api/websites/:id/stats
 * @access  Private
 */
const getWebsiteStats = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    // Get lead statistics using Lead model directly for accurate results
    const Lead = (await import("../models/Lead.js")).default;

    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const leadScope = { websiteId: website._id, tenantId: req.user.tenantId };

    const [
      totalLeads,
      leadsThisMonth,
      leadsThisWeek,
      converted,
      duplicates,
      byStatus,
    ] = await Promise.all([
      Lead.countDocuments(leadScope),
      Lead.countDocuments({
        ...leadScope,
        createdAt: { $gte: oneMonthAgo },
      }),
      Lead.countDocuments({
        ...leadScope,
        createdAt: { $gte: oneWeekAgo },
      }),
      Lead.countDocuments({
        ...leadScope,
        convertedAt: { $ne: null },
      }),
      Lead.countDocuments({ ...leadScope, isDuplicate: true }),
      Lead.aggregate([
        { $match: { ...leadScope } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    const stats = {
      totalLeads,
      leadsThisMonth,
      leadsThisWeek,
      converted,
      duplicates,
      byStatus,
      conversionRate:
        totalLeads > 0
          ? parseFloat(((converted / totalLeads) * 100).toFixed(2))
          : 0,
      lastLeadAt: website.stats?.lastLeadAt || null,
    };

    successResponse(res, stats, "Website statistics retrieved");
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Test website connection
 * @route   POST /api/websites/:id/test
 * @access  Private
 */
const testWebsiteConnection = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    if (!website.webhookUrl) {
      return successResponse(
        res,
        { message: "No webhook URL configured" },
        "Test skipped",
      );
    }

    // Test webhook
    const testPayload = {
      test: true,
      website: website.name,
      timestamp: new Date(),
    };

    try {
      const response = await fetch(website.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(testPayload),
      });

      const result = {
        webhookUrl: website.webhookUrl,
        statusCode: response.status,
        success: response.ok,
        timestamp: new Date(),
      };

      successResponse(res, result, "Webhook test completed");
    } catch (error) {
      return next(ApiError.badRequest(`Webhook test failed: ${error.message}`));
    }
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Delete website
 * @route   DELETE /api/websites/:id
 * @access  Private (admin)
 */
const deleteWebsite = asyncHandler(async (req, res, next) => {
  try {
    const website = await Website.findOne({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    }).select("+apiKey");

    if (!website) {
      return next(ApiError.notFound("Website not found"));
    }

    await Website.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.user.tenantId,
    });

    // Clear cached API key data
    if (website.apiKey) {
      await redis.del(`api_key:${website.apiKey}`);
    }

    logger.info(`Website ${req.params.id} deleted by ${req.user.name}`);

    successResponse(res, null, "Website deleted");
  } catch (error) {
    next(error);
  }
});

export {
  getWebsites,
  getWebsiteDetail,
  createWebsite,
  updateWebsite,
  regenerateApiKey,
  getWebsiteStats,
  testWebsiteConnection,
  deleteWebsite,
};
