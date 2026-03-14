import {
  ApiError,
  asyncHandler,
  successResponse,
} from "../utils/apiResponse.js";
import LeadService from "../core/leads/LeadService.js";
import Lead from "../models/Lead.js";
import Event from "../models/Event.js";
import TicketType from "../models/TicketType.js";
import EventRegistration from "../models/EventRegistration.js";
import Attendee from "../models/Attendee.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import Registration from "../models/Registration.js";
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
      "private",
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
      url: `/api/v1/files/lead-attachments/${leadId}/${uniqueName}`,
      s3Key: null,
      uploadedAt: new Date(),
    });
  }

  return attachments;
};

const parseCustomFields = (value) => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }
  return {};
};

const sanitizeCustomFieldsForEvent = (eventFields = [], incoming = {}) => {
  if (!Array.isArray(eventFields) || !eventFields.length) return {};

  const input = incoming && typeof incoming === "object" ? incoming : {};
  const cleaned = {};

  for (const field of eventFields) {
    const key = String(field?.key || "").trim();
    if (!key) continue;

    const type = field?.type || "text";
    const rawValue = input[key];
    const hasValue =
      rawValue !== undefined &&
      rawValue !== null &&
      String(rawValue).trim() !== "";

    if (field?.required && !hasValue) {
      throw ApiError.badRequest(`${field.label || key} is required`);
    }

    if (!hasValue) continue;

    let value = rawValue;

    if (["text", "textarea", "select", "url", "date"].includes(type)) {
      value = String(rawValue).trim();
    }

    if (type === "number") {
      const numeric = Number(rawValue);
      if (!Number.isFinite(numeric)) {
        throw ApiError.badRequest(
          `${field.label || key} must be a valid number`,
        );
      }
      value = numeric;
    }

    if (type === "url") {
      try {
        const parsedUrl = new URL(String(value));
        if (!parsedUrl.hostname) {
          throw new Error("Invalid URL");
        }
      } catch {
        throw ApiError.badRequest(`${field.label || key} must be a valid URL`);
      }
    }

    if (type === "date") {
      const dt = new Date(String(value));
      if (Number.isNaN(dt.getTime())) {
        throw ApiError.badRequest(`${field.label || key} must be a valid date`);
      }
    }

    const maxLength = Number(field?.maxLength || 0);
    if (maxLength > 0 && String(value).length > maxLength) {
      throw ApiError.badRequest(
        `${field.label || key} cannot exceed ${maxLength} characters`,
      );
    }

    if (
      type === "select" &&
      Array.isArray(field?.options) &&
      field.options.length
    ) {
      const allowed = new Set(field.options.map((option) => String(option)));
      if (!allowed.has(String(value))) {
        throw ApiError.badRequest(
          `${field.label || key} has an invalid option`,
        );
      }
    }

    cleaned[key] = value;
  }

  return cleaned;
};

const deriveOrderStatus = (paymentStatus) => {
  if (paymentStatus === "paid" || paymentStatus === "free") return "confirmed";
  if (paymentStatus === "refunded") return "refunded";
  if (paymentStatus === "failed") return "cancelled";
  return "pending";
};

