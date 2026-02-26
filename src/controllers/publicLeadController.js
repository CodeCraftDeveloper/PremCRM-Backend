import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import LeadService from "../core/leads/LeadService.js";
import Lead from "../models/Lead.js";
import { uploadToS3 } from "../config/s3.js";
import logger from "../utils/logger.js";
import fs from "fs";
import path from "path";

const buildAttachmentRecords = async (leadId, files = []) => {
  if (!files.length) return [];

  const isS3Available = Boolean(
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET,
  );

  const attachments = [];

  for (const file of files) {
    if (isS3Available) {
      try {
        const s3Result = await uploadToS3(
          file.buffer,
          file.originalname,
          file.mimetype,
          `lead-attachments/${leadId}`,
        );

        attachments.push({
          fileName: s3Result.filename,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          url: s3Result.url,
          s3Key: s3Result.key,
          uploadedAt: new Date(),
        });
        continue;
      } catch (error) {
        logger.warn(
          `S3 unavailable for public lead attachment; falling back to local storage: ${error.message}`,
        );
      }
    }

    const uploadDir = path.join(
      process.cwd(),
      "public",
      "uploads",
      "lead-attachments",
      String(leadId),
    );
    fs.mkdirSync(uploadDir, { recursive: true });

    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    fs.writeFileSync(path.join(uploadDir, uniqueName), file.buffer);

    attachments.push({
      fileName: uniqueName,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      url: `/uploads/lead-attachments/${leadId}/${uniqueName}`,
      s3Key: null,
      uploadedAt: new Date(),
    });
  }

  return attachments;
};

/**
 * Public Lead Intake Controller
 * Handles external website form submissions
 * NO authentication required (API key based)
 */

/**
 * @desc    Receive lead from external website
 * @route   POST /api/public/lead
 * @access  Public (API key required)
 * @headers x-api-key: Website API key
 */
const submitPublicLead = asyncHandler(async (req, res, next) => {
  try {
    // Validate required fields
    const { firstName, email, phone, message } = req.body;

    if (!firstName || !email) {
      return next(ApiError.badRequest("First name and email are required"));
    }

    // Prepare lead data
    const leadData = {
      firstName: req.body.firstName?.trim(),
      lastName: req.body.lastName?.trim(),
      email: req.body.email?.trim().toLowerCase(),
      phone: req.body.phone?.trim(),
      message: req.body.message?.trim(),
      country: req.body.country?.trim(),
      city: req.body.city?.trim(),
      state: req.body.state?.trim(),
      zipCode: req.body.zipCode?.trim(),
      company: req.body.company?.trim(),
      productInterest: req.body.productInterest?.trim(),
      source: req.body.source?.trim(),
      customFields: req.body.customFields || {},
      tags: req.body.tags || [],
      notes: req.body.notes?.trim(),
    };

    // Prepare metadata
    const metadata = {
      ipAddress: req.ip || req.connection?.remoteAddress,
      userAgent: req.get("user-agent"),
    };

    // Create lead (LeadService handles duplicates & assignment)
    const result = await LeadService.createLead(
      leadData,
      req.website._id,
      req.website.tenantId,
      metadata,
    );

    let attachmentsCount = 0;
    if (result?.leadId && req.files?.length) {
      const lead = await Lead.findById(result.leadId);
      if (
        lead &&
        lead.tenantId.toString() === req.website.tenantId.toString()
      ) {
        const newAttachments = await buildAttachmentRecords(
          lead._id,
          req.files,
        );
        // Public intake cap: max 10 files per lead in total.
        const capped = newAttachments.slice(
          0,
          Math.max(0, 10 - (lead.attachments?.length || 0)),
        );
        lead.attachments = [...(lead.attachments || []), ...capped];
        lead.lastActivityAt = new Date();
        await lead.save();
        attachmentsCount = capped.length;
      }
    }

    // Log successful submission
    logger.info(`Lead submitted via ${req.website.name}`, {
      leadId: result.leadId,
      isDuplicate: result.isDuplicate,
      email: leadData.email,
    });

    // Return response
    return successResponse(
      res,
      {
        leadId: result.leadId,
        isDuplicate: result.isDuplicate,
        attachmentsCount,
      },
      result.message,
      201,
    );
  } catch (error) {
    logger.error(`Public lead submission error: ${error.message}`);
    next(ApiError.badRequest(error.message));
  }
});

