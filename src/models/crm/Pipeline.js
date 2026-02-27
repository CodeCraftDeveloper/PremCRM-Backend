import mongoose from "mongoose";

/**
 * CRM Pipeline — Defines deal pipelines with ordered stages.
 * Stages are embedded subdocuments for atomic operations.
 */
const stageSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Stage name is required"],
    trim: true,
    maxlength: 80,
  },
  probability: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    default: 0,
  },
  order: {
    type: Number,
    required: true,
    min: 0,
  },
  isClosed: {
    type: Boolean,
    default: false,
  },
  isWon: {
    type: Boolean,
    default: false,
  },
});

const pipelineSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Pipeline name is required"],
      trim: true,
      maxlength: 120,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    stages: {
      type: [stageSchema],
      validate: {
        validator: (v) => v.length >= 2,
        message: "Pipeline must have at least 2 stages",
      },
    },
  },
  { timestamps: true, versionKey: false },
);

// ── Indexes ──────────────────────────────────────────────
pipelineSchema.index({ tenantId: 1, isDefault: 1 });
pipelineSchema.index({ tenantId: 1, isActive: 1 });
pipelineSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * Ensure only one default pipeline per tenant.
 */
pipelineSchema.pre("save", async function () {
  if (this.isDefault && this.isModified("isDefault")) {
    await this.constructor.updateMany(
      { tenantId: this.tenantId, _id: { $ne: this._id }, isDefault: true },
      { isDefault: false },
    );
  }
});

/**
 * Get stages sorted by order.
 */
pipelineSchema.methods.getSortedStages = function () {
  return [...this.stages].sort((a, b) => a.order - b.order);
};

/**
 * Validate stage transition — returns true if fromStage → toStage is valid
 * (moving forward or backward is allowed; only isClosed check matters).
 */
pipelineSchema.methods.validateStageTransition = function (
  fromStageName,
  toStageName,
) {
  const fromStage = this.stages.find((s) => s.name === fromStageName);
  const toStage = this.stages.find((s) => s.name === toStageName);

  if (!fromStage || !toStage)
    return { valid: false, reason: "Stage not found in pipeline" };
  if (fromStage.isClosed)
    return { valid: false, reason: "Cannot move from a closed stage" };

  return { valid: true, fromStage, toStage };
};

/**
 * Get default pipeline for a tenant, creating one if none exists.
 */
pipelineSchema.statics.getDefaultForTenant = async function (tenantId) {
  let pipeline = await this.findOne({
    tenantId,
    isDefault: true,
    isActive: true,
  });
  if (pipeline) return pipeline;

  // Create default "Sales Pipeline"
  pipeline = await this.create({
    tenantId,
    name: "Sales Pipeline",
    isDefault: true,
    isActive: true,
    stages: [
      { name: "Qualification", probability: 10, order: 0 },
      { name: "Needs Analysis", probability: 20, order: 1 },
      { name: "Proposal", probability: 40, order: 2 },
      { name: "Negotiation", probability: 60, order: 3 },
      {
        name: "Closed Won",
        probability: 100,
        order: 4,
        isClosed: true,
        isWon: true,
      },
      {
        name: "Closed Lost",
        probability: 0,
        order: 5,
        isClosed: true,
        isWon: false,
      },
    ],
  });

  return pipeline;
};

export default mongoose.model("Pipeline", pipelineSchema);
