/**
 * Workflow v2 Controller (P3-005).
 *
 * CRUD for the v2 `Workflow` model (graph-based definitions) and a read-only
 * registry endpoint that the builder UI uses to populate the node palette.
 */

import Workflow from "../../models/Workflow.js";
import WorkflowRun from "../../models/WorkflowRun.js";
import {
  getEntriesByType,
} from "../../services/workflow/actionRegistry.js";
import { compileWorkflow } from "../../services/workflow/compileWorkflow.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const notDeleted = { deletedAt: null };

function tenantScope(req) {
  return { tenantId: req.user.tenantId, ...notDeleted };
}

// ── CRUD ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/crm/workflows/v2
 * List all v2 workflows for the current tenant.
 */
export async function listWorkflowsV2(req, res, next) {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const filter = tenantScope(req);
    if (status) filter.status = status;

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [workflows, total] = await Promise.all([
      Workflow.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Workflow.countDocuments(filter),
    ]);

    res.json({ data: workflows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/crm/workflows/v2/:id
 */
export async function getWorkflowV2(req, res, next) {
  try {
    const wf = await Workflow.findOne({
      _id: req.params.id,
      ...tenantScope(req),
    }).lean();
    if (!wf) return res.status(404).json({ message: "Workflow not found" });
    res.json({ data: wf });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/crm/workflows/v2
 */
export async function createWorkflowV2(req, res, next) {
  try {
    const { name, description, nodes, edges, status: wfStatus } = req.body;

    // Compile to validate graph structure
    if (nodes && nodes.length > 0) {
      const result = compileWorkflow({ nodes, edges: edges || [] });
      if (!result.ok) {
        return res.status(400).json({ message: "Invalid workflow graph", errors: result.errors });
      }
    }

    const wf = await Workflow.create({
      tenantId: req.user.tenantId,
      name: name || "Untitled Workflow",
      description,
      nodes: nodes || [],
      edges: edges || [],
      status: wfStatus || "draft",
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    res.status(201).json({ data: wf.toObject() });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
}

/**
 * PUT /api/v1/crm/workflows/v2/:id
 */
export async function updateWorkflowV2(req, res, next) {
  try {
    const wf = await Workflow.findOne({
      _id: req.params.id,
      ...tenantScope(req),
    });
    if (!wf) return res.status(404).json({ message: "Workflow not found" });

    const { name, description, nodes, edges, status: wfStatus, isActive } = req.body;

    // Validate graph if nodes are being updated
    if (nodes && nodes.length > 0) {
      const result = compileWorkflow({ nodes, edges: edges || wf.edges || [] });
      if (!result.ok) {
        return res.status(400).json({ message: "Invalid workflow graph", errors: result.errors });
      }
    }

    if (name !== undefined) wf.name = name;
    if (description !== undefined) wf.description = description;
    if (nodes !== undefined) wf.nodes = nodes;
    if (edges !== undefined) wf.edges = edges;
    if (wfStatus !== undefined) wf.status = wfStatus;
    if (isActive !== undefined) wf.isActive = isActive;
    wf.updatedBy = req.user._id;

    await wf.save();
    res.json({ data: wf.toObject() });
  } catch (err) {
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: err.message });
    }
    next(err);
  }
}

/**
 * DELETE /api/v1/crm/workflows/v2/:id  (soft delete)
 */
export async function deleteWorkflowV2(req, res, next) {
  try {
    const wf = await Workflow.findOne({
      _id: req.params.id,
      ...tenantScope(req),
    });
    if (!wf) return res.status(404).json({ message: "Workflow not found" });

    wf.deletedAt = new Date();
    wf.deletedBy = req.user._id;
    wf.status = "archived";
    await wf.save();

    res.json({ message: "Workflow deleted" });
  } catch (err) {
    next(err);
  }
}

// ── Registry endpoint ────────────────────────────────────────────────────

/**
 * GET /api/v1/crm/workflows/v2/registry
 * Returns the full node palette for the builder UI, grouped by type.
 */
export async function getRegistry(_req, res, next) {
  try {
    const types = ["trigger", "condition", "action", "ai", "approval", "delay", "branch"];
    const registry = {};
    for (const t of types) {
      registry[t] = getEntriesByType(t).map((e) => ({
        subtype: e.subtype,
        type: e.type,
        category: e.category,
        displayName: e.displayName,
        description: e.description,
        requiresApproval: e.requiresApproval,
        status: e.status,
        configSchema: e.configSchema || null,
      }));
    }
    res.json({ data: registry });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/crm/workflows/v2/:id/runs
 * List recent runs for a specific workflow.
 */
export async function getWorkflowRuns(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

    const filter = {
      workflowId: req.params.id,
      tenantId: req.user.tenantId,
    };

    const [runs, total] = await Promise.all([
      WorkflowRun.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      WorkflowRun.countDocuments(filter),
    ]);

    res.json({ data: runs, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    next(err);
  }
}

// ── Activate / Deactivate ────────────────────────────────────────────────

/**
 * PUT /api/v1/crm/workflows/v2/:id/activate
 * Toggle a workflow between draft ↔ active.
 * Active requires compile validation pass.
 */
export async function activateWorkflowV2(req, res, next) {
  try {
    const workflow = await Workflow.findOne({
      _id: req.params.id,
      ...tenantScope(req),
    });
    if (!workflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    const { activate } = req.body; // boolean — true to activate, false to deactivate
    const wantActive = activate !== false;

    if (wantActive) {
      // Must pass compile validation before activation
      const result = compileWorkflow(workflow.toObject());
      if (!result.ok) {
        return res.status(422).json({
          message: "Workflow has validation errors and cannot be activated.",
          errors: result.errors,
          warnings: result.warnings,
        });
      }
      // Reject if any node is preview-only
      if (result.warnings?.some((w) => w.includes("preview"))) {
        return res.status(422).json({
          message: "Workflow contains preview nodes that cannot be activated.",
          warnings: result.warnings,
        });
      }
      workflow.status = "active";
      workflow.isActive = true;
    } else {
      workflow.status = "draft";
      workflow.isActive = false;
    }

    workflow.updatedBy = req.user._id;
    await workflow.save();

    res.json({ data: workflow.toObject() });
  } catch (err) {
    next(err);
  }
}
