import express from "express";
import { protect, authorize } from "../../middlewares/auth.js";
import {
  validateMongoId,
  validatePagination,
  rejectUnknownFields,
} from "../../middlewares/requestValidators.js";
import {
  getRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  getExecutions,
} from "../../controllers/crm/workflowController.js";

const router = express.Router();

router.use(protect);

const RULE_CREATE_FIELDS = [
  "name",
  "description",
  "isActive",
  "module",
  "trigger",
  "conditions",
  "actions",
];
const RULE_UPDATE_FIELDS = [
  "name",
  "description",
  "isActive",
  "trigger",
  "conditions",
  "actions",
];

// Automation rules — admin only
router.get("/rules", authorize("admin"), validatePagination(), getRules);
router.get("/rules/:id", authorize("admin"), validateMongoId(), getRule);
router.post(
  "/rules",
  authorize("admin"),
  rejectUnknownFields(RULE_CREATE_FIELDS),
  createRule,
);
router.put(
  "/rules/:id",
  authorize("admin"),
  validateMongoId(),
  rejectUnknownFields(RULE_UPDATE_FIELDS),
  updateRule,
);
router.delete("/rules/:id", authorize("admin"), validateMongoId(), deleteRule);

// Execution logs
router.get(
  "/executions",
  authorize("admin"),
  validatePagination(),
  getExecutions,
);

export default router;
