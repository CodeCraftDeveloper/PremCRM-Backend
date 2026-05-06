import mongoose from "mongoose";

const websiteSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Website name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
      index: true,
    },
    domain: {
      type: String,
      required: [true, "Domain is required"],
      trim: true,
      lowercase: true,
    },
    apiKey: {
      type: String,
      required: [true, "API key is required"],
      unique: true,
      index: true,
      select: false, // Don't include in queries by default
    },
    apiKeyPrefix: {
      // First 8 chars of API key for reference (not secret)
      type: String,
      index: true,
    },
    description: {
      type: String,
      maxlength: [500, "Description cannot exceed 500 characters"],
    },
    // Lead source category
    category: {
      type: String,
      enum: ["contact_form", "landing_page", "webinar", "partner", "other"],
      default: "contact_form",
      index: true,
    },
    // Configuration for duplicate detection
    duplicateSettings: {
      checkEmail: { type: Boolean, default: true },
      checkPhone: { type: Boolean, default: true },
      checkNameEmail: { type: Boolean, default: false },
    },
    // Rate limiting per website
    rateLimit: {
      requestsPerMinute: {
        type: Number,
        default: 60,
        min: 1,
        max: 10000,
      },
      requestsPerDay: {
        type: Number,
        default: 5000,
        min: 1,
      },
    },
    // Webhook for notifications
    webhookUrl: {
      type: String,
      trim: true,
    },
    webhookSecret: {
      type: String,
      select: false,
    },
    // Track leakage
    stats: {
      totalLeads: { type: Number, default: 0 },
      leadsThisMonth: { type: Number, default: 0 },
      duplicatesDetected: { type: Number, default: 0 },
      lastLeadAt: { type: Date, default: null },
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    ipWhitelist: [
      {
        type: String,
        trim: true,
      },
    ],
    // Admin-configured product/service list for lead forms
    products: [
      {
        type: String,
        trim: true,
        maxlength: [200, "Product name cannot exceed 200 characters"],
      },
    ],
    // Admin-configured custom form fields for lead capture forms
    formFields: [
      {
        fieldName: {
          type: String,
          required: true,
          trim: true,
          maxlength: [50, "Field name cannot exceed 50 characters"],
        },
        label: {
          type: String,
          required: true,
          trim: true,
          maxlength: [100, "Label cannot exceed 100 characters"],
        },
        type: {
          type: String,
          required: true,
          enum: [
            "text",
            "email",
            "number",
            "phone",
            "textarea",
            "select",
            "multiselect",
            "checkbox",
            "radio",
            "date",
            "time",
            "datetime",
            "file",
            "url",
            "address",
            "hidden",
            "heading",
            "paragraph",
            "divider",
            "rating",
            "color",
            "range",
            "country",
          ],
          default: "text",
        },
        placeholder: {
          type: String,
          trim: true,
          maxlength: [200, "Placeholder cannot exceed 200 characters"],
        },
        description: {
          type: String,
          trim: true,
          maxlength: [500, "Description cannot exceed 500 characters"],
        },
        defaultValue: {
          type: mongoose.Schema.Types.Mixed,
          default: null,
        },
        required: { type: Boolean, default: false },
        // Options for select / radio / checkbox-group / multiselect
        options: [
          {
            type: String,
            trim: true,
            maxlength: [200, "Option cannot exceed 200 characters"],
          },
        ],
        // Validation constraints
        validation: {
          minLength: { type: Number, min: 0 },
          maxLength: { type: Number, min: 1 },
          min: { type: Number },
          max: { type: Number },
          pattern: { type: String },
          customError: { type: String, maxlength: 200 },
        },
        // File upload config
        fileConfig: {
          acceptedTypes: { type: String, default: "" }, // e.g. ".pdf,.jpg,.png"
          maxSizeMB: { type: Number, default: 5, min: 0.1, max: 50 },
          multiple: { type: Boolean, default: false },
        },
        // Layout & appearance
        width: {
          type: String,
          enum: ["full", "half", "third"],
          default: "full",
        },
        cssClass: { type: String, trim: true, maxlength: 200 },
        // Conditional visibility
        conditionalLogic: {
          enabled: { type: Boolean, default: false },
          action: {
            type: String,
            enum: ["show", "hide"],
            default: "show",
          },
          field: { type: String, default: "" }, // fieldName of trigger field
          operator: {
            type: String,
            enum: [
              "equals",
              "not_equals",
              "contains",
              "not_contains",
              "is_empty",
              "is_not_empty",
            ],
            default: "equals",
          },
          value: { type: String, default: "" },
        },
        sortOrder: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true },
      },
    ],
    // Form-level configuration
    formConfig: {
      submissionTarget: {
        type: String,
        enum: ["lead", "event_registration"],
        default: "lead",
      },
      eventConfig: {
        eventId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Event",
          default: null,
        },
        defaultTicketTypeId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "TicketType",
          default: null,
        },
        defaultQuantity: {
          type: Number,
          min: 1,
          max: 20,
          default: 1,
        },
        allowTicketSelection: {
          type: Boolean,
          default: true,
        },
        allowQuantitySelection: {
          type: Boolean,
          default: true,
        },
      },
      // Form appearance
      formTitle: { type: String, trim: true, maxlength: 200, default: "" },
      formDescription: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: "",
      },
      submitButtonText: {
        type: String,
        trim: true,
        maxlength: 50,
        default: "Submit",
      },
      successMessage: {
        type: String,
        trim: true,
        maxlength: 500,
        default: "Thank you! We will contact you soon.",
      },
      redirectUrl: { type: String, trim: true, default: "" },
      // Theme
      theme: {
        primaryColor: { type: String, default: "#4F46E5" },
        backgroundColor: { type: String, default: "#FFFFFF" },
        textColor: { type: String, default: "#111827" },
        borderRadius: {
          type: String,
          enum: ["none", "sm", "md", "lg", "xl"],
          default: "md",
        },
        fontSize: {
          type: String,
          enum: ["sm", "base", "lg"],
          default: "base",
        },
        labelPosition: {
          type: String,
          enum: ["top", "left", "floating"],
          default: "top",
        },
      },
      // Default built-in field toggles (which standard fields appear)
      defaultFields: {
        firstName: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: true },
          label: { type: String, default: "First Name" },
        },
        lastName: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Last Name" },
        },
        email: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: true },
          label: { type: String, default: "Email" },
        },
        phone: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Phone" },
        },
        company: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Company" },
        },
        message: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Message" },
        },
        country: {
          show: { type: Boolean, default: false },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Country" },
        },
        city: {
          show: { type: Boolean, default: false },
          required: { type: Boolean, default: false },
          label: { type: String, default: "City" },
        },
        state: {
          show: { type: Boolean, default: false },
          required: { type: Boolean, default: false },
          label: { type: String, default: "State" },
        },
        zipCode: {
          show: { type: Boolean, default: false },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Zip Code" },
        },
        productInterest: {
          show: { type: Boolean, default: true },
          required: { type: Boolean, default: false },
          label: { type: String, default: "Product Interest" },
        },
      },
    },
    // Blog presentation configuration for external blog integrations
    blogConfig: {
      listing: {
        visibleFields: {
          title: { type: Boolean, default: true },
          description: { type: Boolean, default: true },
          category: { type: Boolean, default: true },
          author: { type: Boolean, default: true },
          publishedAt: { type: Boolean, default: true },
          readingTime: { type: Boolean, default: true },
          featuredImage: { type: Boolean, default: true },
          tags: { type: Boolean, default: true },
        },
        elements: {
          containerTag: { type: String, default: "article" },
          titleTag: { type: String, default: "h3" },
          descriptionTag: { type: String, default: "p" },
          categoryTag: { type: String, default: "span" },
          metaTag: { type: String, default: "div" },
          imageTag: { type: String, default: "img" },
        },
        styles: {
          backgroundColor: { type: String, default: "#ffffff" },
          textColor: { type: String, default: "#111827" },
          accentColor: { type: String, default: "#4f46e5" },
          backgroundImage: { type: String, default: "" },
          textAlign: {
            type: String,
            enum: ["left", "center", "right"],
            default: "left",
          },
        },
      },
      detail: {
        visibleFields: {
          title: { type: Boolean, default: true },
          content: { type: Boolean, default: true },
          category: { type: Boolean, default: true },
          author: { type: Boolean, default: true },
          publishedAt: { type: Boolean, default: true },
          featuredImage: { type: Boolean, default: true },
          tags: { type: Boolean, default: true },
        },
        elements: {
          containerTag: { type: String, default: "article" },
          titleTag: { type: String, default: "h1" },
          contentTag: { type: String, default: "div" },
          categoryTag: { type: String, default: "span" },
          metaTag: { type: String, default: "div" },
          imageTag: { type: String, default: "img" },
        },
        styles: {
          backgroundColor: { type: String, default: "#ffffff" },
          textColor: { type: String, default: "#111827" },
          accentColor: { type: String, default: "#4f46e5" },
          backgroundImage: { type: String, default: "" },
          textAlign: {
            type: String,
            enum: ["left", "center", "right"],
            default: "left",
          },
        },
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound unique index: one domain per tenant
websiteSchema.index({ tenantId: 1, domain: 1 }, { unique: true });
websiteSchema.index({ tenantId: 1, isActive: 1 });

// Query helper to exclude API key by default
websiteSchema.query.publicData = function () {
  return this.select("-apiKey -webhookSecret");
};

export default mongoose.model("Website", websiteSchema);