/**
 * @desc    Health check for public API
 * @route   GET /api/public/health
 * @access  Public (API key required)
 */
const publicApiHealth = asyncHandler(async (req, res, next) => {
  try {
    successResponse(
      res,
      {
        status: "healthy",
        website: req.website?.name,
        timestamp: new Date(),
      },
      "API is healthy",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get public API documentation
 * @route   GET /api/public/docs
 * @access  Public
 */
const getPublicApiDocs = asyncHandler(async (req, res, next) => {
  try {
    const documentation = {
      title: "Lead Intake API",
      version: "1.0.0",
      baseUrl: `${req.protocol}://${req.get("host")}/api`,
      endpoints: {
        submitLead: {
          method: "POST",
          path: "/public/lead",
          description: "Submit a new lead from your website",
          authentication: "API key (x-api-key header)",
          rateLimit: "60 requests per minute",
          requestBody: {
            required: ["firstName", "email"],
            optional: [
              "lastName",
              "phone",
              "message",
              "country",
              "city",
              "state",
              "zipCode",
              "company",
              "productInterest",
              "customFields",
              "tags",
              "attachments (multipart/form-data, up to 5 files/request)",
            ],
          },
          responseExample: {
            success: true,
            data: {
              leadId: "507f1f77bcf86cd799439011",
              isDuplicate: false,
            },
            message: "Lead created successfully",
          },
          errorResponses: [
            {
              status: 400,
              message: "First name and email are required",
            },
            {
              status: 401,
              message: "Invalid or inactive API key",
            },
            {
              status: 429,
              message: "Rate limit exceeded",
            },
          ],
        },
        health: {
          method: "GET",
          path: "/public/health",
          description: "Check API health",
          authentication: "API key",
        },
      },
      codeExamples: {
        javascript: `
// Submit lead from contact form
const apiKey = 'your-api-key-here';

fetch('https://yourcrm.com/api/public/lead', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey
  },
  body: JSON.stringify({
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    phone: '+1234567890',
    message: 'Interested in your product',
    company: 'Tech Corp',
    country: 'United States'
  })
})
.then(res => res.json())
.then(data => {
  if (data.success) {
    console.log('Lead created:', data.data.leadId);
  }
})
.catch(err => console.error('Error:', err));
        `,
        javascriptWithAttachments: `
// Submit lead with attachments
const apiKey = 'your-api-key-here';
const payload = new FormData();
payload.append('firstName', 'John');
payload.append('email', 'john@example.com');
payload.append('message', 'Please review attached files');

// <input type="file" id="attachments" multiple />
const files = document.getElementById('attachments')?.files || [];
Array.from(files).slice(0, 5).forEach((file) => payload.append('attachments', file));

fetch('https://yourcrm.com/api/public/lead', {
  method: 'POST',
  headers: { 'x-api-key': apiKey },
  body: payload
})
.then(res => res.json())
.then(console.log);
        `,
        curl: `
curl -X POST https://yourcrm.com/api/public/lead \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: your-api-key-here" \\
  -d '{
    "firstName":"John",
    "lastName":"Doe",
    "email":"john@example.com",
    "phone":"+1234567890",
    "message":"Interested in your product",
    "company":"Tech Corp"
  }'

# With attachments
curl -X POST https://yourcrm.com/api/public/lead \\
  -H "x-api-key: your-api-key-here" \\
  -F "firstName=John" \\
  -F "email=john@example.com" \\
  -F "message=Please review files" \\
  -F "attachments=@/path/to/file1.pdf" \\
  -F "attachments=@/path/to/file2.jpg"
        `,
      },
    };

    successResponse(res, documentation, "API documentation");
  } catch (error) {
    next(error);
  }
});

export { submitPublicLead, publicApiHealth, getPublicApiDocs };
