import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import dns from "dns";
import Tenant from "./src/models/Tenant.js";
import User from "./src/models/User.js";
import logger from "./src/utils/logger.js";

// Use reliable public resolvers for MongoDB SRV lookups.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

/**
 * Seed a platform-level Super Admin user.
 *
 * The superadmin lives inside a special "__platform__" tenant that acts
 * as the platform-owner workspace.  This user has role "superadmin" and
 * full cross-tenant access.
 *
 * Usage:  node seedSuperAdmin.js
 *
 * Defaults (override via env vars):
 *   SUPERADMIN_EMAIL    = superadmin@platform.com
 *   SUPERADMIN_PASSWORD = Super@Admin123
 *   SUPERADMIN_NAME     = Platform Owner
 */
const seedSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    logger.info("MongoDB connected for superadmin seeding");

    const email = (process.env.SUPERADMIN_EMAIL || "pappumahato000@gmail.com")
      .trim()
      .toLowerCase();
    const password = process.env.SUPERADMIN_PASSWORD || "Charan@CRMSUPERADMIN007";
    const name = process.env.SUPERADMIN_NAME || "Platform Owner";

    // 1. Ensure the platform tenant exists
    let platformTenant = await Tenant.findOne({ slug: "__platform__" });

    if (!platformTenant) {
      platformTenant = await Tenant.create({
        name: "Platform Administration",
        slug: "__platform__",
        company: { name: "SaaS Platform" },
        plan: "enterprise",
        isActive: true,
        activeUsers: 1,
        settings: { maxUsers: 100, maxEvents: 999 },
      });
      logger.info("Platform tenant created: __platform__");
    }

    // 2. Create or update the superadmin user
    const existing = await User.findOne({
      tenantId: platformTenant._id,
      email,
    });

    if (existing) {
      if (existing.role !== "superadmin") {
        existing.role = "superadmin";
        existing.isActive = true;
        await existing.save();
        logger.info(`Existing user upgraded to superadmin: ${email}`);
      } else {
        logger.info(`Superadmin already exists: ${email}`);
      }
    } else {
      await User.create({
        tenantId: platformTenant._id,
        name,
        email,
        password,
        role: "superadmin",
        isActive: true,
        approvalStatus: "approved",
      });
      logger.info(`Superadmin user created: ${email}`);
      logger.info(`Default credentials: ${email} / ${password}`);
    }

    logger.info("Superadmin seeding complete!");
    process.exit(0);
  } catch (error) {
    logger.error("Superadmin seeding failed:", error);
    process.exit(1);
  }
};

seedSuperAdmin();
