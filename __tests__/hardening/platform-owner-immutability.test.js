import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.JWT_SECRET = "test-jwt-secret-for-vitest";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret";
process.env.NODE_ENV = "test";
process.env.REDIS_URL = "";

let mongoServer;
let Tenant;
let User;
let AuthService;
let platformTenant;
let platformOwner;

const fixedEmail = "pappumahato000@gmail.com";
const fixedPassword = "Charan@CRMSUPERADMIN007";

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  Tenant = (await import("../../src/models/Tenant.js")).default;
  User = (await import("../../src/models/User.js")).default;
  AuthService = (await import("../../src/core/auth/AuthService.js")).default;
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, 15000);

beforeEach(async () => {
  for (const key of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[key].deleteMany({});
  }

  platformTenant = await Tenant.create({
    name: "Platform Administration",
    slug: "__platform__",
    isActive: true,
    plan: "enterprise",
  });

  platformOwner = await User.create({
    tenantId: platformTenant._id,
    name: "Platform Owner",
    email: fixedEmail,
    password: fixedPassword,
    role: "superadmin",
    isActive: true,
    approvalStatus: "approved",
  });
});

describe("fixed platform owner credentials", () => {
  it("blocks authenticated password changes for the platform owner", async () => {
    await expect(
      AuthService.changePassword(
        platformOwner._id,
        platformTenant._id,
        fixedPassword,
        "Changed@Password123",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    const reloaded = await User.findById(platformOwner._id).select("+password");
    await expect(
      reloaded.comparePassword("Changed@Password123"),
    ).resolves.toBe(false);
    await expect(reloaded.comparePassword(fixedPassword)).resolves.toBe(true);
  });

  it("does not create password reset tokens for the platform owner", async () => {
    await AuthService.initiatePasswordReset(fixedEmail);

    const reloaded = await User.findById(platformOwner._id).select(
      "+passwordResetToken +passwordResetExpires",
    );
    expect(reloaded.passwordResetToken).toBeUndefined();
    expect(reloaded.passwordResetExpires).toBeUndefined();
  });

  it("blocks existing reset tokens from changing the platform owner password", async () => {
    const resetToken = "existing-reset-token";
    platformOwner.passwordResetToken = AuthService.hashToken(resetToken);
    platformOwner.passwordResetExpires = new Date(Date.now() + 60_000);
    await platformOwner.save({ validateBeforeSave: false });

    await expect(
      AuthService.resetPassword(resetToken, "Changed@Password123"),
    ).rejects.toMatchObject({ statusCode: 403 });

    const reloaded = await User.findById(platformOwner._id).select("+password");
    await expect(
      reloaded.comparePassword("Changed@Password123"),
    ).resolves.toBe(false);
    await expect(reloaded.comparePassword(fixedPassword)).resolves.toBe(true);
  });
});
