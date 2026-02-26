import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import dns from "dns";
import Website from "./src/models/Website.js";
import User from "./src/models/User.js";
import logger from "./src/utils/logger.js";

// Use reliable public resolvers for MongoDB SRV lookups.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

/**
 * Seed default company websites as lead sources
 * These represent the various web properties of Prem Industries group
 */
const companyWebsites = [
  {
    name: "Prem Industries",
    domain: "premindustries.net",
    description:
      "Main corporate website for Prem Industries India Limited — Corrugated packaging solutions",
    category: "contact_form",
  },
  {
    name: "Prem Packaging",
    domain: "prempackaging.com",
    description:
      "Packaging solutions division — Corrugated boxes, customized packaging, industrial packaging",
    category: "contact_form",
  },
  {
    name: "PH Steels",
    domain: "phsteels.in",
    description:
      "Steel products division — TMT bars, steel coils, structural steel, MS plates",
    category: "contact_form",
  },
  {
    name: "Sheet Metal Division",
    domain: "sheetmetal.premindustries.net",
    description:
      "Sheet metal fabrication services — CNC punching, laser cutting, bending, welding",
    category: "landing_page",
  },
  {
    name: "Injection Moulding",
    domain: "injectionmoulding.premindustries.net",
    description:
      "Plastic injection moulding division — Custom mould design, mass production, insert moulding",
    category: "landing_page",
  },
  {
    name: "Prem Automobile Parts",
    domain: "autoparts.premindustries.net",
    description:
      "Automobile component manufacturing — Precision auto parts, OEM supplied components",
    category: "contact_form",
  },
  {
    name: "Prem Extrusions",
    domain: "extrusions.premindustries.net",
    description:
      "Aluminium & plastic extrusion division — custom profiles, industrial extrusions",
    category: "landing_page",
  },
  {
    name: "IndiaMART Leads",
    domain: "indiamart.com",
    description:
      "Leads coming from IndiaMART listings for all Prem Industries group products",
    category: "partner",
  },
  {
    name: "TradeIndia Leads",
    domain: "tradeindia.com",
    description: "Leads coming from TradeIndia B2B marketplace listings",
    category: "partner",
  },
  {
    name: "JustDial Leads",
    domain: "justdial.com",
    description: "Leads from JustDial business listings across all divisions",
    category: "partner",
  },
];

const seedWebsites = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      family: 4,
    });
    logger.info("MongoDB connected for website seeding");

    // Find admin user to attach as createdBy
    const admin = await User.findOne({ role: "admin" });
    if (!admin) {
      logger.error(
        "Admin user not found. Run `node seed.js` first to create the admin user.",
      );
      process.exit(1);
    }

    // Determine tenantId from admin user
    const tenantId = admin.tenantId || admin._id;

    let created = 0;
    let skipped = 0;

    for (const site of companyWebsites) {
      const exists = await Website.findOne({
        domain: site.domain.toLowerCase(),
        tenantId,
      });

      if (exists) {
        logger.info(`  ↳ Skipped (exists): ${site.name} — ${site.domain}`);
        skipped++;
        continue;
      }

      // Generate a unique API key
      const { randomBytes } = await import("crypto");
      const apiKey = `pk_${randomBytes(32).toString("hex")}`;

      await Website.create({
        tenantId,
        name: site.name,
        domain: site.domain.toLowerCase(),
        description: site.description,
        category: site.category,
        apiKey,
        apiKeyPrefix: apiKey.substring(0, 11),
        isActive: true,
        createdBy: admin._id,
        duplicateSettings: {
          checkEmail: true,
          checkPhone: true,
          checkNameEmail: false,
        },
        rateLimit: {
          requestsPerMinute: 60,
          requestsPerDay: 5000,
        },
        stats: {
          totalLeads: 0,
          leadsThisMonth: 0,
          duplicatesDetected: 0,
          lastLeadAt: null,
        },
      });

      logger.info(`  ✓ Created: ${site.name} — ${site.domain}`);
      created++;
    }

    logger.info("\n==================================");
    logger.info("Website Seeding Complete");
    logger.info("==================================");
    logger.info(`Created: ${created}`);
    logger.info(`Skipped: ${skipped}`);
    logger.info(`Total:   ${companyWebsites.length}`);
    logger.info("==================================");
    logger.info("\nWebsite Sources:");
    companyWebsites.forEach((s) =>
      logger.info(`  • ${s.name.padEnd(25)} → ${s.domain}`),
    );
    logger.info("==================================\n");
  } catch (error) {
    logger.error(`Website seeding error: ${error.message}`);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

seedWebsites();