const createDomainRegistrationArtifacts = async ({
  tenantId,
  eventId,
  ticketTypeId,
  attendee,
  quantity,
  subtotalAmount,
  discountAmount = 0,
  totalAmount,
  currency,
  paymentStatus,
  notes,
  customFields,
  source,
  legacyRegistration,
}) => {
  const attendeeDoc = await Attendee.findOneAndUpdate(
    { tenantId, email: String(attendee.email).toLowerCase() },
    {
      $set: {
        firstName: attendee.firstName,
        lastName: attendee.lastName || "",
        phone: attendee.phone || "",
        company: attendee.company || "",
      },
      $setOnInsert: {
        tenantId,
        email: String(attendee.email).toLowerCase(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const order = await Order.create({
    tenantId,
    eventId,
    attendeeId: attendeeDoc._id,
    status: deriveOrderStatus(paymentStatus),
    subtotalAmount: subtotalAmount ?? totalAmount,
    discountAmount,
    totalAmount,
    currency,
    source,
    notes: notes || "",
  });

  const payment = await Payment.create({
    tenantId,
    eventId,
    orderId: order._id,
    amount: totalAmount,
    currency,
    status: paymentStatus,
    method: paymentStatus === "free" ? "free" : "other",
    paidAt:
      paymentStatus === "paid" || paymentStatus === "free" ? new Date() : null,
  });

  const registration = await Registration.create({
    tenantId,
    eventId,
    ticketTypeId,
    attendeeId: attendeeDoc._id,
    orderId: order._id,
    paymentId: payment._id,
    legacyRegistrationId: legacyRegistration._id,
    registrationNumber: legacyRegistration.registrationNumber,
    qrToken: legacyRegistration.qrToken,
    quantity,
    subtotalAmount: subtotalAmount ?? totalAmount,
    discountAmount,
    totalAmount,
    currency,
    status: legacyRegistration.status,
    paymentStatus,
    notes: notes || "",
    customFields,
    source,
  });

  return {
    attendeeId: attendeeDoc._id,
    orderId: order._id,
    paymentId: payment._id,
    registrationId: registration._id,
  };
};

const isEventRegistrationTarget = (website) =>
  website?.formConfig?.submissionTarget === "event_registration";

const toPositiveInt = (value, fallback = 1) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    // Validate required fields shared by lead + event registration flows.
    const { firstName, email } = req.body;
    if (!firstName || !email) {
      return next(ApiError.badRequest("First name and email are required"));
    }

    const parsedCustomFields = parseCustomFields(req.body.customFields);

    if (isEventRegistrationTarget(req.website)) {
      const eventConfig = req.website?.formConfig?.eventConfig || {};
      if (!eventConfig?.eventId) {
        return next(
          ApiError.badRequest(
            "Website form is configured for event registration but no event is linked",
          ),
        );
      }

      const event = await Event.findOne({
        _id: eventConfig.eventId,
        tenantId: req.website.tenantId,
      }).lean();

      if (!event) {
        return next(ApiError.notFound("Configured event not found"));
      }

      if (event.status === "cancelled") {
        return next(ApiError.badRequest("This event has been cancelled"));
      }
      if (event.status === "completed") {
        return next(ApiError.badRequest("This event has already ended"));
      }

      const eventCustomFields = sanitizeCustomFieldsForEvent(
        event.registrationFields,
        parsedCustomFields,
      );

      const configuredQty = toPositiveInt(eventConfig.defaultQuantity, 1);
      const requestedQty = toPositiveInt(req.body.quantity, configuredQty);
      const quantity = eventConfig.allowQuantitySelection
        ? requestedQty
        : configuredQty;

      let ticketTypeId =
        req.body.ticketTypeId || eventConfig.defaultTicketTypeId || null;

      if (!ticketTypeId) {
        const firstActiveTicket = await TicketType.findOne({
          tenantId: req.website.tenantId,
          eventId: event._id,
          status: { $ne: "paused" },
        })
          .sort({ createdAt: 1 })
          .lean();
        ticketTypeId = firstActiveTicket?._id || null;
      }

      if (!ticketTypeId) {
        return next(
          ApiError.badRequest(
            "No active ticket type is available for the configured event",
          ),
        );
      }

      const ticketType = await TicketType.findOne({
        _id: ticketTypeId,
        eventId: event._id,
        tenantId: req.website.tenantId,
      });

      if (!ticketType) {
        return next(ApiError.notFound("Ticket type not found"));
      }

      if (!eventConfig.allowTicketSelection) {
        const configuredTicketId = String(
          eventConfig.defaultTicketTypeId || "",
        );
        if (
          configuredTicketId &&
          String(ticketType._id) !== configuredTicketId
        ) {
          return next(
            ApiError.badRequest(
              "Ticket selection is disabled for this registration form",
            ),
          );
        }
      }

      if (ticketType.status === "paused") {
        return next(
          ApiError.badRequest("Ticket sales are paused for this type"),
        );
      }

      const now = new Date();
      if (ticketType.saleStartDate && ticketType.saleStartDate > now) {
        return next(ApiError.badRequest("Ticket sales have not started yet"));
      }
      if (ticketType.saleEndDate && ticketType.saleEndDate < now) {
        return next(ApiError.badRequest("Ticket sales have ended"));
      }
      if (quantity < ticketType.perOrderMin) {
        return next(
          ApiError.badRequest(
            `Minimum ${ticketType.perOrderMin} ticket(s) per order`,
          ),
        );
      }
      if (quantity > ticketType.perOrderMax) {
        return next(
          ApiError.badRequest(
            `Maximum ${ticketType.perOrderMax} ticket(s) per order`,
          ),
        );
      }

      if (ticketType.capacity != null) {
        const remaining = ticketType.capacity - ticketType.sold;
        if (remaining < quantity) {
          return next(
            ApiError.badRequest(
              remaining === 0
                ? "Tickets are sold out"
                : `Only ${remaining} ticket(s) remaining`,
            ),
          );
        }
      }

      const attendee = {
        firstName: req.body.firstName?.trim(),
        lastName: req.body.lastName?.trim() || "",
        email: req.body.email?.trim().toLowerCase(),
        phone: req.body.phone?.trim() || "",
        company: req.body.company?.trim() || "",
      };

      const totalAmount = ticketType.price * quantity;
      const paymentStatus = ticketType.price === 0 ? "free" : "pending";
      const source = "web";

      const registration = await EventRegistration.create({
        tenantId: req.website.tenantId,
        eventId: event._id,
        ticketTypeId: ticketType._id,
        attendee,
        quantity,
        totalAmount,
        currency: ticketType.currency,
        status: "confirmed",
        paymentStatus,
        notes: req.body.notes?.trim() || req.body.message?.trim() || "",
        customFields: eventCustomFields,
        source,
        ipAddress: req.ip,
      });

      const domainRefs = await createDomainRegistrationArtifacts({
        tenantId: req.website.tenantId,
        eventId: event._id,
        ticketTypeId: ticketType._id,
        attendee,
        quantity,
        totalAmount,
        currency: ticketType.currency,
        paymentStatus,
        notes: req.body.notes?.trim() || req.body.message?.trim() || "",
        customFields: eventCustomFields,
        source,
        legacyRegistration: registration,
      });

      await TicketType.findByIdAndUpdate(ticketType._id, {
        $inc: { sold: quantity },
      });

      if (
        ticketType.capacity != null &&
        ticketType.sold + quantity >= ticketType.capacity
      ) {
        await TicketType.findByIdAndUpdate(ticketType._id, {
          status: "sold_out",
        });
      }

      logger.info(`Event registration submitted via ${req.website.name}`, {
        eventId: event._id,
        registrationId: registration._id,
        email: attendee.email,
      });

      return successResponse(
        res,
        {
          registrationId: registration._id,
          registrationNumber: registration.registrationNumber,
          qrToken: registration.qrToken,
          eventId: event._id,
          ticketTypeId: ticketType._id,
          quantity,
          totalAmount,
          currency: ticketType.currency,
          domainRefs,
        },
        "Event registration submitted successfully",
        201,
      );
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
      customFields: parsedCustomFields,
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
      const lead = await Lead.findOne({
        _id: result.leadId,
        tenantId: req.website.tenantId,
      });
      if (lead) {
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
    logger.error(`Public submission error: ${error.message}`);
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
      title: "Public Form Submission API",
      version: "1.0.0",
      baseUrl: `${req.protocol}://${req.get("host")}/api`,
      endpoints: {
        submitLead: {
          method: "POST",
          path: "/public/lead",
          description:
            "Submit a website form payload. Depending on website form configuration, this creates a lead or an event registration.",
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

/**
 * @desc    Get product list for a website (for external form dropdowns)
 * @route   GET /api/public/products
 * @access  Public (API key required)
 */
const getPublicProducts = asyncHandler(async (req, res, next) => {
  try {
    const products = req.website?.products || [];
    successResponse(
      res,
      {
        websiteName: req.website?.name,
        products,
      },
      "Products retrieved",
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @desc    Get complete form schema for a website (products + custom fields)
 * @route   GET /api/public/form-schema
 * @access  Public (API key required)
 */
const getPublicFormSchema = asyncHandler(async (req, res, next) => {
  try {
    const products = req.website?.products || [];
    const formFields = (req.website?.formFields || [])
      .filter((f) => f.isActive !== false)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((f) => ({
        fieldName: f.fieldName,
        label: f.label,
        type: f.type,
        placeholder: f.placeholder || "",
        description: f.description || "",
        defaultValue: f.defaultValue ?? "",
        required: !!f.required,
        options: f.options || [],
        validation: f.validation || {},
        fileConfig: f.fileConfig || {},
        conditionalLogic: f.conditionalLogic || {},
        width: f.width || "full",
        cssClass: f.cssClass || "",
      }));

    const rawConfig = req.website?.formConfig || {};
    const submissionTarget = rawConfig.submissionTarget || "lead";

    let eventRegistration = null;
    if (submissionTarget === "event_registration") {
      const configuredEventId = rawConfig?.eventConfig?.eventId;
      if (configuredEventId) {
        const event = await Event.findOne({
          _id: configuredEventId,
          tenantId: req.website?.tenantId,
        })
          .select("name startDate endDate status location")
          .lean();

        if (event) {
          const ticketTypes = await TicketType.find({
            tenantId: req.website?.tenantId,
            eventId: event._id,
            status: { $ne: "paused" },
          })
            .select(
              "name description price currency capacity sold status perOrderMin perOrderMax",
            )
            .sort({ createdAt: 1 })
            .lean();

          eventRegistration = {
            event,
            ticketTypes: ticketTypes.map((ticket) => ({
              ...ticket,
              available:
                ticket.capacity == null
                  ? null
                  : Math.max(0, ticket.capacity - ticket.sold),
              isSoldOut:
                ticket.capacity != null && ticket.sold >= ticket.capacity,
            })),
          };
        }
      }
    }

    const formConfig = {
      submissionTarget,
      eventConfig: rawConfig.eventConfig || {},
      formTitle: rawConfig.formTitle || "",
      formDescription: rawConfig.formDescription || "",
      submitButtonText: rawConfig.submitButtonText || "Submit",
      successMessage:
        rawConfig.successMessage || "Thank you! We will contact you soon.",
      redirectUrl: rawConfig.redirectUrl || "",
      theme: rawConfig.theme || {},
      defaultFields: rawConfig.defaultFields || {},
    };

    successResponse(
      res,
      {
        websiteName: req.website?.name,
        submissionTarget,
        products,
        formFields,
        formConfig,
        eventRegistration,
      },
      "Form schema retrieved",
    );
  } catch (error) {
    next(error);
  }
});

export {
  submitPublicLead,
  publicApiHealth,
  getPublicApiDocs,
  getPublicProducts,
  getPublicFormSchema,
};
