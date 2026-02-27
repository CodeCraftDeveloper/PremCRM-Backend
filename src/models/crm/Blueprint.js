import mongoose from "mongoose";

/**
 * CRM Blueprint — State machine definition for controlled transitions.
 * Validates stage/status transitions, enforces required fields and actions.
 */
const requiredActionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ["note", "task", "approval"],
    },
    description: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const transitionSchema = new mongoose.Schema(
  {
    fromStage: { type: String, required: true },
    toStage: { type: String, required: true },
    requiredFields: [{ type: String }],
    requiredActions: [requiredActionSchema],
    allowedRoles: {
      type: [String],
      default: ["admin", "marketing", "superadmin"],
    },
  },
  { _id: true },
);

const blueprintSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Blueprint name is required"],
      trim: true,
      maxlength: 200,
    },

    // ── Module this blueprint applies to ────────────────
    module: {
      type: String,
      required: true,
      enum: ["lead", "deal", "contact"],
    },

    isActive: { type: Boolean, default: true },

    // ── Transition rules ────────────────────────────────
    transitions: {
      type: [transitionSchema],
      validate: {
        validator: (v) => v.length >= 1,
        message: "At least one transition is required",
      },
    },

    // ── Meta ────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
blueprintSchema.index({ tenantId: 1, module: 1, isActive: 1 });
blueprintSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * Validate a transition against this blueprint.
 * @param {string} fromStage
 * @param {string} toStage
 * @param {string} userRole
 * @param {Object} entityData — current entity fields
 * @returns {{ valid: boolean, reason?: string, transition?: Object }}
 */
blueprintSchema.methods.validateTransition = function (
  fromStage,
  toStage,
  userRole,
  entityData = {},
) {
  const transition = this.transitions.find(
    (t) => t.fromStage === fromStage && t.toStage === toStage,
  );

  if (!transition) {
    return {
      valid: false,
      reason: `Transition from "${fromStage}" to "${toStage}" is not allowed`,
    };
  }

  // Check role
  if (
    transition.allowedRoles.length > 0 &&
    !transition.allowedRoles.includes(userRole)
  ) {
    return {
      valid: false,
      reason: `Role "${userRole}" is not allowed for this transition`,
    };
  }

  // Check required fields
  const missingFields = [];
  for (const field of transition.requiredFields) {
    const value = entityData[field];
    if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }
  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `Missing required fields: ${missingFields.join(", ")}`,
      missingFields,
    };
  }

  return { valid: true, transition };
};

/**
 * Get active blueprint for a module + tenant.
 */
blueprintSchema.statics.getActiveForModule = function (tenantId, module) {
  return this.findOne({ tenantId, module, isActive: true });
};

export default mongoose.model("Blueprint", blueprintSchema);
