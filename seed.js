import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import User from "./src/models/User.js";
import Event from "./src/models/Event.js";
import logger from "./src/utils/logger.js";

/**
 * Database Seeder - Create initial admin user and sample data
 */
const seedDatabase = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info("MongoDB connected for seeding");

    // Check if admin already exists
    const existingAdmin = await User.findOne({ role: "admin" });

    if (existingAdmin) {
      logger.info(`Admin user already exists: ${existingAdmin.email}`);
    } else {
      // Create admin user
      const admin = await User.create({
        name: "Admin User",
        email: "admin@crm.com",
        password: "Admin@123",
        role: "admin",
        isActive: true,
      });
      logger.info(`Admin user created: ${admin.email}`);
      logger.info("Default credentials: admin@crm.com / Admin@123");
    }

    // Check if sample marketing user exists
    const existingMarketing = await User.findOne({
      email: "marketing@crm.com",
    });

    if (!existingMarketing) {
      const marketing = await User.create({
        name: "Marketing User",
        email: "marketing@crm.com",
        password: "Marketing@123",
        role: "marketing",
        isActive: true,
      });
      logger.info(`Marketing user created: ${marketing.email}`);
      logger.info("Default credentials: marketing@crm.com / Marketing@123");
    }

    // Check if sample event exists
    const existingEvent = await Event.findOne();

    if (!existingEvent) {
      const admin = await User.findOne({ role: "admin" });
      const event = await Event.create({
        name: "Sample Tech Conference 2026",
        description:
          "A sample technology conference for demonstrating the CRM system",
        location: "Tech Hub Convention Center",
        startDate: new Date("2026-03-01"),
        endDate: new Date("2026-03-03"),
        status: "upcoming",
        targetLeads: 100,
        budget: 50000,
        tags: ["technology", "conference", "networking"],
        createdBy: admin._id,
      });
      logger.info(`Sample event created: ${event.name}`);
    }

    logger.info("Database seeding completed successfully!");
    logger.info("\n==================================");
    logger.info("Default Login Credentials:");
    logger.info("==================================");
    logger.info("Admin:     admin@crm.com / Admin@123");
    logger.info("Marketing: marketing@crm.com / Marketing@123");
    logger.info("==================================\n");
  } catch (error) {
    logger.error(`Seeding error: ${error.message}`);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

// Run seeder
seedDatabase();
