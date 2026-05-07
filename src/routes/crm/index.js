import express from "express";
import contactRoutes from "./contactRoutes.js";
import accountRoutes from "./accountRoutes.js";
import dealRoutes from "./dealRoutes.js";
import activityRoutes from "./activityRoutes.js";
import pipelineRoutes from "./pipelineRoutes.js";
import leadConversionRoutes from "./leadConversionRoutes.js";
import workflowRoutes from "./workflowRoutes.js";
import workflowV2Routes from "./workflowV2Routes.js";
import blueprintRoutes from "./blueprintRoutes.js";
import analyticsRoutes from "./analyticsRoutes.js";
import customModuleRoutes from "./customModuleRoutes.js";
import customFieldRoutes from "./customFieldRoutes.js";
import layoutRoutes from "./layoutRoutes.js";
import formRoutes from "./formRoutes.js";

const router = express.Router();

router.use("/contacts", contactRoutes);
router.use("/accounts", accountRoutes);
router.use("/deals", dealRoutes);
router.use("/activities", activityRoutes);
router.use("/pipelines", pipelineRoutes);
router.use("/leads", leadConversionRoutes);
router.use("/workflows", workflowRoutes);
router.use("/workflows/v2", workflowV2Routes);
router.use("/blueprints", blueprintRoutes);
router.use("/analytics", analyticsRoutes);

// Dynamic Metadata Engine routes
router.use("/metadata/modules", customModuleRoutes);
router.use("/metadata/fields", customFieldRoutes);
router.use("/metadata/layouts", layoutRoutes);
router.use("/metadata/forms", formRoutes);

export default router;
